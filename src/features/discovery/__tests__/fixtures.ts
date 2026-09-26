/**
 * Test doubles for the engine seam.
 *
 * This is a fake, not a second engine: it holds two plans the test supplies and
 * returns them. It makes no feasibility decision, computes no fit and no score.
 * The point is to test the feature's own logic — the diff, the guard, the panel —
 * and to make the engine's failure modes reproducible, which is most of what the
 * safety requirements are about.
 *
 * The plans and experiences are built to satisfy the real contract schemas, so a
 * fixture that drifts from the contract fails here rather than in production.
 */
import {
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type Plan,
  type Rejection,
  type RejectionCode,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
  type GeoPoint,
  Experience as ExperienceSchema,
  Plan as PlanSchema,
} from "../../../contracts";
import type { EnginePort, TravelMode } from "../engine";

export const WEIGHTS: WeightProfile = {
  version: "test-1",
  weights: { interest: 1, proximity: 1, rating: 0.5 },
  source: "prior",
  updatedAt: "2026-01-01T00:00:00.000Z",
  observations: 0,
};

const AT = "2026-01-01T00:00:00.000Z";
const rupees = (minor: number) => ({ minor, currency: "INR" as const });

export function exp(overrides: Partial<Experience> & Pick<Experience, "id" | "name">): Experience {
  return ExperienceSchema.parse({
    category: "street_food",
    location: { lat: 19.0, lon: 72.87 },
    durationMin: 45,
    pricePerPerson: rupees(30000),
    capacity: null,
    hours: { raw: "Mo-Su 09:00-22:00", status: "ok", lastVerified: null },
    indoorOutdoor: "outdoor",
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
    rating: { value: 4.4, count: 210, rawMean: 4.5 },
    blurb: null,
    description: null,
    keywords: [],
    neighbourhood: "Colaba",
    city: "Mumbai",
    ...overrides,
  });
}

export type StopSpec = {
  id: string;
  order: number;
  arriveMin: number;
  durationMin?: number;
  costMinor?: number;
  score?: number;
  why?: string[];
  fitRatio?: number;
};

export function stop(ctx: DiscoveryContext, spec: StopSpec): Plan["stops"][number] {
  const duration = spec.durationMin ?? 45;
  return {
    experienceId: spec.id,
    arriveMin: spec.arriveMin,
    departMin: spec.arriveMin + duration,
    order: spec.order,
    why: spec.why ?? ["Closest thing that fits your window."],
    score: {
      experienceId: spec.id,
      total: spec.score ?? 10,
      components: [
        { key: "proximity", label: "Close by", value: 4, weight: 1, reason: "1.2 km away" },
      ],
      profileVersion: "test-1",
      learnedComponents: [],
    },
    fit: {
      experienceId: spec.id,
      travelMin: 10,
      activityMin: duration,
      bufferMin: 5,
      totalMin: duration + 15,
      availableMin: ctx.availableMin,
      fitRatio: spec.fitRatio ?? 1.2,
      cost: rupees(spec.costMinor ?? 30000),
      budget: ctx.budget,
      checks: [{ label: "Fits your window", pass: true, detail: "45 min on site, 15 min travel." }],
      verdict: "fits",
    },
  };
}

/** A plan that satisfies `Plan.parse`, built from a list of stops. */
export function plan(ctx: DiscoveryContext, stops: StopSpec[], overrides: Partial<Plan> = {}): Plan {
  const built = stops.map((spec) => stop(ctx, spec));
  const totalCost = built.reduce((sum, item) => sum + item.fit.cost.minor, 0);
  const totalMin = built.reduce((max, item) => Math.max(max, item.departMin), ctx.nowMin) - ctx.nowMin;
  return PlanSchema.parse({
    id: "plan-test",
    contextId: ctx.id,
    stops: built,
    legs: [],
    totalMin,
    totalCost: rupees(totalCost),
    utilisation: totalMin / ctx.availableMin,
    totalMetres: 1200 * Math.max(0, built.length - 1),
    rejected: [],
    createdAt: AT,
    engineVersion: "test-1",
    ...overrides,
  });
}

export function rejection(
  id: string,
  code: RejectionCode,
  message: string,
  shortfall = 40,
): Rejection {
  return {
    experienceId: id,
    code,
    message,
    shortfall,
    unit: code === "over_budget" ? "minor_units" : "minutes",
    relaxable: true,
  };
}

const travelBetween = (from: GeoPoint, to: GeoPoint, _mode: TravelMode, _atMin: number): TravelLeg => ({
  fromId: `${from.lat},${from.lon}`,
  toId: `${to.lat},${to.lon}`,
  mode: "walk",
  minutes: 12,
  metres: 900,
  detail: null,
  estimated: true,
});

export type FakeOptions = {
  /** What `pack` returns on the first build. */
  initial: Plan;
  /** Successive answers from `replan`, or a function of (prev, ctx, change). */
  replans?: ReplanResult[] | ((prev: Plan, ctx: DiscoveryContext, change: ContextChange) => ReplanResult);
  /** Thrown instead of answering, to test a re-solve that blows up. */
  replanThrows?: Error;
  validate?: ValidationResult;
  catalogue?: Experience[];
};

export function fakeEngine(options: FakeOptions): EnginePort {
  let call = 0;
  const nextReplan = (prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult => {
    if (options.replanThrows) throw options.replanThrows;
    const spec = options.replans;
    if (typeof spec === "function") return spec(prev, ctx, change);
    const result = spec?.[call];
    call += 1;
    if (!result) throw new Error("fakeEngine ran out of replan answers");
    return result;
  };

  const ok: ValidationResult = { ok: true, violations: [], recomputedObjective: 0, claimedObjective: 0, objectiveDelta: 0 };

  return {
    retrieve(input: RetrieveInput): Experience[] {
      return input.catalogue.slice(0, input.limit);
    },
    filterFeasible(_ctx: DiscoveryContext, items: Experience[]): FeasibleResult {
      return { passed: items.map((item) => item.id), rejected: [] };
    },
    score(_ctx: DiscoveryContext, items: Experience[]): ScoreBreakdown[] {
      return items.map((item) => ({
        experienceId: item.id,
        total: 10,
        components: [],
        profileVersion: "test-1",
        learnedComponents: [],
      }));
    },
    pack(): Plan {
      return options.initial;
    },
    validate(): ValidationResult {
      return options.validate ?? ok;
    },
    replan: nextReplan,
    computeFit(ctx: DiscoveryContext, item: Experience): Fit {
      return {
        experienceId: item.id,
        travelMin: 10,
        activityMin: item.durationMin,
        bufferMin: 5,
        totalMin: item.durationMin + 15,
        availableMin: ctx.availableMin,
        fitRatio: (item.durationMin + 15) / Math.max(1, ctx.availableMin),
        cost: item.pricePerPerson ?? rupees(0),
        budget: ctx.budget,
        checks: [],
        verdict: item.durationMin + 15 <= ctx.availableMin ? "fits" : "does_not_fit",
      };
    },
    stress(_plan: Plan, _ctx: DiscoveryContext) {
      return { score: 40, factors: [] };
    },
    travelBetween,
  };
}

/** A `ReplanResult` around a plan the test built by hand. */
export function replanResult(planValue: Plan, change: ContextChange, swaps: ReplanResult["swaps"] = []): ReplanResult {
  return { plan: planValue, change, swaps, preservedIntent: true, summary: "Re-solved." };
}
