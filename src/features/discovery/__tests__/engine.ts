/**
 * A deterministic `EnginePort` that actually decides things.
 *
 * `fixtures.ts` holds `fakeEngine`, which holds a plan the test hands it and hands
 * it back. That is the right double for testing the *feature* — the diff, the
 * guard, the panel — and the wrong double for proving that a repair picked a
 * *feasible* replacement, because a fake cannot pick anything. So this is the
 * other kind of fixture: a small, honest, fully deterministic implementation of
 * the nine engine functions. It knows no swaps, holds no table of
 * `old place -> new place`, and has never heard of the test cases below.
 *
 * It is a *fixture*, not a second planner:
 *  - it lives in `__tests__` and nothing in `src/` imports it;
 *  - `src/engine/**` is Abhijit's path (TASKS.md ownership table) and is
 *    unwritten, so this stands in for the module under test rather than
 *    competing with it;
 *  - every number it produces is derived from the catalogue and the context, so a
 *    test that changes a constraint and sees a different plan is watching the
 *    pipeline work, not a fixture answering.
 *
 * What "actually decides" means here, function by function:
 *  - `filterFeasible` runs hard checks and emits a real `Rejection` per failure,
 *    including the walking limit that `context.ts` lowers the `walking`
 *    preference into. This is the only thing in the repo that reads those tokens.
 *  - `score` is a weighted sum over the `WeightProfile` handed to it, with the
 *    profile's own keys read, so a changed preference changes the ranking.
 *  - `pack` is a greedy time-feasible fill from `ctx.nowMin` against
 *    `ctx.availableMin` and `ctx.budget`, so a shorter window packs fewer stops.
 *  - `validate` recomputes cost and distance from the plan's own contents and
 *    rejects on any mismatch, so it can contradict the packer.
 *  - `replan` keeps every stop in `ctx.pinnedIds`, at the times it already had,
 *    then re-runs retrieve -> filter -> score -> pack for what is left. That is
 *    the whole of "replan only the remaining portion", and it belongs here and
 *    not in the feature, because only the engine holds the previous plan.
 *
 * `createdAt` comes from `ctx.nowMin`, not `new Date()`, so two runs of the same
 * test produce byte-identical plans.
 */
import {
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type GeoPoint,
  type Money,
  type Plan,
  type PlanStop,
  type Rejection,
  type RejectionCode,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type Swap,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
  Plan as PlanSchema,
} from "../../../contracts";
import { INDOOR_TOKEN, WALK_TOKENS } from "../context";
import type { EnginePort, TravelMode } from "../engine";

const ENGINE_VERSION = "fixture-deterministic-1";
const BAD_WEATHER = new Set(["heavy_rain", "storm"]);

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

const EARTH_M = 6_371_000;

/** Great-circle metres. This stands in for the routing table, nothing more. */
export function metresBetween(from: GeoPoint, to: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a))));
}

/** m/min by mode. Walking is deliberately the slowest, which is the point. */
const SPEED_M_PER_MIN: Record<TravelMode, number> = {
  walk: 75,
  auto: 320,
  transit: 260,
  ferry: 400,
};

/** `travelMode` includes "any", which is not a leg. The same map `diff.ts` uses. */
export const LEG_MODE: Record<DiscoveryContext["travelMode"], TravelMode> = {
  walk: "walk",
  auto: "auto",
  transit: "transit",
  any: "auto",
};

const ORIGIN: GeoPoint = { lat: 19.0, lon: 72.87 };

export function legBetween(
  from: GeoPoint,
  to: GeoPoint,
  mode: TravelMode,
  fromId: string,
  toId: string,
): TravelLeg {
  const metres = metresBetween(from, to);
  return {
    fromId,
    toId,
    mode,
    minutes: Math.max(1, Math.round(metres / SPEED_M_PER_MIN[mode])),
    metres,
    detail: null,
    estimated: true,
  };
}

const travelBetween = (from: GeoPoint, to: GeoPoint, mode: TravelMode): TravelLeg =>
  legBetween(from, to, mode, "from", "to");

// ---------------------------------------------------------------------------
// Walking budget, read back out of the tokens `context.ts` lowers into `avoid`
// ---------------------------------------------------------------------------

/**
 * How far one stop may sit from the one before it, from the walking token in the
 * context. This is the engine's half of the `walking` preference: the feature
 * writes the token and this is the only thing in the repo that can act on it.
 * `Infinity` when the traveller did not say anything about walking.
 */
export function walkLimitPerLeg(ctx: DiscoveryContext): number {
  if (ctx.avoid.includes(WALK_TOKENS.minimal)) return 500;
  if (ctx.avoid.includes(WALK_TOKENS.low)) return 1200;
  return Number.POSITIVE_INFINITY;
}

const indoorsOnly = (ctx: DiscoveryContext): boolean => ctx.avoid.includes(INDOOR_TOKEN);

// ---------------------------------------------------------------------------
// Feasibility
// ---------------------------------------------------------------------------

function reject(
  id: string,
  code: RejectionCode,
  message: string,
  shortfall: number | null = null,
  unit: Rejection["unit"] = null,
): Rejection {
  return { experienceId: id, code, message, shortfall, unit, relaxable: code !== "sold_out" };
}

/**
 * Hard gate. Every survivor it drops gets a rejection, because "why not that" is
 * the product. The order is fixed, so the same catalogue always produces the same
 * first failure and a test can assert on the message.
 *
 * `from` is the last place already accepted, so the walking limit is measured
 * against a real neighbour rather than against the centre of the city. That is
 * what turns the check into a nearest-neighbour constraint instead of a radius.
 */
export function check(
  ctx: DiscoveryContext,
  item: Experience,
  from: GeoPoint | null,
): Rejection | null {
  const limit = walkLimitPerLeg(ctx);
  const walkMetres = from === null ? 0 : metresBetween(from, item.location);

  if (ctx.excludedIds.includes(item.id)) {
    return reject(item.id, "excluded_by_traveller", `${item.name} is off the list.`);
  }
  if (ctx.accessNeeds.includes("wheelchair") && item.accessibility.stepFree === false) {
    return reject(item.id, "not_step_free", `${item.name} has steps, and we said step-free.`);
  }
  if (ctx.accessNeeds.includes("lowStairs") && item.accessibility.lowStairs === false) {
    return reject(item.id, "no_low_stairs", `${item.name} is up stairs.`);
  }
  if (ctx.accessNeeds.includes("restroom") && item.accessibility.restroomOnSite === false) {
    return reject(item.id, "no_restroom", `${item.name} has no restroom on site.`);
  }
  if (ctx.accessNeeds.includes("hearingLoop") && item.accessibility.hearingLoop === false) {
    return reject(item.id, "no_hearing_loop", `${item.name} has no hearing loop.`);
  }
  if (item.minAge !== null && ctx.partySize < item.minAge) {
    return reject(item.id, "inaccessible", `${item.name} is not for a group of ${ctx.partySize}.`);
  }
  if (item.capacity !== null && ctx.partySize > item.capacity) {
    return reject(
      item.id,
      "capacity_exceeded",
      `${item.name} seats ${item.capacity} and we are ${ctx.partySize}.`,
      ctx.partySize - item.capacity,
      "people",
    );
  }
  if (indoorsOnly(ctx) && item.indoorOutdoor === "outdoor") {
    return reject(item.id, "excluded_by_traveller", `${item.name} is outside, and we said indoors only.`);
  }
  if (
    BAD_WEATHER.has(ctx.weather.condition) &&
    item.weatherSensitive !== "none" &&
    item.indoorOutdoor === "outdoor"
  ) {
    return reject(
      item.id,
      "weather_unsafe",
      `${ctx.weather.condition.replace("_", " ")} and ${item.name} has no cover.`,
    );
  }
  if (from !== null && walkMetres > limit) {
    return reject(
      item.id,
      "too_far",
      `${item.name} is ${walkMetres} m from the last stop, over the ${limit} m walking limit.`,
      walkMetres - limit,
      "metres",
    );
  }
  if (item.durationMin > ctx.availableMin) {
    return reject(
      item.id,
      "duration_exceeds_budget",
      `${item.name} needs ${item.durationMin} min and ${ctx.availableMin} min are left.`,
      item.durationMin - ctx.availableMin,
      "minutes",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokensOf(item: Experience): string[] {
  return [item.category, ...item.keywords, ...item.cuisines, ...item.diets, ...item.perception.activities]
    .map((token) => token.toLowerCase());
}

/** How many of the traveller's interests this place speaks to, 0..1. */
export function interestHit(ctx: DiscoveryContext, item: Experience): number {
  if (ctx.interests.length === 0) return 0.5;
  const tokens = new Set(tokensOf(item));
  const hits = ctx.interests.filter((interest) => tokens.has(interest.toLowerCase())).length;
  return Math.min(1, hits / Math.min(2, ctx.interests.length));
}

export function minutesFromOrigin(ctx: DiscoveryContext, item: Experience): number {
  return travelBetween(ctx.origin.point ?? ORIGIN, item.location, LEG_MODE[ctx.travelMode]).minutes;
}

/**
 * A weighted sum over the profile's own keys, so the weight profile is load-bearing
 * rather than decorative. A key the profile does not carry scores nothing; this
 * never invents a default weight.
 */
export function scoreOf(ctx: DiscoveryContext, item: Experience, weights: WeightProfile): ScoreBreakdown {
  const w = weights.weights;
  const minutes = minutesFromOrigin(ctx, item);
  const avoided = ctx.avoid.filter((token) => tokensOf(item).includes(token)).length;
  const parts = [
    { key: "interest", label: "Matches what you asked for", value: interestHit(ctx, item), weight: w.interest ?? 0 },
    { key: "proximity", label: `${minutes} min from where you are`, value: 1 / (1 + minutes / 15), weight: w.proximity ?? 0 },
    { key: "rating", label: `Rated ${item.rating.value}`, value: item.rating.value / 5, weight: w.rating ?? 0 },
    { key: "avoided", label: "Something you said to avoid", value: -avoided, weight: 1 },
  ];
  return {
    experienceId: item.id,
    total: Math.round(parts.reduce((sum, part) => sum + part.value * part.weight, 0) * 1000) / 1000,
    components: parts.map((part) => ({ ...part })),
    profileVersion: weights.version,
    learnedComponents: weights.source === "learned" ? ["proximity"] : [],
  };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const rupees = (minor: number): Money => ({ minor: Math.max(0, Math.round(minor)), currency: "INR" });

/** Deterministic timestamp. `new Date()` would make every run unreproducible. */
function stampOf(ctx: DiscoveryContext): string {
  const hours = Math.floor(ctx.nowMin / 60) % 24;
  return new Date(Date.UTC(2026, 0, 1, hours, ctx.nowMin % 60)).toISOString();
}

function fitOf(ctx: DiscoveryContext, item: Experience, travelMin: number): Fit {
  const activityMin = item.durationMin;
  const bufferMin = 5;
  const totalMin = travelMin + activityMin + bufferMin;
  const cost = rupees((item.pricePerPerson?.minor ?? 0) * ctx.partySize);
  const fitRatio = ctx.availableMin === 0 ? 0 : totalMin / ctx.availableMin;
  return {
    experienceId: item.id,
    travelMin,
    activityMin,
    bufferMin,
    totalMin,
    availableMin: ctx.availableMin,
    fitRatio: Math.round(fitRatio * 1000) / 1000,
    cost,
    budget: ctx.budget,
    checks: [
      {
        label: "Fits the time you have left",
        pass: activityMin + travelMin <= ctx.availableMin,
        detail: `${activityMin} min on site, ${travelMin} min to get there, ${ctx.availableMin} min left.`,
      },
      {
        label: "Inside budget",
        pass: ctx.budget === null || cost.minor <= ctx.budget.minor,
        detail: `${cost.minor} paise of ${ctx.budget?.minor ?? "no ceiling"}.`,
      },
    ],
    verdict: fitRatio <= 0.75 ? "fits" : fitRatio <= 1 ? "tight" : "does_not_fit",
  };
}

/**
 * A sit-down between stops. Not decoration: a day of consecutive stops with no
 * break in it is not a day anybody can do, and the plan has to say when the break
 * is. It is also what stops `Plan.stops` from being one unbroken block, which is
 * the difference between a plan and a queue.
 */
export const REST_MIN = 30;

/**
 * Greedy fill, in the order it is handed. A candidate that does not fit the
 * window or the budget is skipped and the walk carries on to the next one, so a
 * shorter window gives a shorter day rather than a different day. Every skip
 * leaves a `Rejection` behind: `Plan.rejected` is "everything that did not make
 * it, with reasons", and a stop that vanished silently is exactly the bug that
 * field exists to prevent.
 */
export function packStops(
  ctx: DiscoveryContext,
  ordered: readonly Experience[],
  weights: WeightProfile,
): { stops: PlanStop[]; legs: TravelLeg[]; rejected: Rejection[] } {
  const mode = LEG_MODE[ctx.travelMode];
  const ceiling = ctx.budget?.minor ?? Number.POSITIVE_INFINITY;
  const stops: PlanStop[] = [];
  const legs: TravelLeg[] = [];
  const rejected: Rejection[] = [];

  let cursor = ctx.nowMin;
  let hereId = "origin";
  let here: GeoPoint = ctx.origin.point ?? ORIGIN;
  let spend = 0;

  for (const item of ordered) {
    const travel = legBetween(here, item.location, mode, hereId, item.id);
    const arrive = cursor + travel.minutes;
    const depart = arrive + item.durationMin;
    const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;

    if (depart - ctx.nowMin > ctx.availableMin) {
      rejected.push(
        reject(
          item.id,
          "duration_exceeds_budget",
          `${item.name} would end ${depart - ctx.availableMin} min after you have to leave.`,
          depart - ctx.nowMin - ctx.availableMin,
          "minutes",
        ),
      );
      continue;
    }
    if (spend + cost > ceiling) {
      rejected.push(
        reject(
          item.id,
          "over_budget",
          `${item.name} costs ${cost} paise for ${ctx.partySize}, over the ${ceiling} left.`,
          spend + cost - ceiling,
          "minor_units",
        ),
      );
      continue;
    }

    const score = scoreOf(ctx, item, weights);
    stops.push({
      experienceId: item.id,
      arriveMin: arrive,
      departMin: depart,
      fit: fitOf(ctx, item, travel.minutes),
      score,
      why: [score.components.find((part) => part.key === "interest")?.label ?? `Rated ${item.rating.value}.`],
      order: stops.length,
    });
    legs.push(travel);
    // The break belongs to the day, so it is charged to the day.
    cursor = depart + REST_MIN;
    hereId = item.id;
    here = item.location;
    spend += cost;
  }
  return { stops, legs, rejected };
}

export function measureStress(
  plan: Pick<Plan, "stops" | "legs" | "utilisation">,
  ctx: DiscoveryContext,
): { score: number; factors: Plan["stressFactors"] } {
  const hops = Math.max(1, plan.stops.length - 1);
  const rides = plan.legs.filter((item) => item.mode !== "walk").length;
  const factors: Plan["stressFactors"] = [
    {
      dimension: "utilisation",
      weight: 0.4,
      value: plan.utilisation,
      rescue: plan.utilisation > 0.9 ? "Drop the lowest-scoring stop." : null,
    },
    {
      dimension: "transfers",
      weight: 0.35,
      value: rides / hops,
      rescue: hops > 2 ? "Move the stops into one cluster." : null,
    },
    {
      dimension: "walking",
      weight: 0.25,
      value: ctx.travelMode === "walk" ? 1 : 0,
      rescue: null,
    },
  ];
  const score = Math.max(
    0,
    Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.value * f.weight * 100, 0))),
  );
  return { score, factors };
}

function buildPlan(
  ctx: DiscoveryContext,
  stops: readonly PlanStop[],
  legs: readonly TravelLeg[],
  rejected: readonly Rejection[],
): Plan {
  const last = stops.at(-1)?.departMin ?? ctx.nowMin;
  const totalMin = Math.max(0, last - ctx.nowMin);
  const draft = PlanSchema.parse({
    id: `plan-${ctx.id}-${ctx.nowMin}`,
    contextId: ctx.id,
    stops: [...stops],
    legs: [...legs],
    totalMin,
    totalCost: rupees(stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0)),
    utilisation: ctx.availableMin === 0 ? 0 : Math.round((totalMin / ctx.availableMin) * 1000) / 1000,
    totalMetres: legs.reduce((sum, item) => sum + item.metres, 0),
    rejected: [...rejected],
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: stampOf(ctx),
    engineVersion: ENGINE_VERSION,
  });
  const { score, factors } = measureStress(draft, ctx);
  return PlanSchema.parse({ ...draft, stressScore: score, stressFactors: factors });
}

// ---------------------------------------------------------------------------
// Validation — recompute, then compare
// ---------------------------------------------------------------------------

/**
 * Independent recompute, in the spirit of `docs/ARCHITECTURE.md` §7: the plan is
 * checked against its own contents, not against the packer's word. It can and
 * does contradict `pack`, which is the only way a guard is worth anything.
 * Everything here is computable from the `Plan` alone, because
 * `EnginePort.validate` is handed nothing else.
 */
export function validatePlan(plan: Plan): ValidationResult {
  const violations: ValidationResult["violations"] = [];
  const seen = new Set<string>();

  plan.stops.forEach((stop, index) => {
    if (seen.has(stop.experienceId)) {
      violations.push({
        code: "duplicate",
        message: `${stop.experienceId} is in the plan twice.`,
        at: stop.experienceId,
      });
    }
    seen.add(stop.experienceId);
    if (stop.order !== index) {
      violations.push({
        code: "order_mismatch",
        message: `Stop ${index} claims order ${stop.order}.`,
        at: stop.experienceId,
      });
    }
    if (stop.departMin < stop.arriveMin) {
      violations.push({
        code: "negative_dwell",
        message: `${stop.experienceId} leaves before it arrives.`,
        at: stop.experienceId,
      });
    }
  });

  const cost = plan.stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
  if (cost !== plan.totalCost.minor) {
    violations.push({
      code: "cost_mismatch",
      message: `The stops cost ${cost} paise; the plan claims ${plan.totalCost.minor}.`,
      at: null,
    });
  }
  const metres = plan.legs.reduce((sum, item) => sum + item.metres, 0);
  if (metres !== plan.totalMetres) {
    violations.push({
      code: "metres_mismatch",
      message: `The legs cover ${metres} m; the plan claims ${plan.totalMetres} m.`,
      at: null,
    });
  }
  for (const item of plan.legs) {
    if (!seen.has(item.toId)) {
      violations.push({
        code: "leg_dangling",
        message: `A leg arrives at ${item.toId}, which is not in the plan.`,
        at: item.toId,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    recomputedObjective: null,
    claimedObjective: null,
    objectiveDelta: 0,
  };
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type FixtureOptions = {
  /** The rows `retrieve` draws from. `EnginePort.replan` gets no catalogue. */
  catalogue: readonly Experience[];
  weights: WeightProfile;
  limit?: number;
};

export function deterministicEngine(options: FixtureOptions): EnginePort {
  const { weights } = options;
  const limit = options.limit ?? 120;

  const retrieve = (input: RetrieveInput): Experience[] =>
    [...input.catalogue]
      .filter((item) => !input.context.excludedIds.includes(item.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, input.limit || limit);

  const filterFeasible = (ctx: DiscoveryContext, items: Experience[]): FeasibleResult => {
    const passed: string[] = [];
    const rejected: Rejection[] = [];
    let here: GeoPoint | null = ctx.origin.point ?? ORIGIN;
    for (const item of items) {
      const failure = check(ctx, item, ctx.pinnedIds.includes(item.id) ? null : here);
      if (failure) {
        rejected.push(failure);
        continue;
      }
      passed.push(item.id);
      here = item.location;
    }
    return { passed, rejected };
  };

  const score = (ctx: DiscoveryContext, items: Experience[]): ScoreBreakdown[] =>
    items.map((item) => scoreOf(ctx, item, weights));

  /** The documented order, in one place, so `discover` and `replan` cannot drift. */
  const solve = (ctx: DiscoveryContext, catalogue: readonly Experience[], taken: readonly string[]) => {
    const shortlist = retrieve({ context: ctx, catalogue: [...catalogue], limit });
    const byId = new Map(shortlist.map((item) => [item.id, item]));
    const feasible = filterFeasible(ctx, shortlist);
    const items = feasible.passed
      .map((id) => byId.get(id))
      .filter((item): item is Experience => item !== undefined);
    const rank = new Map(score(ctx, items).map((entry) => [entry.experienceId, entry.total]));
    const ordered = [...items]
      .filter((item) => !taken.includes(item.id))
      .sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.id.localeCompare(b.id));
    return { ordered, rejected: feasible.rejected };
  };

  const pack = (ctx: DiscoveryContext, ordered: Experience[]): Plan => {
    const { stops, legs, rejected } = packStops(ctx, ordered, weights);
    return buildPlan(ctx, stops, legs, rejected);
  };

  /**
   * Keep everything pinned, at the times it already had, and re-solve the rest
   * from where the day has actually got to. The residual context keeps the same
   * `id`, so the plan it returns still belongs to this trip and passes `admit`.
   */
  const replan = (prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult => {
    const held = prev.stops
      .filter((stop) => ctx.pinnedIds.includes(stop.experienceId))
      .sort((a, b) => a.order - b.order);
    const from = Math.max(ctx.nowMin, held.at(-1)?.departMin ?? ctx.nowMin);
    const residual: DiscoveryContext = {
      ...ctx,
      nowMin: from,
      availableMin: Math.max(1, ctx.availableMin - (from - ctx.nowMin)),
      pinnedIds: [],
    };

    const taken = held.map((stop) => stop.experienceId);
    const { ordered, rejected } = solve(residual, options.catalogue, taken);
    const suffix = packStops(residual, ordered, weights);

    const stops = [...held, ...suffix.stops].map((stop, index) => ({ ...stop, order: index }));
    const legs = [
      ...prev.legs.filter((item) => taken.includes(item.toId)),
      ...suffix.legs,
    ];
    const kept = new Set(stops.map((stop) => stop.experienceId));
    // Anything the traveller took off the list is the engine's account to record,
    // because `retrieve` is where it happened and that has no rejection channel.
    const dropped: Rejection[] = options.catalogue
      .filter((item) => ctx.excludedIds.includes(item.id) && !kept.has(item.id))
      .map((item) => reject(item.id, "excluded_by_traveller", `${item.name} is off the list.`));
    // Only this re-solve's account. A shortfall measured against the old window
    // is not a shortfall against this one, and a repaired plan that quotes it
    // would be quoting a number nobody can re-derive.
    const plan = buildPlan(ctx, stops, legs, [
      ...rejected,
      ...suffix.rejected,
      ...dropped,
    ]);

    const after = new Set(kept);
    const before = new Set(prev.stops.map((stop) => stop.experienceId));
    const swaps: Swap[] = [
      ...prev.stops
        .filter((stop) => !after.has(stop.experienceId))
        .map((stop) => ({
          removedId: stop.experienceId,
          addedId: null,
          reason: plan.rejected.find((entry) => entry.experienceId === stop.experienceId)?.message ?? change.narrative,
          scoreDelta: -stop.score.total,
        })),
      ...stops
        .filter((stop) => !before.has(stop.experienceId))
        .map((stop) => ({
          removedId: null,
          addedId: stop.experienceId,
          reason: stop.why[0] ?? change.narrative,
          scoreDelta: stop.score.total,
        })),
    ];

    return { plan, change, swaps, preservedIntent: true, summary: change.narrative };
  };

  return {
    retrieve,
    filterFeasible,
    score,
    pack,
    validate: validatePlan,
    replan,
    computeFit(ctx, item) {
      return fitOf(ctx, item, travelBetween(ctx.origin.point ?? ORIGIN, item.location, LEG_MODE[ctx.travelMode]).minutes);
    },
    stress(plan, ctx) {
      return measureStress(plan, ctx);
    },
    travelBetween,
  };
}
