/**
 * Provider analytics and demand intelligence. The public surface.
 *
 * The loop, end to end:
 *
 *   UnmetDemand  ->  aggregateDemand / buildCells  ->  buildOpportunities
 *                ->  buildProviderSuggestions      ->  ProviderOpportunity
 *
 * Everything is a pure function of a `AnalyticsSource` plus a fixed `asOf`. There
 * is no clock, no randomness, and no I/O, so the same input gives the same bytes
 * in a test, in CI, and in a screen recording.
 *
 * Typical use from a page:
 *
 *   const source = resolveAnalyticsSource();          // demo until the API lands
 *   const dashboard = buildDashboard(source, "prov-nila");
 *
 * Then render `<ProviderDashboardView dashboard={dashboard} />` and wire
 * `onOpportunity` / `onSuggestion` to the listing editor.
 */
export { parseAnalyticsSource, resolveAnalyticsSource } from "./adapter";
export { createDemoSource, AS_OF, IST_OFFSET_MIN } from "./demo-data";

export {
  aggregateDemand,
  buildCells,
  categoryIntent,
  distanceKm,
  durationBandOf,
  humanise,
  localDate,
  localMinutesOfDay,
  median,
  MIN_SAMPLE,
  MUMBAI_TZ_OFFSET_MIN,
  partyBandOf,
  priceBandOf,
  RADIUS_KM,
  rejectionLabel,
  round3,
  WINDOW_DAYS,
  windowStart,
} from "./aggregate";
export type { AggregateOptions, Band, CellOptions, CategoryIntent } from "./aggregate";

export {
  buildOpportunities,
  buildProviderSuggestions,
  fixFor,
  MAX_SUGGESTIONS,
  MIN_CELL_FOR_OPPORTUNITY,
  NEVER_AN_OPPORTUNITY,
  opportunitiesFor,
} from "./opportunities";
export type { BuildOptions } from "./opportunities";

export {
  buildAllDashboards,
  buildDashboard,
  citywideOpportunities,
  CONFIDENCE_FLOOR,
} from "./dashboard";
export type { DashboardOptions } from "./dashboard";

export {
  describeWindow,
  formatClock,
  formatCount,
  formatDay,
  formatInr,
  formatMinutes,
  formatPercent,
  suggestedWindow,
  TIME_BUCKETS,
  timeBucketLabel,
  timeBucketOf,
  timeBucketShort,
} from "./format";

export {
  toCopilotBrief,
  toGraphExport,
  toSupplyLoopSignals,
} from "./graph";
export type {
  CopilotBrief,
  GraphEdge,
  GraphEdgeKind,
  GraphExport,
  GraphNode,
  GraphNodeKind,
  SupplyLoopSignal,
} from "./graph";

export { ProviderDashboardView } from "./components/ProviderDashboardView";
export type { ProviderDashboardViewProps } from "./components/ProviderDashboardView";
export {
  DemandBars,
  DemandHeatGrid,
  MetricCard,
  OpportunityCard,
  Panel,
  SuggestionRow,
  TierBadge,
  TrendLine,
} from "./components/charts";

export { CLAIM_TIERS, DIMENSIONS } from "./types";
export type {
  AccessNeed,
  AnalyticsDataset,
  AnalyticsSource,
  BookingRequest,
  ClaimTier,
  DashboardMetrics,
  DemandAggregation,
  DemandBar,
  DemandCell,
  DemandDimension,
  DemandHeat,
  Dimension,
  Experience,
  Interaction,
  ListingSummary,
  Opportunity,
  Provider,
  ProviderSuggestion,
  RejectionCode,
  SuggestionKind,
  SupplyFix,
  TimeBucket,
  TrendPoint,
  UnmetDemand,
} from "./types";
