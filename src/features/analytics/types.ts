/**
 * Feature-local types for the analytics + demand-intelligence layer.
 *
 * WHY A LOCAL FILE: `src/contracts` is frozen and must never be widened at the
 * call site, so everything the provider dashboard needs on top of the contract
 * (claim tiers, aggregated demand, opportunity payloads) is defined here and
 * COMPOSED with contract types, never in place of them. Anything you can express
 * with a contract type is expressed with a contract type.
 *
 * The one idea this layer exists to enforce: a number without a tier and a
 * sample size is marketing copy, not analytics. See `CLAIM_TIERS`.
 */
import type {
  AccessNeed,
  BookingRequest,
  Experience,
  Interaction,
  Provider,
  ProviderOpportunity,
  RejectionCode,
  UnmetDemand,
} from "../../contracts";

/** Derived from the contract, not redefined. */
export type TimeBucket = Experience["bestTimeOfDay"][number];

/**
 * How much of a claim is measurement and how much is us guessing.
 *
 *   observed  counted from a real event stream. Show the number plainly.
 *   inferred  derived from observed data by a rule a human wrote. Show it, but
 *             say it is derived, and show the sample size it rests on.
 *   suggested our recommendation. Never a fact. Never carries a naked number.
 *
 * The rule the UI enforces: an `observed` or `inferred` claim must have
 * `sampleSize > 0`. A `suggested` claim may not present a number as an outcome.
 */
export const CLAIM_TIERS = ["observed", "inferred", "suggested"] as const;
export type ClaimTier = (typeof CLAIM_TIERS)[number];

/** The five axes demand is aggregated on. Fixed so the UI can index them. */
export const DIMENSIONS = ["category", "locality", "time", "price", "constraint"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** One bar in one demand chart. */
export interface DemandBar {
  /** Stable machine key, e.g. `not_step_free` or `₹501-1,000`. */
  key: string;
  /** Human label for the axis. Finished, not a slug. */
  label: string;
  /** Count of searches in this bar. Always an integer. */
  value: number;
  /** value / dimension.n, rounded to 3dp so output is byte-stable. */
  share: number;
  /** Whether the underlying classification is a fact or a rule we applied. */
  tier: ClaimTier;
  /** n behind the number. Duplicated on purpose: every claim carries a count. */
  sampleSize: number;
}

/** One axis of the demand picture, with its own denominator. */
export interface DemandDimension {
  dimension: Dimension | "access_need" | "party_size" | "weather" | "duration";
  /** Searches that produced at least one bar here. Denominator for `share`. */
  n: number;
  /** false when n < minSample. The UI then says so instead of drawing bars. */
  reliable: boolean;
  bars: DemandBar[];
}

export interface DemandAggregation {
  /** Unmet searches inside the window. The headline "we found nothing" count. */
  total: number;
  /** Searches rejected for being outside the window. */
  outsideWindow: number;
  minSample: number;
  windowDays: number;
  /** ISO datetime the window ends on. Everything is relative to this. */
  asOf: string;

  byCategory: DemandDimension;
  byLocality: DemandDimension;
  byTime: DemandDimension;
  byPrice: DemandDimension;
  byConstraint: DemandDimension;
  byAccessNeed: DemandDimension;
  byPartySize: DemandDimension;
  byWeather: DemandDimension;
  byDuration: DemandDimension;
}

/**
 * A group of unmet searches that describe ONE gap: same neighbourhood, same
 * blocking constraint, same category intent. The unit an opportunity is built
 * from, and the unit the counts in `evidence` refer to.
 */
export interface DemandCell {
  /** `${neighbourhood}|${blockingCode}|${category ?? "any"}` */
  key: string;
  neighbourhood: string;
  /** Centroid of the member searches, so radius checks are real. */
  point: { lat: number; lon: number };
  blockingCode: RejectionCode;
  /** null when no interest string mapped to a category. */
  category: Experience["category"] | null;
  categoryTier: ClaimTier;
  /** Searches in the cell. */
  n: number;
  /** Summed `topBlockingCount`: candidates that died on the binding code. */
  blockedCandidates: number;
  /** null when no search in the cell stated a budget. */
  budgetMinor: number | null;
  /** Median stated availableMin. */
  availableMin: number;
  /** Median party size. */
  partySize: number;
  /** Modal time-of-day bucket, or null when the cell is too small to have one. */
  timeBucket: TimeBucket | null;
  timeTier: ClaimTier;
  accessNeeds: AccessNeed[];
  weather: string[];
  /** Free-text interests, deduped, sorted. Open vocabulary by design. */
  interests: string[];
  /** True when any member search signalled children. */
  kidSignal: boolean;
  /** true when n >= minSample. Drives the tier of anything built from it. */
  reliable: boolean;
  /** ISO datetime of the most recent member search. */
  latestAt: string;
}

/**
 * The supply attribute a gap actually points at, and how to check for it.
 *
 * `state` is three-valued on purpose. A `null` accessibility field is a real
 * state, not a `false` (research/findings/04 §1: iD `wheelchair` is 3-state, and
 * collapsing `null` to `false` silently drops a provider out of every accessible
 * search). So we distinguish "we know it is not offered" from "nobody has ever
 * said", and the copy says "add" versus "confirm".
 */
export interface SupplyFix {
  /** Dotted path on `Experience`, so the CTA can deep-link to the field. */
  field: string;
  /** What the traveller asked for, in their words. */
  label: string;
  state: (listing: Experience, cell: DemandCell) => "absent" | "unknown" | "offered";
  /** The suggestion this fix produces when aggregated. */
  suggestionKind: SuggestionKind;
  /** The contract's opportunity taxonomy. */
  contractKind: "unmet_search" | "capacity_window" | "listing_quality";
}

/**
 * An opportunity, as the product shows it.
 *
 * `contract` is the exact `ProviderOpportunity` shape the rest of the app
 * expects, so this feeds the provider feature without anyone widening a type.
 * The extra fields are the evidence detail the dashboard needs and the contract
 * has no room for.
 */
export interface Opportunity {
  id: string;
  providerId: string;
  providerName: string;
  /** `observed` when the cell is well sampled, `inferred` when it is thin. */
  tier: ClaimTier;
  /** The contract payload. `estimatedImpact` stays null until we can measure. */
  contract: ProviderOpportunity;

  demand: {
    neighbourhood: string;
    category: Experience["category"] | null;
    categoryTier: ClaimTier;
    preferredBudgetMinor: number | null;
    preferredTime: TimeBucket | null;
    preferredTimeTier: ClaimTier;
    constraints: {
      availableMin: number;
      partySize: number;
      accessNeeds: AccessNeed[];
      weather: string[];
      kidSignal: boolean;
    };
  };
  /** Which attribute of the listing is missing, and why that is the blocker. */
  missingSupply: { code: RejectionCode; field: string; label: string };
  /** One click. The FEATURES spec requires this to be actionable, not advisory. */
  cta: string;
  evidence: { label: string; value: string }[];
  /** Provider listings in the cell's radius offering the same category. */
  nearbyMatches: number;
  sampleSize: number;
}

export type SuggestionKind =
  | "accessibility_metadata"
  | "accessibility_attribute"
  | "availability_window"
  | "family_package"
  | "price_band"
  | "indoor_option"
  | "shorter_duration"
  | "capacity"
  | "listing_metadata";

/**
 * A concrete change to a listing, justified by demand.
 *
 * `tier` is always `suggested`: the thing being asserted is an action, and an
 * action we invented is never a measurement. The tier of the DEMAND behind it is
 * carried in the evidence, as `demand evidence: observed | inferred`, so the two
 * are never conflated.
 */
export interface ProviderSuggestion {
  id: string;
  providerId: string;
  kind: SuggestionKind;
  tier: ClaimTier;
  /** Finished sentence naming the change. No placeholders. */
  action: string;
  /** The button label. Verb first. */
  cta: string;
  /** Deep link target: dotted field path the listing editor can focus. */
  targetField: string;
  evidence: { label: string; value: string }[];
  /** Searches behind this suggestion. Zero means we do not show it. */
  sampleSize: number;
  /** Candidates currently blocked on the same code in the same cells. */
  blockedCandidates: number;
  /** Cells this suggestion was aggregated from, for drill-down. */
  cellKeys: string[];
}

export interface TrendPoint {
  /** YYYY-MM-DD. */
  date: string;
  impressions: number;
  requests: number;
}

export interface DashboardMetrics {
  impressions: number;
  fitViews: number;
  requests: number;
  confirmed: number;
  declined: number;
  /** null, never 0, when there were no requests. We do not fake a rate. */
  acceptanceRate: number | null;
  /** requests / impressions. null when there were no impressions. */
  requestRate: number | null;
  /** "high" | "low" | "none" — drives the honesty banner on the dashboard. */
  confidence: "high" | "low" | "none";
  /** Unmet searches in the provider's own neighbourhoods. */
  unmetNearby: number;
  /** Opportunities this provider can act on right now. */
  opportunityCount: number;
  /** Suggestions this provider can act on right now. */
  suggestionCount: number;
}

export interface ListingSummary {
  id: string;
  name: string;
  category: Experience["category"];
  neighbourhood: string;
  durationMin: number;
  priceMinor: number | null;
  indoorOutdoor: Experience["indoorOutdoor"];
  kidFriendly: boolean | null;
  /** Accessibility fields still `null` = never confirmed by the provider. */
  unconfirmedAccess: AccessNeed[];
  bestTimeOfDay: TimeBucket[];
  capacity: number | null;
  impressions: number;
  fitViews: number;
  requests: number;
}

/** Area by time-of-day cross-tab, ready for the heat representation. */
export interface DemandHeat {
  rows: string[];
  columns: string[];
  /** `${row}|${column}` -> search count. A missing key is zero. */
  cells: Record<string, number>;
  peak: number;
}

export interface ProviderDashboard {
  provider: Provider;
  /** Always present so the UI can render even on an empty dataset. */
  listings: ListingSummary[];
  metrics: DashboardMetrics;
  trend: TrendPoint[];
  demand: DemandAggregation;
  /** Unmet searches near this provider, all axes. */
  demandFeed: DemandAggregation;
  heat: DemandHeat;
  opportunities: Opportunity[];
  suggestions: ProviderSuggestion[];
  /** Why travellers who saw this provider got nothing, by blocking code. */
  blockingCodes: DemandBar[];
  /** Why providers declined. Counts, not vibes. */
  declineReasons: DemandBar[];
  dataset: AnalyticsDataset;
  notes: string[];
}

export interface AnalyticsDataset {
  source: "demo" | "live";
  label: string;
  /** ISO datetime. The window anchor. Nothing in this feature calls Date.now(). */
  asOf: string;
  notes: string[];
}

/**
 * The adapter. The one seam between this feature and whatever eventually holds
 * the data. There is no backend API yet, so nothing here imports `fetch`; the
 * demo source is the only implementation shipped. Swap in a real one by
 * constructing the same object from contract rows.
 */
export interface AnalyticsSource {
  dataset: AnalyticsDataset;
  providers: Provider[];
  /** Catalogue rows owned by a provider. `providerId !== null`. */
  listings: Experience[];
  interactions: Interaction[];
  bookings: BookingRequest[];
  unmetDemand: UnmetDemand[];
}

export type { AccessNeed, BookingRequest, Experience, Interaction, Provider, RejectionCode, UnmetDemand };
