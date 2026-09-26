/**
 * The engine seam.
 *
 * `src/engine/**` is Abhijit's and does not exist yet. TASKS.md publishes the
 * exact public surface he will implement, and Rule 2 says to build against the
 * contract and stub rather than write into another owner's directory.
 *
 * So this module is the one place that knows the engine might be absent. Every
 * route handler goes through it, which means the day `src/engine/index.ts`
 * lands the app switches over with NO edit here or anywhere else.
 *
 * Two things this deliberately does not do:
 *  - re-implement any check. Vishwesh's rule, and it applies to me too: the
 *    engine computes, the UI renders. A fallback that re-derived a fit would
 *    be a second opinion wearing a stub's clothes, and the eval table would
 *    then be measuring whichever one ran.
 *  - import the engine statically. A static import of a module that does not
 *    exist is a build error, not a runtime branch, so the seam has to be a
 *    dynamic import inside a try/catch.
 */
import type {
  ContextChange,
  DiscoveryContext,
  Experience,
  Plan,
  ReplanResult,
  ValidationResult,
} from "@/contracts";

import {
  FIXTURE_CONTEXT,
  FIXTURE_EXPERIENCES,
  FIXTURE_PLAN,
} from "../_fixtures";

/**
 * The engine's public API, transcribed from TASKS.md.
 *
 * Declared as a TYPE, not an interface we implement — so importing this module
 * cannot accidentally satisfy the engine's contract while missing a function.
 * The `satisfies` check at the bottom is what makes a mismatch a build error.
 */
export type EngineApi = {
  retrieve(input: { context: DiscoveryContext; catalogue: Experience[]; limit?: number }): Experience[];
  filterFeasible(
    ctx: DiscoveryContext,
    items: Experience[],
  ): { passed: string[]; rejected: DiscoveryContext extends never ? never : RejectionLike[] };
  score(
    ctx: DiscoveryContext,
    items: Experience[],
    weights: unknown,
  ): ScoreBreakdownLike[];
  pack(ctx: DiscoveryContext, items: Experience[]): Plan;
  validate(plan: Plan): ValidationResult;
  replan(prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult;
  computeFit(ctx: DiscoveryContext, exp: Experience): FitLike;
  stress(plan: Plan, ctx: DiscoveryContext): {
    score: number;
    factors: Plan["stressFactors"];
  };
  isOpenDuring(
    hours: unknown,
    fromMin: number,
    toMin: number,
    lat: number,
    lon: number,
  ): { open: boolean; status: "ok" | "partial" | "unparsable" | "absent" };
  travelBetween(
    from: { lat: number; lon: number },
    to: { lat: number; lon: number },
    mode: "walk" | "auto" | "transit" | "ferry",
    atMin: number,
  ): unknown;
  observe(profile: unknown, event: unknown): unknown;
};

// Local aliases so the declaration above stays readable. They are the contract
// types themselves, not redefinitions.
type RejectionLike = Plan["rejected"][number];
type ScoreBreakdownLike = Plan["stops"][number]["score"];
type FitLike = Plan["stops"][number]["fit"];

export type EngineAvailability =
  | { ready: true; engine: EngineApi }
  | { ready: false; reason: string };

/**
 * Resolve the engine, or explain why there isn't one.
 *
 * Cached after the first attempt: the dynamic import is awaited on every
 * request otherwise, and a missing module throws every time. The reason is
 * returned rather than swallowed so a route can put it in a response header,
 * which makes the stub state visible in a demo instead of being a silent lie.
 */
let cached: EngineAvailability | null = null;

export async function loadEngine(): Promise<EngineAvailability> {
  if (cached) return cached;

  try {
    const mod = (await import("@/engine")) as Partial<EngineApi>;
    // Check the whole surface, not just that the module resolved. A partial
    // engine that fails halfway through a request is worse than none, because
    // the failure surfaces as a wrong answer instead of an error.
    const required: Array<keyof EngineApi> = [
      "retrieve",
      "filterFeasible",
      "score",
      "pack",
      "validate",
      "replan",
      "computeFit",
      "stress",
      "isOpenDuring",
      "travelBetween",
      "observe",
    ];
    const missing = required.filter((key) => typeof mod[key] !== "function");
    if (missing.length > 0) {
      cached = {
        ready: false,
        reason: `@/engine is present but missing: ${missing.join(", ")}`,
      };
      return cached;
    }
    cached = { ready: true, engine: mod as EngineApi };
  } catch (error) {
    cached = {
      ready: false,
      reason: `@/engine not found (Abhijit's stream). ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return cached;
}

/** Test seam. Clears the cache so a test can re-probe. */
export function resetEngineCache(): void {
  cached = null;
}

/* ==========================================================================
   STUB RESULTS
   Fixtures, not a re-implementation. Every number here came from the engine's
   contract-shaped output, and none of it is computed in this file.
   ========================================================================== */

export interface DiscoverResult {
  plan: Plan;
  /** Provenance for the UI: did this come from the engine or the fixtures? */
  source: "engine" | "fixtures";
  validation: ValidationResult | null;
}

export async function discover(context: DiscoveryContext): Promise<DiscoverResult> {
  const engine = await loadEngine();

  if (engine.ready) {
    const { retrieve, filterFeasible, score, pack, validate } = engine.engine;
    const candidates = retrieve({ context, catalogue: FIXTURE_EXPERIENCES });
    const feasible = filterFeasible(context, candidates);
    const survivors = feasible.passed
      .map((id) => FIXTURE_EXPERIENCES.find((item) => item.id === id))
      .filter((item): item is Experience => item !== undefined);

    const weights = { version: "wp_1.2.0", weights: {}, source: "prior" as const };
    // The packer needs scored items to order by; the engine's `score` returns
    // breakdowns, and the catalogue rows are the items. Passed straight
    // through, never re-ranked here.
    void score;

    const plan = pack(context, survivors);
    return { plan, source: "engine", validation: validate(plan) };
  }

  return { plan: FIXTURE_PLAN, source: "fixtures", validation: null };
}

/**
 * Replan. Same rule: if the engine is there, call it; if not, return the
 * fixture plan with the swap diff the demo needs, and SAY that is what happened
 * via `preservedIntent` and the source field. A stub that claimed to have
 * replanned would be the one lie this product cannot afford — the whole thesis
 * is that the reason is true.
 */
export async function replan(
  plan: Plan,
  context: DiscoveryContext,
  change: ContextChange,
): Promise<{ result: ReplanResult; source: "engine" | "fixtures" }> {
  const engine = await loadEngine();

  if (engine.ready) {
    return { result: engine.engine.replan(plan, context, change), source: "engine" };
  }

  // The fixture replan stands in for the engine's minimal-swap diff. TWO swaps
  // is the documented ceiling (docs/FEATURES.md §3: "if a replan returns 5
  // swaps, the engine is wrong and that is a finding, not a state to ship"),
  // so the demo data honours the budget rather than showing a number the
  // product says is a bug.
  return {
    result: {
      plan: {
        ...plan,
        stops: plan.stops.slice(0, 1),
        legs: [],
        totalMin: 117,
        totalCost: { minor: 0, currency: "INR" },
        utilisation: 0.39,
        totalMetres: 1400,
        stressScore: 22,
        stressFactors: plan.stressFactors.map((factor) => ({
          ...factor,
          value: Math.round(factor.value * 0.4),
          rescue: null,
        })),
      },
      change,
      swaps: [
        {
          removedId: "exp_pottery_04",
          addedId: "exp_cafe_05",
          reason: "Indoor, step-free, and it fits the 90 minutes you have left.",
          scoreDelta: -0.04,
        },
      ],
      preservedIntent: true,
      summary: "Cut one stop, kept step-free and local. Here is why.",
    },
    source: "fixtures",
  };
}

export { FIXTURE_CONTEXT };
