/**
 * The trip health feature, in one import.
 *
 * `src/features/health` answers exactly one question — how hard is this plan —
 * and answers it from the `Plan`, the `DiscoveryContext` and the catalogue.
 * It computes nothing about feasibility and nothing about the engine's own
 * score, so it does not belong behind `src/features/discovery`'s barrel, which
 * says of itself: "Nothing in this folder computes a fit, a score, a rejection
 * or an objective."
 */
export {
  DIMENSION_LABELS,
  DIMENSION_WEIGHTS,
  DIMENSIONS,
  THRESHOLDS,
  assessTripHealth,
  bandOf,
  dimensionLabel,
  indexCatalogue,
  isIndex,
  stressFor,
  toPlanStress,
  type Catalogue,
  type CompanionDimension,
  type Dimension,
  type HealthBand,
  type HealthDimension,
  type HealthLabel,
  type Signal,
  type Thresholds,
  type TripFacts,
  type TripHealth,
} from "./health";

export {
  compareHealth,
  recoveryMoves,
  type DimensionMove,
  type HealthDelta,
  type RecoveryCost,
  type RecoveryKind,
  type RecoveryMove,
} from "./recovery";
