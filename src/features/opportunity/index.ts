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
 *   aggregateGaps()    logged searches -> gaps, with counts
 *        |
 *        v
 *   detectOpportunities()  gaps + current supply -> opportunity records
 *        |
 *        v
 *   queryOpportunities()   the provider-facing read
 *
 * Steps 1 and 4 are pure functions of their inputs. Re-run 4 after a provider
 * edits a listing and the feed answers for itself.
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

export { catalogueNeighbourhoods, loadCatalogue } from "./catalogue";
