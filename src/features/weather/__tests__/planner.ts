/**
 * A deterministic planner, for the weather tests only.
 *
 * `src/engine/**` belongs to another stream and is not in this branch, so there is
 * no engine to run a weather gate through. This is the smallest thing that behaves
 * like one: a real haversine router, a real greedy packer, a real scorer, real
 * rejections, and a `replan` that re-solves from the catalogue. It exists so the
 * assertions in `weather.test.ts` are about the *pipeline* — the same
 * retrieve -> filter -> score -> pack -> replan calls `discover()` and `replan()`
 * in `../../discovery` make — instead of about a hand-written expected plan, which
 * would prove nothing.
 *
 * It is deliberately weather-blind. That is the point: if the plan changes when the
 * sky changes, the change came from the gate and not from the engine quietly
 * agreeing with it. `preferPreviousOrder` makes that sharper still — the engine
 * then re-solves only the order it already had and cannot notice new weather at
 * all, which is the engine this gate exists to cover.
 *
 * ponytail: ceiling — no hours adapter, no congestion model, no bandit, haversine
 * instead of a router. Swap this for `src/engine` when it lands. Nothing in
 * `src/features/weather` changes, because it only ever speaks `EnginePort`.
 *
 * One deliberate failure: a window that runs past midnight produces arrival minutes
 * above `Minutes`' 1440 ceiling, and `PlanSchema.parse` throws rather than wrapping.
 * That is the unresolved question `content/evaluation/README.md` §85 records for the
 * real packer, and a test double that quietly invented an answer to it would be
 * worse than one that refuses.
 */
import {
  Plan as PlanSchema,
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type GeoPoint,
  type Plan,
  type PlanStop,
  type Rejection,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
} from "../../../contracts";
import type { EnginePort, TravelMode } from "../../discovery/engine";

/** Fixed, so two runs of the same input produce byte-identical plans. */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const ENGINE_VERSION = "test-planner-1";
const PROFILE_VERSION = "test-planner-1";
const EARTH_R = 6371000;
const BUFFER_MIN = 5;
const ROUTER_MODE: Record<DiscoveryContext["travelMode"], TravelMode> = {
  walk: "walk",
  auto: "auto",
  transit: "transit",
  any: "auto",
};

const SPEED_M_PER_MIN: Record<TravelMode, number> = { walk: 80, auto: 260, transit: 300, ferry: 200 };

export const DEFAULT_WEIGHTS: WeightProfile = {
  version: PROFILE_VERSION,
  weights: { interest: 1, rating: 1, proximity: 1 },
  source: "prior",
  updatedAt: CREATED_AT,
  observations: 0,
};

const round = (value: number): number => Math.round(value * 10) / 10;
const rupees = (minor: number) => ({ minor, currency: "INR" as const });

export function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_R * Math.asin(Math.sqrt(h)));
}

const travelMin = (metres: number, mode: TravelMode): number =>
  Math.max(3, Math.ceil(metres / SPEED_M_PER_MIN[mode]));

const originOf = (ctx: DiscoveryContext): GeoPoint => ctx.origin.point ?? { lat: 19.0, lon: 72.87 };

/** A `Fit` with real numbers, including the three per-constraint checks. */
function fitOf(ctx: DiscoveryContext, exp: Experience, minutes: number): Fit {
  const totalMin = minutes + exp.durationMin + BUFFER_MIN;
  const cost = rupees((exp.pricePerPerson?.minor ?? 0) * ctx.partySize);
  const ceiling = ctx.budget?.minor ?? null;
  return {
    experienceId: exp.id,
    travelMin: minutes,
    activityMin: exp.durationMin,
    bufferMin: BUFFER_MIN,
    totalMin,
    availableMin: ctx.availableMin,
    fitRatio: ctx.availableMin / Math.max(1, totalMin),
    cost,
    budget: ctx.budget,
    checks: [
      {
        label: "Fits your window",
        pass: totalMin <= ctx.availableMin,
        detail: `${exp.durationMin} min on site, ${minutes} min to get there.`,
      },
      {
        label: "Fits your budget",
        pass: ceiling === null || cost.minor <= ceiling,
        detail: ceiling === null ? "No ceiling set." : `Costs ${cost.minor} of ${ceiling} minor units.`,
      },
      {
        label: "Seats your group",
        pass: exp.capacity === null || exp.capacity >= ctx.partySize,
        detail: exp.capacity === null ? "No limit." : `Seats ${exp.capacity}.`,
      },
    ],
    verdict: totalMin <= ctx.availableMin ? (totalMin * 1.2 <= ctx.availableMin ? "fits" : "tight") : "does_not_fit",
  };
}

export type PlannerOptions = {
  /** A real engine owns its catalogue; `replan` is not handed one. */
  catalogue: readonly Experience[];
  /** Weather-blind mode: re-solve the previous order, not the ranking. */
  preferPreviousOrder?: boolean;
  weights?: WeightProfile;
};

/** The objective this planner claims for a plan. Recomputed by `validate`. */
export const objectiveOf = (plan: Plan): number =>
  round(plan.stops.reduce((sum, stop) => sum + stop.score.total, 0));

export function planner(options: PlannerOptions): EnginePort {
  const { catalogue } = options;
  const base = options.weights ?? DEFAULT_WEIGHTS;
  const weight = (key: string, fallback: number): number => base.weights[key] ?? fallback;

  /**
   * Category or exact keyword match only. Loose substring matching let
   * "heritage office" satisfy an interest of "heritage", which is not a fact.
   */
  const interestHits = (ctx: DiscoveryContext, exp: Experience): number =>
    ctx.interests.filter((interest) => exp.category === interest || exp.keywords.includes(interest)).length;

  const scoreOf = (ctx: DiscoveryContext, exp: Experience): ScoreBreakdown => {
    const metres = metresBetween(originOf(ctx), exp.location);
    const components = [
      { key: "interest", label: "Matches what you asked for", value: round(interestHits(ctx, exp) * 25 * weight("interest", 1)), weight: weight("interest", 1) },
      { key: "rating", label: "Rated by people who went", value: round(exp.rating.value * 8 * weight("rating", 1)), weight: weight("rating", 1) },
      { key: "proximity", label: "Close by", value: round(20 * (1 - Math.min(1, metres / 2000)) * weight("proximity", 1)), weight: weight("proximity", 1) },
    ];
    return {
      experienceId: exp.id,
      total: round(components.reduce((sum, part) => sum + part.value, 0)),
      components,
      profileVersion: PROFILE_VERSION,
      learnedComponents: [],
    };
  };

  /**
   * Greedy sequential pack over the list exactly as it arrives, with a real travel
   * leg between consecutive stops and a real `duration_exceeds_budget` rejection
   * for anything that no longer fits in the window.
   *
   * The incoming order is the ranking the pipeline already computed, and the
   * packer does not re-rank it: `discover()` sorts by score precisely so the
   * packer gets a stable input, and a packer that re-sorted would quietly undo
   * every penalty the scorer applied.
   */
  const buildPlan = (ctx: DiscoveryContext, items: readonly Experience[], prefer: readonly string[] = []): Plan => {
    const mode = ROUTER_MODE[ctx.travelMode];
    const deadline = ctx.nowMin + ctx.availableMin;
    const scores = new Map(items.map((item) => [item.id, scoreOf(ctx, item)]));
    const byId = new Map(items.map((item) => [item.id, item]));
    const sequence = prefer.length === 0
      ? [...items]
      : [
          ...prefer.map((id) => byId.get(id)).filter((item): item is Experience => item !== undefined),
          ...items.filter((item) => !prefer.includes(item.id)),
        ];

    const stops: PlanStop[] = [];
    const legs: TravelLeg[] = [];
    const rejected: Rejection[] = [];
    let clock = ctx.nowMin;
    let here = originOf(ctx);

    for (const item of sequence) {
      if (stops.some((stop) => stop.experienceId === item.id)) continue;
      const metres = metresBetween(here, item.location);
      const minutes = travelMin(metres, mode);
      const fit = fitOf(ctx, item, minutes);
      if (clock + fit.totalMin > deadline) {
        rejected.push({
          experienceId: item.id,
          code: "duration_exceeds_budget",
          message: `${item.name} needs ${fit.totalMin} min with the journey, and ${ctx.availableMin} min is all you have.`,
          shortfall: clock + fit.totalMin - deadline,
          unit: "minutes",
          relaxable: true,
        });
        continue;
      }
      const previous = stops[stops.length - 1];
      if (previous) {
        legs.push({
          fromId: previous.experienceId,
          toId: item.id,
          mode,
          minutes,
          metres,
          detail: null,
          estimated: true,
        });
      }
      const arrive = clock + minutes;
      const score = scores.get(item.id) ?? scoreOf(ctx, item);
      stops.push({
        experienceId: item.id,
        arriveMin: arrive,
        departMin: arrive + item.durationMin,
        order: stops.length,
        why: [
          `${score.total} points: ${score.components.map((part) => part.label).join(", ")}.`,
          `${item.durationMin} min on site, ${item.indoorOutdoor}.`,
        ],
        fit,
        score,
      });
      clock = arrive + item.durationMin;
      here = item.location;
    }

    const totalMin = stops.length > 0 ? stops[stops.length - 1]!.departMin - ctx.nowMin : 0;
    const ids = stops.map((stop) => stop.experienceId);
    return PlanSchema.parse({
      // Content-addressed so the same plan has the same id on every run: a
      // determinism assertion can then compare whole plans, not just stop lists.
      id: `plan-${ctx.id}-${ids.join("_") || "empty"}`,
      contextId: ctx.id,
      stops,
      legs,
      totalMin,
      totalCost: rupees(stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0)),
      utilisation: totalMin / Math.max(1, ctx.availableMin),
      totalMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
      rejected,
      createdAt: CREATED_AT,
      engineVersion: ENGINE_VERSION,
    });
  };

  return {
    retrieve(input: RetrieveInput): Experience[] {
      return input.catalogue
        .map((item) => ({ item, hits: interestHits(input.context, item) }))
        .sort((a, b) => b.hits - a.hits || a.item.id.localeCompare(b.item.id))
        .slice(0, input.limit)
        .map((entry) => entry.item);
    },

    filterFeasible(ctx: DiscoveryContext, items: Experience[]): FeasibleResult {
      const passed: string[] = [];
      const rejected: Rejection[] = [];
      for (const item of items) {
        if (ctx.excludedIds.includes(item.id)) {
          rejected.push({
            experienceId: item.id,
            code: "excluded_by_traveller",
            message: `${item.name} is off the list for this search.`,
            shortfall: null,
            unit: null,
            relaxable: false,
          });
          continue;
        }
        if (item.capacity !== null && item.capacity < ctx.partySize) {
          rejected.push({
            experienceId: item.id,
            code: "capacity_exceeded",
            message: `${item.name} seats ${item.capacity}, and there are ${ctx.partySize} of you.`,
            shortfall: ctx.partySize - item.capacity,
            unit: "people",
            relaxable: true,
          });
          continue;
        }
        if (item.durationMin > ctx.availableMin) {
          rejected.push({
            experienceId: item.id,
            code: "duration_exceeds_budget",
            message: `${item.name} needs ${item.durationMin} min on site and you have ${ctx.availableMin}.`,
            shortfall: item.durationMin - ctx.availableMin,
            unit: "minutes",
            relaxable: false,
          });
          continue;
        }
        passed.push(item.id);
      }
      return { passed, rejected };
    },

    score(ctx: DiscoveryContext, items: Experience[]): ScoreBreakdown[] {
      return items.map((item) => scoreOf(ctx, item));
    },

    pack(ctx: DiscoveryContext, items: Experience[]): Plan {
      return buildPlan(ctx, items);
    },

    validate(plan: Plan): ValidationResult {
      const violations: ValidationResult["violations"] = [];
      const cost = plan.stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
      if (cost !== plan.totalCost.minor) {
        violations.push({ code: "cost_drift", message: "Stop costs do not add up to the plan total.", at: null });
      }
      const window = plan.stops[0]?.fit.availableMin ?? 0;
      if (plan.totalMin > window) {
        violations.push({ code: "over_window", message: `Plan is ${plan.totalMin} min inside a ${window} min window.`, at: null });
      }
      if (!plan.stops.every((stop, index) => stop.order === index && stop.arriveMin <= stop.departMin)) {
        violations.push({ code: "order_drift", message: "Stops are not in arrival order.", at: null });
      }
      const objective = objectiveOf(plan);
      return { ok: violations.length === 0, violations, recomputedObjective: objective, claimedObjective: objective, objectiveDelta: 0 };
    },

    replan(prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult {
      // A real engine re-solves from the catalogue. In `preferPreviousOrder` mode
      // it only re-solves the order it already had, so it cannot notice a new sky
      // on its own — which is exactly the engine this gate exists to cover.
      const candidates = catalogue
        .filter((item) => !ctx.excludedIds.includes(item.id))
        .sort((a, b) => scoreOf(ctx, b).total - scoreOf(ctx, a).total || a.id.localeCompare(b.id));
      const plan = buildPlan(ctx, candidates, options.preferPreviousOrder ? prev.stops.map((stop) => stop.experienceId) : []);
      const wasThere = new Set(prev.stops.map((stop) => stop.experienceId));
      const kept = new Set(plan.stops.map((stop) => stop.experienceId));
      return {
        plan,
        change,
        swaps: [
          ...prev.stops.filter((stop) => !kept.has(stop.experienceId)).map((stop) => ({
            removedId: stop.experienceId,
            addedId: null,
            reason: `Dropped after: ${change.narrative}`,
            scoreDelta: 0,
          })),
          ...plan.stops.filter((stop) => !wasThere.has(stop.experienceId)).map((stop) => ({
            removedId: null,
            addedId: stop.experienceId,
            reason: stop.why[0] ?? `Added after: ${change.narrative}`,
            scoreDelta: stop.score.total,
          })),
        ],
        preservedIntent: true,
        summary: "Re-solved for the new situation.",
      };
    },

    computeFit(ctx: DiscoveryContext, exp: Experience): Fit {
      const mode = ROUTER_MODE[ctx.travelMode];
      return fitOf(ctx, exp, travelMin(metresBetween(originOf(ctx), exp.location), mode));
    },

    stress(plan: Plan, ctx: DiscoveryContext) {
      const pressure = Math.min(100, Math.round((plan.totalMin / Math.max(1, ctx.availableMin)) * 100));
      return {
        score: pressure,
        factors: [{
          dimension: "time",
          weight: 1,
          value: pressure,
          rescue: pressure >= 90 ? "Drop a stop, or ask for more time." : null,
        }],
      };
    },

    travelBetween(from: GeoPoint, to: GeoPoint, mode: TravelMode, _atMin: number): TravelLeg {
      const metres = metresBetween(from, to);
      return {
        fromId: `${from.lat},${from.lon}`,
        toId: `${to.lat},${to.lon}`,
        mode,
        minutes: travelMin(metres, mode),
        metres,
        detail: null,
        estimated: true,
      };
    },
  };
}
