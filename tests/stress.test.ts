/**
 * Stress radar tests.
 *
 * The properties tested here are the ones that make the radar trustworthy rather
 * than decorative:
 *
 *   - Bounded. 0..100 always, no matter how bad the input, because a gauge that
 *     can exceed its own scale is a gauge people stop reading.
 *   - Monotonic. More time pressure, less buffer, more travel => a higher score.
 *     A stress function that does not respond to stress is broken.
 *   - Calibrated. A comfortable plan lands in "relaxed", a relentless one in
 *     "relentless", so the labels Karan renders actually mean something.
 *   - One rescue, not eight. The contract allows a rescue on the worst factor
 *     only; a list of everything is a list nobody reads.
 */
import { describe, expect, it } from "vitest";
import { DiscoveryContext, Fit, Plan, PlanStop, ScoreBreakdown, TravelLeg } from "@/contracts";
import { fromMinor } from "@/lib/money";
import {
  STRESS_DIMENSIONS,
  STRESS_WEIGHTS,
  stress,
  stressLabel,
} from "@/engine/stress";

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
    checks: [{ label: "Indoor", pass: true, detail: "indoor" }],
    verdict: "fits",
    ...over,
  };
}

function score(): ScoreBreakdown {
  return { experienceId: "e1", total: 10, components: [], profileVersion: "t/1", learnedComponents: [] };
}

function stop(id: string, order: number, arriveMin: number, over: Partial<Fit> = {}): PlanStop {
  return {
    experienceId: id,
    arriveMin,
    departMin: arriveMin + (over.activityMin ?? 45),
    fit: fit({ experienceId: id, ...over }),
    score: score(),
    why: [],
    order,
  };
}

function leg(fromId: string, toId: string, minutes: number): TravelLeg {
  return { fromId, toId, mode: "walk", minutes, metres: minutes * 80, detail: null, estimated: true };
}

function ctx(over: Partial<DiscoveryContext> = {}): DiscoveryContext {
  return {
    id: "c1",
    origin: { label: "Mumbai", point: null },
    availableMin: 180,
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
    original: { availableMin: 180, budget: null, partySize: 1, accessNeeds: [] },
    ...over,
  } as DiscoveryContext;
}

function plan(stops: PlanStop[], legs: TravelLeg[], over: Partial<Plan> = {}): Plan {
  const totalMin = stops.reduce((s, x) => s + x.fit.activityMin, 0) + legs.reduce((s, l) => s + l.minutes, 0);
  const totalCost = fromMinor(stops.reduce((s, x) => s + (x.fit.cost?.minor ?? 0), 0));
  return {
    id: "p1",
    contextId: "c1",
    stops,
    legs,
    totalMin,
    totalCost,
    utilisation: totalMin / 180,
    totalMetres: legs.reduce((s, l) => s + l.metres, 0),
    rejected: [],
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: "2026-09-26T00:00:00.000Z",
    engineVersion: "packer/1.0.0",
    ...over,
  } as Plan;
}

/** Three stops, mid-morning, generous buffer, short walks. Should feel easy. */
function easyPlan(): Plan {
  return plan(
    [stop("a", 0, 630), stop("b", 1, 720), stop("c", 2, 810)],
    [leg("a", "b", 5), leg("b", "c", 5)],
    { totalMin: 145 },
  );
}

describe("stress", () => {
  it("always returns a score inside 0..100", () => {
    const cases = [
      easyPlan(),
      plan([stop("a", 0, 300), stop("b", 1, 1400)], [leg("a", "b", 600)], { totalMin: 1200 }),
      plan([stop("a", 0, 300)], [], { totalMin: 45 }),
    ];
    for (const p of cases) {
      const { score } = stress(p, ctx());
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("returns exactly the seven declared dimensions, weighted, and summing to 1", () => {
    const { factors } = stress(easyPlan(), ctx());
    expect(factors).toHaveLength(7);
    expect(factors.map((f) => f.dimension).sort()).toEqual([...STRESS_DIMENSIONS].sort());
    for (const f of factors) {
      expect(f.value).toBeGreaterThanOrEqual(0);
      expect(f.value).toBeLessThanOrEqual(1);
    }
    const weightSum = factors.reduce((s, f) => s + f.weight, 0);
    expect(weightSum).toBeCloseTo(1, 5);
    for (const f of factors) {
      expect(f.weight).toBe(STRESS_WEIGHTS[f.dimension as keyof typeof STRESS_WEIGHTS]);
    }
  });

  it("scores an empty plan as 0, not as a crisis", () => {
    // A red radar on a blank state trains people to ignore the radar.
    const { score } = stress(plan([], []), ctx());
    expect(score).toBe(0);
  });

  it("rates a comfortable plan as relaxed", () => {
    const { score } = stress(easyPlan(), ctx());
    expect(stressLabel(score)).toBe("relaxed");
  });

  it("rises when the plan overruns the window", () => {
    const roomy = stress(easyPlan(), ctx({ availableMin: 300 })).score;
    const over = stress(easyPlan(), ctx({ availableMin: 90 })).score;
    expect(over).toBeGreaterThan(roomy);
  });

  it("rises when the buffer is stripped out", () => {
    const withBuffer = stress(
      plan([stop("a", 0, 630, { bufferMin: 25 })], []),
      ctx(),
    ).score;
    const noBuffer = stress(
      plan([stop("a", 0, 630, { bufferMin: 0 })], []),
      ctx(),
    ).score;
    expect(noBuffer).toBeGreaterThan(withBuffer);
  });

  it("rises when most of the day is spent travelling", () => {
    const still = stress(plan([stop("a", 0, 630), stop("b", 1, 700)], [leg("a", "b", 10)]), ctx()).score;
    const trudging = stress(plan([stop("a", 0, 630), stop("b", 1, 700)], [leg("a", "b", 240)]), ctx()).score;
    expect(trudging).toBeGreaterThan(still);
  });

  it("rises when the plan spends the budget", () => {
    const cheap = stress(easyPlan(), ctx({ budget: fromMinor(1000000) })).score;
    const blown = stress(easyPlan(), ctx({ budget: fromMinor(20000) })).score;
    expect(blown).toBeGreaterThan(cheap);
  });

  it("gives no rescue on a comfortable plan", () => {
    const { factors } = stress(easyPlan(), ctx());
    expect(factors.every((f) => f.rescue === null)).toBe(true);
  });

  it("gives at most one rescue, on the highest-impact factor", () => {
    const rough = plan(
      [stop("a", 0, 300, { bufferMin: 0 }), stop("b", 1, 1400, { bufferMin: 0 })],
      [leg("a", "b", 300)],
      { totalMin: 400 },
    );
    const { factors } = stress(rough, ctx({ availableMin: 120 }));
    const rescues = factors.filter((f) => f.rescue !== null);
    expect(rescues.length).toBeLessThanOrEqual(1);
    if (rescues.length === 1) {
      const impact = (f: (typeof factors)[number]) => f.value * f.weight;
      const worstImpact = Math.max(...factors.map(impact));
      expect(impact(rescues[0]!)).toBeCloseTo(worstImpact, 5);
    }
  });

  it("penalises outdoor stops in the heat but not indoor ones", () => {
    const outdoor = stop("a", 0, 630, { checks: [{ label: "Indoor", pass: false, detail: "outdoor" }] });
    const indoor = stop("a", 0, 630, { checks: [{ label: "Indoor", pass: true, detail: "indoor" }] });
    const hot = ctx({ weather: { condition: "heat", tempC: 41, source: "live" } });
    const outside = stress(plan([outdoor], []), hot).score;
    const inside = stress(plan([indoor], []), hot).score;
    expect(outside).toBeGreaterThan(inside);
  });

  it("does not penalise cost when no budget was set", () => {
    const noBudget = stress(easyPlan(), ctx({ budget: null }));
    expect(noBudget.factors.find((f) => f.dimension === "cost")?.value).toBe(0);
  });

  it("labels split at the documented thresholds", () => {
    expect(stressLabel(0)).toBe("relaxed");
    expect(stressLabel(37)).toBe("relaxed");
    expect(stressLabel(38)).toBe("workable");
    expect(stressLabel(67)).toBe("workable");
    expect(stressLabel(68)).toBe("relentless");
    expect(stressLabel(100)).toBe("relentless");
  });

  it("is deterministic: the same plan and context give the same score", () => {
    const a = stress(easyPlan(), ctx()).score;
    const b = stress(easyPlan(), ctx()).score;
    expect(a).toBe(b);
  });
});
