/**
 * The engine is authoritative. This file is the only place in the discovery
 * feature that names it.
 *
 * Why a local port instead of `import { replan } from "@/engine"`:
 *  - `src/engine/**` belongs to Abhijit (TASKS.md ownership table). We consume,
 *    we never write there.
 *  - This folder has to typecheck on a branch where his files are not present
 *    yet, and a bare import of a missing module fails `tsc --noEmit` for the
 *    whole repo.
 *  - The port is structural, so the single wiring line in the app
 *    (`createSession({ engine, ... })`) is type-checked by `tsc` against the
 *    real engine. If a signature drifts, the build breaks at the wiring site
 *    with a normal type error, not here with a mystery.
 *
 * So: one wiring line in `src/app`, zero engine logic under `src/features/**`.
 * If the engine grows a function, it is added to this interface, not invented
 * locally.
 */
import type {
  ContextChange,
  DiscoveryContext,
  Experience,
  FeasibleResult,
  Fit,
  GeoPoint,
  Plan,
  ReplanResult,
  RetrieveInput,
  ScoreBreakdown,
  TravelLeg,
  ValidationResult,
  WeightProfile,
} from "../../contracts";

/** `TravelLeg["mode"]` also allows `ferry`, which `travelMode` does not. */
export type TravelMode = TravelLeg["mode"];

/**
 * Exactly the surface published in TASKS.md §"The engine's public API".
 * Pure functions, no I/O, no model, no `Date` objects.
 */
export interface EnginePort {
  retrieve(input: RetrieveInput): Experience[];
  filterFeasible(ctx: DiscoveryContext, items: Experience[]): FeasibleResult;
  score(ctx: DiscoveryContext, items: Experience[], weights: WeightProfile): ScoreBreakdown[];
  pack(ctx: DiscoveryContext, items: Experience[]): Plan;
  validate(plan: Plan): ValidationResult;
  replan(prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult;
  computeFit(ctx: DiscoveryContext, exp: Experience): Fit;
  stress(plan: Plan, ctx: DiscoveryContext): { score: number; factors: Plan["stressFactors"] };
  travelBetween(from: GeoPoint, to: GeoPoint, mode: TravelMode, atMin: number): TravelLeg;
}
