/**
 * The trip health read, tested against real itineraries.
 *
 * WHY THESE TESTS EXIST. A stress score is the easiest number in the product to
 * fake: `return 87` passes every smoke test and tells a traveller nothing. So
 * every case here builds a plan an engine could actually have packed, changes
 * exactly one thing about it, and asserts that the specific dimensions moved.
 * If a dimension can be moved without the score noticing, the read is decoration
 * and these fail.
 */
import { describe, expect, it } from "vitest";
import { Plan as PlanSchema, type DiscoveryContext, type Plan } from "../../contracts";
import { context as sharedContext, plan as sharedPlan } from "../../llm/fixtures";
import {
  DIMENSION_WEIGHTS,
  DIMENSIONS,
  THRESHOLDS,
  assessTripHealth,
  toPlanStress,
  type Dimension,
  type TripHealth,
} from "./health";
import { CATALOGUE, byId, context, exp, plan, rejection, type PlanSpec, type StopSpec } from "./fixtures";

const value = (health: TripHealth, dimension: Dimension): number =>
  health.dimensions.find((d) => d.dimension === dimension)?.value ?? -1;

const signal = (health: TripHealth, dimension: Dimension, key: string) =>
  health.dimensions
    .find((d) => d.dimension === dimension)
    ?.signals.find((s) => s.key === key);

const DEFAULT_STOPS: StopSpec[] = [
  { id: "exp-fort", arrive: 630, activityMin: 45, travelMin: 8, bufferMin: 20, costMinor: 40_000 },
  { id: "exp-gallery", arrive: 713, activityMin: 60, travelMin: 8, bufferMin: 20, costMinor: 60_000 },
];

const build = (spec: PlanSpec, ctx: DiscoveryContext = context()): [TripHealth, Plan] => {
  const packed = plan(spec);
  return [assessTripHealth(packed, ctx, CATALOGUE), packed];
};

/** Generous: a long window, short hops on foot, buffer everywhere, nothing cut. */
const generous = (): TripHealth =>
  build({ stops: DEFAULT_STOPS, availableMin: 420 }, context({ availableMin: 420 }))[0];

/** Knife-edge: same neighbourhood, no slack, every stop pinned to the clock. */
const tight = (): TripHealth =>
  build(
    {
      stops: [
        { ...DEFAULT_STOPS[0]!, arrive: 620, travelMin: 25, bufferMin: 3, fitRatio: 0.95, verdict: "tight" },
        { ...DEFAULT_STOPS[1]!, arrive: 700, travelMin: 24, bufferMin: 3, fitRatio: 0.95, verdict: "tight" },
      ],
      availableMin: 130,
    },
    context({ availableMin: 130 }),
  )[0];

/** Same stops, same order, but the 30-minute walks become 10-minute rides. */
const ridden = (): TripHealth =>
  build(
    {
      stops: WALK_STOPS.map((s) => ({ ...s, travelMin: 10, travelMode: "auto" as const })),
      availableMin: 480,
    },
    context({ availableMin: 480 }),
  )[0];

/** Three stops, half an hour on foot between each. Real distances, not guesses. */
const WALK_STOPS: StopSpec[] = [
  { id: "exp-fort", arrive: 600, activityMin: 60, travelMin: 30, bufferMin: 20, costMinor: 40_000 },
  { id: "exp-cafe", arrive: 690, activityMin: 60, travelMin: 30, bufferMin: 20, costMinor: 60_000 },
  { id: "exp-gallery", arrive: 780, activityMin: 60, travelMin: 30, bufferMin: 20, costMinor: 60_000 },
];

const walked = (): TripHealth => build({ stops: WALK_STOPS, availableMin: 480 }, context({ availableMin: 480 }))[0];

/** Seven things in under three hours, no buffer, alternating modes. */
const denseStops: StopSpec[] = [
  { id: "exp-fort", arrive: 600, activityMin: 20, travelMin: 5, travelMode: "walk", bufferMin: 0, fitRatio: 1, verdict: "tight" },
  { id: "exp-cafe", arrive: 625, activityMin: 20, travelMin: 5, travelMode: "auto", bufferMin: 0, fitRatio: 1, verdict: "tight" },
  { id: "exp-gallery", arrive: 650, activityMin: 20, travelMin: 5, travelMode: "transit", bufferMin: 0, fitRatio: 1, verdict: "tight" },
  { id: "exp-market", arrive: 675, activityMin: 20, travelMin: 5, travelMode: "walk", bufferMin: 0, fitRatio: 1, verdict: "tight" },
  { id: "exp-museum", arrive: 700, activityMin: 20, travelMin: 5, travelMode: "auto", bufferMin: 0, fitRatio: 1, verdict: "tight" },
  { id: "exp-showcase", arrive: 725, activityMin: 20, travelMin: 5, travelMode: "transit", bufferMin: 0, fitRatio: 1, verdict: "tight" },
  { id: "exp-theatre", arrive: 750, activityMin: 20, travelMin: 5, travelMode: "walk", bufferMin: 0, fitRatio: 1, verdict: "tight" },
];

const dense = (): TripHealth => build({ stops: denseStops, availableMin: 300 }, context({ availableMin: 300 }))[0];

/**
 * The bad day: a storm, six exposed stops all reached on foot, nothing with
 * slack, two stops behind a booking, and four things left out by minutes.
 */
const BAD_STOPS: StopSpec[] = [
  { id: "exp-fort", arrive: 600, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 90_000 },
  { id: "exp-market", arrive: 670, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 40_000 },
  { id: "exp-beach", arrive: 740, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 40_000 },
  { id: "exp-nature", arrive: 810, activityMin: 60, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 90_000 },
  { id: "exp-theatre", arrive: 895, activityMin: 60, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 90_000 },
  { id: "exp-showcase", arrive: 980, activityMin: 45, travelMin: 25, bufferMin: 0, fitRatio: 1, verdict: "tight", costMinor: 40_000 },
];

const BAD_REJECTIONS = [
  rejection({ experienceId: "exp-cafe", code: "duration_exceeds_budget", shortfall: 5, unit: "minutes" }),
  rejection({ experienceId: "exp-gallery", code: "lead_time_too_short", shortfall: 15, unit: "minutes" }),
  rejection({ experienceId: "exp-museum", code: "closed_during_window", shortfall: 10, unit: "minutes" }),
  rejection({ experienceId: "exp-market2", code: "too_far", shortfall: 800, unit: "metres" }),
];

const BAD_CTX: DiscoveryContext = context({
  availableMin: 300,
  budget: { minor: 400_000, currency: "INR" },
  weather: { condition: "storm", tempC: 26, source: "live" },
});

const stormy = (): TripHealth =>
  assessTripHealth(plan({ stops: BAD_STOPS, availableMin: 300, rejected: BAD_REJECTIONS, costMinor: 390_000 }), BAD_CTX, CATALOGUE);

/** The same plan on a clear day with nothing left out. Only the day changed. */
const samePlanClearDay = (): TripHealth =>
  assessTripHealth(
    plan({ stops: BAD_STOPS, availableMin: 300, costMinor: 390_000 }),
    context({
      availableMin: 300,
      budget: { minor: 400_000, currency: "INR" },
      weather: { condition: "clear", tempC: 32, source: "live" },
    }),
    CATALOGUE,
  );

// ---------------------------------------------------------------------------

describe("it reads a plan the rest of the app already builds", () => {
  /**
   * WHY THIS CASE. Every other fixture here is mine, so it proves my builder
   * works with my engine. This one is `src/llm/fixtures.ts`'s Plan — the fixture
   * the narration and guardrail tests already run on — read through the same
   * catalogue. If this passes, the engine reads a `Plan` the product already
   * produces, not a shape I invented for my own convenience.
   */
  const shared = sharedPlan();
  const sharedCtx = sharedContext();
  const read = assessTripHealth(shared, sharedCtx, CATALOGUE);

  it("reads it without a single unmeasured dimension", () => {
    expect(read.unknownIds).toEqual([]);
    expect(read.coverage).toBe(1);
    expect(read.unmeasured).toEqual([]);
  });

  it("finds it sane, which is what that plan is", () => {
    expect(read.label).toBe("sane");
    expect(read.score).toBeLessThanOrEqual(THRESHOLDS.saneAt);
    expect(read.facts.stops).toBe(2);
    expect(read.facts.walkMetres).toBe(620);
  });

  it("replaces the fixture's placeholder stress figures with its own arithmetic", () => {
    expect(shared.stressScore).toBe(38);
    expect(shared.stressFactors[0]?.dimension).toBe("walking");
    const { score, factors } = toPlanStress(read);
    expect(score).not.toBe(38);
    expect(factors.map((f) => f.dimension)).toContain("transitComplexity");
    expect(factors.map((f) => f.dimension)).not.toContain("walking");
  });
});

describe("the arithmetic is pinned, not merely directional", () => {
  /**
   * WHY THESE EXACT NUMBERS. Every other case here proves a dimension MOVES.
   * This one proves the moving is arithmetic and not a vibe: if a threshold, a
   * weight or a formula is edited, these fail with the old number next to the
   * new one, which is the diff a reviewer actually wants. Order of the arrays
   * is `DIMENSIONS`, and the values are `overload, pinDebt, weatherRisk,
   * fomoRisk, spreadRisk, transitComplexity, reservationRisk`.
   */
  const golden = (): [string, number, number[]][] => [
    ["generous", generous().score, generous().dimensions.map((d) => d.value)],
    ["tight", tight().score, tight().dimensions.map((d) => d.value)],
    ["walked", walked().score, walked().dimensions.map((d) => d.value)],
    ["ridden", ridden().score, ridden().dimensions.map((d) => d.value)],
    ["dense", dense().score, dense().dimensions.map((d) => d.value)],
    ["stormy", stormy().score, stormy().dimensions.map((d) => d.value)],
    ["clear day, same plan", samePlanClearDay().score, samePlanClearDay().dimensions.map((d) => d.value)],
    ["empty", build({ stops: [] })[0].score, build({ stops: [] })[0].dimensions.map((d) => d.value)],
  ];

  it("reads the scenarios below at these scores and these seven values", () => {
    const expected: [string, number, number[]][] = [
      ["generous", 2, [6.8, 0, 0, 0, 3, 0, 0]],
      ["tight", 36, [76.9, 83.3, 0, 0, 9, 10, 0]],
      ["walked", 11, [17.9, 0, 0, 0, 11.3, 50, 0]],
      ["ridden", 2, [6, 0, 0, 0, 3.8, 0, 0]],
      ["dense", 68, [100, 94, 0, 0, 100, 100, 50]],
      ["stormy", 94, [100, 100, 81.7, 100, 100, 62.5, 100]],
      ["clear day, same plan", 69, [100, 100, 0, 0, 100, 62.5, 100]],
      ["empty", 0, [0, 0, 0, 0, 0, 0, 0]],
    ];
    expect(golden()).toEqual(expected);
  });
  it("orders the scenarios the way a traveller would", () => {
    const scores = golden().map(([, score]) => score);
    expect(scores[0]!).toBeLessThan(scores[1]!);
    expect(scores[3]!).toBeLessThan(scores[2]!);
    expect(scores[6]!).toBeLessThan(scores[5]!);
    expect(Math.max(...scores)).toBeLessThanOrEqual(100);
  });

  it("reads budget pressure off the same paise as the money", () => {
    expect(stormy().budgetPressure.value).toBe(93.75);
    expect(walked().budgetPressure.value).toBe(50);
    expect(generous().budgetPressure.value).toBe(0);
  });
});

describe("the radar is the design system's, not ours", () => {
  it("is the seven dimensions docs/DESIGN_SYSTEM.md fixes, in weight order", () => {
    expect(DIMENSIONS).toEqual([
      "overload",
      "pinDebt",
      "weatherRisk",
      "fomoRisk",
      "spreadRisk",
      "transitComplexity",
      "reservationRisk",
    ]);
  });

  it("carries the weights that document gives, and they sum to 1", () => {
    expect(DIMENSION_WEIGHTS).toEqual({
      overload: 0.25,
      pinDebt: 0.18,
      weatherRisk: 0.14,
      fomoRisk: 0.13,
      spreadRisk: 0.12,
      transitComplexity: 0.1,
      reservationRisk: 0.08,
    });
    const total = Object.values(DIMENSION_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("labels at the document's 68 and 38 cuts", () => {
    expect(THRESHOLDS.frictionAt).toBe(68);
    expect(THRESHOLDS.saneAt).toBe(38);
  });
});

describe("a generous plan reads as sane", () => {
  const health = generous();

  it("scores low, and says so in the document's own words", () => {
    expect(health.score).toBeGreaterThan(0);
    expect(health.score).toBeLessThanOrEqual(THRESHOLDS.saneAt);
    expect(health.label).toBe("sane");
    expect(health.labelSentence).toContain("Trip feels sane");
  });

  it("reports every dimension and every one is in range", () => {
    expect(health.dimensions.map((d) => d.dimension)).toEqual(DIMENSIONS);
    for (const dim of health.dimensions) {
      expect(dim.value).toBeGreaterThanOrEqual(0);
      expect(dim.value).toBeLessThanOrEqual(100);
      expect(dim.signals.length).toBeGreaterThan(0);
      for (const s of dim.signals) {
        expect(s.load).toBeGreaterThanOrEqual(0);
        expect(s.load).toBeLessThanOrEqual(1);
        expect(s.measured.length).toBeGreaterThan(0);
        expect(s.against.length).toBeGreaterThan(0);
      }
    }
  });

  it("scores zero where the data says zero, not low-but-nonzero", () => {
    expect(value(health, "fomoRisk")).toBe(0);
    expect(value(health, "weatherRisk")).toBe(0);
    expect(value(health, "pinDebt")).toBe(0);
    expect(value(health, "reservationRisk")).toBe(0);
  });

  it("adds up: the contributions are the score", () => {
    const sum = health.dimensions.reduce((total, d) => total + d.contribution, 0);
    expect(sum).toBeCloseTo(health.score, 0);
  });

  it("is deterministic, because nothing in it reads a clock", () => {
    const again = generous();
    expect(again).toEqual(health);
  });
});

describe("tight transitions raise exactly the dimensions that should move", () => {
  const calm = generous();
  const tightHealth = tight();

  it("raises the score", () => {
    expect(tightHealth.score).toBeGreaterThan(calm.score);
  });

  it("raises overload, because the plan eats its whole window", () => {
    expect(value(tightHealth, "overload")).toBeGreaterThan(value(calm, "overload"));
    expect(signal(tightHealth, "overload", "plannedVsTarget")?.load).toBeGreaterThan(0.5);
  });

  it("raises pinned time, because nothing has slack any more", () => {
    expect(value(tightHealth, "pinDebt")).toBeGreaterThan(value(calm, "pinDebt"));
    expect(signal(tightHealth, "pinDebt", "pinnedStops")?.load).toBeGreaterThan(0.5);
    expect(signal(calm, "pinDebt", "pinnedStops")?.load).toBe(0);
  });

  it("raises transit cost, because the legs are long enough to hurt", () => {
    expect(value(tightHealth, "transitComplexity")).toBeGreaterThan(value(calm, "transitComplexity"));
    expect(signal(calm, "transitComplexity", "legPain")?.load).toBe(0);
    expect(signal(tightHealth, "transitComplexity", "legPain")?.load).toBeGreaterThan(0);
  });

  it("leaves the dimensions the change did not touch exactly where they were", () => {
    expect(value(tightHealth, "fomoRisk")).toBe(value(calm, "fomoRisk"));
    expect(value(tightHealth, "weatherRisk")).toBe(value(calm, "weatherRisk"));
    expect(value(tightHealth, "reservationRisk")).toBe(value(calm, "reservationRisk"));
  });

  it("explains itself with the real numbers, not a template", () => {
    const dim = tightHealth.dimensions.find((d) => d.dimension === "overload");
    expect(dim?.explanation).toContain("planned");
    expect(dim?.explanation).toContain("you asked for");
    expect(dim?.explanation).toContain("past the moment you have to leave");
    expect(dim?.explanation).not.toMatch(/undefined|NaN|null/);
  });

  it("names the party's own ceiling when that, not the window, is what binds", () => {
    const busyDay = assessTripHealth(
      plan({ stops: DEFAULT_STOPS, availableMin: 720 }),
      context({ availableMin: 720, partyType: "business" }),
      CATALOGUE,
    );
    expect(busyDay.facts.saneTargetMin).toBe(300);
    expect(busyDay.dimensions.find((d) => d.dimension === "overload")?.explanation).toContain("a working day");
  });
});

describe("rest availability is read off the plan's own clock", () => {
  const roomy = build({
    stops: [
      { id: "exp-fort", arrive: 630, activityMin: 45, travelMin: 8, bufferMin: 20 },
      { id: "exp-gallery", arrive: 760, activityMin: 60, travelMin: 8, bufferMin: 20 },
    ],
    availableMin: 420,
  }, context({ availableMin: 420 }))[0];

  const packed = build({
    stops: [
      { id: "exp-fort", arrive: 630, activityMin: 45, travelMin: 8, bufferMin: 20 },
      { id: "exp-gallery", arrive: 675, activityMin: 60, travelMin: 8, bufferMin: 20 },
    ],
    availableMin: 420,
  }, context({ availableMin: 420 }))[0];

  it("sees a real gap between the stops and calls it a breather", () => {
    expect(signal(roomy, "pinDebt", "noBreather")?.measured).toBe("tightest transition has 1h 25m of slack");
    expect(signal(roomy, "pinDebt", "noBreather")?.load).toBe(0);
  });

  it("sees no gap at all and says so, without touching the other dimensions", () => {
    expect(signal(packed, "pinDebt", "noBreather")?.measured).toBe("tightest transition has 0m of slack");
    expect(signal(packed, "pinDebt", "noBreather")?.load).toBe(1);
    expect(value(packed, "fomoRisk")).toBe(value(roomy, "fomoRisk"));
    expect(value(packed, "reservationRisk")).toBe(value(roomy, "reservationRisk"));
  });

  it("omits the signal for a one-stop plan, which has no transition to measure", () => {
    expect(signal(build({ stops: [DEFAULT_STOPS[0]!] })[0], "pinDebt", "noBreather")).toBeUndefined();
  });

  it("does not read Fit.fitRatio as a pin, because the contract says >= 1 fits easily", () => {
    const roomyRatio = build({
      stops: [{ id: "exp-fort", arrive: 630, activityMin: 45, travelMin: 8, bufferMin: 20, fitRatio: 3 }],
    })[0];
    expect(value(roomyRatio, "pinDebt")).toBe(0);
  });
});

describe("walking load is measured, not asserted", () => {
  const onFoot = walked();
  const byCar = ridden();

  it("drops spread when the same stops are driven to", () => {
    expect(value(byCar, "spreadRisk")).toBeLessThan(value(onFoot, "spreadRisk"));
    expect(signal(onFoot, "spreadRisk", "perStop")?.measured).not.toBe(
      signal(byCar, "spreadRisk", "perStop")?.measured,
    );
  });

  it("drops transit cost when no leg is long enough to register", () => {
    expect(value(byCar, "transitComplexity")).toBeLessThan(value(onFoot, "transitComplexity"));
    expect(signal(byCar, "transitComplexity", "legPain")?.load).toBe(0);
    expect(signal(onFoot, "transitComplexity", "legPain")?.load).toBeGreaterThan(0.4);
  });

  it("counts the metres it is judging, from the legs", () => {
    expect(onFoot.facts.walkMetres).toBeGreaterThan(3_000);
    expect(byCar.facts.walkMetres).toBe(0);
    expect(onFoot.facts.totalMetres).toBeGreaterThan(byCar.facts.totalMetres);
  });

  it("charges walking more when the weather turns", () => {
    const clearDay = assessTripHealth(
      plan({ stops: DEFAULT_STOPS, availableMin: 420 }),
      context({ availableMin: 420, weather: { condition: "clear", tempC: 32, source: "live" } }),
      CATALOGUE,
    );
    const wetWalk = assessTripHealth(
      plan({ stops: DEFAULT_STOPS, availableMin: 420 }),
      context({ availableMin: 420, weather: { condition: "heavy_rain", tempC: 26, source: "live" } }),
      CATALOGUE,
    );
    expect(value(clearDay, "weatherRisk")).toBe(0);
    expect(value(wetWalk, "weatherRisk")).toBeGreaterThan(0);
    expect(signal(wetWalk, "weatherRisk", "exposedWalking")?.load).toBeGreaterThan(0);
  });
});

describe("excessive activity density is caught by density, not by a constant", () => {
  const calm = generous();
  const packed = dense();

  it("scores it far worse overall", () => {
    expect(packed.score).toBeGreaterThan(calm.score + 20);
  });

  it("drives overload through the stop-density signal specifically", () => {
    expect(signal(packed, "overload", "stopDensity")?.load).toBeGreaterThan(
      (signal(calm, "overload", "stopDensity")?.load ?? 0) + 0.3,
    );
    expect(packed.facts.stops).toBe(7);
    expect(calm.facts.stops).toBe(2);
  });

  it("penalises the mode ping-pong the density creates", () => {
    expect(signal(packed, "transitComplexity", "modeSwitches")?.load).toBeGreaterThan(0.9);
    expect(signal(calm, "transitComplexity", "modeSwitches")?.load).toBe(0);
  });

  it("is the storm and the near misses on top of the density that make the worst day", () => {
    expect(stormy().label).toBe("high_friction");
    expect(stormy().score).toBeGreaterThanOrEqual(THRESHOLDS.frictionAt);
    expect(stormy().score).toBeGreaterThan(dense().score);
    expect(stormy().labelSentence).toContain("High friction");
  });

  it("takes the same plan out of high friction on a clear day, one variable at a time", () => {
    expect(samePlanClearDay().score).toBeLessThan(stormy().score);
    expect(value(samePlanClearDay(), "weatherRisk")).toBe(0);
    expect(value(samePlanClearDay(), "fomoRisk")).toBe(0);
  });

  it("reads the storm off the condition and the stops it ruins", () => {
    const health = stormy();
    expect(signal(health, "weatherRisk", "conditionSeverity")?.measured).toContain("storm");
    expect(signal(health, "weatherRisk", "exposedStops")?.load).toBeGreaterThan(0);
    expect(signal(health, "weatherRisk", "exposedStops")?.load).toBeLessThan(1);
  });
});

describe("budget pressure is measured beside the score, not inside it", () => {
  const cheap = build({ stops: DEFAULT_STOPS, costMinor: 40_000 }, context({ budget: { minor: 200_000, currency: "INR" } }))[0];
  const squeezed = build({ stops: DEFAULT_STOPS, costMinor: 196_000 }, context({ budget: { minor: 200_000, currency: "INR" } }))[0];

  it("stays flat when the money is comfortable", () => {
    expect(cheap.budgetPressure.value).toBe(0);
    expect(cheap.budgetPressure.explanation).toContain("20%");
  });

  it("reads 98% of the ceiling as pressure, and says what breaks it", () => {
    expect(squeezed.budgetPressure.value).toBeGreaterThan(80);
    expect(squeezed.budgetPressure.explanation).toContain("98%");
    expect(squeezed.budgetPressure.explanation).toContain("One price rise");
  });

  it("measures the per-person ceiling as well as the total one", () => {
    const perHead = assessTripHealth(plan({ stops: DEFAULT_STOPS, costMinor: 120_000 }), context({
      budget: null,
      budgetPerPerson: { minor: 50_000, currency: "INR" },
      partySize: 2,
    }), CATALOGUE);
    const s = perHead.budgetPressure.signals.find((x) => x.key === "perPersonCeiling");
    expect(s?.measured).toContain("a head for 2 people");
    expect(perHead.budgetPressure.value).toBeGreaterThan(0);
  });

  it("does not fake a reading when the traveller set no ceiling", () => {
    const noCeiling = assessTripHealth(plan({ stops: DEFAULT_STOPS }), context({ budget: null }), CATALOGUE);
    expect(noCeiling.budgetPressure.signals).toEqual([]);
    expect(noCeiling.budgetPressure.value).toBe(0);
    expect(noCeiling.budgetPressure.explanation).toContain("no ceiling");
  });

  it("is deliberately outside the score, so the radar stays at seven", () => {
    expect(squeezed.dimensions).toHaveLength(7);
    expect(squeezed.dimensions.every((_d) => !(DIMENSION_WEIGHTS as Record<string, number>).budgetPressure)).toBe(true);
  });
});

describe("left-out regret and reservation risk come from the rejection ledger", () => {
  it("rises on near misses and ignores what the traveller already refused", () => {
    const none = build({ stops: DEFAULT_STOPS })[0];
    const nearMiss = build({
      stops: DEFAULT_STOPS,
      rejected: [
        rejection({ experienceId: "exp-museum", code: "duration_exceeds_budget", shortfall: 8, unit: "minutes" }),
        rejection({ experienceId: "exp-showcase", code: "too_far", shortfall: 400, unit: "metres" }),
      ],
    })[0];
    const theirs = build({
      stops: DEFAULT_STOPS,
      rejected: [
        rejection({ experienceId: "exp-museum", code: "excluded_by_traveller" }),
        rejection({ experienceId: "exp-showcase", code: "already_planned" }),
      ],
    })[0];

    expect(value(none, "fomoRisk")).toBe(0);
    expect(value(nearMiss, "fomoRisk")).toBeGreaterThan(50);
    expect(value(theirs, "fomoRisk")).toBe(0);
    expect(nearMiss.dimensions.find((d) => d.dimension === "fomoRisk")?.explanation).toContain("2");
  });

  it("counts a distant miss as less tempting than a close one", () => {
    const close = build({
      stops: DEFAULT_STOPS,
      rejected: [rejection({ experienceId: "exp-museum", code: "duration_exceeds_budget", shortfall: 5, unit: "minutes" })],
    })[0];
    const far = build({
      stops: DEFAULT_STOPS,
      rejected: [rejection({ experienceId: "exp-museum", code: "duration_exceeds_budget", shortfall: 180, unit: "minutes" })],
    })[0];
    expect(value(close, "fomoRisk")).toBeGreaterThan(value(far, "fomoRisk"));
  });

  it("rises when a stop needs a booking we cannot make in time", () => {
    const walkIn = build({ stops: DEFAULT_STOPS })[0];
    const booked = build({
      stops: [
        { id: "exp-nature", arrive: 600, activityMin: 150, travelMin: 30, bufferMin: 20, costMinor: 80_000 },
        { id: "exp-theatre", arrive: 800, activityMin: 60, travelMin: 15, bufferMin: 20, costMinor: 80_000 },
      ],
      availableMin: 300,
    }, context({ availableMin: 300 }))[0];

    expect(value(walkIn, "reservationRisk")).toBe(0);
    expect(value(booked, "reservationRisk")).toBeGreaterThan(0);
    expect(signal(booked, "reservationRisk", "bookings")?.measured).toContain("2 of 2 stops");
    expect(signal(booked, "reservationRisk", "shortNotice")?.measured).toContain("2 need more notice");
  });
});

describe("changing the plan changes the read", () => {
  it("is a strict function of the plan, not of the session", () => {
    const one = build({ stops: [DEFAULT_STOPS[0]!] })[0];
    const two = build({ stops: DEFAULT_STOPS })[0];
    const three = build({
      stops: [
        ...DEFAULT_STOPS,
        { id: "exp-cafe", arrive: 800, activityMin: 60, travelMin: 9, bufferMin: 20, costMinor: 60_000 },
      ],
    })[0];
    expect(value(three, "overload")).toBeGreaterThan(value(two, "overload"));
    expect(value(two, "overload")).toBeGreaterThan(value(one, "overload"));
    expect(three.score).toBeGreaterThan(two.score);
    expect(two.score).toBeGreaterThanOrEqual(one.score);
  });

  it("moves the score when only the context changes", () => {
    const [shortWindow] = build({ stops: DEFAULT_STOPS, availableMin: 420 }, context({ availableMin: 90 }));
    const [longWindow] = build({ stops: DEFAULT_STOPS, availableMin: 420 }, context({ availableMin: 420 }));
    expect(shortWindow.score).toBeGreaterThan(longWindow.score);
    expect(shortWindow.facts.saneTargetMin).toBe(90);
    expect(longWindow.facts.saneTargetMin).toBe(420);
  });

  it("counts a plan with nothing in it as low stress, not as a failure", () => {
    const empty = build({ stops: [] })[0];
    expect(empty.score).toBeLessThanOrEqual(THRESHOLDS.saneAt);
    expect(empty.worst.rescue).toBeTruthy();
  });

  it("never returns the same number for two different plans", () => {
    const scores = new Set([generous().score, tight().score, dense().score, stormy().score, walked().score]);
    expect(scores.size).toBeGreaterThan(3);
  });
});

describe("it degrades honestly instead of inventing a reading", () => {
  it("drops the dimensions it cannot compute when the catalogue is short", () => {
    const orphan = build({ stops: [{ id: "exp-unknown", arrive: 620, activityMin: 60, travelMin: 10, bufferMin: 20 }] })[0];
    expect(orphan.unknownIds).toEqual(["exp-unknown"]);
    expect(orphan.coverage).toBeLessThan(1);
    expect(orphan.unmeasured.map((u) => u.dimension).sort()).toEqual([
      "pinDebt",
      "reservationRisk",
      "spreadRisk",
      "weatherRisk",
    ]);
    expect(orphan.dimensions).toHaveLength(7);
    expect(orphan.dimensions.find((d) => d.dimension === "overload")?.value).toBeGreaterThanOrEqual(0);
  });

  it("takes a Map catalogue as happily as an array", () => {
    const packed = plan({ stops: DEFAULT_STOPS, availableMin: 420 });
    expect(assessTripHealth(packed, context({ availableMin: 420 }), byId).score).toBe(
      assessTripHealth(packed, context({ availableMin: 420 }), CATALOGUE).score,
    );
  });

  it("re-weights the score over what it could read, rather than scoring zero", () => {
    const orphan = build({ stops: [{ id: "exp-unknown", arrive: 620, activityMin: 60, travelMin: 10, bufferMin: 20 }] })[0];
    const coverage = orphan.coverage;
    expect(coverage).toBeCloseTo(0.25 + 0.13 + 0.1, 2);
    expect(orphan.score).toBeGreaterThanOrEqual(0);
    expect(orphan.score).toBeLessThanOrEqual(100);
  });
});

describe("thresholds are configuration, not magic numbers in the arithmetic", () => {
  it("moves the reading when a threshold moves", () => {
    const packed = plan({ stops: DEFAULT_STOPS, availableMin: 1_200 });
    const ctx = context({ availableMin: 1_200 });
    const roomy = assessTripHealth(packed, ctx, CATALOGUE, { saneTargetHours: 16 });
    const strict = assessTripHealth(packed, ctx, CATALOGUE, { saneTargetHours: 2 });
    expect(roomy.score).toBeLessThan(strict.score);
    expect(roomy.facts.saneTargetMin).toBe(960);
    expect(strict.facts.saneTargetMin).toBe(120);
  });

  it("makes density forgiving when a traveller's density thresholds are widened", () => {
    const dense2 = plan({ stops: denseStops, availableMin: 300 });
    const ctx = context({ availableMin: 300 });
    const normal = assessTripHealth(dense2, ctx, CATALOGUE);
    const packedIsFine = assessTripHealth(dense2, ctx, CATALOGUE, { densityCalmMin: 60, densityPackedMin: 20 });
    expect(packedIsFine.score).toBeLessThan(normal.score);
    expect(value(packedIsFine, "overload")).toBeLessThan(value(normal, "overload"));
  });

  it("moves the label cut without touching any dimension", () => {
    const health = dense();
    const lenient = assessTripHealth(plan({ stops: denseStops, availableMin: 300 }), context({ availableMin: 300 }), CATALOGUE, {
      frictionAt: 10,
    });
    expect(lenient.score).toBe(health.score);
    expect(lenient.label).toBe("high_friction");
  });
});

describe("the contract's own two fields, filled from the read", () => {
  it("produces Plan.stressScore and Plan.stressFactors that the schema accepts", () => {
    const health = stormy();
    const { score, factors } = toPlanStress(health);
    const filled = PlanSchema.parse({
      ...plan({ stops: BAD_STOPS, availableMin: 300 }),
      stressScore: score,
      stressFactors: factors,
    });
    expect(filled.stressScore).toBe(health.score);
    expect(filled.stressScore).toBeGreaterThanOrEqual(0);
    expect(filled.stressScore).toBeLessThanOrEqual(100);
    expect(filled.stressFactors).toHaveLength(7);
  });

  it("carries the rescue on the worst factor only, as the contract's comment says", () => {
    const health = dense();
    const { factors } = toPlanStress(health);
    expect(factors.filter((f) => f.rescue !== null)).toHaveLength(1);
    expect(factors.find((f) => f.rescue !== null)?.dimension).toBe(health.worst.dimension);
    expect(health.worst.rescue).toBeTruthy();
    expect(health.worst.rescue).toMatch(/[.!]$/);
  });

  it("names the worst factor by contribution, not by declaration order", () => {
    const health = build({
      stops: DEFAULT_STOPS,
      rejected: [
        rejection({ experienceId: "exp-museum", code: "duration_exceeds_budget", shortfall: 5, unit: "minutes" }),
        rejection({ experienceId: "exp-showcase", code: "requires_booking_not_available", shortfall: 10, unit: "minutes" }),
        rejection({ experienceId: "exp-beach", code: "too_far", shortfall: 900, unit: "metres" }),
      ],
    })[0];
    expect(health.worst.dimension).toBe("fomoRisk");
    expect(health.worst.rescue).toContain("needed");
  });

  it("uses the design system's keys, which is what the radar indexes by", () => {
    const { factors } = toPlanStress(dense());
    expect(factors.map((f) => f.dimension)).toEqual(DIMENSIONS);
  });
});

describe("the fixtures are the contract, not a shape we invented", () => {
  it("parses every catalogue row through the real schema", () => {
    expect(CATALOGUE.length).toBeGreaterThan(4);
    expect(CATALOGUE.map((e) => e.id)).toContain("exp-fort");
    expect(byId.get("exp-nature")?.booking.required).toBe(true);
  });

  it("builds plans whose fits add up and whose legs join real stops", () => {
    const health = generous();
    expect(health.facts.stops).toBe(2);
    expect(health.facts.legs).toBe(1);
    expect(health.facts.travelMin).toBe(8);
    expect(health.facts.onSiteMin).toBe(105);
    expect(health.facts.bufferMin).toBe(40);
  });

  it("leaves the weather source visible, because 'clear' from nowhere is not clear", () => {
    const guessed = assessTripHealth(plan({ stops: DEFAULT_STOPS }), context({ weather: { condition: "clear", tempC: 30, source: "unknown" } }), CATALOGUE);
    expect(signal(guessed, "weatherRisk", "conditionSeverity")?.measured).toContain("source: unknown");
  });

  it("counts an unverified listing as a pin, because it is an unfixable time", () => {
    const unverified = exp({ id: "exp-gallery", name: "Unverified", hours: { raw: null, status: "absent", lastVerified: null } });
    const read = assessTripHealth(
      plan({ stops: DEFAULT_STOPS }),
      context({ availableMin: 420 }),
      CATALOGUE.map((e) => (e.id === "exp-gallery" ? unverified : e)),
    );
    expect(signal(read, "pinDebt", "unverifiable")?.load).toBeGreaterThan(0);
  });
});

