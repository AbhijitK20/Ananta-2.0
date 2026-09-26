/**
 * Travel load: how much a plan asks of the body, as opposed to how well it fills
 * the window.
 *
 * `Fit` answers "does this stop fit the time left". Nothing in the feature
 * answered "can this group actually do this", so the `walking` preference was
 * inert: `prefers_no_walks` was written into `DiscoveryContext.avoid` and then
 * nothing read it. This file is the reader.
 *
 * FIVE RULES, all load-bearing.
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
 *     replace. A non-walk leg also costs no strain: we have no data on how far
 *     someone walks to a station, so we charge nothing rather than guess. That
 *     under-counts by design and `metrics.unpricedLegs` says how much.
 *
 *  3. **A stop is not a rest.** Standing at a market for ninety minutes costs
 *     something, and `session` after `session` is how a day wrecks people. So
 *     every stop is charged for its duration at a posture rate taken from the
 *     row's own `seatingAvailable` when we have it and from its category when we
 *     do not. This is the one axis a distance-only model cannot see: six short
 *     stops can be harder than two long ones.
 *
 *  4. **Effort is cumulative, so a flat kilometre budget is wrong.** The fourth
 *     kilometre of a day is not the first kilometre. Each metre is charged at a
 *     rate that grows with the strain already spent, and a genuine sit-down
 *     (`REST_GAP_MIN`) gives some of it back. Two plans that walk the same
 *     distance are therefore not equally hard, and only one of them is the same
 *     plan twice. Strain is denominated in metre-equivalents, so it compares
 *     against the same `budget.walkMetres` a traveller would quote at you.
 *
 *  5. **The budget is derived from the context, not from the plan.** Walking
 *     capacity, longest unbroken block and how many stops can follow each other
 *     all follow from `avoid` tokens, `childAges`, `accessNeeds`, `partySize`,
 *     `weather` and `availableMin`. Two different parties looking at the same
 *     plan get two different verdicts, which is the whole claim.
 *
 * Consequences, in `replanner.ts` and nowhere else: `packWithinLoad` /
 * `replanWithinLoad` re-solve with the offending stop off the list, and `admit`
 * refuses a plan that is still over budget. So a plan a traveller can be shown
 * is a plan their group can walk.
 *
 * NOT HERE, ON PURPOSE: the `max_walk_<n>m` token. `whatif` owns that judgement
 * and tests it end to end, including the case where a planner ignores the cap,
 * so this file records the cap in `budget.walkCapM` and in `budget.basis` and
 * leaves the verdict alone — two components must not both refuse a plan for the
 * same reason. `walkCapOf` below is the canonical reader if that ever changes.
 */
import type {
  Category,
  ContextChange,
  DiscoveryContext,
  Experience,
  GeoPoint,
  Plan,
  ReplanResult,
  TravelLeg,
  WeatherNow,
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

/**
 * Standing still, as a fraction of walking pace. Walking is 70 strain-units a
 * minute, so 6 is about 8.5%: an hour on your feet in a market is worth a bit
 * over 350 m of walking. Deliberately small — a stop is much cheaper than
 * walking it — because a stop you can sit at is very much cheaper still.
 */
const STAND_STRAIN_PER_MIN = 6;

/**
 * How much harder each further metre is, per unit of capacity already spent.
 *
 * At 1.0, spending half your allowance makes the next metre cost 1.5x and
 * spending all of it makes it cost 2x. That is the shape of the real thing: the
 * tail of a long day is where people give up, and a model that charges every
 * metre the same cannot see that.
 */
const FATIGUE_GAIN = 1;

/**
 * Share of the strain spent before a break that a real sit-down gives back, and
 * the ceiling on how much one break can return. Bounded so a plan cannot bank
 * recovery across a dozen gaps and walk 20 km.
 */
const RECOVERY_RATE = 0.35;
const RECOVERY_CAP_SHARE = 0.25;

/**
 * Strain capacity is larger than the walking budget, because most of a day out
 * is spent standing or sitting rather than walking. 1.6x lets a party use its
 * whole walking allowance AND spend a normal day on its feet without the model
 * calling that over budget.
 */
const STRAIN_HEADROOM = 1.6;

/** Above this, walking starts to cost more than it does at a mild temperature. */
const COMFORTABLE_C = 24;
/** Per extra degree past `COMFORTABLE_C`. 30 C is +11%, 40 C is +29%. */
const HEAT_PER_C = 0.018;

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

const WALK_CAP_TOKEN = /^max_walk_(\d+)m$/;

/**
 * The exact walking ceiling a "what if" asked for, read back out of the frozen
 * context. Recorded in the budget and in the evidence; not enforced here, for
 * the reason in the file header. Exported so there is one regex for it.
 */
export function walkCapOf(ctx: DiscoveryContext): number | null {
  for (const token of ctx.avoid) {
    const hit = WALK_CAP_TOKEN.exec(token);
    if (hit?.[1]) return Number(hit[1]);
  }
  return null;
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
  /**
   * Total effort this party can be asked to spend, in the same metre-equivalents
   * as `walkMetres`, so the two can be compared without a conversion table.
   * Always `walkMetres * STRAIN_HEADROOM`.
   */
  strainCapacity: number;
  maxConsecutiveStops: number;
  /** Longest run of stops with no sit-down, regardless of how many there are. */
  maxBlockMin: number;
  maxLegWalkMetres: number;
  tolerance: WalkingTolerance;
  /** The exact cap a "what if" asked for, if one is in force. Reported, not enforced. */
  walkCapM: number | null;
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

/**
 * What the sky is doing to the cost of being on foot. This is a different axis
 * from `weather_averse`, which is about whether to go out at all: a party that
 * decided to go out anyway still walks more slowly for it.
 *
 * Applied to *effort*, never to `walkMetres`. A hot day does not shorten how far
 * a body can physically walk; it makes every metre of it cost more, and the
 * strain model is the only place that distinction can live. Putting it in both
 * would count the same heat twice and make the strain check contradict the
 * distance check it is supposed to sit behind.
 */
function weatherLoad(ctx: DiscoveryContext): { factor: number; basis: string[] } {
  const basis: string[] = [];
  let factor = 1;

  const heat = Math.max(0, ctx.weather.tempC - COMFORTABLE_C);
  if (heat > 0) {
    factor *= 1 + heat * HEAT_PER_C;
    basis.push(`strain_temp:${ctx.weather.tempC}c(+${round1(heat * HEAT_PER_C * 100)}%)`);
  }
  const byCondition: Partial<Record<WeatherNow["condition"], [number, string]>> = {
    heat: [1.2, "strain_condition:heat"],
    heavy_rain: [1.15, "strain_condition:heavy_rain"],
    storm: [1.15, "strain_condition:storm"],
    light_rain: [1.05, "strain_condition:light_rain"],
    wind: [1.05, "strain_condition:wind"],
  };
  const hit = byCondition[ctx.weather.condition];
  if (hit) {
    factor *= hit[0];
    basis.push(hit[1]);
  }
  return { factor: round2(factor), basis };
}

export function loadBudget(ctx: DiscoveryContext): LoadBudget {
  const tolerance = toleranceOf(ctx);
  const table = TOLERANCE[tolerance];
  const { factor, basis } = partyLoad(ctx);
  const { basis: skyBasis } = weatherLoad(ctx);
  const walkCapM = walkCapOf(ctx);

  // A window is a hard ceiling on its own: 45 minutes cannot hold a day's walking.
  // The party factor is the whole group penalty and is applied HERE, once. The
  // strain model must not apply it again: a metre of this party's walking is
  // already one metre of the budget they were just given.
  const windowCap = ctx.availableMin * WALK_M_PER_MIN;
  const personalCap = DAY_WALK_M * table.share;
  const walkMetres = Math.round(Math.min(personalCap, windowCap) * factor);

  // Never demand a break the window has no room for: a 45 min trip is not a
  // 45 min block violation.
  const maxBlockMin = Math.min(table.maxBlockMin, Math.max(60, ctx.availableMin));

  return {
    walkMetres,
    strainCapacity: Math.round(walkMetres * STRAIN_HEADROOM),
    maxConsecutiveStops: table.maxConsecutiveStops,
    maxBlockMin,
    maxLegWalkMetres: table.maxLegWalkMetres,
    tolerance,
    walkCapM,
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
      ...skyBasis,
      ...(walkCapM === null ? [] : [`walk_cap:${walkCapM}m(reported_not_enforced)`]),
      `strain_headroom:${STRAIN_HEADROOM}x`,
      ...basis,
    ],
  };
}

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/**
 * What a stop costs to be at, as a multiple of the standing rate.
 *
 * Three classes, not thirty-six: seated, mixed, and on-your-feet. The split is
 * the only thing that changes a plan's verdict, and finer categories would be
 * invention dressed as precision. `seatingAvailable` overrides the class
 * whenever the row carries it, because a market with benches is not a market
 * without them, and a `null` there means "nobody recorded it", never "no".
 */
const SEATED: readonly Category[] = [
  "cafe", "restaurant", "wellness", "theatre", "church", "mosque", "temple", "nightlife",
];
const ON_FEET: readonly Category[] = [
  "nature", "beach", "adventure", "dance_performance", "music_live", "community_hosted",
  "art_studio", "craft_workshop",
];

function postureOf(item: Experience | undefined): { factor: number; basis: string } {
  if (!item) return { factor: 1, basis: "posture:unknown_row" };
  const standing = SEATED.includes(item.category)
    ? "seated"
    : ON_FEET.includes(item.category)
      ? "on_feet"
      : "mixed";
  let factor = standing === "seated" ? 0.5 : standing === "on_feet" ? 1.2 : 1;

  const seating = item.accessibility.seatingAvailable;
  if (seating === true) factor = Math.min(factor, 0.45);
  else if (seating === false) factor = Math.max(factor, 1.15);

  // Outside with no shade, standing is standing. Only outdoors; `covered` and
  // `indoor` already give you somewhere to stop.
  if (item.indoorOutdoor === "outdoor") factor *= 1.15;

  const seatingNote = seating === null ? "seating:unknown" : `seating:${seating}`;
  return { factor: round2(factor), basis: `posture:${standing}(${seatingNote},${item.indoorOutdoor})` };
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
// The strain timeline
// ---------------------------------------------------------------------------

/**
 * One charged moment in the day. Kept whole rather than summed on the fly,
 * because the whole argument of this file is that the order matters: you cannot
 * know what a metre costs without knowing what came before it, and you cannot
 * show a traveller which stop hurt without having kept them apart.
 */
export type StrainStep = {
  kind: "leg" | "stop" | "rest";
  /** Stop id, leg destination, or "origin" for a break before the first stop. */
  id: string;
  minutes: number;
  /** On-foot metres. Zero for anything that is not a `walk` leg. */
  metres: number;
  /** Posture multiplier for a stop, 1 for a leg. */
  posture: number;
  /** The fatigue multiplier in force when this step was charged. */
  multiplier: number;
  /** Strain added, or handed back for a `rest`. */
  strain: number;
  /** Strain already spent when this step began. */
  strainBefore: number;
  basis: string;
};

type StrainTimeline = {
  steps: StrainStep[];
  used: number;
  fromLegs: number;
  fromStops: number;
  recovered: number;
  unpricedLegs: number;
  worst: StrainStep | null;
};

/**
 * Walk the day in order, charging as we go. The order is the point: rule 4.
 *
 * `budget` is threaded in rather than recomputed so the caller measures the day
 * against exactly the budget it is about to compare it with.
 */
function strainOf(
  plan: Plan,
  ctx: DiscoveryContext,
  legs: readonly TravelLeg[],
  catalogue: ReadonlyMap<string, Experience>,
  budget: LoadBudget,
): StrainTimeline {
  const steps: StrainStep[] = [];
  const capacity = Math.max(1, budget.strainCapacity);
  const { factor: sky } = weatherLoad(ctx);
  let used = 0;
  let fromLegs = 0;
  let fromStops = 0;
  let recovered = 0;
  let unpricedLegs = 0;
  let worst: StrainStep | null = null;

  const note = (step: StrainStep): void => {
    steps.push(step);
    if (step.kind === "leg") fromLegs += step.strain;
    else if (step.kind === "stop") fromStops += step.strain;
    else recovered += -step.strain;
    // The worst single *stop*, not the worst leg: the traveller can act on "this
    // one is too long to stand at" and not on "the second kilometre is expensive".
    if (step.kind === "stop" && (worst === null || step.strain > worst.strain)) worst = step;
  };

  for (const [index, stop] of plan.stops.entries()) {
    const leg = legs[index];
    if (leg) {
      const onFoot = leg.mode === "walk";
      if (!onFoot) unpricedLegs += leg.minutes;
      const multiplier = round2(1 + FATIGUE_GAIN * (used / capacity));
      // No `groupFactor` here, and that is deliberate. The party penalty is
      // already in `budget.walkMetres`, so dividing again would make walking
      // exactly one's own budget cost several budgets, and the strain check
      // would refuse every plan the distance check had just passed.
      const strain = onFoot ? Math.round(leg.metres * multiplier * sky) : 0;
      note({
        kind: "leg",
        id: leg.toId,
        minutes: leg.minutes,
        metres: onFoot ? leg.metres : 0,
        posture: 1,
        multiplier,
        strain,
        strainBefore: used,
        basis: onFoot
          ? `leg:walk(${leg.metres}m@${multiplier}x,sky${sky})`
          : `leg:${leg.mode}(not_foot,unpriced)`,
      });
      used += strain;
    }

    const posture = postureOf(catalogue.get(stop.experienceId));
    const minutes = Math.max(0, stop.departMin - stop.arriveMin);
    const strain = Math.round(minutes * STAND_STRAIN_PER_MIN * posture.factor);
    note({
      kind: "stop",
      id: stop.experienceId,
      minutes,
      metres: 0,
      posture: posture.factor,
      multiplier: 1,
      strain,
      strainBefore: used,
      basis: `${posture.basis}x${minutes}min`,
    });
    used += strain;

    const next = plan.stops[index + 1];
    const gap = next ? next.arriveMin - stop.departMin : 0;
    if (gap < REST_GAP_MIN) continue;
    // A real break gives back a share of what came before, and no more than the
    // recovery ceiling — otherwise a plan could bank rest and walk forever.
    const back = Math.min(
      Math.round(used * RECOVERY_RATE),
      Math.round(capacity * RECOVERY_CAP_SHARE),
    );
    note({
      kind: "rest",
      id: stop.experienceId,
      minutes: gap,
      metres: 0,
      posture: 1,
      multiplier: 1,
      strain: -back,
      strainBefore: used,
      basis: `rest:${gap}min(-${back})`,
    });
    used = Math.max(0, used - back);
  }

  return { steps, used, fromLegs, fromStops, recovered, unpricedLegs, worst };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type LoadCode =
  | "window_exceeded"
  | "walking_budget_exceeded"
  | "leg_too_long_to_walk"
  | "strain_exhausted"
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
  unit: "metres" | "minutes" | "stops" | "strain";
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
  /**
   * Strain this stop is responsible for: its own posture cost plus the walking
   * either side of it. This is what makes the ranking work on a plan where every
   * leg is driven, where the metre saving is zero for every stop and the old
   * ranking collapsed to "shortest activity first".
   */
  savesStrainUpTo: number;
  /** `strain + metres + 10 * minutes` over the stop's engine score. */
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
  /** Total effort spent, in metre-equivalents. Rule 4: order matters. */
  strainUsed: number;
  strainFromLegs: number;
  strainFromStops: number;
  /** Strain handed back by real breaks. */
  strainRecovered: number;
  /** `strainUsed / budget.strainCapacity`. The number a group should be shown. */
  strainRatio: number;
  /** Minutes of travel we deliberately did not price, because it was not on foot. */
  unpricedLegs: number;
  /** The stop that cost the most to be at, with the sentence for why. */
  worstStop: { id: string; minutes: number; strain: number; basis: string } | null;
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
  /** Every charged moment, in order. The audit trail behind `metrics`. */
  timeline: StrainStep[];
};

/** A stop dropped because the plan was over budget, with the sentence that says so. */
export type LoadExclusion = { id: string; reason: string; savesMetresUpTo: number; savesMinUpTo: number };

/**
 * Which sentence a traveller sees when the plan is refused.
 *
 * Not `violations[0]`. A day that overruns its window *because* it walks further
 * than the group can walk should say so about the walking — that is the thing
 * they can act on, by asking for a nearer stop or a car. Fixed order, so the same
 * report always produces the same sentence. A stated limit outranks a derived
 * one, because the stated one is the one they can relax.
 */
const SEVERITY: LoadCode[] = [
  "walking_budget_exceeded",
  "leg_too_long_to_walk",
  "strain_exhausted",
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

  const strain = strainOf(plan, ctx, legs, catalogue, budget);

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
    strainUsed: strain.used,
    strainFromLegs: strain.fromLegs,
    strainFromStops: strain.fromStops,
    strainRecovered: strain.recovered,
    strainRatio: round2(strain.used / Math.max(1, budget.strainCapacity)),
    unpricedLegs: strain.unpricedLegs,
    worstStop: strain.worst
      ? {
          id: strain.worst.id,
          minutes: strain.worst.minutes,
          strain: strain.worst.strain,
          basis: strain.worst.basis,
        }
      : null,
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

  // 4. Total effort, which is not the same question as distance. This is the one
  //    that catches a plan nobody walked too far but nobody could have done.
  if (strain.used > budget.strainCapacity) {
    const worst = metrics.worstStop;
    const where = worst
      ? ` That one place alone is worth ${km(worst.strain)} of walking, for ${worst.minutes} min.`
      : "";
    violations.push({
      code: "strain_exhausted",
      at: worst?.id ?? null,
      message: `That is ${strain.used} of effort against ${budget.strainCapacity} for this group — ${strain.fromStops} of it standing still and ${strain.fromLegs} walking.${where}`,
      shortfall: strain.used - budget.strainCapacity,
      unit: "strain",
    });
  }

  // 5. Too many back to back, even if each one is short.
  if (consecutiveMax > budget.maxConsecutiveStops) {
    violations.push({
      code: "too_many_back_to_back",
      at: longestRun?.ids[budget.maxConsecutiveStops] ?? null,
      message: `${consecutiveMax} stops with no proper break between them. ${budget.maxConsecutiveStops} is as many as this group can take in a row.`,
      shortfall: consecutiveMax - budget.maxConsecutiveStops,
      unit: "stops",
    });
  }

  // 6. A long day on no rest, however it is split.
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
    dropOrder: dropOrder(plan, legs, strain.steps, longestRun, budget.maxConsecutiveStops),
    timeline: strain.steps,
  };
}

/**
 * Which stop to cut, worst value for the relief first. Two stops that free the
 * same effort are separated by the engine's own score, so the one we give up is
 * the one the engine liked least.
 *
 * Effort, not just metres, is what a cut is measured in. On a plan where every
 * leg is driven, the metre saving is zero for every stop and a distance-only
 * ranking degenerates into "shortest activity first" — which cuts the cafe and
 * keeps the three-hour market. The strain timeline already knows what each stop
 * cost, so that case is now ranked on the thing that actually broke.
 *
 * A stop inside the run that has no break in it is worth twice as much to drop,
 * because dropping anything else does not shorten the run — the run violation
 * survives the swap. That is the one place the ranking is not pure value.
 */
function dropOrder(
  plan: Plan,
  legs: readonly TravelLeg[],
  steps: readonly StrainStep[],
  longestRun: Run | null,
  maxConsecutive: number,
): LoadDrop[] {
  const inRun = new Set(longestRun && longestRun.ids.length > maxConsecutive ? longestRun.ids : []);
  // What each stop is on the hook for, by name rather than by position: a
  // reconstruction that assumed one leg per stop broke the moment a plan had a
  // leg the engine did not number the way we guessed.
  const strainOfStop = new Map<string, number>();
  for (const step of steps) {
    if (step.kind !== "stop") continue;
    strainOfStop.set(step.id, (strainOfStop.get(step.id) ?? 0) + step.strain);
  }

  return plan.stops
    .map((stop) => {
      // Leg `index` arrives here, leg `index + 1` leaves. Both go if this stop does.
      const index = plan.stops.indexOf(stop);
      const before = legs[index];
      const after = legs[index + 1];
      const saved = [before, after].filter((leg): leg is TravelLeg => leg?.mode === "walk");
      const savesMetresUpTo = sum(saved.map((leg) => leg.metres));
      const savesMinUpTo = sum(saved.map((leg) => leg.minutes)) + Math.max(0, stop.departMin - stop.arriveMin);
      const savesStrainUpTo =
        (strainOfStop.get(stop.experienceId) ?? 0) + sum(saved.map((leg) => leg.metres));
      const relief = savesStrainUpTo + 0.1 * savesMetresUpTo + savesMinUpTo;
      const rank = inRun.has(stop.experienceId) ? 2 * relief : relief;
      return {
        id: stop.experienceId,
        savesMetresUpTo,
        savesMinUpTo,
        savesStrainUpTo,
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
      reason: leadViolation(load)?.message ?? "Over what this group can do in that time.",
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
      reason: leadViolation(load)?.message ?? "Over what this group can do in that time.",
      savesMetresUpTo: drop.savesMetresUpTo,
      savesMinUpTo: drop.savesMinUpTo,
    },
  ];
  const retry = engine.replan(previous, withExcluded(ctx, [drop.id]), change);
  const retryLoad = loadOf(retry.plan, ctx, engine, catalogue);
  return { result: retry, load: retryLoad, excluded };
}
