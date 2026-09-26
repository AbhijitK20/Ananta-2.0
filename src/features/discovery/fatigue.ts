/**
 * Travel load: how much a plan asks of the body, as opposed to how well it fills
 * the window.
 *
 * `Fit` answers "does this stop fit the time left". Nothing in the feature
 * answered "can this group actually do this", so the `walking` preference was
 * inert: `prefers_no_walks` was written into `DiscoveryContext.avoid` and then
 * nothing read it. This file is the reader.
 *
 * Three rules, all load-bearing:
 *
 *  1. **The router is the only source of distance.** Every metre here comes out
 *     of `Plan.legs`, or out of `engine.travelBetween` when a plan arrives
 *     without legs. No haversine, no "assume 12 min per km". If we do not know
 *     how far a leg is we say we do not know, and the report carries a zero
 *     rather than a guess.
 *
 *  2. **Only `mode: "walk"` legs count as walking.** An `auto` leg's `metres`
 *     are driven metres. Counting them would invent a 4 km walk out of a car
 *     trip, which is exactly the kind of decorative number this is meant to
 *     replace.
 *
 *  3. **The budget is derived from the context, not from the plan.** Walking
 *     capacity, longest unbroken block and how many stops can follow each other
 *     all follow from `avoid` tokens, `childAges`, `accessNeeds`, `partySize`
 *     and `availableMin`. Two different parties looking at the same plan get
 *     two different verdicts, which is the whole claim.
 *
 * Consequences, in `replanner.ts` and nowhere else: `packWithinLoad` /
 * `replanWithinLoad` re-solve with the offending stop off the list, and `admit`
 * refuses a plan that is still over budget. So a plan a traveller can be shown
 * is a plan their group can walk.
 */
import type {
  ContextChange,
  DiscoveryContext,
  Experience,
  GeoPoint,
  Plan,
  ReplanResult,
  TravelLeg,
} from "../../contracts";
import { WALK_TOKENS } from "./context";
import type { EnginePort, TravelMode } from "./engine";

/**
 * 70 m/min ≈ 4.2 km/h. Only ever used to turn a window into a distance ceiling
 * ("you have 120 min, so walking is not the binding constraint"). Actual
 * distances still come from the router.
 */
const WALK_M_PER_MIN = 70;

/** What an unremarkable adult covers in a whole day out. The `share` below cuts it. */
const DAY_WALK_M = 6000;

/**
 * A gap at least this long is a sit-down, not a transfer. Below it, the next
 * stop is on the same run and the body does not get a break.
 */
export const REST_GAP_MIN = 30;

/** `DiscoveryContext.travelMode` includes "any"; the router does not. */
const ROUTER_MODE: Record<DiscoveryContext["travelMode"], TravelMode> = {
  walk: "walk",
  auto: "auto",
  transit: "transit",
  any: "auto",
};

export type WalkingTolerance = "any" | "low" | "minimal";

/**
 * Read back out of `avoid`, which is where `context.ts` lowers the editor's
 * `walking` axis. Same tokens, so the slider, the "Everyone is tired" chip and
 * the chat patch all produce the same budget without a second classifier.
 */
export function toleranceOf(ctx: DiscoveryContext): WalkingTolerance {
  if (ctx.avoid.includes(WALK_TOKENS.minimal)) return "minimal";
  if (ctx.avoid.includes(WALK_TOKENS.low)) return "low";
  return "any";
}

type ToleranceTable = {
  /** Share of the daily walking budget. */
  share: number;
  maxConsecutiveStops: number;
  maxBlockMin: number;
  /** A single walk leg longer than this is its own problem, not the day's. */
  maxLegWalkMetres: number;
};

const TOLERANCE: Record<WalkingTolerance, ToleranceTable> = {
  any: { share: 1, maxConsecutiveStops: 6, maxBlockMin: 240, maxLegWalkMetres: 2500 },
  low: { share: 0.6, maxConsecutiveStops: 3, maxBlockMin: 180, maxLegWalkMetres: 800 },
  minimal: { share: 0.25, maxConsecutiveStops: 1, maxBlockMin: 90, maxLegWalkMetres: 400 },
};

/** Access needs that change what a kilometre on foot costs. */
const MOBILITY_NEEDS = new Set(["wheelchair", "stroller", "lowStairs"]);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export type LoadBudget = {
  /** Distance on foot this party can be asked to cover in this window. */
  walkMetres: number;
  maxConsecutiveStops: number;
  /** Longest run of stops with no sit-down, regardless of how many there are. */
  maxBlockMin: number;
  maxLegWalkMetres: number;
  tolerance: WalkingTolerance;
  /** Multiplier on the budget from who is travelling. 1 for a healthy adult. */
  groupFactor: number;
  /**
   * Why the budget is what it is, as `key:value` pairs. This is the audit trail
   * for a plan that was refused: every number in `metrics` is meaningless
   * without the line that produced its ceiling.
   */
  basis: string[];
};

/**
 * Who is travelling, and what a kilometre costs them. A group walks slower than
 * one person, not four times as fast: the constraint is a shared effort with one
 * slowest member, so this is a divisor on the whole party rather than a sum.
 */
function partyLoad(ctx: DiscoveryContext): { factor: number; basis: string[] } {
  const basis: string[] = [];
  let factor = 1;

  const youngest = ctx.childAges.length > 0 ? Math.min(...ctx.childAges) : null;
  if (youngest !== null && youngest < 6) {
    factor *= 0.45;
    basis.push(`child_under_6:${youngest}`);
  } else if (youngest !== null && youngest < 12) {
    factor *= 0.6;
    basis.push(`child_under_12:${youngest}`);
  } else if (youngest !== null) {
    factor *= 0.85;
    basis.push(`teen_in_party:${youngest}`);
  }

  if (ctx.partyType === "older_adults") {
    factor *= 0.55;
    basis.push("party_type:older_adults");
  }
  const mobility = ctx.accessNeeds.filter((need) => MOBILITY_NEEDS.has(need));
  if (mobility.length > 0) {
    factor *= 0.7;
    basis.push(`access_need:${mobility.join("+")}`);
  }
  if (ctx.partySize >= 4) {
    factor *= 0.8;
    basis.push(`party_size:${ctx.partySize}`);
  }
  return { factor: round2(factor), basis };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const km = (metres: number): string => `${round1(metres / 1000)} km`;

export function loadBudget(ctx: DiscoveryContext): LoadBudget {
  const tolerance = toleranceOf(ctx);
  const table = TOLERANCE[tolerance];
  const { factor, basis } = partyLoad(ctx);

  // A window is a hard ceiling on its own: 45 minutes cannot hold a day's walking.
  const windowCap = ctx.availableMin * WALK_M_PER_MIN;
  const personalCap = DAY_WALK_M * table.share;
  const walkMetres = Math.round(Math.min(personalCap, windowCap) * factor);

  // Never demand a break the window has no room for: a 45 min trip is not a
  // 45 min block violation.
  const maxBlockMin = Math.min(table.maxBlockMin, Math.max(60, ctx.availableMin));

  return {
    walkMetres,
    maxConsecutiveStops: table.maxConsecutiveStops,
    maxBlockMin,
    maxLegWalkMetres: table.maxLegWalkMetres,
    tolerance,
    groupFactor: factor,
    basis: [
      // "any" has no token, because it is the absence of a stated limit rather
      // than a limit of its own. Saying so in the evidence keeps the two apart.
      tolerance === "any"
        ? "tolerance:any(no_stated_limit)"
        : `tolerance:${tolerance}(${WALK_TOKENS[tolerance]})`,
      `daily_cap:${Math.round(personalCap)}m`,
      `window_cap:${Math.round(windowCap)}m(${ctx.availableMin}min@${WALK_M_PER_MIN}m/min)`,
      `group_factor:${factor}`,
      ...basis,
    ],
  };
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

/**
 * The legs the plan actually costs you, in order.
 *
 * `Plan.legs` is authoritative when present. When it is absent the legs are
 * rebuilt from the stop coordinates through `engine.travelBetween`, which is the
 * same call `diff.ts` makes — so a plan without legs is still measurable, and
 * with exactly the router's own numbers rather than ours.
 *
 * Two deliberate gaps, both under-counting, both safer than guessing:
 *  - no origin point, so the first leg is reconstructed from the time gap
 *    (`arriveMin - nowMin`) with **zero metres**. Time is real, distance is not.
 *  - no return leg. The plan does not carry one, so the walk home is not in any
 *    budget here. A party that under-walks by one leg is still under walking.
 */
export function legsOf(
  plan: Plan,
  ctx: DiscoveryContext,
  engine: EnginePort,
  catalogue: ReadonlyMap<string, Experience>,
): TravelLeg[] {
  if (plan.legs.length > 0) return [...plan.legs];

  const mode = ROUTER_MODE[ctx.travelMode];
  const legs: TravelLeg[] = [];

  const first = plan.stops[0];
  if (first) {
    const origin = ctx.origin.point;
    legs.push(
      origin
        ? engine.travelBetween(origin, pointOf(first.experienceId, catalogue), mode, ctx.nowMin)
        : {
            fromId: "origin",
            toId: first.experienceId,
            mode,
            minutes: Math.max(0, first.arriveMin - ctx.nowMin),
            metres: 0,
            detail: null,
            estimated: true,
          },
    );
  }

  for (let i = 0; i + 1 < plan.stops.length; i += 1) {
    const from = plan.stops[i];
    const to = plan.stops[i + 1];
    if (!from || !to) continue;
    legs.push(
      engine.travelBetween(
        pointOf(from.experienceId, catalogue),
        pointOf(to.experienceId, catalogue),
        mode,
        from.departMin,
      ),
    );
  }
  return legs;
}

function pointOf(id: string, catalogue: ReadonlyMap<string, Experience>): GeoPoint {
  return catalogue.get(id)?.location ?? { lat: 0, lon: 0 };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type LoadCode =
  | "window_exceeded"
  | "walking_budget_exceeded"
  | "leg_too_long_to_walk"
  | "too_many_back_to_back"
  | "block_too_long_without_rest";

export type LoadViolation = {
  code: LoadCode;
  /** The stop it lands on, or null when it is about the whole plan. */
  at: string | null;
  /** Finished sentence, real numbers in it. Never "exceeds constraints". */
  message: string;
  /** Over the limit by this much, in `unit`. */
  shortfall: number;
  unit: "metres" | "minutes" | "stops";
};

export type LoadDrop = {
  id: string;
  /**
   * *At most* this many metres go away. Removing a middle stop deletes the two
   * legs that touched it, but the new leg from its neighbour to its neighbour is
   * a distance we have not routed, so this is an upper bound and is named as one.
   */
  savesMetresUpTo: number;
  savesMinUpTo: number;
  /** `metres + 10*minutes` over the stop's engine score: relief per point of value. */
  rank: number;
};

export type LoadMetrics = {
  walkMetres: number;
  walkMin: number;
  travelMin: number;
  activityMin: number;
  /**
   * `lastDepartMin - nowMin`: how long the day actually runs, read off the
   * schedule rather than summed up. Summing `activity + travel` double-counts a
   * slack packer, whose inter-stop gap is often the same minutes its leg claims.
   * Travel is inside this number by construction — a longer leg pushes the last
   * departure later — and `travelMin` is reported beside it so the two can be
   * reconciled offline.
   */
  windowUsedMin: number;
  /** Schedule time that is neither travelling nor on site. Buffer, mostly. */
  idleMin: number;
  availableMin: number;
  stops: number;
  legs: number;
  /** Longest run of stops separated by less than `REST_GAP_MIN`. */
  consecutiveMax: number;
  longestBlockMin: number;
  /** Gaps at or above `REST_GAP_MIN`, in order. */
  restGaps: { afterId: string; beforeId: string; minutes: number }[];
  /** Metres on foot over the budget. 0 when there is no walking. */
  loadRatio: number;
  blockRatio: number;
  /** True when the origin point was missing, so the first leg has no metres. */
  originDistanceUnknown: boolean;
};

export type LoadReport = {
  verdict: "ok" | "overloaded";
  metrics: LoadMetrics;
  budget: LoadBudget;
  violations: LoadViolation[];
  /** Ranked by relief per point of engine score. First one is what we cut. */
  dropOrder: LoadDrop[];
};

/** A stop dropped because the plan was over budget, with the sentence that says so. */
export type LoadExclusion = { id: string; reason: string; savesMetresUpTo: number; savesMinUpTo: number };

/**
 * Which sentence a traveller sees when the plan is refused.
 *
 * Not `violations[0]`. A day that overruns its window *because* it walks further
 * than the group can walk should say so about the walking — that is the thing
 * they can act on, by asking for a nearer stop or a car. Fixed order, so the same
 * report always produces the same sentence.
 */
const SEVERITY: LoadCode[] = [
  "walking_budget_exceeded",
  "leg_too_long_to_walk",
  "too_many_back_to_back",
  "block_too_long_without_rest",
  "window_exceeded",
];

export function leadViolation(report: LoadReport): LoadViolation | null {
  for (const code of SEVERITY) {
    const found = report.violations.find((entry) => entry.code === code);
    if (found) return found;
  }
  return null;
}

type Run = { ids: string[]; startMin: number; endMin: number };

/** Stops split into runs by whether the gap between them is a real break. */
function runsOf(plan: Plan): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;
  for (const stop of plan.stops) {
    if (!current) {
      current = { ids: [stop.experienceId], startMin: stop.arriveMin, endMin: stop.departMin };
      continue;
    }
    if (stop.arriveMin - current.endMin >= REST_GAP_MIN) {
      runs.push(current);
      current = { ids: [stop.experienceId], startMin: stop.arriveMin, endMin: stop.departMin };
      continue;
    }
    current.ids.push(stop.experienceId);
    current.endMin = stop.departMin;
  }
  if (current) runs.push(current);
  return runs;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * The whole model. One pure function of (plan, context, router) — the same
 * inputs always give the same report, which is what lets `admit` be a door
 * rather than a suggestion.
 */
export function loadOf(
  plan: Plan,
  ctx: DiscoveryContext,
  engine: EnginePort,
  catalogue: ReadonlyMap<string, Experience>,
): LoadReport {
  const budget = loadBudget(ctx);
  const legs = legsOf(plan, ctx, engine, catalogue);
  const walkLegs = legs.filter((leg) => leg.mode === "walk");

  const walkMetres = sum(walkLegs.map((leg) => leg.metres));
  const walkMin = sum(walkLegs.map((leg) => leg.minutes));
  const travelMin = sum(legs.map((leg) => leg.minutes));
  const activityMin = sum(plan.stops.map((stop) => Math.max(0, stop.departMin - stop.arriveMin)));
  const lastDepart = plan.stops.length > 0 ? plan.stops[plan.stops.length - 1]!.departMin : ctx.nowMin;
  const windowUsedMin = Math.max(0, lastDepart - ctx.nowMin);
  const idleMin = Math.max(0, windowUsedMin - activityMin - travelMin);

  const runs = runsOf(plan);
  const longestRun = runs.reduce<Run | null>(
    (worst, run) => (worst === null || run.ids.length > worst.ids.length ? run : worst),
    null,
  );
  const longestBlockRun = runs.reduce<Run | null>(
    (worst, run) => (worst === null || run.endMin - run.startMin > worst.endMin - worst.startMin ? run : worst),
    null,
  );
  const consecutiveMax = longestRun?.ids.length ?? 0;
  const longestBlockMin = longestBlockRun ? longestBlockRun.endMin - longestBlockRun.startMin : 0;

  const restGaps: LoadMetrics["restGaps"] = [];
  for (let i = 0; i + 1 < plan.stops.length; i += 1) {
    const from = plan.stops[i];
    const to = plan.stops[i + 1];
    if (!from || !to) continue;
    const gap = to.arriveMin - from.departMin;
    if (gap >= REST_GAP_MIN) restGaps.push({ afterId: from.experienceId, beforeId: to.experienceId, minutes: gap });
  }

  const metrics: LoadMetrics = {
    walkMetres,
    walkMin,
    travelMin,
    activityMin,
    windowUsedMin,
    idleMin,
    availableMin: ctx.availableMin,
    stops: plan.stops.length,
    legs: legs.length,
    consecutiveMax,
    longestBlockMin,
    restGaps,
    loadRatio: budget.walkMetres > 0 ? round2(walkMetres / budget.walkMetres) : 0,
    blockRatio: budget.maxBlockMin > 0 ? round2(longestBlockMin / budget.maxBlockMin) : 0,
    originDistanceUnknown: ctx.origin.point === null && plan.stops.length > 0,
  };

  const violations: LoadViolation[] = [];

  // 1. Time. The independent recompute of what the day costs, against the window
  //    the traveller actually has. `Plan.totalMin` is not consulted: a plan that
  //    under-reports its own length is exactly the case this has to catch.
  if (windowUsedMin > ctx.availableMin) {
    violations.push({
      code: "window_exceeded",
      at: null,
      message: `The day runs ${windowUsedMin} min — ${travelMin} min travelling, ${activityMin} min on site — against ${ctx.availableMin} min. Short by ${windowUsedMin - ctx.availableMin} min.`,
      shortfall: windowUsedMin - ctx.availableMin,
      unit: "minutes",
    });
  }

  // 2. One leg too long to be walked as a single effort.
  for (const leg of walkLegs) {
    if (leg.metres <= budget.maxLegWalkMetres) continue;
    violations.push({
      code: "leg_too_long_to_walk",
      at: leg.toId,
      message: `That leg is ${km(leg.metres)} on foot in one go. The limit here is ${budget.maxLegWalkMetres} m.`,
      shortfall: leg.metres - budget.maxLegWalkMetres,
      unit: "metres",
    });
  }

  // 3. The day's walking, all of it.
  if (walkMetres > budget.walkMetres) {
    violations.push({
      code: "walking_budget_exceeded",
      at: null,
      message: `${km(walkMetres)} on foot against a ${budget.walkMetres} m limit for this group in ${ctx.availableMin} min.`,
      shortfall: walkMetres - budget.walkMetres,
      unit: "metres",
    });
  }

  // 4. Too many back to back, even if each one is short.
  if (consecutiveMax > budget.maxConsecutiveStops) {
    violations.push({
      code: "too_many_back_to_back",
      at: longestRun?.ids[budget.maxConsecutiveStops] ?? null,
      message: `${consecutiveMax} stops with no proper break between them. ${budget.maxConsecutiveStops} is as many as this group can take in a row.`,
      shortfall: consecutiveMax - budget.maxConsecutiveStops,
      unit: "stops",
    });
  }

  // 5. A long day on no rest, however it is split.
  if (longestBlockMin > budget.maxBlockMin) {
    violations.push({
      code: "block_too_long_without_rest",
      at: longestBlockRun?.ids[longestBlockRun.ids.length - 1] ?? null,
      message: `${longestBlockMin} min between the first arrival and the last departure without a ${REST_GAP_MIN} min break. The limit is ${budget.maxBlockMin} min.`,
      shortfall: longestBlockMin - budget.maxBlockMin,
      unit: "minutes",
    });
  }

  return {
    verdict: violations.length > 0 ? "overloaded" : "ok",
    metrics,
    budget,
    violations,
    dropOrder: dropOrder(plan, legs, longestRun, budget.maxConsecutiveStops),
  };
}

/**
 * Which stop to cut, worst value for the relief first. Two stops that free the
 * same walking are separated by the engine's own score, so the one we give up is
 * the one the engine liked least.
 *
 * A stop inside the run that has no break in it is worth twice as much to drop,
 * because dropping anything else does not shorten the run — the run violation
 * survives the swap. That is the one place the ranking is not pure value.
 */
function dropOrder(plan: Plan, legs: readonly TravelLeg[], longestRun: Run | null, maxConsecutive: number): LoadDrop[] {
  const inRun = new Set(longestRun && longestRun.ids.length > maxConsecutive ? longestRun.ids : []);
  return plan.stops
    .map((stop, index) => {
      // Leg `index` arrives here, leg `index + 1` leaves. Both go if this stop does.
      const before = legs[index];
      const after = legs[index + 1];
      const saved = [before, after].filter((leg): leg is TravelLeg => leg?.mode === "walk");
      const savesMetresUpTo = sum(saved.map((leg) => leg.metres));
      const savesMinUpTo = sum(saved.map((leg) => leg.minutes)) + Math.max(0, stop.departMin - stop.arriveMin);
      const relief = savesMetresUpTo + 10 * savesMinUpTo;
      const rank = inRun.has(stop.experienceId) ? 2 * relief : relief;
      return {
        id: stop.experienceId,
        savesMetresUpTo,
        savesMinUpTo,
        rank: Math.round(rank * 10) / 10,
        value: Math.max(1, stop.score.total),
      };
    })
    .map(({ value, ...drop }) => ({ ...drop, rank: Math.round((drop.rank / value) * 100) / 100 }))
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export type LoadSolve = {
  plan: Plan;
  load: LoadReport;
  /** What we took off the list, and the sentence that justified each cut. */
  excluded: LoadExclusion[];
  attempts: number;
};

/** Enough re-solves to strip a bad plan, few enough that a slider still feels live. */
const MAX_ATTEMPTS = 8;

const withExcluded = (ctx: DiscoveryContext, ids: readonly string[]): DiscoveryContext => ({
  ...ctx,
  excludedIds: [...new Set([...ctx.excludedIds, ...ids])],
});

/**
 * Solve, measure, cut one stop, solve again — until the plan is inside the
 * budget or there is nothing left to cut.
 *
 * The engine still packs. We only change the list it is allowed to pack from,
 * and we set `excludedIds` so the exclusion is visible in the plan it returns
 * (`Plan.rejected` is where the engine's own account of the drop ends up). The
 * re-solve is bounded and the excluded set only grows, so this terminates.
 */
function solveUnderLoad(
  engine: EnginePort,
  ctx: DiscoveryContext,
  catalogue: ReadonlyMap<string, Experience>,
  remaining: readonly Experience[],
  attempt: (next: DiscoveryContext, candidates: readonly Experience[]) => Plan,
): LoadSolve {
  let candidates = remaining;
  let current = attempt(ctx, candidates);
  let load = loadOf(current, ctx, engine, catalogue);
  const excluded: LoadExclusion[] = [];

  for (let tries = 0; tries < MAX_ATTEMPTS && load.verdict === "overloaded"; tries += 1) {
    // `candidates` has already had the exclusions filtered out, so "still on the
    // list" is the test. `dropOrder` is a fresh ranking of the plan in front of us
    // each time round, so a cut that stops being the problem is not re-cut.
    const drop = load.dropOrder.find((candidate) => candidates.some((item) => item.id === candidate.id));
    // Nothing left to give up. An empty plan would be worse than an over-budget
    // one, so we hand back what we have and let `admit` refuse it.
    if (!drop || candidates.length <= 1) break;

    excluded.push({
      id: drop.id,
      reason: leadViolation(load)?.message ?? "Over the walking budget for this group.",
      savesMetresUpTo: drop.savesMetresUpTo,
      savesMinUpTo: drop.savesMinUpTo,
    });
    candidates = candidates.filter((item) => !excluded.some((entry) => entry.id === item.id));
    current = attempt(withExcluded(ctx, excluded.map((entry) => entry.id)), candidates);
    load = loadOf(current, ctx, engine, catalogue);
  }

  return { plan: current, load, excluded, attempts: excluded.length + 1 };
}

/**
 * `discover`'s packer, with the load model holding a veto over the result.
 * `catalogue` is needed to rebuild legs for a plan the engine packed without any.
 */
export function packWithinLoad(
  engine: EnginePort,
  ctx: DiscoveryContext,
  ordered: readonly Experience[],
  catalogue: ReadonlyMap<string, Experience>,
): LoadSolve {
  return solveUnderLoad(engine, ctx, catalogue, ordered, (next, candidates) => engine.pack(next, [...candidates]));
}

export type ReplanUnderLoad = {
  result: ReplanResult;
  load: LoadReport;
  excluded: LoadExclusion[];
};

/**
 * `replan`'s re-solve, with one retry.
 *
 * The retry is the whole reason this is not just the gate: when the engine hands
 * back a plan that is over budget, the offender goes on `excludedIds` and the
 * same `ContextChange` is solved again. A second answer is a normal engine call,
 * so this is not a local re-implementation of the replanner — it is the same
 * solver, told one thing it did not know.
 */
export function replanWithinLoad(
  engine: EnginePort,
  previous: Plan,
  ctx: DiscoveryContext,
  change: ContextChange,
  catalogue: ReadonlyMap<string, Experience>,
): ReplanUnderLoad {
  const result = engine.replan(previous, ctx, change);
  const load = loadOf(result.plan, ctx, engine, catalogue);
  if (load.verdict === "ok") return { result, load, excluded: [] };

  const drop = load.dropOrder[0];
  if (!drop) return { result, load, excluded: [] };

  const excluded: LoadExclusion[] = [
    {
      id: drop.id,
      reason: leadViolation(load)?.message ?? "Over the walking budget for this group.",
      savesMetresUpTo: drop.savesMetresUpTo,
      savesMinUpTo: drop.savesMinUpTo,
    },
  ];
  const retry = engine.replan(previous, withExcluded(ctx, [drop.id]), change);
  const retryLoad = loadOf(retry.plan, ctx, engine, catalogue);
  return { result: retry, load: retryLoad, excluded };
}
