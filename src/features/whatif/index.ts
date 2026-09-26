/**
 * `src/features/whatif/**` — counterfactual trip simulation.
 *
 * One rule, and everything else follows from it: a what-if runs the real planner.
 * Not a narration of what the planner would do, not a diff of two strings, not a
 * sentence with a number in it. `simulate()` hands a cloned `DiscoveryContext` to
 * `discover()` and returns the `Plan` that comes back, so the answer to "what if
 * it rains?" is an actual itinerary you could look at — and therefore one you can
 * catch being wrong.
 *
 *   import { SCENARIO_PRESET_BY_ID, simulate } from "@/features/whatif";
 *
 *   const preset = SCENARIO_PRESET_BY_ID.get("more_money")!;
 *   const outcome = simulate(engine, session, preset.edits);
 *   outcome.ok && renderWhatIf(outcome.scenario);   // never render the live plan
 *
 * The live trip cannot be mutated, and cannot be replaced either: `simulate`
 * returns no `DiscoverySession`, so there is nothing here to adopt by mistake.
 */
// The public surface is one function and one token convention. Everything else —
// the clone, the patch, the comparison, the breach check — is a step inside
// `simulate` and is tested through it, because a caller that recomputes any of it
// is a caller who can get a different answer than the planner did.
//
// `walkCapToken` / `walkCapOf` are the exception, and deliberately so: the
// `max_walk_<m>m` convention is a contract with whoever implements the engine,
// and a convention nobody can name is a convention nobody honours.
export {
  WALK_CAP_PREFIX,
  deltaOf,
  simulate,
  walkCapOf,
  walkCapToken,
  type AxisComparison,
  type ScenarioBreach,
  type ScenarioComparison,
  type ScenarioDelta,
  type ScenarioEdit,
  type ScenarioOutcome,
  type ScenarioResult,
} from "./scenario";

export {
  SCENARIO_PRESETS,
  SCENARIO_PRESET_BY_ID,
  type ScenarioPreset,
} from "./presets";
