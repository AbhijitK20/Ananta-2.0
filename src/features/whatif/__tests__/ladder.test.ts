/**
 * The ladder, the gates, and the render model.
 *
 * The ladder is the part of this feature that cannot be reduced to a single
 * plan, so its tests are about the SHAPE of the frontier rather than one answer:
 * where an axis stops paying, and that the claim is a difference between two
 * solver runs rather than a sentence somebody wrote.
 *
 * `gates.ts` gets hand-built plans as well as solver output, because two of its
 * five crossings — `tightened` and `dropped` — cannot occur in the fixture world
 * and would otherwise ship untested. A state that is never exercised is a state
 * nobody has thought about.
 */
import { describe, expect, it } from "vitest";
import { Plan as PlanSchema, type Plan, type Rejection, type RejectionCode } from "../../../contracts";
import { createSession, discover, type DiscoverySession } from "../../discovery/replanner";
import { indexCatalogue } from "../../discovery/diff";
import {
  findingsIn,
  gateChanges,
  labelFor,
  ladder,
  present,
  simulate,
  unlockedBy,
  type GateChange,
} from "..";
import {
  CATALOGUE,
  DURATION_MIN,
  HOP_METRES,
  HOP_MINUTES,
  NOW_MIN,
  PARTY_SIZE,
  PER_STOP,
  WINDOW_MIN,
  scriptedPlanner,
  type EngineCall,
  type Planner,
} from "./planner";

const CATALOGUE_MAP = indexCatalogue(CATALOGUE);
const FIFTEEN_HUNDRED = PER_STOP * 3;

const SEED = {
  id: "ctx-ladder",
  origin: { label: "Colaba" },
  availableMin: WINDOW_MIN,
  nowMin: NOW_MIN,
  budgetMinor: FIFTEEN_HUNDRED,
  partySize: PARTY_SIZE,
  interests: ["street_food", "local"],
};

function live(planner: Planner): DiscoverySession {
  const first = discover(
    planner.engine,
    createSession({ engine: planner.engine, seed: SEED, catalogue: CATALOGUE, weights: {
      version: "scripted-1", weights: {}, source: "prior", updatedAt: "2026-01-01T00:00:00.000Z", observations: 0,
    } }),
  );
  if (!first.ok) throw new Error(first.reason);
  return first.session;
}

const packCalls = (calls: EngineCall[]): EngineCall[] => calls.filter((c) => c.fn === "pack");
const rungStops = (rung: { plan: Plan | null }): number => rung.plan?.stops.length ?? -1;

const minsFor = (stops: number): number =>
  stops === 0 ? 0 : stops * DURATION_MIN + (stops - 1) * HOP_MINUTES;

// ---------------------------------------------------------------------------
// Hand-built plans, for the crossings the fixture world cannot produce
// ---------------------------------------------------------------------------

const rejection = (id: string, code: RejectionCode, message: string): Rejection => ({
  experienceId: id,
  code,
  message,
  shortfall: 100,
  unit: "minor_units",
  relaxable: true,
});

/** A minimal valid plan over the fixture catalogue, with the given states. */
function fakePlan(stops: string[], rejected: string[]): Plan {
  return PlanSchema.parse({
    id: "plan-hand",
    contextId: "ctx-ladder",
    stops: stops.map((id, order) => {
      const exp = CATALOGUE_MAP.get(id);
      if (!exp) throw new Error(`no fixture ${id}`);
      return {
        experienceId: id,
        arriveMin: NOW_MIN + order * 60,
        departMin: NOW_MIN + order * 60 + DURATION_MIN,
        order,
        why: ["because"],
        score: {
          experienceId: id,
          total: 10,
          components: [],
          profileVersion: "scripted-1",
          learnedComponents: [],
        },
        fit: {
          experienceId: id,
          travelMin: HOP_MINUTES,
          activityMin: DURATION_MIN,
          bufferMin: 5,
          totalMin: DURATION_MIN + HOP_MINUTES + 5,
          availableMin: WINDOW_MIN,
          fitRatio: 0.2,
          cost: { minor: PER_STOP, currency: "INR" },
          budget: { minor: FIFTEEN_HUNDRED, currency: "INR" },
          checks: [],
          verdict: "fits",
        },
      };
    }),
    legs: [],
    totalMin: minsFor(stops.length),
    totalCost: { minor: PER_STOP * stops.length, currency: "INR" },
    utilisation: stops.length / 4,
    totalMetres: HOP_METRES * Math.max(0, stops.length - 1),
    rejected: rejected.map((id) => rejection(id, "over_budget", `${id} is over your budget.`)),
    createdAt: "2026-01-01T00:00:00.000Z",
    engineVersion: "hand",
  });
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

describe("what-if ladder: budget", () => {
  it("finds the rung where money stops paying, and names what took over", () => {
    const planner = scriptedPlanner();
    const session = live(planner);

    const result = ladder(planner.engine, session, "budget", [
      FIFTEEN_HUNDRED,
      PER_STOP * 4,
      PER_STOP * 5,
      PER_STOP * 6,
    ]);

    expect(result.axis).toBe("budget");
    expect(result.unit).toBe("minor_units");
    // The first rung IS the live trip, so it costs no solve and is not re-derived.
    expect(result.rungs[0]?.isCurrent).toBe(true);
    expect(result.rungs[0]?.plan).toBe(session.plan);
    expect(result.plannerCalls).toBe(3);
    expect(result.rungs.map(rungStops)).toEqual([3, 4, 4, 4]);

    // The first ₹500 buys a stop and names the place it freed.
    const first = result.steps[0];
    expect(first?.cost).toBe(PER_STOP);
    expect(first?.stops).toBe(1);
    expect(first?.spendMinor).toBe(PER_STOP);
    // The day itself gets 52 minutes longer: 45 on site plus the 7-minute walk.
    expect(first?.minutes).toBe(DURATION_MIN + HOP_MINUTES);
    expect(first?.walkingMetres).toBe(HOP_METRES);
    expect(first?.saturated).toBe(false);
    expect(first?.unlocked.map((change) => change.id)).toEqual(["gallery"]);
    expect(first?.unlocked[0]?.reason).toBe("₹500 over your budget.");

    // The next two buy nothing, and the reason is the window, not the money.
    // `saturatesAt` is ₹2000, the last rung that bought anything: the fact is
    // "you have enough at ₹2,000", not "₹2,500 was the first to fail".
    expect(result.steps.slice(1).map((step) => step.saturated)).toEqual([true, true]);
    expect(result.saturatesAt).toBe(PER_STOP * 4);
    expect(result.verdict).toContain("buys 1 more stop");
    expect(result.verdict).toContain("The last 2 steps changed nothing.");
    expect(result.verdict).toContain("Past ₹2,000, this axis is spent.");
    // The claim is falsifiable: ₹2500 WOULD pay for a fifth stop, and the day
    // will not hold one.
    expect(result.steps[1]?.from).toBe(PER_STOP * 4);
    expect(result.steps[1]?.saturatedBecause).toContain("kept out by money");
    expect(result.failures).toEqual([]);
  });

  it("charges one real solve per rung it does not already have", () => {
    const planner = scriptedPlanner();
    const session = live(planner);
    const before = packCalls(planner.calls).length;

    // 240 is the live window, so only 120 and 180 are actually re-solved.
    const result = ladder(planner.engine, session, "time", [120, 180, 240]);
    expect(result.plannerCalls).toBe(2);
    expect(packCalls(planner.calls).length - before).toBe(2);
    expect(packCalls(planner.calls).map((c) => c.availableMin)).toEqual([240, 120, 180]);
  });

  it("refuses to invent a budget to climb", () => {
    const planner = scriptedPlanner();
    const session = createSession({
      engine: planner.engine,
      seed: { ...SEED, budgetMinor: null },
      catalogue: CATALOGUE,
      weights: {
        version: "scripted-1", weights: {}, source: "prior",
        updatedAt: "2026-01-01T00:00:00.000Z", observations: 0,
      },
    });
    const first = discover(planner.engine, session);
    if (!first.ok) throw new Error(first.reason);
    const before = packCalls(planner.calls).length;

    const result = ladder(planner.engine, first.session, "budget", [100000, 200000]);
    expect(result.rungs).toEqual([]);
    expect(result.plannerCalls).toBe(0);
    expect(result.verdict).toContain("no budget");
    expect(packCalls(planner.calls).length).toBe(before);
  });

  it("collects the rungs that could not be planned, instead of skipping them", () => {
    const broken = scriptedPlanner({ packThrows: new Error("solver diverged") });
    const session = live(scriptedPlanner());
    const result = ladder(broken.engine, session, "time", [120, 180]);

    expect(result.rungs).toHaveLength(2);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0]?.label).toBe("2h");
    expect(result.failures[0]?.reason).toContain("did not survive planning");
    // No step can be measured between two runs that did not happen.
    expect(result.steps).toEqual([]);
    expect(result.verdict).toContain("not a ladder");
  });

  it("normalises the rungs it was given, so a step always costs something", () => {
    const planner = scriptedPlanner();
    const session = live(planner);
    const result = ladder(planner.engine, session, "time", [240, 120, 120, 180.4]);
    expect(result.rungs.map((rung) => rung.value)).toEqual([120, 180, 240]);
    expect(result.steps.map((step) => step.cost)).toEqual([60, 60]);
    expect(result.steps.every((step) => step.cost > 0)).toBe(true);
  });
});

describe("what-if ladder: time and walk", () => {
  it("shows time saturating because the BUDGET binds, not the clock", () => {
    const planner = scriptedPlanner();
    const session = live(planner);
    const result = ladder(planner.engine, session, "time", [120, 180, 240, 300]);

    // The budget is still ₹1500, so three stops is all the money allows however
    // much afternoon there is. That cross-axis finding is only visible because
    // the ladder re-solves instead of estimating.
    expect(result.rungs.map(rungStops)).toEqual([2, 3, 3, 3]);
    expect(result.steps.map((step) => step.saturated)).toEqual([false, true, true]);
    expect(result.saturatesAt).toBe(180);
    expect(result.verdict).toContain("buys 1 more stop");
    expect(result.verdict).toContain("this axis is spent");
  });

  it("climbs a walking cap, and stops when the money runs out", () => {
    const planner = scriptedPlanner();
    const session = live(planner);
    const result = ladder(planner.engine, session, "walk", [500, 1000, 2000, 3000, 4000]);

    // One hop is 556 m, so each rung adds a stop until three, and then the ₹1500
    // budget binds exactly as it does for time.
    expect(result.rungs.map(rungStops)).toEqual([1, 2, 3, 3, 3]);
    expect(result.saturatesAt).toBe(2000);
    expect(result.steps.at(-1)?.saturatedBecause).toContain("close enough");
    expect(result.verdict).toContain("this axis is spent");
  });

  it("says so plainly when the whole ladder paid for itself", () => {
    const planner = scriptedPlanner();
    const session = live(planner);
    // One step, and it bought a stop: nothing on the list is saturated, so the
    // verdict has to say that rather than inventing a ceiling.
    const result = ladder(planner.engine, session, "time", [120, 180]);

    expect(result.rungs.map(rungStops)).toEqual([2, 3]);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.saturated).toBe(false);
    expect(result.saturatesAt).toBeNull();
    expect(result.verdict).toBe("1h more — from 2h to 3h — buys 1 more stop. Every step paid for itself.");
  });

  it("refuses to call a single rung a ladder", () => {
    const planner = scriptedPlanner();
    const result = ladder(planner.engine, live(planner), "time", [180]);
    expect(result.rungs).toHaveLength(1);
    expect(result.steps).toEqual([]);
    expect(result.verdict).toContain("not a ladder");
  });

  it("labels each axis the way a traveller would say it", () => {
    expect(labelFor("budget", 150000)).toBe("₹1,500");
    expect(labelFor("time", 120)).toBe("2h");
    expect(labelFor("time", 150)).toBe("2h 30m");
    expect(labelFor("walk", 1000)).toBe("1000 m");
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe("what-if gates: every crossing", () => {
  const before = fakePlan(["market", "chaat"], ["gallery", "fort"]);

  it("unlocks what was blocked and now planned", () => {
    const after = fakePlan(["market", "chaat", "gallery"], ["fort"]);
    const changes = gateChanges(before, after, CATALOGUE_MAP);
    const gallery = changes.find((c) => c.id === "gallery") as GateChange;
    expect(gallery.kind).toBe("unlocked");
    expect(gallery.from).toBe("blocked");
    expect(gallery.to).toBe("planned");
    expect(gallery.reason).toBe("gallery is over your budget.");
    expect(gallery.indoorOutdoor).toBe("covered");
    expect(unlockedBy(changes).map((c) => c.id)).toEqual(["gallery"]);
  });

  it("relaxes a blocker without claiming the stop is in the day", () => {
    const after = fakePlan(["market", "chaat"], []);
    const changes = gateChanges(before, after, CATALOGUE_MAP);
    const gallery = changes.find((c) => c.id === "gallery") as GateChange;
    expect(gallery.kind).toBe("relaxed");
    expect(gallery.to).toBe("unknown");
    // NOT unlocked: nothing ruled it out, and it is not in the day.
    expect(unlockedBy(changes)).toEqual([]);
  });

  it("closes what the day had and can no longer have", () => {
    const after = fakePlan(["market"], ["chaat", "gallery", "fort"]);
    const changes = gateChanges(before, after, CATALOGUE_MAP);
    const chaat = changes.find((c) => c.id === "chaat") as GateChange;
    expect(chaat.kind).toBe("closed");
    expect(chaat.from).toBe("planned");
    expect(chaat.to).toBe("blocked");
  });

  it("tightens what was merely not chosen, and says so differently", () => {
    // `craft` is in neither list here: retrieved, unchosen, not blocked.
    const plain = fakePlan(["market"], []);
    const blocked = fakePlan(["market"], ["craft"]);
    const changes = gateChanges(plain, blocked, CATALOGUE_MAP);
    const craft = changes.find((c) => c.id === "craft") as GateChange;
    expect(craft.kind).toBe("tightened");
    expect(craft.from).toBe("unknown");
    expect(craft.to).toBe("blocked");
  });

  it("flags a stop that left with no reason at all, and only that", () => {
    const after = fakePlan(["market"], ["gallery", "fort"]);
    const changes = gateChanges(before, after, CATALOGUE_MAP);
    const chaat = changes.find((c) => c.id === "chaat") as GateChange;
    expect(chaat.kind).toBe("dropped");
    expect(chaat.reason).toBeNull();
    expect(findingsIn(changes).map((c) => c.id)).toEqual(["chaat"]);

    // A stop that was properly rejected is a closed gate, not a finding.
    const closed = fakePlan(["market"], ["chaat", "gallery", "fort"]);
    expect(findingsIn(gateChanges(before, closed, CATALOGUE_MAP))).toEqual([]);
  });

  it("reports a selection change as nothing at all, because the diff has it", () => {
    // craft goes from unchosen to in the day. Possible before, possible after.
    const plain = fakePlan(["market"], []);
    const chosen = fakePlan(["market", "craft"], []);
    expect(gateChanges(plain, chosen, CATALOGUE_MAP)).toEqual([]);
  });

  it("is stable: the same two plans always give the same order", () => {
    const after = fakePlan(["market", "craft"], ["fort", "gallery"]);
    const once = gateChanges(before, after, CATALOGUE_MAP);
    const twice = gateChanges(before, after, CATALOGUE_MAP);
    expect(twice).toEqual(once);
    expect(once.map((c) => c.id)).toEqual([...once.map((c) => c.id)].sort());
  });

  it("does not crash on an id the catalogue has never heard of", () => {
    const stray = fakePlan(["market"], ["not_a_real_place"]);
    const changes = gateChanges(fakePlan(["market", "chaat"], []), stray, CATALOGUE_MAP);
    const ghost = changes.find((c) => c.id === "not_a_real_place") as GateChange;
    expect(ghost.name).toBe("Unknown place");
    expect(ghost.indoorOutdoor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The render model
// ---------------------------------------------------------------------------

describe("what-if render model", () => {
  const panelFor = (id: string, planner: Planner, session: DiscoverySession) => {
    const preset = { edits: [] as const };
    void preset;
    const outcome = simulate(planner.engine, session, EDIT_FOR[id] ?? []);
    if (!outcome.ok) throw new Error(outcome.reason);
    return present(outcome.scenario, QUESTION_FOR[id] ?? null);
  };

  const EDIT_FOR: Record<string, Parameters<typeof simulate>[2]> = {
    more: [{ kind: "budget_delta", minor: PER_STOP }],
    less_time: [{ kind: "time", availableMin: 120 }],
    rain: [{ kind: "weather", condition: "heavy_rain" }],
    walk: [{ kind: "walk_cap_m", metres: 1000 }],
  };
  const QUESTION_FOR: Record<string, string> = {
    more: "What if I had ₹500 more?",
    less_time: "What if I only had 2 hours?",
    rain: "What if it rains?",
    walk: "What if I don't want to walk more than 1 km?",
  };

  it("resolves every number and every sign, so a component never computes", () => {
    const planner = scriptedPlanner();
    const panel = panelFor("more", planner, live(planner));
    const row = (id: string) => panel.rows.find((r) => r.id === id)!;

    expect(row("stops")).toMatchObject({ before: "3 stops", after: "4 stops", delta: "+1", direction: "up" });
    expect(row("spend")).toMatchObject({ before: "₹1,500", after: "₹2,000", delta: "+₹500", direction: "up" });
    expect(row("walking")).toMatchObject({ before: "1112 m", after: "1668 m", delta: "+556 m" });
    expect(row("window")).toMatchObject({ before: "4h", after: "4h", delta: "", direction: "flat" });
    // A ratio delta is percentage POINTS, not a percent of a percent.
    expect(row("utilisation").delta).toMatch(/^[+-]\d+pp$/);
    expect(row("utilisation").before).toMatch(/^\d+%$/);
  });

  it("says which direction is good, so a component cannot pick the wrong colour", () => {
    const planner = scriptedPlanner();
    const panel = panelFor("more", planner, live(planner));
    const good = (id: string) => panel.rows.find((r) => r.id === id)?.higherIsBetter;
    expect(good("stops")).toBe(true);
    expect(good("utilisation")).toBe(true);
    // More spending and more walking are not wins.
    expect(good("spend")).toBe(false);
    expect(good("walking")).toBe(false);
    expect(good("stress")).toBe(false);
  });

  it("leads with the shortfall when the hypothetical cannot be satisfied", () => {
    const planner = scriptedPlanner({ honourWalkCap: false });
    const panel = panelFor("walk", planner, live(planner));
    expect(panel.verdict).toBe("infeasible");
    expect(panel.headline).toContain("112 m more walking");
    expect(panel.breaches).toHaveLength(1);
    expect(panel.breaches[0]?.axis).toBe("walking");
  });

  it("names what a change made possible, which the diff alone would not", () => {
    const planner = scriptedPlanner();
    const panel = panelFor("more", planner, live(planner));
    expect(panel.unlocked).toHaveLength(1);
    expect(panel.unlocked[0]?.name).toBe("Courtyard gallery");
    expect(panel.unlocked[0]?.reason).toBe("₹500 over your budget.");
    expect(panel.headline).toContain("That makes possible: Courtyard gallery.");
  });

  it("carries the traveller's question through untouched, or null", () => {
    const planner = scriptedPlanner();
    const session = live(planner);
    expect(panelFor("rain", planner, session).question).toBe("What if it rains?");
    const outcome = simulate(planner.engine, session, [{ kind: "time", availableMin: 120 }]);
    if (!outcome.ok) throw new Error(outcome.reason);
    // No question invented for an answer nobody asked in words.
    expect(present(outcome.scenario).question).toBeNull();
  });

  it("surfaces a stop the engine dropped without a reason, as a finding", () => {
    // The live trip is built honestly: four stops, because with ₹2500 the window
    // binds before the money. The hypothetical then gets a planner that quietly
    // drops its last stop, so the same four become three.
    const honest = scriptedPlanner();
    const session = createSession({
      engine: honest.engine,
      seed: { ...SEED, budgetMinor: PER_STOP * 5 },
      catalogue: CATALOGUE,
      weights: {
        version: "scripted-1", weights: {}, source: "prior",
        updatedAt: "2026-01-01T00:00:00.000Z", observations: 0,
      },
    });
    const first = discover(honest.engine, session);
    if (!first.ok) throw new Error(first.reason);
    expect(first.session.plan?.stops).toHaveLength(4);

    const lossy = scriptedPlanner({ silentDrop: true });
    const outcome = simulate(lossy.engine, first.session, [
      { kind: "budget", minor: PER_STOP * 6 },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The plan is internally VALID, which is exactly what makes this subtle: the
    // totals were recomputed, so the validator has nothing to complain about and
    // the only evidence of the loss is the missing Rejection.
    expect(outcome.scenario.validation.ok).toBe(true);
    expect(outcome.scenario.plan.stops).toHaveLength(3);
    expect(outcome.scenario.plan.rejected.some((r) => r.experienceId === "gallery")).toBe(false);

    const panel = present(outcome.scenario);
    expect(panel.findings).toHaveLength(1);
    expect(panel.findings[0]).toContain("Courtyard gallery");
    expect(panel.findings[0]).toContain("no reason attached");
    // And the live trip is untouched by any of it.
    expect(first.session.plan?.stops).toHaveLength(4);
  });

  it("renders 'no limit' rather than a negative rupee amount", () => {
    const planner = scriptedPlanner();
    const session = createSession({
      engine: planner.engine,
      seed: { ...SEED, budgetMinor: null },
      catalogue: CATALOGUE,
      weights: {
        version: "scripted-1", weights: {}, source: "prior",
        updatedAt: "2026-01-01T00:00:00.000Z", observations: 0,
      },
    });
    const first = discover(planner.engine, session);
    if (!first.ok) throw new Error(first.reason);
    const outcome = simulate(planner.engine, first.session, [{ kind: "time", availableMin: 120 }]);
    if (!outcome.ok) throw new Error(outcome.reason);

    const panel = present(outcome.scenario);
    // The ceiling row is not rendered at all, so -1 never reaches a string.
    expect(panel.rows.map((r) => r.id)).not.toContain("budget");
    expect(panel.rows.every((r) => !r.before.includes("-"))).toBe(true);
  });
});
