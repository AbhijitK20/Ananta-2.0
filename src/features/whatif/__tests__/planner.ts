/**
 * A deterministic planner double, shared by the what-if tests.
 *
 * WHY THIS IS A PLANNER AND NOT A SCRIPT. The discovery feature's own fake
 * returns a fixed plan, which is right for testing a diff and useless here: if
 * `pack` ignores its context, then a simulation that ran the real pipeline and a
 * simulation that did nothing at all produce identical bytes, and these tests
 * would pass for the wrong reason. So this reads `ctx.availableMin`, `ctx.budget`,
 * `ctx.weather` and the `max_walk_*` token out of the context it is handed, packs
 * greedily against them with real arithmetic, and logs every call with the
 * context it received.
 *
 * That log is what turns "the simulation genuinely executes the planner" from a
 * claim into an assertion. If the hypothetical's budget never reached `pack`, the
 * money scenario could not possibly have worked.
 *
 * It is also a *plausible* planner, not a real one. Greedy nearest-first, no
 * 2-opt, no clustering. That is enough to make constraint interactions
 * interesting — the window binds before the money at high budgets, which is the
 * whole point of the ladder — and not enough to be mistaken for the engine. The
 * engine is Abhijit's; nothing here is a substitute for it.
 *
 * THE WORLD is six places on one line, 556 m apart, ₹250 each per person, 45
 * minutes on site. That spacing is load-bearing. With a party of two each stop
 * costs ₹500, and the travel is 7 minutes a hop, which puts the constraints in
 * this order of tightness:
 *
 *   ₹1500  budget binds at 3 stops   (a 4th is exactly ₹500 over)
 *   ₹2000  budget binds at 4 stops   (a 5th is ₹500 over)
 *   ₹2500  money stops binding, the 240-minute window binds at 4
 *   240min time binds at 4 stops     (5 would need 253)
 *   300min time binds at 5 stops     (6 would need 305)
 *
 * So a budget ladder saturates because of TIME, which is the insight the feature
 * exists to surface: "₹500 more buys a stop, and after that it is your afternoon
 * that is the limit, not your money."
 */
import {
  Experience as ExperienceSchema,
  Plan as PlanSchema,
  type DiscoveryContext,
  type Experience,
  type Fit,
  type GeoPoint,
  type Plan,
  type PlanStop,
  type Rejection,
  type TravelLeg,
  type ValidationResult,
} from "../../../contracts";
import { money } from "../../discovery/format";
import type { EnginePort, TravelMode } from "../../discovery/engine";
import { walkCapOf } from "..";

const AT = "2026-01-01T00:00:00.000Z";
const EARTH_R = 6371000;
const WALK_M_PER_MIN = 80;
const BUFFER_MIN = 5;

/** ₹250 per person, in paise. The contract says money is minor units. */
export const PRICE_PER_PERSON = 25000;
export const PARTY_SIZE = 2;
/** ₹500 per stop at two people. Every budget boundary below is a multiple of this. */
export const PER_STOP = PRICE_PER_PERSON * PARTY_SIZE;
export const DURATION_MIN = 45;
/** 0.005° of latitude, which is 556 m and rounds to a 7-minute walk. */
export const HOP_METRES = 556;
export const HOP_MINUTES = 7;
export const NOW_MIN = 600;
export const WINDOW_MIN = 240;

const PLACES = [
  { id: "market", name: "Colaba street market", lat: 19.0, rating: 4.9, weather: "rain", indoorOutdoor: "outdoor" },
  { id: "chaat", name: "Corner chaat stall", lat: 19.005, rating: 4.7, weather: "rain", indoorOutdoor: "outdoor" },
  { id: "cafe", name: "Indoor cafe", lat: 19.01, rating: 4.5, weather: "none", indoorOutdoor: "indoor" },
  { id: "gallery", name: "Courtyard gallery", lat: 19.015, rating: 4.3, weather: "rain", indoorOutdoor: "covered" },
  { id: "fort", name: "Fort overlook", lat: 19.02, rating: 4.1, weather: "rain", indoorOutdoor: "outdoor" },
  { id: "craft", name: "Indoor craft workshop", lat: 19.025, rating: 3.9, weather: "none", indoorOutdoor: "indoor" },
] as const;

const rupees = (minor: number) => ({ minor, currency: "INR" as const });

export function place(spec: (typeof PLACES)[number]): Experience {
  return ExperienceSchema.parse({
    id: spec.id,
    name: spec.name,
    category: "cafe",
    location: { lat: spec.lat, lon: 72.87 },
    durationMin: DURATION_MIN,
    pricePerPerson: rupees(PRICE_PER_PERSON),
    capacity: null,
    hours: { raw: "Mo-Su 09:00-22:00", status: "ok", lastVerified: null },
    indoorOutdoor: spec.indoorOutdoor,
    accessibility: {
      stepFree: null,
      strollerOk: null,
      lowStairs: null,
      seatingAvailable: null,
      hearingLoop: null,
      restroomOnSite: null,
    },
    kidFriendly: null,
    minAge: null,
    diets: [],
    cuisines: [],
    rating: { value: spec.rating, count: 210, rawMean: spec.rating },
    blurb: null,
    description: null,
    keywords: [],
    weatherSensitive: spec.weather,
    neighbourhood: "Colaba",
    city: "Mumbai",
  });
}

export const CATALOGUE: Experience[] = PLACES.map(place);
export const WEIGHTS = {
  version: "scripted-1",
  weights: { interest: 1, proximity: 1, rating: 1 },
  source: "prior" as const,
  updatedAt: AT,
  observations: 0,
} as const;

export const metresBetween = (a: GeoPoint, b: GeoPoint): number => {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
};

const legBetween = (from: GeoPoint, to: GeoPoint, mode: TravelMode, atMin: number): TravelLeg => {
  void atMin;
  const metres = Math.round(metresBetween(from, to));
  return {
    fromId: `${from.lat},${from.lon}`,
    toId: `${to.lat},${to.lon}`,
    mode,
    minutes: Math.max(1, Math.round(metres / WALK_M_PER_MIN)),
    metres,
    detail: null,
    estimated: true,
  };
};

/** A real fit, computed from the actual leg rather than a constant. */
export function fitFor(ctx: DiscoveryContext, item: Experience, travelMin: number): Fit {
  const totalMin = item.durationMin + travelMin + BUFFER_MIN;
  const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;
  const withinBudget = !ctx.budget || cost <= ctx.budget.minor;
  const withinWindow = totalMin <= ctx.availableMin;
  return {
    experienceId: item.id,
    travelMin,
    activityMin: item.durationMin,
    bufferMin: BUFFER_MIN,
    totalMin,
    availableMin: ctx.availableMin,
    fitRatio: totalMin / Math.max(1, ctx.availableMin),
    cost: rupees(cost),
    budget: ctx.budget,
    checks: [
      {
        label: "Fits your window",
        pass: withinWindow,
        detail: `${item.durationMin} min on site, ${travelMin} min travel.`,
      },
      {
        label: "Within budget",
        pass: withinBudget,
        detail: `This stop costs ${money(cost)}.`,
      },
    ],
    verdict: withinWindow && withinBudget ? "fits" : "does_not_fit",
  };
}

function stressOf(plan: Plan, ctx: DiscoveryContext) {
  const overTime = Math.max(0, plan.totalMin - ctx.availableMin);
  const overBudget = ctx.budget ? Math.max(0, plan.totalCost.minor - ctx.budget.minor) : 0;
  const slack = Math.max(0, 1 - plan.utilisation);
  const score = Math.max(
    0,
    Math.min(100, Math.round(slack * 100 + overTime / 2 + overBudget / 1000)),
  );
  return {
    score,
    factors: [
      {
        dimension: "window",
        weight: 1,
        value: plan.utilisation,
        rescue:
          overTime > 0
            ? `Take ${Math.ceil(overTime / 2)} minutes off the day.`
            : slack > 0.4
              ? "There is room in the window for one more stop."
              : null,
      },
    ],
  };
}

/**
 * Plan ids fingerprint the constraints they were built under, so a hypothetical's
 * plan is visibly a different object from the live one, and two identical what-ifs
 * produce an identical id. Without this, a UI keying on plan id renders the live
 * plan and the simulated one in the same slot.
 */
const planIdFor = (ctx: DiscoveryContext): string =>
  `plan-${ctx.id}-${[
    ctx.availableMin,
    ctx.budget?.minor ?? -1,
    ctx.weather.condition,
    ctx.travelMode,
    ctx.avoid.join("|"),
  ].join("-")}`;

export type PlannerOptions = {
  /** `false` makes the greedy ignore `max_walk_*`, as a broken engine would. */
  honourWalkCap?: boolean;
  packThrows?: Error;
  rejectValidation?: boolean;
  /**
   * Drop the last stop from the plan and say nothing about it. The plan is still
   * internally valid — totals are recomputed — so it passes `validate` and the
   * only evidence of the loss is the absence of a `Rejection`. That is the exact
   * shape of the bug `gates.ts` looks for.
   */
  silentDrop?: boolean;
};

export type EngineCall = {
  fn: string;
  availableMin: number;
  budgetMinor: number | null;
  condition: string;
};

export type Planner = { engine: EnginePort; calls: EngineCall[] };

/**
 * Greedy pack, nearest-first in score order, checking every constraint and
 * emitting a real `Rejection` for each one that bites.
 */
export function scriptedPlanner(options: PlannerOptions = {}): Planner {
  const calls: EngineCall[] = [];
  /** Set by `filterFeasible`, read by `pack`. A real engine owns the whole pipeline. */
  let hardRejections: Rejection[] = [];

  const record = (fn: string, ctx: DiscoveryContext): void => {
    calls.push({
      fn,
      availableMin: ctx.availableMin,
      budgetMinor: ctx.budget?.minor ?? null,
      condition: ctx.weather.condition,
    });
  };

  const pack = (ctx: DiscoveryContext, items: Experience[]): Plan => {
    if (options.packThrows) throw options.packThrows;
    const cap = options.honourWalkCap === false ? null : walkCapOf(ctx);
    const stops: PlanStop[] = [];
    const legs: TravelLeg[] = [];
    const rejected: Rejection[] = [...hardRejections];
    let spend = 0;
    let at = ctx.nowMin;
    let metres = 0;
    let previous: Experience | null = null;

    for (const item of items) {
      const leg = previous ? legBetween(previous.location, item.location, "walk", at) : null;
      const arrive = previous ? at + (leg?.minutes ?? 0) : at;
      const depart = arrive + item.durationMin;
      const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;

      if (depart - ctx.nowMin > ctx.availableMin) {
        const over = depart - ctx.nowMin - ctx.availableMin;
        rejected.push({
          experienceId: item.id,
          code: "duration_exceeds_budget",
          message: `Needs ${over} min more than you have left.`,
          shortfall: over,
          unit: "minutes",
          relaxable: true,
        });
        continue;
      }
      if (ctx.budget && spend + cost > ctx.budget.minor) {
        const over = spend + cost - ctx.budget.minor;
        rejected.push({
          experienceId: item.id,
          code: "over_budget",
          message: `${money(over)} over your budget.`,
          shortfall: over,
          unit: "minor_units",
          relaxable: true,
        });
        continue;
      }
      const nextMetres = metres + (leg?.metres ?? 0);
      if (cap !== null && nextMetres > cap) {
        rejected.push({
          experienceId: item.id,
          code: "too_far",
          message: `${nextMetres - cap} m further than the ${cap} m you allowed.`,
          shortfall: nextMetres - cap,
          unit: "metres",
          relaxable: true,
        });
        continue;
      }

      stops.push({
        experienceId: item.id,
        arriveMin: arrive,
        departMin: depart,
        order: stops.length,
        why: [`Rated ${item.rating.value} and it fits what is left of your window.`],
        score: {
          experienceId: item.id,
          total: Math.round(item.rating.value * 10),
          components: [
            {
              key: "rating",
              label: "Well rated",
              value: Math.round(item.rating.value * 10),
              weight: 1,
              reason: `${item.rating.value} from ${item.rating.count} reviews.`,
            },
          ],
          profileVersion: "scripted-1",
          learnedComponents: [],
        },
        fit: fitFor(ctx, item, leg?.minutes ?? 0),
      });
      if (leg) legs.push(leg);
      spend += cost;
      metres = nextMetres;
      at = depart;
      previous = item;
    }

    // The silent drop happens AFTER the greedy, and touches nothing but `stops`.
    // Everything below is recomputed from whatever survives, so the result is a
    // plan the validator is right to accept.
    const kept = options.silentDrop ? stops.slice(0, -1) : stops;
    const keptLegs = kept.length === stops.length ? legs : legs.slice(0, Math.max(0, kept.length - 1));
    const last = kept.at(-1);
    const totalMin = last ? Math.max(0, last.departMin - ctx.nowMin) : 0;
    const totalCost = kept.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
    const totalMetres = keptLegs.reduce((sum, leg) => sum + leg.metres, 0);

    const built = PlanSchema.parse({
      id: planIdFor(ctx),
      contextId: ctx.id,
      stops: kept,
      legs: keptLegs,
      totalMin,
      totalCost: rupees(totalCost),
      utilisation: kept.length === 0 ? 0 : totalMin / Math.max(1, ctx.availableMin),
      totalMetres,
      rejected,
      createdAt: AT,
      engineVersion: "scripted-1",
    });
    const stressed = stressOf(built, ctx);
    return { ...built, stressScore: stressed.score, stressFactors: stressed.factors };
  };

  const engine: EnginePort = {
    retrieve(input) {
      record("retrieve", input.context);
      return input.catalogue.slice(0, input.limit);
    },
    filterFeasible(ctx, items) {
      record("filterFeasible", ctx);
      const raining =
        ctx.weather.condition === "heavy_rain" || ctx.weather.condition === "light_rain";
      const rejected: Rejection[] = [];
      const passed = items.filter((item) => {
        if (raining && item.weatherSensitive === "rain") {
          rejected.push({
            experienceId: item.id,
            code: "weather_unsafe",
            message: "Rain, and this one has no cover.",
            shortfall: null,
            unit: null,
            relaxable: false,
          });
          return false;
        }
        return true;
      });
      hardRejections = rejected;
      return { passed: passed.map((item) => item.id), rejected };
    },
    score(ctx, items) {
      record("score", ctx);
      return items.map((item) => ({
        experienceId: item.id,
        total: Math.round(item.rating.value * 10),
        components: [],
        profileVersion: "scripted-1",
        learnedComponents: [],
      }));
    },
    pack(ctx, items) {
      record("pack", ctx);
      return pack(ctx, items);
    },
    /**
     * Independent re-derivation, the way the real validator is specified to work:
     * recompute the plan's own arithmetic from its stops and reject on drift.
     */
    validate(plan): ValidationResult {
      const cost = plan.stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
      const objective = plan.stops.reduce((sum, stop) => sum + stop.score.total, 0);
      const violations: ValidationResult["violations"] = [];
      if (options.rejectValidation) {
        violations.push({
          code: "objective_drift",
          message: "Recomputed objective does not match.",
          at: null,
        });
      } else if (cost !== plan.totalCost.minor) {
        violations.push({
          code: "cost_drift",
          message: `Plan claims ${plan.totalCost.minor} but the stops sum to ${cost}.`,
          at: null,
        });
      }
      return {
        ok: violations.length === 0,
        violations,
        recomputedObjective: objective,
        claimedObjective: objective,
        objectiveDelta: 0,
      };
    },
    replan() {
      throw new Error("a what-if must never call replan: it re-solves from scratch");
    },
    computeFit(ctx, item) {
      return fitFor(ctx, item, HOP_MINUTES);
    },
    stress(plan, ctx) {
      return stressOf(plan, ctx);
    },
    travelBetween: legBetween,
  };

  return { engine, calls };
}
