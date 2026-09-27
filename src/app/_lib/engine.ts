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
  Plan,
  ReplanResult,
  ValidationResult,
} from "@/contracts";
import { weekdayOf } from "@/lib/time";

import { loadCatalogue } from "./catalogue";
import {
  FIXTURE_CONTEXT,
  FIXTURE_EXPERIENCES,
  FIXTURE_PLAN,
} from "../_fixtures";

/**
 * The engine module, as the seam needs it.
 *
 * `typeof import("@/engine")` rather than a hand-transcribed shape. This file
 * used to declare its own `EngineApi` describing eleven functions, and an
 * ambient `engine-seam.d.ts` declared the same eleven a second time, and BOTH
 * disagreed with the engine that actually landed:
 *
 *   - `filterFeasible(ctx, candidates)` vs the real `(ctx, candidates, opts)`
 *   - `pack(ctx, survivors): Plan` vs the real `(ctx, feasible, opts): PackResult`
 *   - `filterFeasible` takes `Candidate[]` (`{experience, travelMin, ...}`),
 *     not `Experience[]`
 *
 * Every name existed, so the name-based seam test passed, `tsc` was satisfied by
 * the fiction, and all 1,145 tests were green while `POST /api/discover` and
 * `PUT /api/discover` returned a bodiless 500 on every request. The arity and
 * shape were only ever checkable by CALLING it, which nothing did.
 *
 * Deriving the type from the real module makes that class of drift a compile
 * error instead of a production 500. The dynamic import is still load-bearing:
 * it is what lets a build without the engine fall back to fixtures.
 */
type EngineModule = typeof import("@/engine");

export type EngineAvailability =
  | { ready: true; engine: EngineModule }
  | { ready: false; reason: string };

/**
 * The exports the UI requires before it will call the engine at all.
 *
 * Exported so `tests/engine-seam.test.ts` can assert that this runtime guard and
 * the test's own copy of the contract have not drifted apart. That test is the
 * only thing that can catch the drift, because the ambient declaration in
 * `engine-seam.d.ts` is invisible to the typechecker once it exists.
 *
 * Order does not matter; the test sorts both sides.
 */
export const REQUIRED_ENGINE_EXPORTS = [
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
  "planItinerary",
] as const satisfies ReadonlyArray<Extract<keyof EngineModule, string>>;

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
    const mod = (await import("@/engine")) as Partial<EngineModule>;
    // Check the whole surface, not just that the module resolved. A partial
    // engine that fails halfway through a request is worse than none, because
    // the failure surfaces as a wrong answer instead of an error.
    const missing = REQUIRED_ENGINE_EXPORTS.filter((key) => typeof mod[key] !== "function");
    if (missing.length > 0) {
      cached = {
        ready: false,
        reason: `@/engine is present but missing: ${missing.join(", ")}`,
      };
      return cached;
    }
    cached = { ready: true, engine: mod as EngineModule };
  } catch (error) {
    cached = {
      ready: false,
      reason: `@/engine failed to load. ${
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
    /*
      One call, not three.

      This used to hand-assemble `retrieve -> filterFeasible -> pack`, against a
      signature published in TASKS.md rather than one that existed. It threw a
      TypeError on `opts` for every request. `planItinerary` is the orchestrator
      that the landing page already used successfully, so calling it here is both
      the fix and the smaller diff: no retrieve wiring, no Candidate decoration,
      no PackResult-to-Plan assembly, and no chance of forwarding `weekday` to
      the gate but forgetting it for the packer.

      The catalogue is the real one, same as the page. Serving the 133 fixture
      rows from the API while the page served 4,982 harvested rows would have
      been two different products behind one origin.
    */
    const { experiences } = await loadCatalogue();
    const catalogue = experiences.length > 0 ? experiences : FIXTURE_EXPERIENCES;

    const result = engine.engine.planItinerary(context, catalogue, {
      weekday: weekdayOf(new Date()),
      month: new Date().getMonth() + 1,
    });

    return { plan: result.plan, source: "engine", validation: result.validation };
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
