/**
 * Test fixtures for the AI layer. Built from the frozen contract's own schemas,
 * so a contract change breaks these loudly instead of silently making the tests
 * assert against a shape that no longer exists.
 */

import { DiscoveryContext, Experience, Plan, PlanStop, type PlanStop as PlanStopShape } from "../contracts";

export function context(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  const base = {
    id: "ctx-test",
    origin: { label: "Bandra West", point: { lat: 19.06, lon: 72.83 } as const },
    availableMin: 240,
    nowMin: 600, // 10:00am
    budget: { minor: 200_000, currency: "INR" } as const,
    partySize: 2,
    ...overrides,
  };
  return DiscoveryContext.parse({
    ...base,
    // `original` is never mutated, so the fixture derives it from the same base
    // rather than letting each test restate it.
    original: {
      availableMin: base.availableMin,
      budget: base.budget,
      partySize: base.partySize,
      accessNeeds: [],
    },
  });
}

function stop(over: Partial<PlanStopShape> & { experienceId: string; order: number }): PlanStopShape {
  return PlanStop.parse({
    arriveMin: 630,
    departMin: 690,
    why: ["short hop from where you are", "open now"],
    fit: {
      experienceId: over.experienceId,
      travelMin: 12,
      activityMin: 45,
      bufferMin: 8,
      totalMin: 65,
      availableMin: 240,
      fitRatio: 1.2,
      cost: { minor: 40_000, currency: "INR" },
      budget: { minor: 200_000, currency: "INR" },
      checks: [
        { label: "Fits the window", pass: true, detail: "65 of 240 min" },
        { label: "Step-free", pass: true, detail: "curated" },
      ],
      verdict: "fits",
    },
    score: {
      experienceId: over.experienceId,
      total: 7.5,
      components: [{ key: "proximity", label: "Close by", value: 3, weight: 1 }],
      profileVersion: "w1",
    },
    ...over,
  });
}

export function plan(over: Partial<Plan> = {}): Plan {
  const stops = [
    stop({ experienceId: "exp-fort", order: 0 }),
    stop({ experienceId: "exp-cafe", order: 1, arriveMin: 700, departMin: 760 }),
  ];
  return Plan.parse({
    id: "plan-test",
    contextId: "ctx-test",
    stops,
    legs: [{ fromId: "exp-fort", toId: "exp-cafe", mode: "walk", minutes: 9, metres: 620, detail: null }],
    totalMin: 130,
    totalCost: { minor: 80_000, currency: "INR" },
    utilisation: 0.54,
    totalMetres: 620,
    rejected: [
      {
        experienceId: "exp-museum",
        code: "closed_during_window",
        message: "The museum shuts at 7pm, two hours before you have to leave.",
        shortfall: 120,
        unit: "minutes",
        relaxable: true,
      },
    ],
    relaxations: [{ rung: "dropped_minimum", label: "Dropped the minimum stay", gaveUp: "the 90-minute museum", relaxed: "duration_exceeds_budget" }],
    stressScore: 38,
    stressFactors: [{ dimension: "walking", weight: 0.6, value: 62, rescue: "swap the second stop for a nearer one" }],
    createdAt: "2026-01-01T10:00:00.000Z",
    engineVersion: "test-1",
    ...over,
  });
}

export function experience(over: Partial<Experience> = {}): Experience {
  return Experience.parse({
    id: "exp-longtail",
    name: "Kannada Kitchen at Fort",
    category: "restaurant",
    location: { lat: 18.935, lon: 72.836 },
    durationMin: 60,
    pricePerPerson: null,
    capacity: null,
    hours: { raw: "Mo-Su 12:00-22:00", status: "ok", lastVerified: null },
    indoorOutdoor: "indoor",
    accessibility: { stepFree: null, strollerOk: null, lowStairs: null, seatingAvailable: null, hearingLoop: null, restroomOnSite: null },
    kidFriendly: null,
    minAge: null,
    rating: { value: 4.1, count: 40, rawMean: 4.2 },
    blurb: "A Kannada dosa place on a quiet lane in Fort, open from noon.",
    description: null,
    neighbourhood: "Fort",
    ...over,
  });
}

/** The blob an inference must be quotable from. Mirrors `candidateBlob`. */
export const BLOB = "Kannada Kitchen at Fort — restaurant — Fort — A Kannada dosa place on a quiet lane in Fort, open from noon.";

export const LABELS: Record<string, string> = {
  "exp-fort": "Bandra Fort",
  "exp-cafe": "Kaffeine Kabin",
};
