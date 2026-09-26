/**
 * Validator tests.
 *
 * The Definition of Done for this stream says: "Validator catches a deliberately
 * corrupted plan (negative test)". That is the test that matters, and it is
 * written from the other direction: build a plan that is correct by
 * construction, assert it passes, then corrupt one specific field at a time and
 * assert the validator names THAT corruption and not something incidental.
 *
 * A validator that only ever sees good plans is a function that always returns
 * `true`, which is indistinguishable from having no validator at all.
 */
import { describe, expect, it } from "vitest";
import {
  Experience,
  Fit,
  Money,
  Plan,
  PlanStop,
  ScoreBreakdown,
  TravelLeg,
  ValidationResult,
} from "@/contracts";
import { fromMinor } from "@/lib/money";
import { validate } from "@/engine/validate";

/** A Fit with sane defaults; individual tests override the one field under test. */
function fit(over: Partial<Fit> = {}): Fit {
  return {
    experienceId: "e1",
    travelMin: 10,
    activityMin: 45,
    bufferMin: 5,
    totalMin: 60,
    availableMin: 180,
    fitRatio: 3,
    cost: fromMinor(50000),
    budget: null,
    checks: [],
    verdict: "fits",
    ...over,
  };
}

function score(total: number): ScoreBreakdown {
  return {
    experienceId: "e1",
    total,
    components: [],
    profileVersion: "test/1",
    learnedComponents: [],
  };
}

function stop(
  id: string,
  order: number,
  arriveMin: number,
  activityMin: number,
  costMinor: number,
): PlanStop {
  return {
    experienceId: id,
    arriveMin,
    departMin: arriveMin + activityMin,
    fit: fit({ experienceId: id, activityMin, cost: fromMinor(costMinor) }),
    score: score(10),
    why: [],
    order,
  };
}

function leg(fromId: string, toId: string, minutes: number): TravelLeg {
  return {
    fromId,
    toId,
    mode: "walk",
    minutes,
    metres: minutes * 80,
    detail: null,
    estimated: true,
  };
}

/**
 * A plan that is internally consistent by construction: two stops, joined by a
 * leg, and every total derived from them rather than hand-written.
 */
function goodPlan(): Plan {
  const stops = [stop("a", 0, 600, 45, 50000), stop("b", 1, 655, 60, 30000)];
  const legs = [leg("a", "b", 10)];
  // Mirrors validate()'s recompute exactly: activity + buffer + travel. The
  // default fit() carries bufferMin 5, so the two stops add 10 here. Getting
  // this wrong is the 25-minute drift the first e2e test caught in the packer.
  const totalMin =
    stops.reduce((s, x) => s + x.fit.activityMin + x.fit.bufferMin, 0) +
    legs.reduce((s, l) => s + l.minutes, 0);
  const totalCost = fromMinor(
    stops.reduce((s, x) => s + (x.fit.cost?.minor ?? 0), 0),
  );
  const totalMetres = legs.reduce((s, l) => s + l.metres, 0);
  return {
    id: "p1",
    contextId: "c1",
    stops,
    legs,
    totalMin,
    totalCost,
    utilisation: totalMin / 180,
    totalMetres,
    rejected: [],
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    engineVersion: "packer/1.0.0",
  } as Plan;
}

/** Corrupt one field of an otherwise-good plan. */
function corrupt(patch: Partial<Plan>): Plan {
  return { ...goodPlan(), ...patch } as Plan;
}

function codesOf(r: ValidationResult): string[] {
  return r.violations.map((v) => v.code);
}

describe("validate", () => {
  it("passes a plan that is internally consistent", () => {
    const r = validate(goodPlan());
    expect(r.ok, JSON.stringify(r.violations, null, 2)).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("reports a zero objective delta when the totals agree", () => {
    const r = validate(goodPlan());
    expect(r.objectiveDelta).toBe(0);
    expect(r.recomputedObjective).toBe(r.claimedObjective);
  });

  it("passes an empty plan without inventing a comparison", () => {
    // Nothing to recompute, so the honest answer is nulls, not a fake zero.
    const empty = corrupt({ stops: [], legs: [], totalMin: 0, totalMetres: 0,
      totalCost: fromMinor(0) });
    const r = validate(empty);
    expect(r.ok).toBe(true);
    expect(r.objectiveDelta).toBeNull();
    expect(r.recomputedObjective).toBeNull();
  });

  // --- the negative tests: one corruption, one named failure -----------------

  it("catches a totalMin that does not match its own stops and legs", () => {
    const r = validate(corrupt({ totalMin: 999 }));
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("total_min_mismatch");
    expect(r.objectiveDelta).not.toBe(0);
  });

  it("tolerates a single minute of rounding drift but not a dropped leg", () => {
    // One minute is the packer's own rounding; a dropped leg is tens of minutes.
    expect(validate(corrupt({ totalMin: 126 })).ok).toBe(true);
    expect(validate(corrupt({ totalMin: 140 })).ok).toBe(false);
  });

  it("catches a totalCost that does not match its stops", () => {
    const r = validate(corrupt({ totalCost: fromMinor(1) }));
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("total_cost_mismatch");
  });

  it("catches totalMetres that does not match its legs", () => {
    const r = validate(corrupt({ totalMetres: 12345 }));
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("total_metres_mismatch");
  });

  it("catches a plan whose stops are not connected by travel legs", () => {
    // A plan with two stops and no leg between them is not physically possible,
    // and this is the corruption that the arithmetic checks would miss entirely.
    const p = goodPlan();
    const r = validate({ ...p, legs: [] } as Plan);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("unconnected");
  });

  it("catches overlapping stops", () => {
    // Second stop arrives before the first departs.
    const p = goodPlan();
    const bad = p.stops.map((s) =>
      s.order === 1 ? { ...s, arriveMin: 600, departMin: 660 } : s,
    );
    const r = validate({ ...p, stops: bad } as Plan);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("overlap");
  });

  it("catches a duplicated order index", () => {
    const p = goodPlan();
    const bad = p.stops.map((s) => ({ ...s, order: 0 }));
    const r = validate({ ...p, stops: bad } as Plan);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("bad_order");
  });

  it("catches a stop that departs before it arrives", () => {
    const p = goodPlan();
    const bad = p.stops.map((s) =>
      s.order === 0 ? { ...s, arriveMin: 700, departMin: 600 } : s,
    );
    const r = validate({ ...p, stops: bad } as Plan);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("impossible_window");
  });

  it("catches a stop scheduled outside the day", () => {
    const p = goodPlan();
    const bad = p.stops.map((s) =>
      s.order === 0 ? { ...s, arriveMin: 1400, departMin: 1500 } : s,
    );
    const r = validate({ ...p, stops: bad } as Plan);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("impossible_window");
  });

  it("degrades to a named reason instead of throwing on a malformed plan", () => {
    // The validator's whole job is to distrust input, so it must not be the
    // thing that crashes when input is bad.
    const r = validate({ stops: null, legs: null } as unknown as Plan);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toEqual(["impossible_window"]);
  });

  it("names every failure at once rather than stopping at the first", () => {
    // A validator that reports one problem per run turns debugging into a
    // game of whack-a-mole.
    const r = validate(corrupt({ totalMin: 999, totalMetres: 1 }));
    expect(codesOf(r)).toContain("total_min_mismatch");
    expect(codesOf(r)).toContain("total_metres_mismatch");
  });

  it("keeps the plan's own currency when recomputing cost", () => {
    const p = goodPlan();
    const r = validate({ ...p, totalCost: fromMinor(1, "INR") } as Plan);
    expect(r.ok).toBe(false);
    const v = r.violations.find((x) => x.code === "total_cost_mismatch");
    expect(v?.message).toContain("minor units");
  });
});
