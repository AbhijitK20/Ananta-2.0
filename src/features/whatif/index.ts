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
 *   import { SCENARIO_PRESET_BY_ID, present, simulate } from "@/features/whatif";
 *
 *   const preset = SCENARIO_PRESET_BY_ID.get("more_money")!;
 *   const outcome = simulate(engine, session, preset.edits);
 *   if (outcome.ok) render(present(outcome.scenario, preset.question));
 *
 * `present` resolves every string and every delta, so the component renders
 * numbers and never computes them. Those two lines are the entire integration
 * surface for whoever owns the page.
 *
 * Three shapes, in increasing order of how much they answer:
 *
 *   simulate   one question, one plan, one diff against the live trip.
 *   gates      what became POSSIBLE, read from `Plan.rejected` on both sides.
 *              The diff cannot see it; it only explains what left a plan.
 *   ladder     one axis, many rungs, and the rung where it stops paying — the
 *              answer to "is ₹500 more worth it", which no single plan can give.
 *
 * The live trip cannot be mutated, and cannot be replaced either: `simulate`
 * returns no `DiscoverySession`, so there is nothing here to adopt by mistake.
 */
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
  findingsIn,
  gateChanges,
  unlockedBy,
  type GateChange,
  type GateChangeKind,
  type GateState,
} from "./gates";

export {
  editFor,
  labelFor,
  ladder,
  LADDER_UNITS,
  type Ladder,
  type LadderAxis,
  type LadderRung,
  type LadderUnit,
  type MarginalStep,
} from "./ladder";

export {
  present,
  type PanelDirection,
  type PanelRow,
  type PanelStop,
  type WhatIfPanel,
} from "./present";

export {
  SCENARIO_PRESETS,
  SCENARIO_PRESET_BY_ID,
  type ScenarioPreset,
} from "./presets";
