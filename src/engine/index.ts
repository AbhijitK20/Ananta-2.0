/**
 * src/engine/index.ts
 *
 * The engine's public API. This is the only module the app and the feature
 * streams import; nothing outside `src/engine/` reaches into the individual
 * stage files. Vishwesh builds against this surface (TASKS.md §"The engine's
 * public API"), Karan reads only contract types, and `tests/engine-seam.test.ts`
 * asserts that this barrel actually provides every declared export.
 *
 * The eleven functions below are the seam, and they appear in pipeline order —
 * Retrieve -> Feasible -> Score -> Fit/Pack -> Validate -> Replan — with the two
 * supporting primitives (hours, travel) and the learning arm alongside. Types
 * and tunable constants are re-exported too: the UI renders `Fit`, `Plan` and
 * `Rejection` from the contract, and the stress radar needs its dimensions and
 * weights, but none of them are functions so they do not widen the seam.
 *
 * Every re-export below resolves to a real implementation in this directory. If
 * a name is not listed here it is internal and free to change.
 */

// --- the seam: the eleven declared functions --------------------------------

// Retrieve. Pure, no LLM: narrows the catalogue before anything expensive runs.
export { retrieve } from "./retrieve";

// Feasibility. The hard gate. Emits a Rejection for EVERY survivor it drops.
export { filterFeasible } from "./feasibility";

// Scoring. One auditable scalar, split into named contributions.
export { score, DEFAULT_PROFILE } from "./scoring";

// Fit. Backs the per-card feasibility meter.
export { computeFit } from "./fit";

// Packing. Cluster, order, and stay inside the window.
export { pack, ENGINE_VERSION } from "./packer";

/*
  The orchestrator, and the ONLY supported way to get a Plan.

  `retrieve -> filterFeasible -> pack` cannot be wired up by a caller. `pack`
  returns a `PackResult` (stops, legs, totals, no utilisation, no stress, no
  `createdAt`) which is deliberately not a `Plan`, so somebody has to assemble
  the contract shape — and forwarding weekday/month to both the gate and the
  packer without forgetting one is a real trap, not a stylistic one. `plan.ts`
  exists to be the single answer.

  It is on the seam because it is what every consumer actually needs. Callers
  that hand-assemble the stages are how the API routes ended up passing two
  arguments to a three-argument `filterFeasible` and returning 500 on every
  request while all 1,145 tests passed.
*/
export { planItinerary } from "./plan";
export type { PlanOptions, PlanResult } from "./plan";

// Validation. The independent check: recompute the plan, reject on drift.
export { validate } from "./validate";

// Stress. The seven-dimension fragility radar for the whole itinerary.
// `stressLabel` is deliberately NOT re-exported here: it is a label helper for
// the UI, not a seam function, and the seam test flags any function exported
// beyond the declared eleven. Import it from "@/engine/stress" if needed.
export { stress, STRESS_DIMENSIONS, STRESS_WEIGHTS } from "./stress";
export type { StressDimension, StressLabel } from "./stress";

// Replan. Minimal swaps, diffed against the immutable original intent.
export { replan, MAX_SWAPS } from "./replan";

// Learning. The bandit arm behind "what I learned about you".
export { observe } from "./observe";

// --- supporting primitives declared on the seam -----------------------------

export { isOpenDuring } from "./hours";
export { travelBetween } from "./travel";

// --- types the public surface is expressed in --------------------------------

export type { Candidate, FilterOptions } from "./feasibility";
export type { PackOptions, PackResult, ScaleProfile, Cluster } from "./packer";
export type { FitInput, RelaxationRung } from "./fit";
export type { TravelMode, TimeBand, TravelContext, TravelResult } from "./travel";
export type { RouteProvider, CongestionTable, TransitCorridor } from "./travel";
export type { HoursStatus, Interval, HoursEvaluation, OpenVerdict } from "./hours";
export type { WeightProfile } from "./scoring";
export type { BBox, Isochrone, RadiusGraph, Costing } from "./geo";
