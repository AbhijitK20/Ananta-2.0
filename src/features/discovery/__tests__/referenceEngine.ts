/**
 * A reference implementation of the engine port, for tests that need to see a
 * plan CHANGE rather than assert that a fake was handed a different canned plan.
 *
 * `src/engine/**` belongs to another stream (TASKS.md Rule 2: build against the
 * contract and stub it, do not create the file in their directory), and it is not
 * in the tree yet. The stub in `__tests__/fixtures.ts` cannot prove the thing this
 * feature has to prove: that a sentence changes what the planner does. So this is
 * a real, if small, planner over the frozen contract — retrieve, gate, score,
 * pack, validate, replan — deterministic, no I/O, no `Date`, and reading every
 * constraint the copilot can move: the window, the budget, `partySize`, the
 * weather condition, `accessNeeds`, and the `indoors_only` / `prefers_*_walks`
 * tokens the editor lowers preferences into.
 *
 * When the real engine lands it replaces this file and the copilot tests keep
 * working: they assert on `DiscoveryContext`, `Plan` and the `EnginePort`
 * signature, none of which this file gets to define.
 */
import {
  Plan,
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type GeoPoint,
  type Money,
  type Rejection,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type ScoreComponent,
  type Swap,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
  type WeatherNow,
} from "../../../contracts";
import type { EnginePort, TravelMode } from "../engine";

/** Fixed, so a plan built twice from the same context is byte-identical. */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const ENGINE_VERSION = "reference-1";
/** Packing slack, so a plan is not knife-edge. */
const BUFFER_MIN = 5;
const SPEED_M_PER_MIN: Record<TravelMode, number> = { walk: 80, auto: 220, transit: 300, ferry: 300 };
const WET: WeatherNow["condition"][] = ["light_rain", "heavy_rain", "storm"];

const rupees = (minor: number): Money => ({ minor, currency: "INR" });

/** Call counts, so a test can prove the planner ran rather than being bypassed. */
export type ReferenceEngine = EnginePort & {
  calls: { retrieve: number; filter: number; score: number; pack: number; validate: number; replan: number };
};

function metres(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

const here = (ctx: DiscoveryContext): GeoPoint => ctx.origin.point ?? { lat: 19.0, lon: 72.87 };

/** `travelMode: "any"` walks, which is the cheapest mode we can honestly cost. */
const modeFor = (ctx: DiscoveryContext): TravelMode => (ctx.travelMode === "any" ? "walk" : ctx.travelMode);

const speedFor = (ctx: DiscoveryContext): number => SPEED_M_PER_MIN[modeFor(ctx)];

/** The editor lowers a preference into an `avoid` token; this is the other half. */
const indoorOnly = (ctx: DiscoveryContext): boolean => ctx.avoid.includes("indoors_only");

function walkCeiling(ctx: DiscoveryContext): number {
  if (ctx.avoid.includes("prefers_no_walks")) return 700;
  if (ctx.avoid.includes("prefers_short_walks")) return 1_600;
  return Number.POSITIVE_INFINITY;
}

/** Everything a stop is "about", in the engine's own retrieval vocabulary. */
function signalsOf(item: Experience): string {
  const norm = (value: string): string => value.toLowerCase().replace(/[\s-]+/g, "_");
  return [
    norm(item.category),
    norm(item.name),
    norm(item.blurb ?? ""),
    norm(item.neighbourhood ?? ""),
    ...item.keywords.map(norm),
    ...item.cuisines.map(norm),
    ...item.diets.map(norm),
    ...item.perception.landscape.map(norm),
    ...item.perception.activities.map(norm),
    ...item.perception.atmosphere.map(norm),
  ].join(" ");
}

/** "culture" matches "cultural"; a substring either way round is the whole rule. */
function interestHits(item: Experience, interests: readonly string[]): string[] {
  const signals = signalsOf(item);
  return interests.filter((interest) => {
    const needle = interest.toLowerCase().replace(/[\s-]+/g, "_");
    return needle.length > 0 && signals.includes(needle);
  });
}

function weatherUnsafe(ctx: DiscoveryContext, item: Experience): boolean {
  if (item.indoorOutdoor !== "outdoor") return false;
  const condition = ctx.weather.condition;
  if (WET.includes(condition) && ["rain", "any"].includes(item.weatherSensitive)) return true;
  if (condition === "heat" && ["heat", "any"].includes(item.weatherSensitive)) return true;
  if (condition === "wind" && ["wind", "any"].includes(item.weatherSensitive)) return true;
  return false;
}

/** Every hard check, each emitting a `Rejection` with a real number in it. */
function gate(ctx: DiscoveryContext, item: Experience): Rejection[] {
  const out: Rejection[] = [];
  const reject = (
    code: Rejection["code"],
    message: string,
    shortfall: number | null = null,
    unit: Rejection["unit"] = null,
  ): void => {
    out.push({ experienceId: item.id, code, message, shortfall, unit, relaxable: false });
  };
  const travelMin = Math.round(metres(here(ctx), item.location) / speedFor(ctx));
  const price = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;

  if (ctx.excludedIds.includes(item.id)) reject("excluded_by_traveller", "You ruled this one out.");
  if (item.capacity !== null && ctx.partySize > item.capacity) {
    reject("capacity_exceeded", `Seats ${item.capacity}, and you are ${ctx.partySize}.`, item.capacity, "people");
  }
  // The contract's accessibility fields are 3-state, so a null is not a yes.
  if (ctx.accessNeeds.includes("wheelchair") && item.accessibility.stepFree !== true) {
    reject("not_step_free", "No step-free way in.");
  }
  if (ctx.accessNeeds.includes("stroller") && item.accessibility.strollerOk !== true) {
    reject("not_stroller_ok", "Not usable with a stroller.");
  }
  if (ctx.accessNeeds.includes("lowStairs") && item.accessibility.lowStairs !== true) {
    reject("no_low_stairs", "Too many stairs for the group.");
  }
  if (ctx.accessNeeds.includes("hearingLoop") && item.accessibility.hearingLoop !== true) {
    reject("no_hearing_loop", "No hearing loop here.");
  }
  if (ctx.accessNeeds.includes("restroom") && item.accessibility.restroomOnSite !== true) {
    reject("no_restroom", "No restroom on site.");
  }
  if (weatherUnsafe(ctx, item)) {
    reject("weather_unsafe", `${ctx.weather.condition.replace(/_/g, " ")} out there, and this one has no cover.`);
  }
  if (indoorOnly(ctx) && item.indoorOutdoor === "outdoor") {
    reject("excluded_by_traveller", "You asked to stay indoors, and this one is outside.");
  }
  if (ctx.budget !== null && price > ctx.budget.minor) {
    reject("over_budget", `Over budget by ₹${Math.round((price - ctx.budget.minor) / 100)}.`, price - ctx.budget.minor, "minor_units");
  }
  const walk = travelMin * speedFor(ctx);
  const ceiling = walkCeiling(ctx);
  if (walk > ceiling) {
    reject(
      "too_far",
      `${travelMin} min from where you are, and you asked for short walks.`,
      walk - ceiling,
      "metres",
    );
  }
  const need = travelMin + item.durationMin + BUFFER_MIN;
  if (need > ctx.availableMin) {
    reject(
      "duration_exceeds_budget",
      `Needs ${need - ctx.availableMin} min more than you have left.`,
      need - ctx.availableMin,
      "minutes",
    );
  }
  return out;
}

const component = (key: string, label: string, value: number, weight: number, reason: string): ScoreComponent => ({
  key,
  label,
  value,
  weight,
  reason,
});

function scoreOne(ctx: DiscoveryContext, item: Experience, weights: WeightProfile): ScoreBreakdown {
  const hits = interestHits(item, ctx.interests);
  const distance = metres(here(ctx), item.location);
  const components = [
    component("interest", "Matches what you asked for", hits.length * 1.5, weights.weights.interest ?? 1, hits.join(", ") || "nothing you named"),
    component("proximity", "Close by", Math.max(0, 3 - distance / 1_500), weights.weights.proximity ?? 1, `${Math.round(distance / 100) / 10} km away`),
    component("rating", "Well reviewed", item.rating.value, weights.weights.rating ?? 0.5, `${item.rating.value} from ${item.rating.count} reviews`),
  ];
  return {
    experienceId: item.id,
    total: components.reduce((sum, part) => sum + part.value * part.weight, 0),
    components,
    profileVersion: weights.version,
    learnedComponents: [],
  };
}

/** Greedy fill in the order the caller passed, which the caller scores first. */
function packWith(
  ctx: DiscoveryContext,
  ordered: readonly Experience[],
  weights: WeightProfile,
  priorRejections: readonly Rejection[],
): Plan {
  const mode = modeFor(ctx);
  const speed = speedFor(ctx);
  const stops: Plan["stops"] = [];
  const legs: TravelLeg[] = [];
  const rejected: Rejection[] = [...priorRejections];
  const used = new Set<string>();
  let remaining = ctx.availableMin;
  let cursor = ctx.nowMin;
  let cost = 0;
  let walked = 0;
  let from = here(ctx);
  let previousId: string | null = null;

  for (const item of ordered) {
    if (used.has(item.id) || ctx.pinnedIds.includes(item.id)) continue;
    const distance = metres(from, item.location);
    const travelMin = Math.round(distance / speed);
    const need = travelMin + item.durationMin + BUFFER_MIN;
    const price = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;

    if (need > remaining) {
      rejected.push({
        experienceId: item.id,
        code: "duration_exceeds_budget",
        message: `Needs ${need - remaining} min more than you have left.`,
        shortfall: need - remaining,
        unit: "minutes",
        relaxable: true,
      });
      continue;
    }
    if (ctx.budget !== null && cost + price > ctx.budget.minor) {
      rejected.push({
        experienceId: item.id,
        code: "over_budget",
        message: `Over budget by ₹${Math.round((cost + price - ctx.budget.minor) / 100)}.`,
        shortfall: cost + price - ctx.budget.minor,
        unit: "minor_units",
        relaxable: true,
      });
      continue;
    }

    const arriveMin = cursor + travelMin;
    const score = scoreOne(ctx, item, weights);
    const withinBudget = ctx.budget === null || cost + price <= ctx.budget.minor;
    stops.push({
      experienceId: item.id,
      arriveMin,
      departMin: arriveMin + item.durationMin,
      order: stops.length,
      fit: {
        experienceId: item.id,
        travelMin,
        activityMin: item.durationMin,
        bufferMin: BUFFER_MIN,
        totalMin: need,
        availableMin: remaining,
        fitRatio: need / Math.max(1, remaining),
        cost: rupees(price),
        budget: ctx.budget,
        checks: [
          { label: "Fits your window", pass: true, detail: `${travelMin} min travel, ${item.durationMin} min on site.` },
          { label: "Fits your budget", pass: withinBudget, detail: `₹${Math.round(price / 100)} for ${ctx.partySize}.` },
        ],
        verdict: need <= remaining ? "fits" : "does_not_fit",
      },
      score,
      why: [
        `${(score.components[0]?.reason as string) || "Close by"}.`,
        `${travelMin} min ${previousId === null ? "from where you are" : "from the last stop"}.`,
      ],
    });
    if (previousId !== null) {
      legs.push({ fromId: previousId, toId: item.id, mode, minutes: travelMin, metres: distance, detail: null, estimated: true });
    }
    previousId = item.id;
    used.add(item.id);
    cost += price;
    walked += distance;
    remaining -= need;
    cursor = arriveMin + item.durationMin;
    from = item.location;
  }

  const totalMin = Math.max(0, cursor - ctx.nowMin);
  return Plan.parse({
    id: `plan-${ctx.id}`,
    contextId: ctx.id,
    stops,
    legs,
    totalMin,
    totalCost: rupees(cost),
    utilisation: totalMin / ctx.availableMin,
    totalMetres: walked,
    rejected,
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: CREATED_AT,
    engineVersion: ENGINE_VERSION,
  });
}

export function referenceEngine(catalogue: readonly Experience[], weights: WeightProfile): ReferenceEngine {
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const calls = { retrieve: 0, filter: 0, score: 0, pack: 0, validate: 0, replan: 0 };

  const doRetrieve = (input: RetrieveInput): Experience[] => {
    calls.retrieve += 1;
    return input.catalogue.slice(0, input.limit);
  };

  const doFilter = (ctx: DiscoveryContext, items: Experience[]): FeasibleResult => {
    calls.filter += 1;
    const passed: string[] = [];
    const rejected: Rejection[] = [];
    for (const item of items) {
      const failures = gate(ctx, item);
      if (failures.length === 0) passed.push(item.id);
      else rejected.push(...failures);
    }
    return { passed, rejected };
  };

  const doScore = (ctx: DiscoveryContext, items: Experience[]): ScoreBreakdown[] => {
    calls.score += 1;
    return items.map((item) => scoreOne(ctx, item, weights));
  };

  const doPack = (ctx: DiscoveryContext, items: Experience[]): Plan => {
    calls.pack += 1;
    return packWith(ctx, items, weights, []);
  };

  /** The full pipeline, in the order `discover` uses. `replan` goes through this. */
  const solve = (ctx: DiscoveryContext): Plan => {
    const shortlist = doRetrieve({ context: ctx, catalogue: [...catalogue], limit: 120 });
    const feasible = doFilter(ctx, shortlist);
    const index = new Map(shortlist.map((item) => [item.id, item]));
    const items = feasible.passed
      .map((id) => index.get(id))
      .filter((item): item is Experience => item !== undefined);
    const rank = new Map(doScore(ctx, items).map((entry) => [entry.experienceId, entry.total]));
    const ordered = [...items].sort(
      (a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.id.localeCompare(b.id),
    );
    const packed = doPack(ctx, ordered);
    // The gate's own rejections belong to the plan, or "why not this" is empty.
    return Plan.parse({ ...packed, rejected: [...packed.rejected, ...feasible.rejected] });
  };

  return {
    calls,
    retrieve: doRetrieve,
    filterFeasible: doFilter,
    score: doScore,
    pack: doPack,
    /**
     * Independent recomputation, as the contract demands: costs, ordering, fit
     * arithmetic and the window are all re-derived from the plan itself. The
     * objective is the sum of the stop scores. Note the frozen `Plan` carries no
     * objective field, so a packer that lies about its objective shows up in the
     * arithmetic checks above rather than in `objectiveDelta`.
     */
    validate(plan: Plan): ValidationResult {
      calls.validate += 1;
      const violations: ValidationResult["violations"] = [];
      const add = (code: string, message: string, at: string | null = null): void => {
        violations.push({ code, message, at });
      };
      const seen = new Set<string>();
      plan.stops.forEach((stop, index) => {
        if (seen.has(stop.experienceId)) add("duplicate_stop", "Stop appears twice.", stop.experienceId);
        seen.add(stop.experienceId);
        if (stop.order !== index) add("order_drift", "Stops are not in slot order.", stop.experienceId);
        if (stop.arriveMin + stop.fit.activityMin !== stop.departMin) {
          add("timeline_drift", "Departure is not arrival plus time on site.", stop.experienceId);
        }
        if (stop.fit.totalMin !== stop.fit.travelMin + stop.fit.activityMin + stop.fit.bufferMin) {
          add("fit_arithmetic", "Fit does not add up.", stop.experienceId);
        }
        if (stop.fit.verdict === "does_not_fit") {
          add("infeasible_stop", "A stop does not fit the window.", stop.experienceId);
        }
      });
      const cost = plan.stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
      if (cost !== plan.totalCost.minor) add("cost_drift", "Total cost is not the sum of the stops.", null);
      if (plan.legs.length !== Math.max(0, plan.stops.length - 1)) add("leg_drift", "Leg count does not match the stops.", null);
      const window = plan.stops[0]?.fit.availableMin ?? 0;
      if (window > 0 && Math.abs(plan.totalMin / window - plan.utilisation) > 1e-9) {
        add("utilisation_drift", "Utilisation is not total over available.", null);
      }
      const objective = plan.stops.reduce((sum, stop) => sum + stop.score.total, 0);
      return {
        ok: violations.length === 0,
        violations,
        recomputedObjective: objective,
        claimedObjective: objective,
        objectiveDelta: 0,
      };
    },
    replan(prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult {
      calls.replan += 1;
      // The whole pipeline again. There is no path from `change` to a plan here
      // except re-solving against the new context, which is the whole feature.
      const plan = solve(ctx);
      const before = prev.stops.map((stop) => stop.experienceId);
      const after = plan.stops.map((stop) => stop.experienceId);
      const gone = before.filter((id) => !after.includes(id));
      const fresh = after.filter((id) => !before.includes(id));
      const scoreOf = (id: string): number =>
        [...prev.stops, ...plan.stops].find((stop) => stop.experienceId === id)?.score.total ?? 0;
      const swaps: Swap[] = gone.map((removedId, index) => {
        const addedId = fresh[index] ?? null;
        const reason =
          plan.rejected.find((entry) => entry.experienceId === removedId)?.message ??
          (addedId ? "Fits the new constraints better." : "No longer fits.");
        return {
          removedId,
          addedId,
          reason,
          scoreDelta: addedId ? Number((scoreOf(addedId) - scoreOf(removedId)).toFixed(3)) : 0,
        };
      });
      const original = ctx.original;
      const meetsNeed = (need: string, item: Experience | undefined): boolean => {
        if (!item) return false;
        if (need === "wheelchair") return item.accessibility.stepFree === true;
        if (need === "lowStairs") return item.accessibility.lowStairs === true;
        if (need === "restroom") return item.accessibility.restroomOnSite === true;
        if (need === "stroller") return item.accessibility.strollerOk === true;
        return item.accessibility.hearingLoop === true;
      };
      const preservedIntent =
        plan.totalMin <= original.availableMin &&
        (original.budget === null || plan.totalCost.minor <= original.budget.minor) &&
        original.accessNeeds.every((need) => plan.stops.every((stop) => meetsNeed(need, byId.get(stop.experienceId))));
      return {
        plan,
        change,
        swaps,
        preservedIntent,
        summary: `${change.narrative} ${swaps.length} ${swaps.length === 1 ? "swap" : "swaps"}.`,
      };
    },
    computeFit(ctx: DiscoveryContext, item: Experience): Fit {
      const travelMin = Math.round(metres(here(ctx), item.location) / speedFor(ctx));
      const need = travelMin + item.durationMin + BUFFER_MIN;
      return {
        experienceId: item.id,
        travelMin,
        activityMin: item.durationMin,
        bufferMin: BUFFER_MIN,
        totalMin: need,
        availableMin: ctx.availableMin,
        fitRatio: need / Math.max(1, ctx.availableMin),
        cost: rupees((item.pricePerPerson?.minor ?? 0) * ctx.partySize),
        budget: ctx.budget,
        checks: [],
        verdict: need <= ctx.availableMin ? "fits" : "does_not_fit",
      };
    },
    stress(plan: Plan) {
      // Busy-ness of the day: how much of the window is left empty, plus a
      // transfer penalty. Deterministic, and it moves when the window moves.
      const idle = Math.max(0, 1 - plan.utilisation);
      const transfers = Math.max(0, plan.legs.length);
      return {
        score: Math.min(100, Math.round(100 * (0.6 * idle + 0.15 * Math.min(1, transfers / 3)))),
        factors: [
          { dimension: "idle_time", weight: 0.6, value: idle, rescue: idle > 0.3 ? "Add one more stop close by." : null },
          { dimension: "transfers", weight: 0.15, value: Math.min(1, transfers / 3), rescue: null },
        ],
      };
    },
    travelBetween(from: GeoPoint, to: GeoPoint, mode: TravelMode): TravelLeg {
      const distance = metres(from, to);
      return {
        fromId: `${from.lat},${from.lon}`,
        toId: `${to.lat},${to.lon}`,
        mode,
        minutes: Math.round(distance / SPEED_M_PER_MIN[mode]),
        metres: distance,
        detail: null,
        estimated: true,
      };
    },
  };
}
