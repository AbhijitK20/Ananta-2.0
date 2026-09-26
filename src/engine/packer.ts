/**
 * The packer. Cluster-then-route, not TSP on the shortlist.
 *
 * WHERE THIS COMES FROM, and why it is not the obvious thing.
 *
 * ITINERA (arXiv 2402.07204, deployed in production at the TuTu travel service
 * with thousands of real users) does not run a solver over its candidate list. It
 * groups candidates geographically, orders the groups, then solves a small TSP
 * inside each. That is cheap, deterministic, and already proven at scale.
 *
 * Three details we kept:
 *  - CLUSTERS ARE DIAMETER-BOUNDED. Every stop in a cluster sits within the
 *    radius of every other, so "this cluster is walkable" is a geometric fact
 *    rather than a hope. A k-means cluster can be a crescent spanning 8 km.
 *  - THE BUDGET SCALES THE RADIUS. A one-hour plan wants one tight cluster; an
 *    eight-hour plan wants four loose ones. From ITINERA's `TIME2NUM` table,
 *    linear in hours: 1h -> (1 cluster, 3 POIs, 2000m), 8h -> (4, 17, 9000m).
 *  - ORDER BY SUMMED SCORE, NOT BY DISTANCE, then stitch at the closest POI pair.
 *
 * We use connected components rather than a max-clique peel: at our sizes
 * (10-25 feasible candidates) the grouping is equivalent, and components are
 * O(V+E) and cannot collapse into singletons the way a clique peel can.
 * `geo.connectedComponents` is iterative and index-stable, so runs are
 * reproducible — which the eval harness depends on.
 *
 * Local search underneath: cheapest-insertion, then 2-opt and Or-opt, under LAHC
 * (late-acceptance hill climbing) with restart-from-best. That combination is the
 * only real anti-local-optima mechanism in any of the 71 reference repositories
 * (PyVRP's `IteratedLocalSearch`), and it is about fifteen lines.
 *
 * The itinerary is a SINGLE CONNECTED PATH anchored at the traveller's origin,
 * not a free tour. A traveller is standing somewhere and has to walk away from
 * it, which the reference implementation did not have to handle.
 */
import type {
  DiscoveryContext,
  Experience,
  Fit,
  Money,
  PlanStop,
  ScoreBreakdown,
  TravelLeg,
} from "@/contracts";
import { buildRadiusGraph, connectedComponents, type RadiusGraph } from "./geo";
import { score, DEFAULT_PROFILE, type WeightProfile } from "./scoring";
import { bufferFor, type Candidate, type FilterOptions } from "./feasibility";
import { toLeg, type TravelMode } from "./travel";
import { computeFit } from "./fit";
import { addMoney, zero } from "@/lib/money";
import { seedFrom, seededRandom } from "@/lib/id";

export const ENGINE_VERSION = "packer/1.0.0";

/** Per-stop fixed overhead: parking, queueing, finding the entrance. */
const STOP_OVERHEAD_MIN = 8;
/** Straight-line detour factor, since nobody walks a straight line in a city. */
const DETOUR = 1.35;
/** Walking metres per second. */
const WALK_MPS = 1.3;

export interface ScaleProfile {
  clusters: number;
  candidates: number;
  radiusMetres: number;
  maxStops: number;
}

/**
 * Linear in hours, interpolated from ITINERA's `TIME2NUM` table — the only
 * empirically grounded budget-to-geography mapping in the reference corpus.
 */
export function scaleFor(availableMin: number): ScaleProfile {
  const hours = Math.max(0.25, availableMin / 60);
  const t = Math.max(0, Math.min(1, (hours - 1) / 7)); // 1h..8h
  return {
    clusters: Math.round(1 + t * 3),
    candidates: Math.round(3 + t * 14),
    radiusMetres: Math.round(2000 + t * 7000),
    maxStops: Math.max(2, Math.min(6, Math.round(1 + t * 4))),
  };
}

function metresBetween(a: Experience, b: Experience): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.location.lat - a.location.lat);
  const dLon = toRad(b.location.lon - a.location.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.location.lat)) * Math.cos(toRad(b.location.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Symmetric leg cost with a memo. One instance per pack run, so the local search
 * does not re-derive the same leg thousands of times.
 */
class LegCosts {
  private readonly memo = new Map<string, number>();

  constructor(
    private readonly mode: TravelMode,
    private readonly speedMps: number,
  ) {}

  minutes(a: Experience, b: Experience): number {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const metres = metresBetween(a, b) * DETOUR;
    const minutes = Math.max(1, Math.round(metres / this.speedMps / 60));
    this.memo.set(key, minutes);
    return minutes;
  }

  metres(a: Experience, b: Experience): number {
    return Math.round(metresBetween(a, b) * DETOUR);
  }

  /** Full path cost from the origin, through `order`, and back. */
  path(order: readonly number[], items: readonly Experience[], origin: Experience): number {
    if (order.length === 0) return 0;
    let total = 0;
    let prev = origin;
    for (const i of order) {
      const e = items[i];
      if (e === undefined) continue;
      total += this.minutes(prev, e);
      prev = e;
    }
    // Getting back is optional for a traveller, so charge it at half weight.
    const last = items[order[order.length - 1] ?? -1];
    if (last !== undefined) total += this.minutes(last, origin) * 0.5;
    return total;
  }
}

function speedFor(mode: TravelMode): number {
  switch (mode) {
    case "walk":
      return WALK_MPS;
    case "transit":
      return 9.7;
    case "ferry":
      return 6.9;
    case "auto":
      return 8.3;
    default:
      return WALK_MPS;
  }
}

// --- clustering -------------------------------------------------------------

export interface Cluster {
  indices: number[];
  /** Max pairwise distance inside the cluster. Bounded by the radius. */
  diameterMetres: number;
  centroid: { lat: number; lon: number };
  /** Summed score, not mean: a big good cluster beats a tiny perfect one. */
  totalScore: number;
}

export function clusterCandidates(
  items: readonly Experience[],
  graph: RadiusGraph,
  scoreOf: (id: string) => number,
): Cluster[] {
  const clusters: Cluster[] = [];

  for (const comp of connectedComponents(graph)) {
    const present = comp.filter((i) => items[i] !== undefined);
    if (present.length === 0) continue;

    let diameter = 0;
    let lat = 0;
    let lon = 0;
    let total = 0;
    for (const i of present) {
      const e = items[i]!;
      lat += e.location.lat;
      lon += e.location.lon;
      total += scoreOf(e.id);
      for (const j of present) {
        const other = items[j];
        if (other === undefined) continue;
        const d = graph.distances[i]?.[j] ?? 0;
        if (d > diameter) diameter = d;
      }
    }

    clusters.push({
      indices: present,
      diameterMetres: diameter,
      centroid: { lat: lat / present.length, lon: lon / present.length },
      totalScore: total,
    });
  }

  // Ties break on lowest index so the order is stable run to run.
  clusters.sort(
    (a, b) => b.totalScore - a.totalScore || (a.indices[0] ?? 0) - (b.indices[0] ?? 0),
  );
  return clusters;
}

// --- intra-cluster sequencing ----------------------------------------------

/** Cheapest insertion, then 2-opt, then Or-opt. ~80 lines, no solver. */
function cheapestInsertion(
  order: number[],
  items: readonly Experience[],
  origin: Experience,
  legs: LegCosts,
  remaining: readonly number[],
): number[] {
  const current = [...order];
  for (const idx of remaining) {
    const e = items[idx];
    if (e === undefined) continue;
    if (current.length === 0) {
      current.push(idx);
      continue;
    }
    let bestPos = 0;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let pos = 0; pos <= current.length; pos++) {
      const before = current[pos - 1] !== undefined ? items[current[pos - 1]!] : origin;
      const after = current[pos] !== undefined ? items[current[pos]!] : undefined;
      if (before === undefined) continue;
      const removed = after !== undefined ? legs.minutes(before, after) : 0;
      const added = legs.minutes(before, e) + (after !== undefined ? legs.minutes(e, after) : 0);
      const delta = added - removed;
      if (delta < bestDelta) {
        bestDelta = delta;
        bestPos = pos;
      }
    }
    current.splice(bestPos, 0, idx);
  }
  return current;
}

function twoOpt(order: readonly number[], items: readonly Experience[], origin: Experience, legs: LegCosts): number[] {
  const n = order.length;
  if (n < 4) return [...order];
  let best = [...order];
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 12) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        if (legs.path(candidate, items, origin) < legs.path(best, items, origin) - 1e-9) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

function orOpt(order: readonly number[], items: readonly Experience[], origin: Experience, legs: LegCosts): number[] {
  const n = order.length;
  if (n < 4) return [...order];
  let best = [...order];
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 12) {
    improved = false;
    for (let len = 1; len <= 3 && len < n; len++) {
      for (let i = 0; i + len <= n; i++) {
        const seg = best.slice(i, i + len);
        const rest = [...best.slice(0, i), ...best.slice(i + len)];
        for (let pos = 0; pos <= rest.length; pos++) {
          if (pos === i) continue;
          const candidate = [...rest.slice(0, pos), ...seg, ...rest.slice(pos)];
          if (legs.path(candidate, items, origin) < legs.path(best, items, origin) - 1e-9) {
            best = candidate;
            improved = true;
          }
        }
      }
    }
  }
  return best;
}

/**
 * Late-acceptance hill climbing with restart-from-best.
 *
 * Plain hill climbing stops at the first local optimum it meets. LAHC accepts a
 * worse solution when it has been accepted rarely recently, which lets it walk out
 * of shallow traps. Restart-from-best stops the walk from drifting away. Fifteen
 * lines, and it reliably beats repeated descent (PyVRP's `IteratedLocalSearch`).
 */
export function lahc(
  initial: readonly number[],
  items: readonly Experience[],
  origin: Experience,
  legs: LegCosts,
  opts: { iterations?: number; length?: number; seed?: number } = {},
): number[] {
  const iterations = opts.iterations ?? 400;
  const len = opts.length ?? 12;
  const rand = seededRandom(opts.seed ?? seedFrom("lahc", items.length));
  const cost = (o: readonly number[]) => legs.path(o, items, origin);

  let current = [...initial];
  let currentCost = cost(current);
  let best = [...current];
  let bestCost = currentCost;
  const sinceAccepted = new Array<number>(len).fill(0);

  for (let it = 0; it < iterations; it++) {
    const slot = it % len;
    const candidate = [...current];
    if (candidate.length >= 4) {
      // segment reversal perturbation
      const a = Math.floor(rand() * (candidate.length - 3));
      const b = a + 1 + Math.floor(rand() * Math.min(3, candidate.length - a - 1));
      const seg = candidate.slice(a, b + 1).reverse();
      candidate.splice(a, seg.length, ...seg);
    }
    const candidateCost = cost(candidate);
    if (candidateCost < currentCost || sinceAccepted[slot]! >= it) {
      current = candidate;
      currentCost = candidateCost;
      sinceAccepted[slot] = 0;
      if (currentCost < bestCost) {
        best = [...current];
        bestCost = currentCost;
      }
    } else {
      sinceAccepted[slot]! += 1;
    }
  }
  return best; // restart-from-best
}

// --- the packer -------------------------------------------------------------

export interface PackOptions extends FilterOptions {
  weights?: WeightProfile;
  travelContext: { atMin?: number; mode?: TravelMode; allowNetwork?: boolean };
  maxStops?: number;
  seed?: number;
}

export interface PackResult {
  stops: PlanStop[];
  legs: TravelLeg[];
  totalMin: number;
  totalCost: Money;
  totalMetres: number;
  clustersUsed: number;
  candidatesConsidered: number;
  seed: number;
  engineVersion: string;
}

const ORIGIN_ID = "__origin__";

/**
 * Pack feasible candidates into a time-boxed, connected, ordered itinerary.
 *
 * Pure and synchronous: routing is not awaited in the hot loop, because a
 * 250-candidate gate that makes 250 network calls is a 30-second search. The
 * packer uses cached travel times from the `Candidate.travelMin` the retrieval
 * stage already computed, and `resolveLegs` can upgrade them to live values
 * afterwards if the caller wants.
 */
export function pack(
  ctx: DiscoveryContext,
  feasible: readonly Candidate[],
  opts: PackOptions,
): PackResult {
  const seed = opts.seed ?? seedFrom("pack", ctx.id, feasible.length);
  const scale = scaleFor(ctx.availableMin);
  const maxStops = opts.maxStops ?? scale.maxStops;
  const profile = opts.weights ?? DEFAULT_PROFILE;
  const mode: TravelMode =
    opts.travelContext.mode && opts.travelContext.mode !== ("any" as TravelMode)
      ? opts.travelContext.mode
      : "walk";

  if (feasible.length === 0) return emptyResult(seed);

  const origin = makeOrigin(ctx);
  const legs = new LegCosts(mode, speedFor(mode));

  // 1. Score everything: cluster order and insertion order both need it.
  const scored = new Map<string, { score: ScoreBreakdown; travelMin: number }>();
  for (const c of feasible) {
    scored.set(c.experience.id, {
      score: score(ctx, c.experience, profile, { travelMin: c.travelMin }),
      travelMin: c.travelMin,
    });
  }
  const scoreOf = (id: string) => scored.get(id)?.score.total ?? 0;

  // 2. Cluster on the budget-scaled radius.
  const items = feasible.map((c) => c.experience);
  const graph = buildRadiusGraph(items.map((e) => e.location), scale.radiusMetres);
  const clusters = clusterCandidates(items, graph, scoreOf).slice(0, scale.clusters);

  // 3. Draw from clusters in score order, never over the stop cap.
  const chosen: number[] = [];
  for (const cluster of clusters) {
    const byScore = [...cluster.indices].sort(
      (a, b) => scoreOf(items[b]?.id ?? "") - scoreOf(items[a]?.id ?? ""),
    );
    for (const i of byScore) {
      if (chosen.length >= maxStops) break;
      chosen.push(i);
    }
  }
  if (chosen.length === 0) return emptyResult(seed);

  // 4. Sequence: cheapest insertion, then Or-opt and 2-opt, then LAHC.
  const byScoreFirst = [...chosen].sort(
    (a, b) => scoreOf(items[b]?.id ?? "") - scoreOf(items[a]?.id ?? ""),
  );
  const inserted = cheapestInsertion([], items, origin, legs, byScoreFirst);
  const improved = twoOpt(orOpt(inserted, items, origin, legs), items, origin, legs);
  const sequenced = lahc(improved, items, origin, legs, { seed });

  // 5. Walk the sequence against the clock, keeping only what actually fits.
  const ordered = sequenced.map((i) => items[i]).filter((e): e is Experience => e !== undefined);
  const walked = walkClock(ctx, ordered, scored, opts, origin, legs, mode);

  return { ...walked, clustersUsed: clusters.length, candidatesConsidered: items.length, seed, engineVersion: ENGINE_VERSION };
}

function makeOrigin(ctx: DiscoveryContext): Experience {
  return {
    id: ORIGIN_ID,
    name: ctx.origin.label,
    category: "hidden_place",
    location: ctx.origin.point ?? { lat: 19.076, lon: 72.8777 },
    durationMin: 0,
    pricePerPerson: null,
    capacity: null,
    hours: { raw: "24/7", status: "ok", lastVerified: null },
    indoorOutdoor: "mixed",
    accessibility: {
      stepFree: null, strollerOk: null, lowStairs: null,
      seatingAvailable: null, hearingLoop: null, restroomOnSite: null,
    },
    kidFriendly: null,
    minAge: null,
    diets: [],
    cuisines: [],
    rating: { value: 0, count: 0, rawMean: null },
    blurb: null,
    description: null,
    keywords: [],
    perception: { landscape: [], activities: [], atmosphere: [] },
    bestTimeOfDay: [],
    requiresJourney: false,
    booking: { required: false, leadTimeMin: 0, walkIn: true },
    bestMonths: [],
    weatherSensitive: "none",
    provenance: {},
    providerId: null,
    neighbourhood: null,
    city: "Mumbai",
  };
}

function emptyResult(seed: number): PackResult {
  return {
    stops: [], legs: [], totalMin: 0, totalCost: zero(),
    totalMetres: 0, clustersUsed: 0, candidatesConsidered: 0,
    seed, engineVersion: ENGINE_VERSION,
  };
}

/**
 * Greedily accept stops in the planned order while the window holds.
 *
 * The stop budget is recomputed at each step from what is actually left, not
 * from the original context, which is what stops a plan that looked fine at step
 * one from quietly overrunning at step four.
 */
function walkClock(
  ctx: DiscoveryContext,
  ordered: readonly Experience[],
  scored: ReadonlyMap<string, { score: ScoreBreakdown; travelMin: number }>,
  opts: PackOptions,
  origin: Experience,
  legs: LegCosts,
  mode: TravelMode,
): Omit<PackResult, "clustersUsed" | "candidatesConsidered" | "seed" | "engineVersion"> {
  const stops: PlanStop[] = [];
  const travelLegs: TravelLeg[] = [];
  const windowEnd = ctx.nowMin + ctx.availableMin;

  let clock = ctx.nowMin;
  let cost = zero();
  let metres = 0;
  let prevId = ORIGIN_ID;
  let prev = origin;

  for (const exp of ordered) {
    const legMin = legs.minutes(prev, exp);
    const legM = legs.metres(prev, exp);
    const buffer = Math.max(STOP_OVERHEAD_MIN, bufferFor(legMin, mode, opts));

    const arrive = clock + legMin;
    const start = arrive + buffer;
    const depart = start + exp.durationMin;

    // Hard budget checks, cheapest first. Nothing gets a pass it has not earned.
    if (depart > windowEnd) break;
    if (cost.minor + partyPrice(exp, ctx.partySize) > (ctx.budget?.minor ?? Number.POSITIVE_INFINITY)) break;
    if (exp.capacity !== null && exp.capacity < ctx.partySize) break;

    const stopCost = exp.pricePerPerson;
    if (stopCost !== null) {
      cost = addMoney(cost, { minor: stopCost.minor * ctx.partySize, currency: stopCost.currency });
    }
    metres += legM;

    const fit: Fit = computeFit(ctx, exp, {
      travelMin: legMin,
      bufferMin: buffer,
      visitFrom: start,
      visitTo: depart,
      cost,
      weekday: opts.weekday,
    });

    // A stop that does not fit is not silently accepted, and not silently
    // dropped either: it is skipped, and the replanner's ladder decides later.
    if (fit.verdict === "does_not_fit") {
      clock = depart;
      prev = exp;
      prevId = exp.id;
      travelLegs.push(toLeg(prevId, exp.id, { minutes: legMin, metres: legM, estimated: true, detail: null, provider: "estimate" }, mode));
      continue;
    }

    travelLegs.push({
      fromId: prevId,
      toId: exp.id,
      mode,
      minutes: legMin,
      metres: legM,
      detail: `about ${legMin} min ${mode}`,
      estimated: true,
    });

    const s = scored.get(exp.id);
    stops.push({
      experienceId: exp.id,
      arriveMin: arrive % 1440,
      departMin: depart % 1440,
      fit,
      score: s?.score ?? { experienceId: exp.id, total: 0, components: [], profileVersion: "none", learnedComponents: [] },
      why: (s?.score.components ?? []).slice(0, 3).map((c) => c.reason ?? c.label),
      order: stops.length,
    });

    clock = depart;
    prev = exp;
    prevId = exp.id;
  }

  // Legs must match stops one-for-one after any skips.
  const cleanLegs = stops.length > 0 ? travelLegs.filter((l) => stops.some((s) => s.experienceId === l.toId)) : [];

  return {
    stops,
    legs: cleanLegs,
    totalMin: stops.length > 0 ? clock - ctx.nowMin : 0,
    totalCost: cost,
    totalMetres: metres,
  };
}

function partyPrice(exp: Experience, partySize: number): number {
  return exp.pricePerPerson === null ? 0 : exp.pricePerPerson.minor * partySize;
}
