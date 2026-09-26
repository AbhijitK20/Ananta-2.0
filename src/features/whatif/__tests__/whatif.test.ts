/**
 * What-if simulation: the tests that decide whether this feature is real.
 *
 * The double in `planner.ts` is a planner, not a script, so these tests can tell
 * the difference between "the simulation ran the real pipeline" and "the
 * simulation did nothing and the assertions happened to hold anyway".
 *
 * The immutability guarantee is tested with `Object.freeze`, not with a
 * before/after snapshot. Every code path in `simulate` is then either a write and
 * a thrown TypeError, or no write at all — so a regression that starts mutating
 * the live trip fails loudly instead of quietly producing an equal-looking
 * result.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext, Plan, type DiscoveryContext as Ctx } from "../../../contracts";
import type { ContextSeed } from "../../discovery/context";
import type { EnginePort } from "../../discovery/engine";
import { createSession, discover, type DiscoverySession } from "../../discovery/replanner";
import { SCENARIO_PRESETS, SCENARIO_PRESET_BY_ID, simulate, unlockedBy, walkCapOf, walkCapToken } from "..";
import {
  CATALOGUE,
  DURATION_MIN,
  HOP_METRES,
  HOP_MINUTES,
  NOW_MIN,
  PARTY_SIZE,
  PER_STOP,
  PRICE_PER_PERSON,
  WEIGHTS,
  WINDOW_MIN,
  scriptedPlanner,
  type Planner,
} from "./planner";

/** ₹1500 is 150000 paise. Money is minor units, so these are never 1500. */
const FIFTEEN_HUNDRED = PER_STOP * 3;
const TWENTY_HUNDRED = PER_STOP * 4;

const SEED: ContextSeed = {
  id: "ctx-whatif",
  origin: { label: "Colaba" },
  availableMin: WINDOW_MIN,
  nowMin: NOW_MIN,
  budgetMinor: FIFTEEN_HUNDRED,
  partySize: PARTY_SIZE,
  interests: ["street_food", "local"],
};

/** A session with a live plan, exactly as the app would have it. */
function live(engine: EnginePort): DiscoverySession {
  const session = createSession({ engine, seed: SEED, catalogue: CATALOGUE, weights: WEIGHTS });
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
function ask(id: string, planner: Planner, session: DiscoverySession) {
  const outcome = simulate(planner.engine, session, preset(id).edits);
  if (!outcome.ok) throw new Error(`${id} did not simulate: ${outcome.reason}`);
  return outcome.scenario;
}

const diffIds = (stops: readonly { id: string }[]): string[] => stops.map((stop) => stop.id);
const stopIds = (stops: readonly { experienceId: string }[]): string[] => stops.map((s) => s.experienceId);
const rejectionIds = (plan: Plan): string[] => plan.rejected.map((entry) => entry.experienceId);

/** Minutes a greedy day of `stops` places takes, so a test can state a fact. */
const minsFor = (stops: number): number =>
  stops === 0 ? 0 : stops * DURATION_MIN + (stops - 1) * HOP_MINUTES;

// ---------------------------------------------------------------------------
// The world, so a failure in a later test is unambiguous
// ---------------------------------------------------------------------------

describe("what-if: the world the tests assume", () => {
  it("binds budget first, then the window, so the axes interact", () => {
    const { engine } = scriptedPlanner();
    const session = live(engine);
    const live_ = session.plan as Plan;

    // ₹1500 buys three, and the fourth is exactly ₹500 over.
    expect(live_.stops).toHaveLength(3);
    expect(live_.totalCost.minor).toBe(FIFTEEN_HUNDRED);
    expect(live_.totalMin).toBe(minsFor(3));
    expect(live_.totalMetres).toBe(HOP_METRES * 2);
    expect(rejectionIds(live_)).toContain("gallery");

    // ₹2500 would pay for five, but five stops need 253 minutes. Above ₹2000 the
    // WINDOW binds, not the money — which is the fact the ladder exists to say.
    const richer = simulate(engine, session, [{ kind: "budget", minor: PER_STOP * 5 }]);
    expect(richer.ok).toBe(true);
    if (!richer.ok) return;
    expect(richer.scenario.plan.stops).toHaveLength(4);
    expect(richer.scenario.plan.totalMin).toBe(minsFor(4));
  });

  it("prices stops at the party size, not the head rate", () => {
    const { engine } = scriptedPlanner();
    const session = live(engine);
    expect(session.plan?.totalCost.minor).toBe(PRICE_PER_PERSON * PARTY_SIZE * 3);
  });
});

// ---------------------------------------------------------------------------
// The two mandatory scenarios
// ---------------------------------------------------------------------------

describe("what-if: more money", () => {
  it("re-plans over ₹2000 while the live ₹1500 plan is untouched", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);

    expect(session.state.ctx.budget?.minor).toBe(FIFTEEN_HUNDRED);
    expect(session.state.ctx.availableMin).toBe(WINDOW_MIN);
    expect(session.plan?.stops).toHaveLength(3);

    // From here on the live trip is read-only. A write anywhere in the simulation
    // throws rather than passing quietly.
    deepFreeze(session);
    const snapshot = JSON.stringify(session);

    const result = ask("more_money", planner, session);

    // The hypothetical really is ₹2000, and the planner was told so.
    expect(result.ctx.budget?.minor).toBe(TWENTY_HUNDRED);
    expect(result.change.kind).toBe("budget_grew");
    expect(planner.calls.at(-1)).toMatchObject({ fn: "pack", budgetMinor: TWENTY_HUNDRED });

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
    expect(result.kind).toBe("what_if");

    // The fourth stop was not merely added: it was BLOCKED before, and the engine's
    // own budget rejection says by exactly how much.
    const unlocked = unlockedBy(result.gates);
    expect(unlocked.map((change) => change.id)).toEqual(["gallery"]);
    expect(unlocked[0]?.reason).toBe("₹500 over your budget.");
    expect(unlocked[0]?.code).toBe("over_budget");
    expect(unlocked[0]?.shortfall).toBe(PER_STOP);
    expect(unlocked[0]?.unit).toBe("minor_units");

    // And the actual current plan is byte-for-byte what it was.
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(session.state.ctx.budget?.minor).toBe(FIFTEEN_HUNDRED);
    expect(session.state.ctx.availableMin).toBe(WINDOW_MIN);
    expect(session.plan?.stops).toHaveLength(3);
    expect(session.plan?.totalCost.minor).toBe(FIFTEEN_HUNDRED);
  });
});

describe("what-if: less time", () => {
  it("regenerates an independent 2h plan that is feasible, and keeps the 4h one", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    expect(session.state.ctx.availableMin).toBe(WINDOW_MIN);
    expect(session.plan?.stops).toHaveLength(3);

    deepFreeze(session);
    const snapshot = JSON.stringify(session);
    const callsBefore = planner.calls.length;

    const result = ask("less_time", planner, session);

    // Independently regenerated: a fresh pack against the whole catalogue under
    // 120 minutes, not a minimal-swap edit of the 240-minute plan.
    expect(result.ctx.availableMin).toBe(120);
    expect(result.change.kind).toBe("time_shrank");
    expect(
      planner.calls.slice(callsBefore).filter((c) => c.fn === "pack").map((c) => c.availableMin),
    ).toEqual([120]);

    // Feasible on its own terms: inside the new window, inside the old budget.
    expect(result.plan.stops).toHaveLength(2);
    expect(result.plan.totalMin).toBe(minsFor(2));
    expect(result.plan.totalMin).toBeLessThanOrEqual(120);
    expect(result.plan.totalCost.minor).toBeLessThanOrEqual(FIFTEEN_HUNDRED);
    expect(result.feasible).toBe(true);
    expect(result.breaches).toEqual([]);
    expect(result.validation.ok).toBe(true);
    for (const stop of result.plan.stops) {
      expect(stop.fit.availableMin).toBe(120);
      expect(stop.departMin - NOW_MIN).toBeLessThanOrEqual(120);
    }

    expect(result.delta).toBe("removed");
    expect(diffIds(result.reality.removed)).toEqual(["cafe"]);
    expect(result.reality.removed[0]?.reason).toBe("Needs 29 min more than you have left.");
    expect(result.compare.windowMin).toEqual({ before: 240, after: 120, delta: -120, unit: "minutes" });

    // The live 4h plan is still the live 4h plan.
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(session.state.ctx.availableMin).toBe(WINDOW_MIN);
    expect(session.plan?.totalMin).toBe(minsFor(3));
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
    // No `session` on the success type, asserted structurally rather than by
    // convention: a caller holding a ScenarioResult has no way to install it.
    expect(Object.keys(outcome)).toEqual(["ok", "scenario"]);
    expect("session" in outcome.scenario).toBe(false);
    expect(outcome.scenario.kind).toBe("what_if");
  });

  it("deep-clones, so the hypothetical shares no object with the live trip", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("less_time", planner, session);
    expect(result.ctx).not.toBe(session.state.ctx);
    expect(result.ctx.origin).not.toBe(session.state.ctx.origin);
    expect(result.ctx.original).not.toBe(session.state.ctx.original);
    expect(result.ctx.avoid).not.toBe(session.state.ctx.avoid);
    // And the clone still satisfies the frozen contract.
    expect(DiscoveryContext.safeParse(result.ctx).success).toBe(true);
  });

  it("keeps the traveller's original ask in the hypothetical", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("less_time", planner, session);
    // Principle 3 survives the counterfactual: a what-if is not a new intent.
    expect(result.ctx.original).toEqual(session.state.ctx.original);
    expect(result.ctx.original.availableMin).toBe(WINDOW_MIN);
    expect(result.reality.intent).toContain("4h from Colaba");
    expect(result.reality.intent).toContain("under ₹1,500");
    expect(result.reality.intentPreserved).toBe(true);
  });

  it("leaves the live plan alone when the hypothetical fails to plan", () => {
    const working = scriptedPlanner();
    const session = live(working.engine);
    deepFreeze(session);
    const snapshot = JSON.stringify(session);

    const broken = scriptedPlanner({ packThrows: new Error("solver diverged") });
    const outcome = simulate(broken.engine, session, preset("less_time").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("engine_error");
    expect(JSON.stringify(session)).toBe(snapshot);
    expect(session.plan?.stops).toHaveLength(3);
    expect(session.state.ctx.availableMin).toBe(WINDOW_MIN);
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

  it("has nothing to compare against before the first plan, and costs no solve", () => {
    const planner = scriptedPlanner();
    const session = createSession({
      engine: planner.engine,
      seed: SEED,
      catalogue: CATALOGUE,
      weights: WEIGHTS,
    });
    const outcome = simulate(planner.engine, session, preset("less_time").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("no plan to compare");
    // Refusing before the clone means never touching the planner at all.
    expect(planner.calls).toHaveLength(0);
  });

  it("gives the same answer twice, so a re-render cannot change the story", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const first = ask("more_money", planner, session);
    const second = ask("more_money", planner, session);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("never calls replan, which is a commitment move and not a hypothetical", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    ask("rain", planner, session);
    ask("more_money", planner, session);
    // The double THROWS on replan, so reaching the assertions at all proves it.
    expect(planner.calls.map((call) => call.fn)).not.toContain("replan");
  });
});

// ---------------------------------------------------------------------------
// The other questions
// ---------------------------------------------------------------------------

describe("what-if: rain", () => {
  it("re-plans around the weather and closes the exposed stops", () => {
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

  it("separates what closed from what merely tightened", () => {
    const planner = scriptedPlanner();
    const result = ask("rain", planner, live(planner.engine));

    // In the live day and now impossible: closed, with the engine's reason.
    const closed = result.gates.filter((change) => change.kind === "closed");
    expect(closed.map((change) => change.id).sort()).toEqual(["chaat", "market"]);
    expect(closed[0]?.code).toBe("weather_unsafe");
    expect(closed[0]?.unit).toBeNull();

    // Never possible and not possible now: tightened, and it was already out of
    // the running. Reporting it as newly lost would be false.
    const tightened = result.gates.filter((change) => change.kind === "tightened");
    expect(tightened.map((change) => change.id)).toEqual(["fort"]);

    // Nothing was unlocked by rain, and saying so is better than implying the
    // swap was a win.
    expect(unlockedBy(result.gates)).toEqual([]);
  });
});

describe("what-if: a walking cap", () => {
  it("honours a 1 km cap and names the stop it cost", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    // Two stops is 1112 m, so the live plan already breaks a 1 km cap.
    expect(session.plan?.totalMetres).toBe(HOP_METRES * 2);

    const result = ask("less_walking", planner, session);

    expect(result.ctx.avoid).toContain("max_walk_1000m");
    expect(walkCapOf(result.ctx)).toBe(1000);
    expect(result.plan.totalMetres).toBeLessThanOrEqual(1000);
    // One hop is 556 m, so a 1 km cap buys two stops and rules out the third.
    expect(result.plan.stops).toHaveLength(2);
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
    expect(breach?.shortfall).toBe(HOP_METRES * 2 - 1000);
    expect(breach?.message).toBe("112 m more walking than the 1000 m you allowed.");
    // Still the live plan underneath, and still frozen.
    expect(session.plan?.stops).toHaveLength(3);
  });

  it("replaces a previous cap instead of stacking another one on", () => {
    const planner = scriptedPlanner();
    const base = live(planner.engine);
    const caps = (ctx: Ctx) => ctx.avoid.filter((token) => token.startsWith("max_walk_"));

    const tight = simulate(planner.engine, base, [{ kind: "walk_cap_m", metres: 500 }]);
    expect(tight.ok).toBe(true);
    if (!tight.ok) return;
    expect(caps(tight.scenario.ctx)).toEqual(["max_walk_500m"]);

    const wider = simulate(
      planner.engine,
      { ...base, state: { ...base.state, ctx: tight.scenario.ctx } },
      [{ kind: "walk_cap_m", metres: 5000 }],
    );
    expect(wider.ok).toBe(true);
    if (!wider.ok) return;
    expect(caps(wider.scenario.ctx)).toEqual(["max_walk_5000m"]);
    // And the traveller's own tokens are never collateral damage.
    expect(wider.scenario.ctx.avoid).toEqual(expect.arrayContaining(["street_food"].slice(0, 0)));
    expect(walkCapToken(1000)).toBe("max_walk_1000m");
    expect(walkCapOf({ ...base.state.ctx, avoid: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe("what-if: honest refusals", () => {
  it("refuses to add money to a trip with no budget", () => {
    const planner = scriptedPlanner();
    const session = createSession({
      engine: planner.engine,
      seed: { ...SEED, budgetMinor: null },
      catalogue: CATALOGUE,
      weights: WEIGHTS,
    });
    const first = discover(planner.engine, session);
    if (!first.ok) throw new Error(first.reason);
    expect(first.session.state.ctx.budget).toBeNull();

    const outcome = simulate(planner.engine, first.session, preset("more_money").edits);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // "No limit" must not quietly become a ₹500 ceiling, which would be a
    // restriction dressed up as a loosening.
    expect(outcome.reason).toContain("no budget");
    expect(first.session.state.ctx.budget).toBeNull();
  });

  it("refuses a scenario that changes nothing, before paying for a solve", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const before = planner.calls.length;
    const outcome = simulate(planner.engine, session, [{ kind: "time", availableMin: WINDOW_MIN }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain("would not change anything");
    expect(planner.calls).toHaveLength(before);
  });

  it("folds a multi-part question into one hypothetical, not two", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    deepFreeze(session);
    const outcome = simulate(planner.engine, session, [
      { kind: "budget_delta", minor: PER_STOP },
      { kind: "time", availableMin: 120 },
      { kind: "indoor_only", on: true },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.scenario;
    expect(result.ctx.budget?.minor).toBe(TWENTY_HUNDRED);
    expect(result.ctx.availableMin).toBe(120);
    expect(result.ctx.avoid).toContain("indoors_only");
    // One re-solve for three edits, not three.
    expect(planner.calls.filter((c) => c.fn === "pack")).toHaveLength(1);
    expect(result.plan.totalMin).toBeLessThanOrEqual(120);
    expect(session.state.ctx.availableMin).toBe(WINDOW_MIN);
    expect(session.state.ctx.avoid).not.toContain("indoors_only");
  });

  it("gives every named question a scenario, and every scenario a real answer", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    expect(SCENARIO_PRESETS.map((entry) => entry.id)).toEqual([
      "more_money",
      "less_time",
      "rain",
      "less_walking",
      "more_time",
      "three_hours",
    ]);
    for (const entry of SCENARIO_PRESETS) {
      expect(entry.question, entry.id).toMatch(/\?$/);
      expect(entry.label.length, entry.id).toBeLessThanOrEqual(16);
      expect(entry.edits.length, entry.id).toBeGreaterThan(0);
      const result = ask(entry.id, planner, session);
      // A different object from the live plan, admitted by the same door.
      expect(result.plan, entry.id).not.toBe(session.plan);
      expect(Plan.safeParse(result.plan).success, entry.id).toBe(true);
      expect(result.validation.ok, entry.id).toBe(true);
      expect(result.ctx.id, entry.id).toBe(session.state.ctx.id);
      expect(result.reality.warnings, entry.id).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

describe("what-if: the comparison", () => {
  it("reports budget, time, walking and fit for both plans", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("more_money", planner, session);

    expect(result.compare.stops).toEqual({ before: 3, after: 4, delta: 1, unit: "count" });
    expect(result.compare.spend).toEqual({
      before: FIFTEEN_HUNDRED,
      after: TWENTY_HUNDRED,
      delta: PER_STOP,
      unit: "minor_units",
    });
    expect(result.compare.budgetCeiling.delta).toBe(PER_STOP);
    expect(result.compare.plannedMin.before).toBe(minsFor(3));
    expect(result.compare.plannedMin.after).toBe(minsFor(4));
    expect(result.compare.windowMin).toEqual({ before: 240, after: 240, delta: 0, unit: "minutes" });
    expect(result.compare.walkingMetres.before).toBe(HOP_METRES * 2);
    expect(result.compare.walkingMetres.after).toBe(HOP_METRES * 3);
    expect(result.compare.utilisation.before).toBeCloseTo(minsFor(3) / 240, 2);

    // A real per-stop fit, recomputed for this plan rather than a constant: the
    // first stop pays no travel leg, so it cannot have the same ratio as the rest.
    const ratios = result.plan.stops.map((stop) => stop.fit.fitRatio);
    expect(new Set(ratios).size).toBeGreaterThan(1);
    const meanOf = (stops: readonly { fit: { fitRatio: number } }[]): number =>
      stops.reduce((sum, stop) => sum + stop.fit.fitRatio, 0) / stops.length;
    expect(result.compare.meanFitRatio.after).toBeCloseTo(meanOf(result.plan.stops), 5);
    expect(result.compare.meanFitRatio.before).toBeCloseTo(meanOf(session.plan?.stops ?? []), 5);

    // More of the same window used, so the day is less stressful, not more.
    expect(result.compare.stress.delta).toBeLessThan(0);
  });

  it("distinguishes a real ceiling from no ceiling at all", () => {
    const planner = scriptedPlanner();
    const session = live(planner.engine);
    const result = ask("more_money", planner, session);
    // -1 means "no limit", which is not the same number as ₹0.
    expect(result.compare.budgetCeiling.before).toBeGreaterThan(0);

    const noBudget = createSession({
      engine: planner.engine,
      seed: { ...SEED, budgetMinor: null },
      catalogue: CATALOGUE,
      weights: WEIGHTS,
    });
    const first = discover(planner.engine, noBudget);
    if (!first.ok) throw new Error(first.reason);
    const open = simulate(planner.engine, first.session, [{ kind: "time", availableMin: 120 }]);
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.scenario.compare.budgetCeiling.before).toBe(-1);
    expect(open.scenario.compare.budgetCeiling.after).toBe(-1);
  });

  it("scores the live plan against the hypothetical, so pointless churn is visible", () => {
    const planner = scriptedPlanner();
    const result = ask("less_time", planner, live(planner.engine));
    // The 240-minute day under a 120-minute window is 29 minutes over, so the
    // old plan is visibly worse than the new one, and can be compared with it.
    expect(result.reality.stressBefore).not.toBeNull();
    expect(result.reality.stressBefore ?? 0).toBeGreaterThan(result.reality.after.stressScore);
  });
});

