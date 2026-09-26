/**
 * Trip health: one deterministic 0-100 read on how hard a real `Plan` is.
 *
 * WHY THIS IS NOT A SCORE WE INVENTED. `docs/DESIGN_SYSTEM.md` already fixes
 * the Stress Radar: seven named dimensions, the weights below, 0-100, a label
 * cut at 68 and 38, and exactly one "Rescue move" for the worst factor. This
 * file is the arithmetic behind that component, so Karan renders a number that
 * came from a `Plan` and not from a mood.
 *
 * WHY IT IS NOT A CONSTANT. Every dimension is computed from three real inputs
 * the app already has — the `Plan` the engine packed, the `DiscoveryContext`
 * the traveller filled in, and the `Experience` rows the plan points at. Change
 * any of them and the numbers move. `health.test.ts` asserts exactly that,
 * dimension by dimension, and would fail on any hardcoded return.
 *
 * THE ONE RULE. Every dimension is the max of its named `Signal`s, and every
 * signal is `clamp01((measured - threshold) / span)`. No hidden blend inside a
 * dimension, so when the UI shows a bar, the signal list is the whole story.
 * The only blend in the file is the documented `exposureBlend` in weatherRisk.
 *
 * HONESTY OVER PRECISION. A dimension that cannot be computed from the data
 * given is not scored 0 — it is left out, its weight is removed from the
 * denominator, and it is named in `unmeasured`. A score renormalised over the
 * dimensions we could actually read beats a confident zero.
 *
 * WIRING, AND WHY IT IS NOT DONE HERE. `EnginePort.stress(plan, ctx)` in
 * `src/features/discovery/engine.ts` cannot call this: four of the seven
 * dimensions need the catalogue, and the port has no catalogue parameter. That
 * is a signature change to a file this session does not own, so it is raised
 * rather than made. `toPlanStress()` is the adapter that fills
 * `Plan.stressScore` / `Plan.stressFactors` the moment the port is widened.
 */
import type {
  DiscoveryContext,
  Experience,
  Money,
  PartyType,
  Plan,
  RejectionCode,
  WeatherNow,
} from "../../contracts";
import { hm, money, plural } from "../discovery/format";

/**
 * The radar's dimensions and weights, verbatim from `docs/DESIGN_SYSTEM.md`
 * Â§StressRadar. They sum to 1.00. Order is the display order (heaviest first).
 * Keys are the design system's, not ours, because the radar indexes by them.
 */
export const DIMENSION_WEIGHTS = {
  overload: 0.25,
  pinDebt: 0.18,
  weatherRisk: 0.14,
  fomoRisk: 0.13,
  spreadRisk: 0.12,
  transitComplexity: 0.1,
  reservationRisk: 0.08,
} as const;

export type Dimension = keyof typeof DIMENSION_WEIGHTS;
export const DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as Dimension[];

/**
 * Every tunable in the file, in one place, so a reviewer can check the whole
 * model without reading the arithmetic. Sources are named per constant.
 */
export const THRESHOLDS = {
  /** NomadNote `MODE_HOURS.balanced`. Hours of *planned* time a healthy day holds. */
  saneTargetHours: 8,  /** Overload is 0 at half the sane target and 100 at 1.2x it. */
  overloadFloorRatio: 0.5,
  overloadFullRatio: 1.2,
  /** A plan that runs past the traveller's own deadline is scored on the overrun. */
  overrunFullMin: 60,
  /** Density: 0 at one stop per `densityCalmMin`, 100 at one per `densityPackedMin`. */
  densityCalmMin: 90,
  densityPackedMin: 25,
  /** A stop with less buffer than this has nowhere to sit down when it runs late. */
  anchorTightBufferMin: 5,
  /** Pin weight at which the plan's stops are all fully pinned. */
  pinsForFullLoad: 1.2,
  /** Idle minutes between two stops before a transition counts as no breather. */
  breatherFullMin: 20,
  /** Half the plan unverifiable = full uncertainty load on pinDebt. */
  unverifiedFullShare: 0.5,
  /** Conditions on `WeatherNow.condition`, worst last. Named so the radar can read them. */
  conditionSeverity: {
    clear: 0,
    cloudy: 0,
    light_rain: 0.35,
    wind: 0.4,
    heat: 0.5,
    heavy_rain: 0.7,
    storm: 0.95,
  } as Record<WeatherNow["condition"], number>,
  /** How much of a walk / an exposed stop / no buffer counts toward exposure. */
  exposureBlend: { walk: 0.4, stops: 0.4, shelter: 0.2 } as const,
  /** `Experience.weatherSensitive` values each condition actually threatens. */
  conditionThreat: {
    clear: [] as string[],
    cloudy: [] as string[],
    light_rain: ["rain", "any"],
    heavy_rain: ["rain", "any"],
    storm: ["rain", "wind", "any"],
    heat: ["heat", "any"],
    wind: ["wind", "any"],
  } as Record<WeatherNow["condition"], string[]>,
  /** Minutes of total buffer that count as "somewhere to shelter". */
  shelterFullBufferMin: 60,
  /** A rejection this far from the cutoff stops counting as tempting. */
  nearnessWindowMin: 90,
  nearnessWindowMetres: 5_000,
  /** Temptation points needed for full fomo load. */
  fomoFullLoad: 2.5,
  /** `docs/EVAL_SPEC.md`: median travel per stop target is 1.8 km. */
  kmPerStopTarget: 1.8,
  /** Extra km per stop before spreadRisk is maxed. */
  kmPerStopSpan: 3.0,
  /** A single leg this long is maximum spread on its own. */
  longestLegFullKm: 20,
  /** Two stops this far apart is maximum dispersion on their own. */
  pairFullKm: 15,
  /** NomadNote `travelTimePainScore`: each leg past this adds `(min - 20) / 10`. */
  legPainAfterMin: 20,
  legPainFullLoad: 4,
  /** Mode changes in the sequence before transit complexity is maxed. */
  modeSwitchesFullLoad: 3,
  /** Travel as a share of the plan: calm below this, maxed at the next line. */
  travelShareCalm: 0.25,
  travelShareFull: 0.6,
  /** Cost as a share of the ceiling. Also the only home for budget pressure. */
  budgetCalmShare: 0.6,
  /** At or above this share the copy says one price rise breaks the plan. */
  budgetTightShare: 0.95,
  budgetFullShare: 1,
  /** Share of stops needing a booking that maxes the booking signal. */
  bookingShareFullLoad: 0.66,
  /** Stops whose lead time outruns the window before it is maxed. */
  shortNoticeFullLoad: 2,
  /** Design-system label cuts. */
  frictionAt: 68,
  saneAt: 38,
  /**
   * The four `HealthBand` cuts. `severe` is pinned to `frictionAt` and
   * `moderate` to `saneAt`, so a band can never disagree with the headline label
   * about the same number.
   */
  bandCuts: { low: 20, moderate: 38, high: 55, severe: 68 } as const,
  /**
   * How wrong `Plan.totalMin` may be before we stop believing it. Generous on
   * purpose: `Fit.totalMin` is per stop and the leg list is separate, so a real
   * engine's two totals differ by the per-stop travel estimate. Only a gross
   * disagreement means the plan is broken.
   */
  minutesTolerance: 30,
  minutesToleranceShare: 0.25,
  /** A city ride is this much quicker than the walk it replaces. */
  rideSpeedup: 2.5,
  /**
   * The smallest gain worth putting in front of a traveller, in score points.
   *
   * The bands sit 20 points apart, so a 2-point "improvement" crosses nothing and
   * changes no label: it is a rescue the traveller cannot act on and can only
   * learn to ignore. A move is therefore shown when it clears this OR when it
   * crosses a band, because crossing a band is a real milestone even at 1 point.
   */
  minRecoveryGain: 3,
} as const;

/**
 * Every number in `THRESHOLDS` is widened, so an override can hold a DIFFERENT
 * number. Left as literal types, `Partial<Thresholds>` would only ever accept
 * the shipped value and the override argument would be a lie.
 */
export type Thresholds = {
  -readonly [K in keyof typeof THRESHOLDS]: (typeof THRESHOLDS)[K] extends number
    ? number
    : (typeof THRESHOLDS)[K];
};

/**
 * Who can hold how much, as a multiple of `saneTargetHours`. Multipliers rather
 * than hours so the base stays one tunable instead of eight.
 */
const PARTY_FACTOR: Record<PartyType, number> = {
  solo: 1,
  couple: 1,
  friends: 1.125,
  business: 0.625,
  family_with_children: 0.75,
  family_teens: 1,
  older_adults: 0.75,
  solo_female: 1,
};

/** An hour off the cap for a group with someone under six in it. */
const TODDLER_MIN = 60;

const PARTY_PHRASE: Record<PartyType, string> = {
  solo: "one traveller",
  couple: "a couple",
  friends: "a group of friends",
  business: "a working day",
  family_with_children: "a family with children",
  family_teens: "a family with teenagers",
  older_adults: "older adults",
  solo_female: "one traveller",
};

/** One measured quantity, its threshold, and the 0..1 load it produced. */
export type Signal = {
  /** Stable machine key, so a test or a tooltip can name it. */
  key: string;
  /** The measured value, already unit-stamped for display. */
  measured: string;
  /** The number it was compared against. */
  against: string;
  /** 0..1 after the threshold. What the dimension actually used. */
  load: number;
};

export type HealthDimension = {
  dimension: Dimension;
  /** Human label for the radar. Finished, not a slug. */
  label: string;
  weight: number;
  /** 0..100. Higher is worse for every dimension here. */
  value: number;
  /** weight * value. The dimensions sum to `TripHealth.score`. */
  contribution: number;
  /** One finished sentence with the real numbers in it. */
  explanation: string;
  /** The named sub-measurements. This is the audit trail for `value`. */
  signals: Signal[];
  /** Word for `value`, so no component has to invent the scale. */
  band: HealthBand;
  /** Non-null only on the worst factor, per the contract's own comment. */
  rescue: string | null;
};

/**
 * A measured companion to the radar. Same 0-100 reading, same `Signal` trail,
 * but deliberately NOT summed into `score`.
 *
 * WHY IT IS NOT AN EIGHTH DIMENSION: `docs/DESIGN_SYSTEM.md` fixes the radar at
 * seven weighted dimensions and the component already exists against that
 * contract, so a plan and a screen have to agree on seven. Budget pressure
 * still has to be reported, because a plan at 98% of the ceiling is one price
 * rise away from being wrong and none of the seven says so. It sits beside the
 * score, and the panel shows it beside the radar.
 */
export type CompanionDimension = {
  /** 0..100, higher is worse. */
  value: number;
  explanation: string;
  signals: Signal[];
};

/**
 * `unreadable` is not a stress level. It means the plan contradicts itself, so
 * no score off it means anything, and the UI must not draw bars off it. See
 * `TripHealth.warnings`.
 */
export type HealthLabel = "high_friction" | "manageable" | "sane" | "unreadable";

/**
 * How bad a single dimension is, in words. The radar needs a band per bar and
 * the design system only fixes two cuts (38 and 68), so the three between them
 * are ours and are named here rather than left to a component to invent.
 */
export type HealthBand = "clear" | "low" | "moderate" | "high" | "severe";

/** Word for a 0-100 reading, on the design system's own scale. */
export function bandOf(value: number, t: Thresholds = THRESHOLDS): HealthBand {
  if (value >= t.bandCuts.severe) return "severe";
  if (value >= t.bandCuts.high) return "high";
  if (value >= t.bandCuts.moderate) return "moderate";
  if (value >= t.bandCuts.low) return "low";
  return "clear";
}

export type TripHealth = {
  planId: string;
  contextId: string;
  /** 0..100, integer. This is the value for `Plan.stressScore`. */
  score: number;
  label: HealthLabel;
  /** Finished copy carrying the number, per the design system's two cuts. */
  labelSentence: string;
  /** Descending weight, so the radar and the ledger agree on order. */
  dimensions: HealthDimension[];
  /** The single factor worth a rescue move. */
  worst: HealthDimension;
  /** Weight of the dimensions that could be read, 0..1. Below 1 means degraded. */
  coverage: number;
  /** Dimensions dropped for want of data, with the reason. */
  unmeasured: { dimension: Dimension; why: string }[];
  /** Plan ids the catalogue could not resolve. Empty means full coverage. */
  unknownIds: string[];
  /** Beside the score, not inside it. See `CompanionDimension`. */
  budgetPressure: CompanionDimension;
  /**
   * Ways this plan contradicts itself, in the traveller's words. Non-empty means
   * the read is arithmetic on a broken input, so `label` is `unreadable` and the
   * numbers should be shown as untrustworthy rather than as a score.
   */
  warnings: string[];
  /** `warnings.length === 0`. The one thing a panel should check before drawing. */
  trustworthy: boolean;
  /** The facts every dimension was read from, so the whole read is checkable. */
  facts: TripFacts;
};

/** Everything the seven dimensions were computed from. No arithmetic, no copy. */
export type TripFacts = {
  stops: number;
  legs: number;
  plannedMin: number;
  windowMin: number;
  /** The smaller of the traveller's window and what this party can hold. */
  saneTargetMin: number;
  onSiteMin: number;
  travelMin: number;
  bufferMin: number;
  totalMetres: number;
  /** Sum of leg metres, which is what the weather walk-share divides by. */
  legMetres: number;
  walkMetres: number;
  longestLegKm: number;
  cost: Money | null;
  ceiling: Money | null;
  condition: WeatherNow["condition"];
  estimatedLegs: number;
  rejected: number;
};

export type Catalogue = readonly Experience[] | ReadonlyMap<string, Experience>;

const clamp01 = (n: number): number => (n <= 0 ? 0 : n >= 1 ? 1 : n);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const maxOf = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), 0);
const km = (metres: number): string => `${(metres / 1000).toFixed(1)} km`;

/** Great-circle metres. Five lines beats an undeclared transitive import. */
function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** `instanceof Map` will not narrow a `ReadonlyMap`, and `Array.isArray` does not narrow it out of a union either. */
export function isIndex(catalogue: Catalogue): catalogue is ReadonlyMap<string, Experience> {
  return !Array.isArray(catalogue);
}

/** One place that knows how a `Catalogue` becomes a lookup, whatever shape it arrived in. */
export function indexCatalogue(catalogue: Catalogue): Map<string, Experience> {
  if (isIndex(catalogue)) return new Map(catalogue);
  return new Map(catalogue.map((exp) => [exp.id, exp]));
}

function collectFacts(plan: Plan, ctx: DiscoveryContext, t: Thresholds): TripFacts {
  const stops = [...plan.stops].sort((a, b) => a.order - b.order);
  const partyCap =
    t.saneTargetHours * 60 * PARTY_FACTOR[ctx.partyType] -
    (ctx.childAges.some((a) => a < 6) ? TODDLER_MIN : 0);
  const legMetres = plan.legs.reduce((sum, leg) => sum + leg.metres, 0);
  const walkMetres = plan.legs
    .filter((leg) => leg.mode === "walk")
    .reduce((sum, leg) => sum + leg.metres, 0);
  return {
    stops: stops.length,
    legs: plan.legs.length,
    plannedMin: plan.totalMin,
    windowMin: ctx.availableMin,
    saneTargetMin: Math.max(1, Math.min(ctx.availableMin, partyCap)),
    onSiteMin: stops.reduce((sum, stop) => sum + Math.max(0, stop.departMin - stop.arriveMin), 0),
    travelMin: plan.legs.reduce((sum, leg) => sum + leg.minutes, 0),
    bufferMin: stops.reduce((sum, stop) => sum + stop.fit.bufferMin, 0),
    totalMetres: plan.totalMetres,
    legMetres,
    walkMetres: legMetres > 0 ? walkMetres : 0,
    longestLegKm: maxOf(plan.legs.map((leg) => leg.metres)) / 1000,
    cost: plan.totalCost,
    ceiling: ctx.budget ?? ctx.budgetPerPerson,
    condition: ctx.weather.condition,
    estimatedLegs: plan.legs.filter((leg) => leg.estimated).length,
    rejected: plan.rejected.length,
  };
}

/** Distance across every ordered pair of stop locations, so "dispersion" is real. */
function widestPairKm(stops: Plan["stops"], byId: Map<string, Experience>): number | null {
  const points = stops.map((stop) => byId.get(stop.experienceId)?.location ?? null);
  if (points.length < 2 || points.some((p) => p === null)) return null;
  let widest = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i];
      const b = points[j];
      if (a && b) widest = Math.max(widest, haversine(a, b) / 1000);
    }
  }
  return widest;
}

type Ctx = {
  plan: Plan;
  ctx: DiscoveryContext;
  byId: Map<string, Experience>;
  facts: TripFacts;
  t: Thresholds;
};

const clock = (min: number): string => {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
};

/**
 * Ways the plan argues with itself. A read is arithmetic, and arithmetic on a
 * self-contradictory input produces a confident wrong number — which is worse
 * than no number, because the panel has no way to tell. Every message names the
 * two facts that disagree, in the traveller's words, because "invalid plan"
 * would be a support ticket.
 *
 * This is deliberately NOT the engine's `validate`: that recomputes the
 * objective and rejects a plan. This one does not reject anything, it marks the
 * reading untrustworthy and lets the caller decide.
 */
function integrityOf(plan: Plan, ctx: DiscoveryContext, facts: TripFacts, t: Thresholds): string[] {
  const found: string[] = [];
  const stops = [...plan.stops].sort((a, b) => a.order - b.order);

  if (new Set(stops.map((s) => s.order)).size !== stops.length) {
    found.push("Two stops claim the same place in the plan, so the order is ambiguous.");
  }
  if (new Set(stops.map((s) => s.experienceId)).size !== stops.length) {
    found.push("The same place is in the plan more than once.");
  }
  for (const stop of stops) {
    if (stop.departMin < stop.arriveMin) {
      found.push(`Stop ${stop.order + 1} leaves before it arrives.`);
    }
  }
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (prev && next && next.arriveMin < prev.departMin) {
      found.push(
        `Stop ${next.order + 1} starts at ${clock(next.arriveMin)}, before stop ${prev.order + 1} ends at ${clock(prev.departMin)}.`,
      );
    }
  }
  if (plan.contextId !== ctx.id) {
    found.push("This plan was built for a different search, so it was not measured against your window.");
  }
  const expectedLegs = Math.max(0, stops.length - 1);
  if (plan.legs.length !== expectedLegs) {
    found.push(
      `${plural(plan.legs.length, "leg", "legs")} for ${plural(stops.length, "stop", "stops")}, which needs ${expectedLegs}.`,
    );
  }
  for (let i = 0; i < plan.legs.length; i += 1) {
    const leg = plan.legs[i];
    const from = stops[i];
    const to = stops[i + 1];
    if (!leg || !from || !to) continue;
    if (leg.fromId !== from.experienceId || leg.toId !== to.experienceId) {
      // Not cosmetic: this is the invariant any re-timing of the plan relies on.
      // A route cannot be checked, or rebuilt, when the legs do not say which two
      // stops they join.
      found.push(
        `The leg between stop ${from.order + 1} and stop ${to.order + 1} does not join them, so the route cannot be checked.`,
      );
      break;
    }
  }
  const legMin = plan.legs.reduce((sum, leg) => sum + leg.minutes, 0);
  const stopMin = stops.reduce(
    (sum, stop) => sum + Math.max(0, stop.departMin - stop.arriveMin) + stop.fit.bufferMin,
    0,
  );
  const built = legMin + stopMin;
  if (stops.length > 0) {
    const slack = Math.max(t.minutesTolerance, built * t.minutesToleranceShare);
    if (Math.abs(built - facts.plannedMin) > slack) {
      found.push(`The plan says ${hm(facts.plannedMin)}, but its own stops and legs add up to ${hm(built)}.`);
    }
  }
  if (plan.legs.length > 0 && facts.legMetres !== facts.totalMetres) {
    found.push(`It claims ${km(facts.totalMetres)} of travel, but the legs add up to ${km(facts.legMetres)}.`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// The seven dimensions. Each returns a value, its signals, and a sentence.
// ---------------------------------------------------------------------------

function overload(d: Ctx) {
  const { facts, t } = d;
  const ratio = facts.plannedMin / facts.saneTargetMin;
  const overrun = Math.max(0, facts.plannedMin - facts.windowMin);
  const stopRate = facts.stops / Math.max(1, facts.plannedMin);
  const signals: Signal[] = [
    {
      key: "plannedVsTarget",
      measured: `${hm(facts.plannedMin)} planned`,
      against: `${hm(facts.saneTargetMin)} a ${PARTY_PHRASE[d.ctx.partyType]} holds`,      load: clamp01((ratio - t.overloadFloorRatio) / (t.overloadFullRatio - t.overloadFloorRatio)),
    },
    {
      key: "windowOverrun",
      measured: overrun === 0 ? "inside the window" : `${hm(overrun)} past the deadline`,
      against: `${hm(t.overrunFullMin)} past the ${hm(facts.windowMin)} window`,
      load: clamp01(overrun / t.overrunFullMin),
    },
    {
      key: "stopDensity",
      measured: facts.plannedMin > 0 ? `${round1(facts.stops / (facts.plannedMin / 60))} stops an hour` : "no stops",
      against: `one per ${hm(t.densityCalmMin)} to one per ${hm(t.densityPackedMin)}`,
      load: clamp01(
        (stopRate - 1 / t.densityCalmMin) / (1 / t.densityPackedMin - 1 / t.densityCalmMin),
      ),
    },
  ];
  const load = maxOf(signals.map((s) => s.load));
  // The target is the SMALLER of what they asked for and what this party can
  // hold, so say which one bound it, rather than implying we over-ruled them.
  const windowBinds = facts.saneTargetMin >= facts.windowMin;
  const target = windowBinds
    ? `the ${hm(facts.windowMin)} you asked for`
    : `a ${hm(facts.saneTargetMin)} target for ${PARTY_PHRASE[d.ctx.partyType]}`;
  const share = windowBinds
    ? ""
    : `, ${Math.round((facts.plannedMin / Math.max(1, facts.windowMin)) * 100)}% of the ${hm(facts.windowMin)} on the clock`;
  return {
    value: load * 100,
    signals,
    explanation:
      `${hm(facts.plannedMin)} planned against ${target}${share}` +
      (overrun > 0 ? `, and ${hm(overrun)} past the moment you have to leave.` : "."),
  };
}

function pinDebt(d: Ctx) {
  const { plan, byId, facts, t } = d;
  const stops = [...plan.stops].sort((a, b) => a.order - b.order);
  let pins = 0;
  const pinnedIds: string[] = [];
  for (const stop of stops) {
    const exp = byId.get(stop.experienceId);
    // `Fit.fitRatio` is deliberately NOT a term: the contract documents
    // `>= 1` as "fits with room to spare", so it points the other way.
    // `Fit.verdict` is the contract's own tightness call and is unambiguous.
    const weight =
      (stop.fit.verdict === "does_not_fit" ? 1 : stop.fit.verdict === "tight" ? 0.7 : 0) +
      (stop.fit.bufferMin <= t.anchorTightBufferMin ? 0.3 : 0) +
      (exp?.booking.required ? 0.5 : 0) +
      (exp && exp.bestTimeOfDay.length <= 1 ? 0.4 : 0);
    if (weight > 0) {
      pins += weight;
      pinnedIds.push(stop.experienceId);
    }
  }
  const unverified =
    facts.estimatedLegs + stops.filter((s) => byId.get(s.experienceId)?.hours.status !== "ok").length;
  const unverifiedShare = unverified / Math.max(1, facts.legs + facts.stops);

  // Rest availability, read off the plan's own clock: the idle minutes between
  // one stop leaving and the next arriving. Zero means no room to sit down, be
  // late, or find a toilet that is not the one you already used.
  const gaps: number[] = [];
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const next = stops[i];
    if (prev && next) gaps.push(Math.max(0, next.arriveMin - prev.departMin));
  }
  const tightestGap = gaps.length > 0 ? Math.min(...gaps) : null;

  const signals: Signal[] = [
    {
      key: "pinnedStops",
      measured: `${pinnedIds.length} of ${plural(facts.stops, "stop", "stops")} pinned, ${round1(pins)} pin weight`,
      against: `${t.pinsForFullLoad} pin weight per stop`,
      load: clamp01(pins / Math.max(1, facts.stops * t.pinsForFullLoad)),
    },
  ];
  if (tightestGap !== null) {
    signals.push({
      key: "noBreather",
      measured: `tightest transition has ${hm(tightestGap)} of slack`,
      against: `${hm(t.breatherFullMin)}`,
      load: clamp01(1 - tightestGap / t.breatherFullMin),
    });
  }
  signals.push({
    key: "unverifiable",
    measured: `${unverified} of ${facts.legs + facts.stops} legs and stops estimated or unverified`,
    against: `half the plan, ${Math.round(t.unverifiedFullShare * 100)}%`,
    load: clamp01(unverifiedShare / t.unverifiedFullShare),
  });
  const load = maxOf(signals.map((s) => s.load));
  return {
    value: load * 100,
    signals,
    explanation:
      `${pinnedIds.length} of ${plural(facts.stops, "stop", "stops")} pinned, ` +
      `${hm(facts.bufferMin)} of buffer across the whole plan` +
      (tightestGap === null
        ? "."
        : `, and the tightest transition leaves ${hm(tightestGap)} of slack`) +
      (unverified > 0
        ? `, with ${plural(unverified, "timing that is", "timings that are")} an estimate rather than a live route.`
        : "."),
  };
}

function weatherRisk(d: Ctx) {
  const { plan, ctx, byId, facts, t } = d;
  const stops = [...plan.stops].sort((a, b) => a.order - b.order);
  const severity = t.conditionSeverity[ctx.weather.condition];
  const threats = new Set(t.conditionThreat[ctx.weather.condition]);
  const exposedMin = stops
    .filter((stop) => {
      const exp = byId.get(stop.experienceId);
      return exp !== undefined && threats.has(exp.weatherSensitive);
    })
    .reduce((sum, stop) => sum + Math.max(0, stop.departMin - stop.arriveMin), 0);
  const legMetres = facts.legMetres;
  const walkShare = clamp01(legMetres > 0 ? facts.walkMetres / legMetres : 0);
  const stopShare = clamp01(exposedMin / Math.max(1, facts.onSiteMin));
  const shelter = clamp01(1 - facts.bufferMin / t.shelterFullBufferMin);
  const blend = t.exposureBlend;
  const exposure =
    facts.stops === 0 && facts.legs === 0
      ? 0
      : clamp01(blend.walk * walkShare + blend.stops * stopShare + blend.shelter * shelter);
  const signals: Signal[] = [
    {
      key: "conditionSeverity",
      measured: `${ctx.weather.condition} (source: ${ctx.weather.source})`,
      against: "clear",
      load: severity,
    },
    {
      key: "exposedWalking",
      measured: `${Math.round(walkShare * 100)}% of the travel on foot, ${km(facts.walkMetres)}`,
      against: "all of it walking",
      load: walkShare,
    },
    {
      key: "exposedStops",
      measured: `${hm(exposedMin)} on site in weather-ruined spots`,
      against: `${hm(facts.onSiteMin)} on site in total`,
      load: stopShare,
    },
    {
      key: "noShelter",
      measured: `${hm(facts.bufferMin)} of buffer to wait it out`,
      against: `${hm(t.shelterFullBufferMin)}`,
      load: shelter,
    },
  ];
  const load = severity * exposure;
  return {
    value: load * 100,
    signals,
    explanation:
      severity === 0
        ? `${ctx.weather.condition} right now, so weather is not a factor.`
        : `${ctx.weather.condition} outside, ${Math.round(walkShare * 100)}% of the travel on foot and ${hm(exposedMin)} of the time in spots this weather ruins.`,
  };
}

const FOMO_WEIGHT: Record<RejectionCode, number> = {
  too_far: 0.7,
  travel_time_exceeds_budget: 1,
  duration_exceeds_budget: 1,
  closed_now: 0.6,
  closed_during_window: 0.8,
  hours_unverified: 0.5,
  over_budget: 0.6,
  over_budget_per_person: 0.6,
  capacity_exceeded: 0.5,
  not_step_free: 0.3,
  not_stroller_ok: 0.3,
  no_low_stairs: 0.3,
  no_hearing_loop: 0.2,
  no_restroom: 0.3,
  inaccessible: 0.3,
  diet_mismatch: 0.3,
  sold_out: 0.8,
  requires_booking_not_available: 0.9,
  lead_time_too_short: 0.9,
  weather_unsafe: 0.2,
  duplicate: 0,
  already_planned: 0,
  excluded_by_traveller: 0,
  mustsee_conflict: 0.4,
  seasonal_mismatch: 0.2,
};

function nearnessOf(rejection: Plan["rejected"][number], ceilingMinor: number, t: Thresholds): number {
  if (rejection.shortfall === null) return 0.6;
  if (rejection.unit === "minutes") return 1 - clamp01(rejection.shortfall / t.nearnessWindowMin);
  if (rejection.unit === "minor_units") return 1 - clamp01(rejection.shortfall / Math.max(1, ceilingMinor));
  if (rejection.unit === "metres") return 1 - clamp01(rejection.shortfall / t.nearnessWindowMetres);
  return 0.5;
}

function fomoRisk(d: Ctx) {
  const { plan, facts, t } = d;
  const ceilingMinor = facts.ceiling?.minor ?? Math.max(1, facts.cost?.minor ?? 0);
  let temptation = 0;
  let near = 0;
  for (const rejection of plan.rejected) {
    const closeness = nearnessOf(rejection, ceilingMinor, t);
    const weight = FOMO_WEIGHT[rejection.code] ?? 0.4;
    if (closeness >= 0.6 && weight > 0) near += 1;
    temptation += weight * closeness;
  }
  const signals: Signal[] = [
    {
      key: "temptation",
      measured: `${round2(temptation)} temptation points from ${plural(facts.rejected, "rejection", "rejections")}`,
      against: `${t.fomoFullLoad} points`,
      load: clamp01(temptation / t.fomoFullLoad),
    },
    {
      key: "nearMisses",
      measured: `${near} missed by a hair`,
      against: "any missed by a hair",
      load: clamp01(near / 3),
    },
  ];
  const load = maxOf(signals.map((s) => s.load));
  return {
    value: load * 100,
    signals,
    explanation:
      facts.rejected === 0
        ? "Nothing was left out, so there is nothing to be tempted by."
        : `${plural(facts.rejected, "thing was", "things were")} left out, ${near} of ${near === 1 ? "it" : "them"} missing by under ${hm(t.nearnessWindowMin)}.`,
  };
}

function spreadRisk(d: Ctx) {
  const { plan, byId, facts, t } = d;
  const perStopKm = facts.totalMetres / 1000 / Math.max(1, facts.stops);
  const pairKm = widestPairKm(plan.stops, byId);
  const signals: Signal[] = [
    {
      key: "perStop",
      measured: `${round1(perStopKm)} km travelled per stop`,
      against: `${t.kmPerStopTarget} km`,
      load: clamp01((perStopKm - t.kmPerStopTarget) / t.kmPerStopSpan),
    },
    {
      key: "longestLeg",
      measured: facts.legs > 0 ? `longest leg ${round1(facts.longestLegKm)} km` : "no legs",
      against: `${t.longestLegFullKm} km`,
      load: clamp01(facts.longestLegKm / t.longestLegFullKm),
    },
  ];
  if (pairKm !== null) {
    signals.push({
      key: "widestPair",
      measured: `widest pair of stops ${round1(pairKm)} km apart`,
      against: `${t.pairFullKm} km`,
      load: clamp01(pairKm / t.pairFullKm),
    });
  }
  const load = maxOf(signals.map((s) => s.load));
  return {
    value: load * 100,
    signals,
    explanation:
      `${km(facts.totalMetres)} of travel across ${plural(facts.stops, "stop", "stops")}` +
      (pairKm === null ? ", and the catalogue could not place them all." : `, the widest gap ${round1(pairKm)} km.`),
  };
}

function transitComplexity(d: Ctx) {
  const { plan, facts, t } = d;
  const pain = plan.legs.reduce(
    (sum, leg) => sum + Math.min(1, Math.max(0, (leg.minutes - t.legPainAfterMin) / 10)),
    0,
  );
  const switches = plan.legs.reduce(
    (sum, leg, i) => sum + (i > 0 && plan.legs[i - 1]?.mode !== leg.mode ? 1 : 0),
    0,
  );
  const signals: Signal[] = [
    {
      key: "legPain",
      measured: `${round1(pain)} pain from ${plural(facts.legs, "leg", "legs")} over ${hm(t.legPainAfterMin)}`,
      against: `${t.legPainFullLoad} pain`,
      load: clamp01(pain / t.legPainFullLoad),
    },
    {
      key: "modeSwitches",
      measured: `${switches} mode ${plural(switches, "switch", "switches")}`,
      against: `${t.modeSwitchesFullLoad} switches`,
      load: clamp01(switches / t.modeSwitchesFullLoad),
    },
    {
      key: "travelShare",
      measured: `${Math.round((facts.travelMin / Math.max(1, facts.plannedMin)) * 100)}% of the plan is getting there`,
      against: `${Math.round(d.t.travelShareCalm * 100)}% to ${Math.round(d.t.travelShareFull * 100)}%`,
      load: clamp01(
        (facts.travelMin / Math.max(1, facts.plannedMin) - t.travelShareCalm) /
          (t.travelShareFull - t.travelShareCalm),
      ),
    },
  ];
  const load = maxOf(signals.map((s) => s.load));
  return {
    value: load * 100,
    signals,
    explanation: `${hm(facts.travelMin)} in transit over ${plural(facts.legs, "leg", "legs")}, ${plural(switches, "mode switch", "mode switches")}.`,
  };
}

const BOOKING_CODES: RejectionCode[] = [
  "requires_booking_not_available",
  "lead_time_too_short",
  "sold_out",
];

function reservationRisk(d: Ctx) {
  const { plan, byId, facts } = d;
  let booked = 0;
  let shortNotice = 0;
  for (const stop of plan.stops) {
    const exp = byId.get(stop.experienceId);
    if (!exp?.booking.required) continue;
    booked += 1;
    if (exp.booking.leadTimeMin > facts.windowMin) shortNotice += 1;
  }
  const refused = plan.rejected.filter((r) => BOOKING_CODES.includes(r.code)).length;
  const signals: Signal[] = [
    {
      key: "bookings",
      measured: `${booked} of ${plural(facts.stops, "stop", "stops")} need a booking`,
      against: `${Math.round(d.t.bookingShareFullLoad * 100)}% of stops`,
      load: clamp01(booked / Math.max(1, facts.stops) / d.t.bookingShareFullLoad),
    },
    {
      key: "shortNotice",
      measured: `${shortNotice} need more notice than the ${hm(facts.windowMin)} window`,
      against: `${d.t.shortNoticeFullLoad} stops`,
      load: clamp01(shortNotice / d.t.shortNoticeFullLoad),
    },
    {
      key: "refused",
      measured: `${refused} lost to booking rules`,
      against: `${d.t.shortNoticeFullLoad}`,
      load: clamp01(refused / d.t.shortNoticeFullLoad),
    },
  ];
  const load = maxOf(signals.map((s) => s.load));
  return {
    value: load * 100,
    signals,
    explanation:
      booked === 0 && refused === 0
        ? "Nothing in this plan needs a reservation, so nothing can be cancelled out from under you."
        : `${plural(booked, "stop needs", "stops need")} a reservation, ${shortNotice} of ${booked === 1 ? "it" : "them"} past the lead time.`,
  };
}

// ---------------------------------------------------------------------------
// Budget pressure. A companion read, not one of the radar's seven.
// ---------------------------------------------------------------------------

function budgetPressure(d: Ctx): CompanionDimension {
  const { ctx, facts, t } = d;
  const cost = facts.cost?.minor ?? 0;
  const signals: Signal[] = [];
  let share = 0;
  if (facts.ceiling) {
    share = cost / Math.max(1, facts.ceiling.minor);
    signals.push({
      key: "totalCeiling",
      measured: `${money(facts.cost)} of the ${money(facts.ceiling)} ceiling`,
      against: `${money(facts.ceiling)}`,
      load: clamp01((share - t.budgetCalmShare) / (t.budgetFullShare - t.budgetCalmShare)),
    });
  }
  if (ctx.budgetPerPerson) {
    const perHead = cost / Math.max(1, ctx.partySize);
    const perHeadShare = perHead / Math.max(1, ctx.budgetPerPerson.minor);
    signals.push({
      key: "perPersonCeiling",
      measured: `${money(perHead)} a head for ${plural(ctx.partySize, "person", "people")}`,
      against: `${money(ctx.budgetPerPerson)} a head`,
      load: clamp01((perHeadShare - t.budgetCalmShare) / (t.budgetFullShare - t.budgetCalmShare)),
    });
  }
  const load = maxOf(signals.map((s) => s.load));
  return {
    // Rounded because this is bound straight to a 0-100 scale, and a 0-1 float
    // division prints its binary remainder to whoever is looking at it.
    value: round2(load * 100),
    signals,
    explanation: !facts.ceiling
      ? `${money(facts.cost)} spent, with no ceiling set to press against.`
      : share >= t.budgetTightShare
        ? `${money(facts.cost)} is ${Math.round(share * 100)}% of the ${money(facts.ceiling)} ceiling. One price rise and it does not fit.`
        : `${money(facts.cost)} of the ${money(facts.ceiling)} ceiling, ${Math.round(share * 100)}% of it spent.`,
  };
}

// ---------------------------------------------------------------------------
// Rescue moves. One sentence, one concrete action, real numbers.
// ---------------------------------------------------------------------------
function rescueFor(dimension: Dimension, d: Ctx): string {
  const { plan, facts, byId } = d;
  const stops = [...plan.stops].sort((a, b) => a.order - b.order);
  const longest = [...stops].sort((a, b) => b.fit.totalMin - a.fit.totalMin)[0];

  switch (dimension) {
    case "overload":
      return longest
        ? `Drop the stop that takes ${hm(longest.fit.totalMin)} and you get that back, leaving ${hm(Math.max(0, facts.windowMin - facts.plannedMin + longest.fit.totalMin))} of the window.`
        : "Nothing to cut; the window is the constraint to change, not the plan.";
    case "pinDebt": {
      const tightest = [...stops].sort((a, b) => a.fit.bufferMin - b.fit.bufferMin)[0];
      return tightest
        ? `Start the pinned stop that holds ${hm(tightest.fit.bufferMin)} of buffer earlier, and the ${hm(Math.max(0, facts.plannedMin - facts.bufferMin))} of unbuffered time gets somewhere to go.`
        : "Nothing is pinned, so the plan can absorb a delay as it stands.";
    }
    case "weatherRisk":
      return `Swap the ${plural(plan.legs.filter((l) => l.mode === "walk").length, "walking leg", "walking legs")} for a ride and the wet-weather exposure drops with it.`;
    case "fomoRisk": {
      const nearest = [...plan.rejected].sort(
        (a, b) => (a.shortfall ?? Number.MAX_SAFE_INTEGER) - (b.shortfall ?? Number.MAX_SAFE_INTEGER),
      )[0];
      return nearest
        ? `The closest miss needed ${nearest.shortfall ?? 0} ${nearest.unit ?? "more"}. Freeing that much and it stops being a regret.`
        : "Nothing was left out, so there is no regret to talk about.";
    }
    case "spreadRisk":
      return `Reorder so the two furthest stops meet in the middle; that alone removes the ${round1(facts.longestLegKm)} km leg.`;
    case "transitComplexity":
      return `Stay on one mode for the middle leg and the ${plural(plan.legs.length, "transfer", "transfers")} collapse into one.`;
    case "reservationRisk": {
      const booked = stops.filter((stop) => byId.get(stop.experienceId)?.booking.required);
      const last = booked[booked.length - 1];
      return last
        ? `Confirm the ${ordinal((last?.order ?? 0) + 1)} stop's booking now; a reservation you cannot make is a hole in the plan.`
        : "Nothing in this plan needs a booking, so leave it alone.";
    }
  }
}

const ordinal = (n: number): string =>
  n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : `${n}th`;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Finished labels, so no caller has to keep its own copy of the vocabulary. */
export const DIMENSION_LABELS: Record<Dimension, string> = {
  overload: "Overload",
  pinDebt: "Pinned time",
  weatherRisk: "Weather risk",
  fomoRisk: "Left-out regret",
  spreadRisk: "Spread",
  transitComplexity: "Getting there",
  reservationRisk: "Reservation risk",
};

/** The label a dimension is shown under, by its key. */
export const dimensionLabel = (dimension: Dimension): string => DIMENSION_LABELS[dimension];

type Computed = { value: number; signals: Signal[]; explanation: string };

/**
 * The one call. `catalogue` is the real catalogue the plan's ids point at; a
 * plan whose stops cannot be resolved there loses those dimensions rather than
 * scoring them zero, and says so in `unmeasured`.
 */
export function assessTripHealth(
  plan: Plan,
  ctx: DiscoveryContext,
  catalogue: Catalogue,
  overrides: Partial<Thresholds> = {},
): TripHealth {
  const t: Thresholds = { ...THRESHOLDS, ...overrides };
  const byId = indexCatalogue(catalogue);
  const d: Ctx = { plan, ctx, byId, facts: collectFacts(plan, ctx, t), t };
  const facts = d.facts;

  const all: Record<Dimension, Computed> = {
    overload: overload(d),
    pinDebt: pinDebt(d),
    weatherRisk: weatherRisk(d),
    fomoRisk: fomoRisk(d),
    spreadRisk: spreadRisk(d),
    transitComplexity: transitComplexity(d),
    reservationRisk: reservationRisk(d),
  };

  const unknownIds = [...new Set(plan.stops.map((s) => s.experienceId).filter((id) => !byId.has(id)))];
  const needsCatalogue: Dimension[] = ["pinDebt", "weatherRisk", "spreadRisk", "reservationRisk"];
  const unmeasured: { dimension: Dimension; why: string }[] = [];
  if (unknownIds.length > 0) {
    for (const dimension of needsCatalogue) {
      unmeasured.push({
        dimension,
        why: `the catalogue has no row for ${plural(unknownIds.length, "one of the stops", `${unknownIds.length} of the stops`)}`,
      });
    }
  }

  const measured = DIMENSIONS.filter((dimension) => !unmeasured.some((u) => u.dimension === dimension));
  const weightOf = measured.reduce((sum, dimension) => sum + DIMENSION_WEIGHTS[dimension], 0);
  const coverage = round2(weightOf);

  const dimensions: HealthDimension[] = DIMENSIONS.map((dimension) => {
    const weight = DIMENSION_WEIGHTS[dimension];
    const value = round1(Math.min(100, all[dimension].value));
    const contribution = round2(weight * value * (weightOf > 0 ? 1 / weightOf : 0));
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      weight,
      value,
      contribution,
      explanation: all[dimension].explanation,
      signals: all[dimension].signals,
      band: bandOf(value, t),
      rescue: null,
    };
  });

  const score = Math.max(
    0,
    Math.min(100, Math.round(measured.reduce((sum, key) => sum + DIMENSION_WEIGHTS[key] * all[key].value, 0) / (weightOf || 1))),
  );

  // `reduce` and not `sort()[0]`: under `noUncheckedIndexedAccess` an index
  // access is `| undefined` even on a seven-element literal array.
  const worst = dimensions.reduce((a, b) =>
    b.contribution > a.contribution || (b.contribution === a.contribution && b.value > a.value) ? b : a,
  );
  if (weightOf > 0) worst.rescue = rescueFor(worst.dimension, d);

  const warnings = integrityOf(plan, ctx, facts, t);
  const trustworthy = warnings.length === 0;
  const label: HealthLabel = !trustworthy
    ? "unreadable"
    : score >= t.frictionAt
      ? "high_friction"
      : score <= t.saneAt
        ? "sane"
        : "manageable";
  const labelSentence = !trustworthy
    ? `This plan contradicts itself, so the ${score} off it means nothing. ${warnings[0] ?? ""}`
    : label === "high_friction"
      ? `High friction at ${score} of 100.`
      : label === "sane"
        ? `Trip feels sane at ${score} of 100.`
        : `Workable at ${score} of 100.`;

  return {
    planId: plan.id,
    contextId: plan.contextId,
    score,
    label,
    labelSentence,
    dimensions,
    worst,
    coverage,
    unmeasured,
    unknownIds,
    budgetPressure: budgetPressure(d),
    warnings,
    trustworthy,
    facts,
  };
}

/**
 * The `EnginePort.stress` implementation, ready to hand the engine.
 *
 * The third argument is OPTIONAL on purpose. `EnginePort.stress` is stubbed in
 * every engine and test double in the repo, and four of the seven dimensions
 * need the catalogue. Making the catalogue a required argument would break all
 * of those call sites; making it optional means every existing two-argument call
 * still compiles, and simply reads fewer dimensions — which `assessTripHealth`
 * already reports honestly through `coverage` and `unmeasured`.
 *
 * The catalogue argument is the whole reason this exists rather than
 * `toPlanStress(assessTripHealth(...))` at each call site: one place decides
 * what a missing catalogue means.
 */
export function stressFor(
  plan: Plan,
  ctx: DiscoveryContext,
  catalogue: Catalogue = [],
  thresholds?: Partial<Thresholds>,
): { score: number; factors: Plan["stressFactors"] } {
  return toPlanStress(assessTripHealth(plan, ctx, catalogue, thresholds));
}

/**
 * The contract's own two fields, so the engine can fill `Plan.stressScore` and
 * `Plan.stressFactors` without the health read being widened at the call site.
 * The rescue rides on the worst factor only, per `Plan.stressFactors`' comment.
 */
export function toPlanStress(health: TripHealth): { score: number; factors: Plan["stressFactors"] } {
  return {
    score: health.score,
    factors: health.dimensions.map((dim) => ({
      dimension: dim.dimension,
      weight: dim.weight,
      value: dim.value,
      rescue: dim.rescue,
    })),
  };
}
