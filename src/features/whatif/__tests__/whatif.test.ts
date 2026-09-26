/**
 * What-if simulation: the tests that decide whether this feature is real.
 *
 * The discovery feature's own fake engine returns a fixed plan, which is right
 * for testing a diff and useless here: if `pack` ignores its context, then a
 * simulation that ran the real pipeline and a simulation that did nothing at all
 * produce identical bytes, and these tests would pass for the wrong reason. So
 * the double below is a *planner*, not a script. It reads `ctx.availableMin`,
 * `ctx.budget`, `ctx.weather` and the `max_walk_*` token out of the context it is
 * handed, packs greedily against them with real arithmetic, and logs every call
 * with the context it received.
 *
 * That log is what turns "the simulation genuinely executes the planner" from a
 * claim into an assertion: if the hypothetical's budget never reached `pack`,
 * the money scenario could not possibly have worked.
 *
 * The immutability guarantee is tested with `Object.freeze`, not with a
 * before/after snapshot. Every code path in `simulate` is then either a write and
 * a thrown TypeError, or no write at all — so a regression that starts mutating
 * the live trip fails loudly instead of quietly producing an equal-looking
 * result.
 */
import { describe, expect, it } from "vitest";
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
import { createContext, type ContextSeed } from "../../discovery/context";
import type { EnginePort, TravelMode } from "../../discovery/engine";
import { createSession, discover } from "../../discovery/replanner";
import {
  SCENARIO_PRESETS,
  SCENARIO_PRESET_BY_ID,
  deltaOf,
  simulate,
  walkCapOf,
  walkCapToken,
  type ScenarioEdit,
  type ScenarioResult,
} from "..";

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

const AT = "2026-01-01T00:00:00.000Z";
const NOW_MIN = 600;
const WALK_M_PER_MIN = 80;
const BUFFER_MIN = 5;
const EARTH_R = 6371000;

/** Budget in paise, so ₹1500 is 150000 and never 1500. */
const FIFTEEN_HUNDRED = 150000;
const TWENTY_HUNDRED = 200000;

/**
 * Five places on one line, 556 m apart. The spacing is the point: two stops cost
 * 556 m of walking, three cost 1113 m. A "no more than 1 km on foot" hypothetical
 * therefore has a real, non-trivial answer, and the walk-cap test can tell the
 * difference between honouring the cap and ignoring it.
 *
 * Ratings descend so the planner's order is `a, b, c, d, e` and every assertion
 * about which stop was added or removed is about a named place.
 */
const PLACES = [
  { id: "market", name: "Colaba street market", lat: 19.0, rating: 4.8, weather: "rain", indoorOutdoor: "outdoor" },
  { id: "chaat", name: "Corner chaat stall", lat: 19.005, rating: 4.6, weather: "rain", indoorOutdoor: "outdoor" },
  { id: "cafe", name: "Indoor cafe", lat: 19.01, rating: 4.4, weather: "none", indoorOutdoor: "indoor" },
  { id: "gallery", name: "Courtyard gallery", lat: 19.015, rating: 4.2, weather: "rain", indoorOutdoor: "covered" },
  { id: "craft", name: "Indoor craft workshop", lat: 19.02, rating: 4.0, weather: "none", indoorOutdoor: "indoor" },
] as const;

const rupees = (minor: number) => ({ minor, currency: "INR" as const });

function place(spec: (typeof PLACES)[number]): Experience {
  return ExperienceSchema.parse({
    id: spec.id,
    name: spec.name,
    category: "cafe",
    location: { lat: spec.lat, lon: 72.87 },
    durationMin: 45,
    pricePerPerson: rupees(25000),
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

const CATALOGUE = PLACES.map(place);

const SEED: ContextSeed = {
  id: "ctx-whatif",
  origin: { label: "Colaba" },
  availableMin: 240,
  nowMin: NOW_MIN,
  budgetMinor: FIFTEEN_HUNDRED,
  partySize: 2,
  interests: ["street_food", "local"],
};

// ---------------------------------------------------------------------------
// The planner double
// ---------------------------------------------------------------------------

const metresBetween = (a: GeoPoint, b: GeoPoint): number => {
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

function fitFor(ctx: DiscoveryContext, item: Experience, travelMin: number): Fit {
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
        detail: `This stop costs ${cost / 100} rupees.`,
      },
    ],
    verdict: withinWindow && withinBudget ? "fits" : "does_not_fit",
  };
}

function stressOf(plan: Plan, ctx: DiscoveryContext) {
  const overTime = Math.max(0, plan.totalMin - ctx.availableMin);
  const overBudget = ctx.budget ? Math.max(0, plan.totalCost.minor - ctx.budget.minor) : 0;
  const slack = Math.max(0, 1 - plan.utilisation);
  const score = Math.max(0, Math.min(100, Math.round(slack * 100 + overTime / 2 + overBudget / 1000)));
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
 * Plan ids are a fingerprint of the constraints they were built under, so a
 * hypothetical's plan is a visibly different object from the live one and two
 * identical what-ifs produce an identical id.
 */
const planIdFor = (ctx: DiscoveryContext): string =>
  `plan-${ctx.id}-${[ctx.availableMin, ctx.budget?.minor ?? -1, ctx.weather.condition, ctx.travelMode, ctx.avoid.join("|")].join("-")}`;

export type PlannerOptions = {
  /** When false, the greedy ignores the `max_walk_*` token, as a broken engine would. */
  honourWalkCap?: boolean;
  packThrows?: Error;
  rejectValidation?: boolean;
};

export type EngineCall = { fn: string; availableMin: number; budgetMinor: number | null };

export function scriptedPlanner(options: PlannerOptions = {}) {
  const calls: EngineCall[] = [];
  /** Set by `filterFeasible`, read by `pack`. A real engine owns the whole pipeline. */
  let hardRejections: Rejection[] = [];

  const record = (fn: string, ctx: DiscoveryContext): void => {
    calls.push({ fn, availableMin: ctx.availableMin, budgetMinor: ctx.budget?.minor ?? null });
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
          message: `${over / 100} rupees over your budget.`,
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
            { key: "rating", label: "Well rated", value: Math.round(item.rating.value * 10), weight: 1, reason: `${item.rating.value} from ${item.rating.count} reviews.` },
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

    const built = PlanSchema.parse({
      id: planIdFor(ctx),
      contextId: ctx.id,
      stops,
      legs,
      totalMin: Math.max(0, at - ctx.nowMin),
      totalCost: rupees(spend),
      utilisation: stops.length === 0 ? 0 : (at - ctx.nowMin) / Math.max(1, ctx.availableMin),
      totalMetres: metres,
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
      const raining = ctx.weather.condition === "heavy_rain" || ctx.weather.condition === "light_rain";
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
    score(ctx, items, weights) {
      record("score", ctx);
      void weights;
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
    validate(plan): ValidationResult {
      const cost = plan.stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
      const objective = plan.stops.reduce((sum, stop) => sum + stop.score.total, 0);
      const violations: ValidationResult["violations"] = [];
      if (options.rejectValidation) {
        violations.push({ code: "objective_drift", message: "Recomputed objective does not match.", at: null });
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
      return fitFor(ctx, item, 10);
    },
    stress(plan, ctx) {
      return stressOf(plan, ctx);
    },
    travelBetween: legBetween,
  };

  return { engine, calls };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const editor = () => createContext(SEED);

const weights = {
  version: "scripted-1",
  weights: { interest: 1, proximity: 1, rating: 1 },
  source: "prior" as const,
  updatedAt: AT,
  observations: 0,
};

/** A session with a live plan, exactly as the app would have it. */
function live(engine: EnginePort) {
  const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights });
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`fixture did not build: ${first.reason}`);
  return first.session;
}

/** Recursively freeze, so any write to the live trip throws instead of passing. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const preset = (id: string) => {
  const found = SCENARIO_PRESET_BY_ID.get(id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

/** Run a preset, failing the test rather than returning a union to narrow. */
function ask(id: string, planner: ReturnType<typeof scriptedPlanner>, session: ReturnType<typeof live>) {
  const outcome = simulate(planner.engine, session, preset(id).edits);
  if (!outcome.ok) throw new Error(`${id} did not simulate: ${outcome.reason}`);
  return outcome.scenario;
}

/** Ids off a diff bucket, and ids off a plan. Different shapes, different helpers. */
const diffIds = (stops: readonly { id: string }[]): string[] => stops.map((stop) => stop.id);
const stopIds = (stops: readonly { experienceId: string }[]): string[] => stops.map((s) => s.experienceId);

// ---------------------------------------------------------------------------
// The two mandatory scenarios
// ---------------------------------------------------------------------------

describe("what-if: more money", () => {
  it("re-plans over ₹2000 while the live ₹1500 plan is untouched", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);

    // Baseline, before anything is simulated: 4h and ₹1500 buys three stops,
    // because the fourth one crosses the ceiling by ₹500.
    expect(session.state.ctx.budget?.minor).toBe(FIFTEEN_HUNDRED);
    expect(session.state.ctx.availableMin).toBe(240);
    expect(session.plan?.stops).toHaveLength(3);
    expect(session.plan?.totalCost.minor).toBe(FIFTEEN_HUNDRED);

    // From here on, the live trip is read-only. A write anywhere in the
    // simulation throws rather than passing quietly.
    deepFreeze(session);
    const snapshot = JSON.stringify(session);

    const result = ask("more_money", planner, session);

    // The hypothetical really is ₹2000, and the planner was told so.
    expect(result.ctx.budget?.minor).toBe(TWENTY_HUNDRED);
    expect(result.change.kind).toBe("budget_grew");
    expect(planner.calls.filter((call) => call.fn === "pack").at(-1)?.budgetMinor).toBe(TWENTY_HUNDRED);

    // The hypothetical plan can change: more money buys a fourth stop.
    expect(result.plan.stops).toHaveLength(4);
    expect(result.plan).not.toBe(session.plan);
    expect(result.delta).toBe("added");
    expect(diffIds(result.reality.added)).toEqual(["gallery"]);
    expect(result.reality.removed).toEqual([]);
    expect(result.compare.stops.delta).toBe(1);
    expect(result.compare.spend.delta).toBe(TWENTY_HUNDRED - FIFTEEN_HUNDRED);
    expect(result.feasible).toBe(true);
    expect(result.breaches).toEqual([]);
    expect(result.validation.ok).toBe(true);

    // And the actual current plan is byte-for-byte what it was.
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(session.state.ctx.budget?.minor).toBe(FIFTEEN_HUNDRED);
    expect(session.state.ctx.availableMin).toBe(240);
    expect(session.plan?.stops).toHaveLength(3);
    expect(session.plan?.totalCost.minor).toBe(FIFTEEN_HUNDRED);
  });
});

describe("what-if: less time", () => {
  it("regenerates an independent 2h plan that is feasible, and keeps the 4h one", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    expect(session.state.ctx.availableMin).toBe(240);
    expect(session.plan?.stops).toHaveLength(3);

    deepFreeze(session);
    const snapshot = JSON.stringify(session);
    const callsBefore = planner.calls.length;

    const result = ask("less_time", planner, session);

    // Independently regenerated: a fresh pack against the whole catalogue under
    // 120 minutes, not a minimal-swap edit of the 240-minute plan.
    expect(result.ctx.availableMin).toBe(120);
    expect(result.change.kind).toBe("time_shrank");
    expect(planner.calls.slice(callsBefore).filter((call) => call.fn === "pack").map((call) => call.availableMin)).toEqual([120]);

    // Feasible on its own terms: inside the new window, inside the old budget.
    expect(result.plan.stops.length).toBeLessThan(3);
    expect(result.plan.totalMin).toBeLessThanOrEqual(120);
    expect(result.plan.totalCost.minor).toBeLessThanOrEqual(FIFTEEN_HUNDRED);
    expect(result.feasible).toBe(true);
    expect(result.breaches).toEqual([]);
    expect(result.validation.ok).toBe(true);
    for (const stop of result.plan.stops) {
      expect(stop.fit.availableMin).toBe(120);
      expect(stop.departMin - session.state.ctx.nowMin).toBeLessThanOrEqual(120);
    }

    expect(result.delta).toBe("removed");
    expect(diffIds(result.reality.removed)).toEqual(["cafe"]);
    expect(result.reality.removed[0]?.reason).toBe("Needs 29 min more than you have left.");
    expect(result.compare.windowMin).toEqual({ before: 240, after: 120, delta: -120, unit: "minutes" });

    // The live 4h plan is still the live 4h plan.
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(session.state.ctx.availableMin).toBe(240);
    expect(session.plan?.totalMin).toBe(149);
    expect(session.plan?.stops).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The guarantee
// ---------------------------------------------------------------------------

describe("what-if: the live trip is never touched", () => {
  it("cannot adopt a hypothetical, because a scenario is not a session", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const outcome = simulate(planner.engine, session, preset("rain").edits);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // There is no `session` on the success type at all. Asserted structurally:
    // a caller holding a ScenarioResult has no way to install it.
    expect(Object.keys(outcome)).toEqual(["ok", "scenario"]);
    expect("session" in outcome.scenario).toBe(false);
  });

  it("keeps the traveller's original ask in the hypothetical", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("less_time", planner, session);
    // Principle 3 survives the counterfactual: a what-if is not a new intent.
    expect(result.ctx.original).toEqual(session.state.ctx.original);
    expect(result.ctx.original.availableMin).toBe(240);
    expect(result.reality.intent).toContain("4h from Colaba");
    expect(result.reality.intent).toContain("under ₹1,500");
  });

  it("leaves the live plan alone when the hypothetical fails to plan", () => {
    // A planner that works, so there is a real live plan to protect...
    const working = scriptedPlanner();
    const session = live(working.engine);
    expect(session.plan?.stops).toHaveLength(3);
    deepFreeze(session);
    const snapshot = JSON.stringify(session);

    // ...then the same session handed to a planner that blows up mid-solve.
    const broken = scriptedPlanner({ packThrows: new Error("solver diverged") });
    const outcome = simulate(broken.engine, session, preset("less_time").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("engine_error");
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(session.plan?.stops).toHaveLength(3);
    expect(session.state.ctx.availableMin).toBe(240);
  });

  it("leaves the live plan alone when the hypothetical fails validation", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    deepFreeze(session);

    const rejecting = scriptedPlanner({ rejectValidation: true });
    const outcome = simulate(rejecting.engine, session, preset("more_money").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("objective_drift");
    expect(session.plan?.stops).toHaveLength(3);
    expect(session.state.ctx.budget?.minor).toBe(FIFTEEN_HUNDRED);
  });

  it("has nothing to compare against before the first plan", () => {
    const planner = scriptedPlanner();
    const session = createSession({ engine: planner.engine, seed: SEED, catalogue: CATALOGUE, weights });
    const outcome = simulate(planner.engine, session, preset("less_time").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("no plan to compare");
  });
});

// ---------------------------------------------------------------------------
// The other two questions
// ---------------------------------------------------------------------------

describe("what-if: rain", () => {
  it("re-plans around the weather and swaps the exposed stops out", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("rain", planner, session);

    expect(result.ctx.weather.condition).toBe("heavy_rain");
    expect(result.change.kind).toBe("weather_changed");
    expect(stopIds(result.plan.stops)).toEqual(["cafe", "craft"]);
    expect(diffIds(result.reality.removed)).toEqual(["market", "chaat"]);
    expect(diffIds(result.reality.added)).toEqual(["craft"]);
    expect(result.delta).toBe("swapped");
    // The reason a stop left is the engine's own sentence, not a generated one.
    expect(result.reality.removed[0]?.reason).toBe("Rain, and this one has no cover.");
    expect(result.reality.warnings).toEqual([]);
    expect(session.state.ctx.weather.condition).toBe("clear");
  });
});

describe("what-if: a walking cap", () => {
  it("honours a 1 km cap and says which stop it cost", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    // Three stops is 1112 m of walking, so the live plan already breaks a 1 km cap.
    expect(session.plan?.totalMetres).toBeGreaterThan(1000);

    const result = ask("less_walking", planner, session);

    expect(result.ctx.avoid).toContain("max_walk_1000m");
    expect(walkCapOf(result.ctx)).toBe(1000);
    expect(result.plan.totalMetres).toBeLessThanOrEqual(1000);
    expect(result.feasible).toBe(true);
    expect(result.delta).toBe("removed");
    expect(diffIds(result.reality.removed)).toEqual(["cafe"]);
    expect(result.reality.removed[0]?.reason).toBe("112 m further than the 1000 m you allowed.");
    expect(session.state.ctx.avoid).not.toContain("max_walk_1000m");
  });

  it("catches a planner that ignored the hypothetical's own cap", () => {
    const planner = scriptedPlanner({ honourWalkCap: false });
    const session = live(planner.engine);
    deepFreeze(session);

    const result = ask("less_walking", planner, session);
    expect(result.feasible).toBe(false);
    expect(result.delta).toBe("infeasible");
    expect(result.breaches).toHaveLength(1);
    const breach = result.breaches[0];
    expect(breach?.axis).toBe("walking");
    expect(breach?.unit).toBe("metres");
    expect(breach?.shortfall).toBe(112);
    expect(breach?.message).toBe("112 m more walking than the 1000 m you allowed.");
    // Still the live plan underneath, and still frozen.
    expect(session.plan?.stops).toHaveLength(3);
  });

  it("replaces a previous cap instead of stacking another one on", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const tight: ScenarioEdit = { kind: "walk_cap_m", metres: 500 };
    const looser: ScenarioEdit = { kind: "walk_cap_m", metres: 5000 };

    const first = ask("less_walking", planner, session);
    const capped = simulate(planner.engine, { ...session, state: { ...session.state, ctx: first.ctx } }, [tight]);
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.scenario.ctx.avoid.filter((token) => token.startsWith("max_walk_"))).toEqual(["max_walk_500m"]);

    const widened = simulate(planner.engine, { ...session, state: { ...session.state, ctx: capped.scenario.ctx } }, [looser]);
    expect(widened.ok).toBe(true);
    if (!widened.ok) return;
    expect(widened.scenario.ctx.avoid.filter((token) => token.startsWith("max_walk_"))).toEqual(["max_walk_5000m"]);
    expect(walkCapToken(1000)).toBe("max_walk_1000m");
  });
});

// ---------------------------------------------------------------------------
// Refusals, and the shape of the answer
// ---------------------------------------------------------------------------

describe("what-if: honest refusals", () => {
  it("refuses to add money to a trip with no budget", () => {
    const planner = scriptedPlanner();
    const noBudget = createContext({ ...SEED, budgetMinor: null });
    const session = createSession({ engine: planner.engine, seed: { ...SEED, budgetMinor: null }, catalogue: CATALOGUE, weights });
    const first = discover(planner.engine, session);
    if (!first.ok) throw new Error(first.reason);
    expect(noBudget.ctx.budget).toBeNull();

    const outcome = simulate(planner.engine, first.session, preset("more_money").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // "No limit" must not quietly become a ₹500 ceiling, which would be a
    // restriction dressed up as a loosening.
    expect(outcome.reason).toContain("no budget");
    expect(first.session.state.ctx.budget).toBeNull();
  });

  it("refuses a scenario that changes nothing", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const outcome = simulate(planner.engine, session, [{ kind: "time", availableMin: 240 }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("would not change anything");
  });

  it("gives every named question a scenario, and every scenario a real answer", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    expect(SCENARIO_PRESETS.map((entry) => entry.id)).toEqual([
      "more_money",
      "less_time",
      "rain",
      "less_walking",
    ]);
    for (const entry of SCENARIO_PRESETS) {
      expect(entry.question, entry.id).toMatch(/\?$/);
      expect(entry.edits.length, entry.id).toBeGreaterThan(0);
      const result = ask(entry.id, planner, session);
      expect(result.plan, entry.id).not.toBe(session.plan);
      expect(result.validation.ok, entry.id).toBe(true);
      expect(PlanSchema.safeParse(result.plan).success, entry.id).toBe(true);
      expect(result.ctx.id, entry.id).toBe(session.state.ctx.id);
    }
  });

  it("folds a multi-part question into one hypothetical", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const outcome = simulate(planner.engine, session, [
      { kind: "budget_delta", minor: 50000 },
      { kind: "time", availableMin: 120 },
      { kind: "indoor_only", on: true },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result: ScenarioResult = outcome.scenario;
    expect(result.ctx.budget?.minor).toBe(TWENTY_HUNDRED);
    expect(result.ctx.availableMin).toBe(120);
    expect(result.ctx.avoid).toContain("indoors_only");
    expect(result.plan.totalMin).toBeLessThanOrEqual(120);
    expect(session.state.ctx.availableMin).toBe(240);
    expect(session.state.ctx.avoid).not.toContain("indoors_only");
  });
});

describe("what-if: the comparison", () => {
  it("reports budget, time, walking and fit for both plans", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("more_money", planner, session);

    expect(result.compare.stops).toEqual({ before: 3, after: 4, delta: 1, unit: "count" });
    expect(result.compare.spend).toEqual({ before: 150000, after: 200000, delta: 50000, unit: "minor_units" });
    expect(result.compare.budgetCeiling).toEqual({ before: 150000, after: 200000, delta: 50000, unit: "minor_units" });
    expect(result.compare.plannedMin.before).toBe(149);
    expect(result.compare.plannedMin.after).toBe(201);
    expect(result.compare.windowMin).toEqual({ before: 240, after: 240, delta: 0, unit: "minutes" });
    expect(result.compare.walkingMetres.before).toBe(1112);
    expect(result.compare.walkingMetres.after).toBe(1668);
    expect(result.compare.utilisation.before).toBeCloseTo(149 / 240, 2);
    expect(result.compare.meanFitRatio.unit).toBe("ratio");
    // A real per-stop fit, recomputed for this plan rather than a constant: the
    // first stop pays no travel leg, so it cannot have the same ratio as the rest.
    const ratios = result.plan.stops.map((stop) => stop.fit.fitRatio);
    expect(new Set(ratios).size).toBeGreaterThan(1);
    // Derived from each plan separately, so neither column is the other's.
    const meanOf = (stops: readonly { fit: { fitRatio: number } }[]): number =>
      stops.reduce((sum, stop) => sum + stop.fit.fitRatio, 0) / stops.length;
    expect(result.compare.meanFitRatio.after).toBeCloseTo(meanOf(result.plan.stops), 5);
    expect(result.compare.meanFitRatio.before).toBeCloseTo(meanOf(session.plan?.stops ?? []), 5);
    // More of the same window used, so the day is less stressful, not more.
    expect(result.compare.stress.delta).toBeLessThan(0);
  });

  it("scores the live plan against the hypothetical, so pointless churn is visible", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("less_time", planner, session);
    // The 240-minute plan under a 120-minute window is 49 minutes over.
    expect(result.reality.stressBefore).not.toBeNull();
    expect(result.reality.stressBefore ?? 0).toBeGreaterThan(result.reality.after.stressScore);
  });

  it("classifies the shape of every possible answer", () => {
    expect(deltaOf(0, 0, false)).toBe("infeasible");
    expect(deltaOf(1, 0, false)).toBe("infeasible");
    expect(deltaOf(0, 0, true)).toBe("unchanged");
    expect(deltaOf(1, 0, true)).toBe("added");
    expect(deltaOf(0, 1, true)).toBe("removed");
    expect(deltaOf(1, 1, true)).toBe("swapped");
  });
});
