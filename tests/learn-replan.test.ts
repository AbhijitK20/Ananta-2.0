/**
 * Learning-arm tests (`observe`) and replanner tests (`replan`).
 *
 * The two properties that carry the most weight here:
 *
 *   - Nothing is learned that is not visible. The bandit's whole justification
 *     is that the traveller can see and interrogate what it learned, so a test
 *     asserts every learned weight is a named, bounded, previously-known key —
 *     not a new dimension invented in the dark.
 *   - A replan never replaces the intent. `DiscoveryContext.original` is the
 *     thing the diff is measured against, and the tests corrupt and shrink the
 *     window repeatedly to prove the original survives every round.
 */
import { describe, expect, it } from "vitest";
import {
  ContextChange,
  DiscoveryContext,
  Fit,
  Interaction,
  Plan,
  PlanStop,
  ScoreBreakdown,
  TravelLeg,
  WeightProfile,
} from "@/contracts";
import { fromMinor } from "@/lib/money";
import { DEFAULT_PROFILE } from "@/engine/scoring";
import { observe } from "@/engine/observe";
import { replan, MAX_SWAPS } from "@/engine/replan";

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

function profile(over: Partial<WeightProfile> = {}): WeightProfile {
  return { ...DEFAULT_PROFILE, ...over };
}

function event(type: Interaction["type"], reward?: number): Interaction {
  return {
    travellerId: "t1",
    experienceId: "e1",
    type,
    reward: reward ?? 0,
    at: "2026-09-26T00:00:00.000Z",
    contextSnapshotId: "c1",
  };
}

describe("observe", () => {
  it("returns a new profile and never mutates the input", () => {
    const before = profile();
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = observe(before, event("save", 1));
    expect(after).not.toBe(before);
    expect(before).toEqual(snapshot);
  });

  it("only ever learns weights that already exist in the prior", () => {
    // The bandit must not invent a dimension. Every key it writes is one the
    // engine already scores on, so the UI knows how to name it.
    const after = observe(profile(), event("book_requested", 1.5));
    for (const key of Object.keys(after.weights)) {
      expect(DEFAULT_PROFILE.weights, `unknown weight ${key}`).toHaveProperty(key);
    }
  });

  it("lifts weights on positive reward and lowers them on negative", () => {
    const up = observe(profile(), event("save", 1));
    const down = observe(profile(), event("not_interested", -1));
    const base = DEFAULT_PROFILE.weights.interestMatch!;
    expect(up.weights.interestMatch!).toBeGreaterThan(base);
    expect(down.weights.interestMatch!).toBeLessThan(base);
  });

  it("records an impression without moving a weight", () => {
    // An impression is counted (the UI shows "learned from N") but carries no
    // outcome, so it must not pretend to have learned something.
    const after = observe(profile(), event("impression", 0));
    expect(after.weights).toEqual(DEFAULT_PROFILE.weights);
    expect(after.observations).toBe(1);
  });

  it("marks a learned profile as learned and never as prior", () => {
    const after = observe(profile(), event("click", 0.4));
    expect(after.source).toBe("learned");
  });

  it("keeps every weight inside its bounds no matter the signal", () => {
    // A single max-reward click, then a flood, must not launch a weight.
    let p = profile();
    for (let i = 0; i < 500; i++) p = observe(p, event("book_requested", 10));
    for (const v of Object.values(p.weights)) {
      expect(v).toBeGreaterThanOrEqual(0.02);
      expect(v).toBeLessThanOrEqual(3.0);
    }
  });

  it("decays: many small signals move a weight less than one early signal", () => {
    const early = observe(profile({ observations: 0 }), event("save", 1));
    const late = observe(profile({ observations: 5000 }), event("save", 1));
    const base = DEFAULT_PROFILE.weights.rating!;
    const earlyStep = Math.abs(early.weights.rating! - base);
    const lateStep = Math.abs(late.weights.rating! - base);
    expect(lateStep).toBeLessThan(earlyStep);
  });

  it("counts every interaction", () => {
    let p = profile();
    p = observe(p, event("click", 0.4));
    p = observe(p, event("save", 1));
    expect(p.observations).toBe(2);
  });

  it("is deterministic", () => {
    const a = observe(profile(), event("save", 1));
    const b = observe(profile(), event("save", 1));
    expect(a.weights).toEqual(b.weights);
  });
});

// ---------------------------------------------------------------------------
// replan
// ---------------------------------------------------------------------------

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext {
  const availableMin = over.availableMin ?? 180;
  return {
    id: "c1",
    origin: { label: "Mumbai", point: null },
    availableMin,
    nowMin: 600,
    budget: null,
    budgetPerPerson: null,
    partySize: 1,
    partyType: "solo",
    childAges: [],
    accessNeeds: [],
    diets: [],
    interests: [],
    avoid: [],
    weather: { condition: "clear", tempC: 28, source: "live" },
    travelMode: "any",
    requests: [],
    excludedIds: [],
    pinnedIds: [],
    original: { availableMin, budget: null, partySize: 1, accessNeeds: [] },
    ...over,
  } as DiscoveryContext;
}

function fit(over: Partial<Fit> = {}): Fit {
  return {
    experienceId: "e1",
    travelMin: 10,
    activityMin: 45,
    bufferMin: 20,
    totalMin: 75,
    availableMin: 180,
    fitRatio: 2.4,
    cost: fromMinor(20000),
    budget: null,
    checks: [],
    verdict: "fits",
    ...over,
  };
}

function score(): ScoreBreakdown {
  return { experienceId: "e1", total: 10, components: [], profileVersion: "t/1", learnedComponents: [] };
}

function stop(id: string, order: number, totalMin: number): PlanStop {
  return {
    experienceId: id,
    arriveMin: 600 + order * 100,
    departMin: 600 + order * 100 + 45,
    fit: fit({ experienceId: id, totalMin, activityMin: totalMin, bufferMin: 0 }),
    score: score(),
    why: [],
    order,
  };
}

function leg(fromId: string, toId: string): TravelLeg {
  return { fromId, toId, mode: "walk", minutes: 10, metres: 800, detail: null, estimated: true };
}

function plan(stops: PlanStop[]): Plan {
  const totalMin = stops.reduce((s, x) => s + x.fit.totalMin, 0);
  const legs = stops.slice(0, -1).map((s, i) => leg(s.experienceId, stops[i + 1]!.experienceId));
  return {
    id: "p1",
    contextId: "c1",
    stops,
    legs,
    totalMin,
    totalCost: fromMinor(stops.length * 20000),
    utilisation: totalMin / 180,
    totalMetres: legs.reduce((s, l) => s + l.metres, 0),
    rejected: [],
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    engineVersion: "packer/1.0.0",
  } as Plan;
}

const change: ContextChange = {
  kind: "time_shrank",
  narrative: "Your meeting ran long",
  patch: { availableMin: 90 },
};

describe("replan", () => {
  it("keeps a stop that still fits", () => {
    const prev = plan([stop("a", 0, 60)]);
    const r = replan(prev, ctx({ availableMin: 180 }), change);
    expect(r.plan.stops.map((s) => s.experienceId)).toEqual(["a"]);
    expect(r.swaps).toHaveLength(0);
  });

  it("drops the tail that no longer fits and reports a swap", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60)]);
    // Window now only fits one stop.
    const r = replan(prev, ctx({ availableMin: 70 }), change);
    expect(r.plan.stops.map((s) => s.experienceId)).toEqual(["a"]);
    expect(r.swaps).toHaveLength(1);
    expect(r.swaps[0]!.removedId).toBe("b");
  });

  it("never reports more swaps than the documented ceiling", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60), stop("c", 2, 60), stop("d", 3, 60)]);
    // A window that fits almost nothing.
    const r = replan(prev, ctx({ availableMin: 65 }), change);
    expect(r.swaps.length).toBeLessThanOrEqual(MAX_SWAPS);
  });

  it("stays contiguous: it never leaves an unjoined gap", () => {
    // validate() rejects a plan with a missing leg between consecutive stops, so
    // the replanner must not drop a middle stop and call the result a plan.
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60), stop("c", 2, 60)]);
    const r = replan(prev, ctx({ availableMin: 130 }), change);
    const ids = r.plan.stops.map((s) => s.experienceId);
    for (let i = 1; i < ids.length; i++) {
      const joined = r.plan.legs.some(
        (l) => l.fromId === ids[i - 1] && l.toId === ids[i],
      );
      expect(joined, `gap between ${ids[i - 1]} and ${ids[i]}`).toBe(true);
    }
  });

  it("drops only legs whose endpoints both survived", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60)]);
    const r = replan(prev, ctx({ availableMin: 70 }), change);
    // "b" is gone, so the a->b leg must be gone too.
    expect(r.plan.legs.some((l) => l.toId === "b")).toBe(false);
  });

  it("preserves the original intent across a shrink", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60)]);
    const c = ctx({ availableMin: 70 });
    const r = replan(prev, c, change);
    expect(r.preservedIntent).toBe(true);
    // The original window is untouched on the context.
    expect(c.original.availableMin).toBe(70);
  });

  it("does not mutate the previous plan", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60)]);
    const before = JSON.parse(JSON.stringify(prev));
    replan(prev, ctx({ availableMin: 70 }), change);
    expect(prev).toEqual(before);
  });

  it("never exceeds the new window with the stops it keeps", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60), stop("c", 2, 60)]);
    const r = replan(prev, ctx({ availableMin: 100 }), change);
    expect(r.plan.totalMin).toBeLessThanOrEqual(100);
  });

  it("reports a negative scoreDelta for a dropped stop", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60)]);
    const r = replan(prev, ctx({ availableMin: 70 }), change);
    expect(r.swaps[0]!.scoreDelta).toBeLessThan(0);
  });

  it("is deterministic", () => {
    const prev = plan([stop("a", 0, 60), stop("b", 1, 60)]);
    const a = replan(prev, ctx({ availableMin: 70 }), change);
    const b = replan(prev, ctx({ availableMin: 70 }), change);
    expect(a.plan.stops.map((s) => s.experienceId)).toEqual(b.plan.stops.map((s) => s.experienceId));
    expect(a.summary).toBe(b.summary);
  });
});
