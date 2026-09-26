/**
 * Public surface of the opportunity engine. The provider feature imports from
 * here and nowhere else, so nothing outside this folder needs the file layout.
 *
 * The pipeline, in the order a caller runs it:
 *
 *   searchTraveller()  a real request against a real catalogue
 *        |  (only when it found nothing)
 *        v
 *   UnmetDemand[]      the contract row, parsed by the contract schema
 *        |
 *        v
 *   aggregateGaps()    logged searches -> gaps, with counts, trend, the hour
 *                      they happened at, and a privacy detail level
 *        |
 *        v
 *   detectOpportunities()  gaps + today's supply (+ the provider's calendar)
 *                          -> opportunity records, measured by replay
 *        |
 *        v
 *   toActions()           one to-do per provider/listing/field
 *   queryOpportunities()  the provider-facing read
 *
 * Steps 1, 2 and 4 are pure functions of their inputs. Re-run 4 after a provider
 * edits a listing or publishes a slot, and the feed answers for itself.
 */
export {
  distanceKm,
  hardChecks,
  inr,
  mins,
  plural,
  RADIUS_KM,
  retrieveCandidates,
  SEARCH_SPREAD_KM,
  searchTraveller,
  topBlocker,
  type SearchOutcome,
  type SearchShape,
  type TravellerRequest,
} from "./demand";

export {
  acquisitionGaps,
  aggregateGaps,
  categoryIntent,
  categoryWord,
  detectOpportunities,
  fixFor,
  MIN_SEARCHES,
  MIN_TRAVELLERS,
  NEVER_AN_OPPORTUNITY,
  opportunitiesForProvider,
  queryOpportunities,
  SUPPRESS_BELOW,
  type AggregateOptions,
  type CategoryIntent,
  type DemandGap,
  type DetectOptions,
  type EvidenceTier,
  type OpportunityQuery,
  type OpportunityStatus,
  type ProviderOpportunityRecord,
  type SupplyFix,
  WINDOW_DAYS,
} from "./engine";

export {
  bookableDates,
  bucketOf,
  type Calendar,
  type CalendarVerdict,
  localDate,
  localMinutesOfDay,
  MUMBAI_TZ_OFFSET_MIN,
  type Seats,
  type SlotSuggestion,
  suggestSlot,
  type TimeBucket,
  usableSlots,
  verdictFor,
  type Window,
} from "./slots";

export { measureGap, type MeasureOptions, type Measurement } from "./measure";

export { type ActionEvidence, type ProviderAction, toActions } from "./actions";

export { catalogueNeighbourhoods, loadCatalogue } from "./catalogue";
