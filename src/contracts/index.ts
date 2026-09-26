/**
 * FROZEN CONTRACT — Day 1. Do not edit without a 3-person agreement.
 *
 * This file is the seam between the three work streams. Everyone imports from
 * here; nobody defines types locally. That is what lets us work in parallel
 * without merge conflicts and without integration hell on Day 6.
 *
 *   Abhijit  data + engine + ML   -> reads everything, writes nothing here
 *   Karan    UI                   -> reads everything, writes nothing here
 *   Vishwesh features             -> reads everything, writes nothing here
 *
 * If a field genuinely must change: raise it in standup, change it HERE first,
 * rebase. Never widen a type at the call site.
 *
 * Design notes worth knowing before you use these:
 *  - Every `Experience` field carries provenance. We never blend a curated fact
 *    with an LLM guess without saying so in the UI.
 *  - `Rejection` is a first-class value, not an error. "Why you are not seeing
 *    X" is a product feature; unmet demand is the provider acquisition funnel.
 *  - Money is always integer minor units (paise). Never floats.
 *  - Time is always integer minutes from local midnight. Never Date objects in
 *    the engine; the Date <-> minutes boundary lives in exactly one place.
 */
import { z } from "zod";

// ============================================================================
// PROVENANCE — the honesty backbone
// ============================================================================

/**
 * Where did this fact come from? Surfaced in the UI as a badge.
 * curated    a human wrote it (Abhijit/Vishwesh, from local knowledge)
 * provider   the listing's owner submitted it
 * osm        harvested from OpenStreetMap
 * inferred   an LLM guessed it from name/category. LOWEST TRUST. Always shown.
 * derived    computed by our engine (travel time, fit score)
 */
export const Provenance = z.enum(["curated", "provider", "osm", "inferred", "derived"]);
export type Provenance = z.infer<typeof Provenance>;

/** A single fact plus where it came from and how sure we are. */
export const Sourced = z.object({
  value: z.unknown(),
  provenance: Provenance,
  /** 0..1. Only meaningful for `inferred`. Curated facts are 1. */
  confidence: z.number().min(0).max(1).default(1),
  /** Who or what last touched it. */
  source: z.string().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type Sourced = z.infer<typeof Sourced>;

// ============================================================================
// MONEY & TIME — no floats, no Dates in the engine
// ============================================================================

/** Integer minor units. 1500 rupees = 150000 paise = 1_50000. */
export const Money = z.object({
  /** Minor units. paise for INR, cents for USD. */
  minor: z.number().int().nonnegative(),
  currency: z.string().length(3).default("INR"),
});
export type Money = z.infer<typeof Money>;

/** Minutes from local midnight. 9:30am IST = 570. */
export const Minutes = z.number().int().min(0).max(1440);
export type Minutes = number;

// ============================================================================
// ACCESSIBILITY — a PS-graded factor that OSM barely populates (1% coverage)
// ============================================================================

/**
 * Deliberately a union of booleans, not a score. "I need step-free" must be
 * satisfiable exactly or not at all. See research/findings/04 §1: the iD
 * `wheelchair` field is 3-state (yes/no/absent), so `null` is a real state and
 * must not collapse to `false`.
 */
export const Accessibility = z.object({
  /** iD `wheelchair` = yes. Step-free, usable wheelchair. */
  stepFree: z.boolean().nullable(),
  /** Our own curation: usable with a stroller. */
  strollerOk: z.boolean().nullable(),
  /** Few stairs / no long climbs. */
  lowStairs: z.boolean().nullable(),
  /** Seating available for the wait. */
  seatingAvailable: z.boolean().nullable(),
  /** Hearing loop or captioned. */
  hearingLoop: z.boolean().nullable(),
  /** Restroom available on site. */
  restroomOnSite: z.boolean().nullable(),
});
export type Accessibility = z.infer<typeof Accessibility>;

export const AccessNeed = z.enum([
  "wheelchair",
  "stroller",
  "lowStairs",
  "hearingLoop",
  "restroom",
]);
export type AccessNeed = z.infer<typeof AccessNeed>;

// ============================================================================
// EXPERIENCE — the catalogue row
// ============================================================================

export const Category = z.enum([
  "street_food",
  "restaurant",
  "cafe",
  "market",
  "craft_workshop",
  "art_studio",
  "music_live",
  "dance_performance",
  "theatre",
  "temple",
  "church",
  "mosque",
  "heritage_site",
  "museum",
  "gallery",
  "nature",
  "beach",
  "adventure",
  "wellness",
  "nightlife",
  "shopping",
  "community_hosted",
  "festival",
  "event",
  "hidden_place",
]);
export type Category = z.infer<typeof Category>;

export const IndoorOutdoor = z.enum(["indoor", "outdoor", "covered", "mixed"]);
export type IndoorOutdoor = z.infer<typeof IndoorOutdoor>;

/**
 * Opening hours, stored the way OSM expresses them so we can evaluate any
 * window without lossy parsing at query time.
 *
 * We wrap the npm `opening_hours` port (LGPL-3.0, hence the adapter) because
 * it correctly parses real OSM strings including `24/7`, `off`, `open`,
 * `Jan 1 off` and multi-range. Verified live: `Mo-Fr 09:00-18:00` evaluates to
 * 09:00-18:00 IST. `PH off` and inline comments are NOT supported, so the
 * adapter must degrade to `hoursStatus: 'unparsable'`, never throw.
 */
export const OpeningHours = z.object({
  /** Raw OSM expression, e.g. "Mo-Su 09:00-21:00". Null when never surveyed. */
  raw: z.string().nullable(),
  status: z.enum(["ok", "partial", "unparsable", "absent"]).default("absent"),
  /** iD `check_date` — drives the "hours unverified" badge. */
  lastVerified: z.string().nullable().default(null),
});
export type OpeningHours = z.infer<typeof OpeningHours>;

/** Rating with an honest sample size, so we can shrink toward the mean. */
export const Rating = z.object({
  /** Bayesian-smoothed 0..5, already shrunk toward the regional prior. */
  value: z.number().min(0).max(5),
  /** Raw count, so the UI can say "4.6 (312)" and we can see the shrinkage. */
  count: z.number().int().nonnegative(),
  /** Raw mean before smoothing. Null when count is 0. */
  rawMean: z.number().nullable(),
});
export type Rating = z.infer<typeof Rating>;

export const GeoPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/**
 * One row of the catalogue. Deliberately ONE row with all attributes, unlike
 * TripWeaver which keeps separate restaurant/attraction/hotel lists and so
 * cannot reason about price or category inside its solver.
 */
export const Experience = z.object({
  id: z.string(),
  name: z.string(),
  category: Category,
  location: GeoPoint,

  /** Typical minutes on site. The single most important missing OSM field. */
  durationMin: z.number().int().positive(),

  /** Per person. Null when free. */
  pricePerPerson: Money.nullable(),

  /** Largest group we can seat in one booking. Null = unlimited. */
  capacity: z.number().int().positive().nullable(),

  hours: OpeningHours,
  indoorOutdoor: IndoorOutdoor,
  accessibility: Accessibility,

  /** Child-suitability. The PS example is a family with a toddler. */
  kidFriendly: z.boolean().nullable(),

  /** Minimum sensible age. */
  minAge: z.number().int().nullable(),

  /** Dietary tags, open vocabulary. NOT an enum — see DATA_SPEC §1. */
  diets: z.array(z.string()).default([]),
  /** Cuisine, open vocabulary. iD's 103-value list omits mughlai/chaat. */
  cuisines: z.array(z.string()).default([]),

  rating: Rating,
  /** Short editorial line. Shown on the card. */
  blurb: z.string().nullable(),

  /** Long description, the LLM's main enrichment input. */
  description: z.string().nullable(),

  /** Free-form search terms and aliases, incl. transliterations. */
  keywords: z.array(z.string()).default([]),

  /**
   * The three perception dimensions from UGuideRAG (ACM SIGSPATIAL 2025).
   * The SCHEMA is worth stealing even though we found the reference
   * implementation broken (its retrieval is one-pass with unnormalised
   * weights; its spatial stage raises NameError). We extract these with our
   * own prompts and keep them separate rather than blending one embedding.
   */
  perception: z.object({
    /** What it physically is. */
    landscape: z.array(z.string()).default([]),
    /** What you actually do there. */
    activities: z.array(z.string()).default([]),
    /** The felt quality: romantic, lively, calm, noisy, cramped. */
    atmosphere: z.array(z.string()).default([]),
  }).default({ landscape: [], activities: [], atmosphere: [] }),

  /** Best hours of day. From curated local knowledge. */
  bestTimeOfDay: z.array(z.enum(["early_morning", "morning", "afternoon", "evening", "night"])).default([]),

  /** True when getting there is the experience (hidden place, viewpoint). */
  requiresJourney: z.boolean().default(false),

  /** Booking requirements. */
  booking: z.object({
    required: z.boolean().default(false),
    /** Minimum notice in minutes. */
    leadTimeMin: z.number().int().nonnegative().default(0),
    /** Walk-ins possible right now? Drives the availability gate. */
    walkIn: z.boolean().default(true),
  }).default({ required: false, leadTimeMin: 0, walkIn: true }),

  /** Seasonality in months, 1-12. Mumbai monsoon = Jun..Sep. */
  bestMonths: z.array(z.number().int().min(1).max(12)).default([]),
  /** True when weather ruins it. Feeds the replanner. */
  weatherSensitive: z.enum(["none", "rain", "heat", "wind", "any"]).default("none"),

  /** Per-field provenance. Anything `inferred` gets a visible badge. */
  provenance: z.record(z.string(), Provenance).default({}),

  /** Provider link, null for OSM-only rows. */
  providerId: z.string().nullable().default(null),
  neighbourhood: z.string().nullable(),
  city: z.string().default("Mumbai"),
});
export type Experience = z.infer<typeof Experience>;

// ============================================================================
// DISCOVERY CONTEXT — what the traveller told us
// ============================================================================

/**
 * ITINERA's real fields (itinera.py:177-199), not the three axes its own
 * write-ups describe. `mustsee` IS the specificity axis; `neg` IS the attitude
 * axis. No dataclass, no rules upstream — one LLM call, then this.
 */
export const DecomposedRequest = z.object({
  /** What they want. Negation must be extracted OUT of this into `neg`. */
  pos: z.string(),
  /** What they want to avoid. Null when none. */
  neg: z.string().nullable().default(null),
  /** Specificity: is `pos` a named place? Then it is a hard must-visit. */
  mustsee: z.boolean().default(false),
  /** Granularity. */
  type: z.enum(["location", "itinerary", "starting_point", "ending_point"]),
});
export type DecomposedRequest = z.infer<typeof DecomposedRequest>;

export const PartyType = z.enum([
  "solo",
  "couple",
  "family_with_children",
  "family_teens",
  "friends",
  "business",
  "solo_female",
  "older_adults",
]);
export type PartyType = z.infer<typeof PartyType>;

export const WeatherNow = z.object({
  condition: z.enum(["clear", "cloudy", "light_rain", "heavy_rain", "storm", "heat", "wind"]),
  tempC: z.number(),
  /** Real forecast from Open-Meteo when available, simulated for the demo. */
  source: z.enum(["live", "simulated", "unknown"]).default("unknown"),
});
export type WeatherNow = z.infer<typeof WeatherNow>;

/**
 * The single object that describes a traveler's situation. Every adaptation is
 * a diff against this. Principle 3 of the masterplan: never replace the intent
 * when reality changes — so `original` is kept forever and the replanner
 * diffs against it, not against the last mutation.
 */
export const DiscoveryContext = z.object({
  /** Stable id for the session. */
  id: z.string(),

  /** Where they are. Free-text label + resolved point. */
  origin: z.object({
    label: z.string(),
    point: GeoPoint.nullable().default(null),
  }),

  /** Minutes from now until they must leave. THE primary constraint. */
  availableMin: z.number().int().positive(),
  /** Wall-clock now, minutes from midnight IST. */
  nowMin: Minutes,

  /** Total spend ceiling for the whole plan. */
  budget: Money.nullable().default(null),
  /** Optional per-person ceiling, applied on top. */
  budgetPerPerson: Money.nullable().default(null),

  partySize: z.number().int().positive().default(1),
  partyType: PartyType.default("solo"),
  /** Child ages. Drives toddler vs teen behaviour. */
  childAges: z.array(z.number().int().min(0).max(17)).default([]),

  accessNeeds: z.array(AccessNeed).default([]),
  /** Dietary hard filters, open vocabulary: "vegetarian", "jain", "halal". */
  diets: z.array(z.string()).default([]),

  interests: z.array(z.string()).default([]),
  /** "want indoors", "avoid crowded", "must be quiet". */
  avoid: z.array(z.string()).default([]),

  weather: WeatherNow.default({ condition: "clear", tempC: 30, source: "unknown" }),
  /** Travel mode preference. We still surface a faster alternative. */
  travelMode: z.enum(["walk", "auto", "transit", "any"]).default("any"),

  requests: z.array(DecomposedRequest).default([]),

  /** What they explicitly rejected earlier. Feeds the novelty penalty. */
  excludedIds: z.array(z.string()).default([]),
  /** Already in the plan, so the packer never duplicates them. */
  pinnedIds: z.array(z.string()).default([]),

  /** Never mutated. The replanner diffs against this. */
  original: z.object({
    availableMin: z.number().int().positive(),
    budget: Money.nullable(),
    partySize: z.number().int().positive(),
    accessNeeds: z.array(AccessNeed),
  }),
});
export type DiscoveryContext = z.infer<typeof DiscoveryContext>;

/** A change to the context, from a slider, a button, or the chat sidecar. */
export const ContextChange = z.object({
  kind: z.enum([
    "time_shrank",
    "time_grew",
    "budget_cut",
    "budget_grew",
    "weather_changed",
    "became_unavailable",
    "party_grew",
    "access_need_added",
    "interest_added",
    "mood_changed",
  ]),
  /** Human sentence shown in the swap diff. Never machine-worded. */
  narrative: z.string(),
  patch: z.record(z.string(), z.unknown()),
});
export type ContextChange = z.infer<typeof ContextChange>;

// ============================================================================
// REJECTIONS — why you are NOT seeing something
// ============================================================================

/**
 * A hard-constraint failure. Not an error — a product feature. Two consumers:
 * the "why not this" panel, and the provider-side unmet-demand feed.
 *
 * `code` is a stable machine key. `message` is a finished, human sentence with
 * the actual numbers filled in. Never "constraint violated".
 */
export const RejectionCode = z.enum([
  "too_far",
  "travel_time_exceeds_budget",
  "duration_exceeds_budget",
  "closed_now",
  "closed_during_window",
  "hours_unverified",
  "over_budget",
  "over_budget_per_person",
  "capacity_exceeded",
  "not_step_free",
  "not_stroller_ok",
  "no_low_stairs",
  "no_hearing_loop",
  "no_restroom",
  "inaccessible",
  "diet_mismatch",
  "sold_out",
  "requires_booking_not_available",
  "lead_time_too_short",
  "weather_unsafe",
  "duplicate",
  "already_planned",
  "excluded_by_traveller",
  "mustsee_conflict",
  "seasonal_mismatch",
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

export const Rejection = z.object({
  experienceId: z.string(),
  code: RejectionCode,
  /** Finished sentence with real numbers: "Needs 40 min more than you have left." */
  message: z.string(),
  /** The shortfall, so the UI can show "short by 40 min" / "over by ₹300". */
  shortfall: z.number().nullable().default(null),
  unit: z.enum(["minutes", "minor_units", "people", "metres"]).nullable().default(null),
  /** True when a relaxation would fix it. Drives the relaxation ladder. */
  relaxable: z.boolean().default(false),
});
export type Rejection = z.infer<typeof Rejection>;

// ============================================================================
// SCORING — one auditable scalar
// ============================================================================

/**
 * Scalarised on purpose. TripWeaver calls `opt.minimize` and `opt.maximize` on
 * the same Z3 Optimize object, which is lexicographic — the penalty ends up
 * lowest-priority and the relaxation is silently defeated. One number, split
 * into named contributions, re-derivable offline, avoids that entirely.
 */
export const ScoreComponent = z.object({
  key: z.string(),
  label: z.string(),
  /** Signed contribution to the total. */
  value: z.number(),
  /** The weight applied. Exposed so the "what I learned about you" panel works. */
  weight: z.number(),
  /** One sentence for the why-ledger. */
  reason: z.string().optional(),
});
export type ScoreComponent = z.infer<typeof ScoreComponent>;

export const ScoreBreakdown = z.object({
  experienceId: z.string(),
  total: z.number(),
  components: z.array(ScoreComponent),
  /** Version of the weight profile. Required so scores stay auditable. */
  profileVersion: z.string(),
  /** Which of the components came from learned per-traveller weights. */
  learnedComponents: z.array(z.string()).default([]),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

// ============================================================================
// FIT — the signature UI element's data
// ============================================================================

/**
 * Backs the feasibility meter: activity > travel > buffer, against the
 * traveller's remaining window, with the overflow in `alarm` colour.
 */
export const Fit = z.object({
  experienceId: z.string(),
  travelMin: z.number().int().nonnegative(),
  activityMin: z.number().int().nonnegative(),
  /** Fixed overhead we add so a plan is not knife-edge. */
  bufferMin: z.number().int().nonnegative(),
  totalMin: z.number().int().nonnegative(),
  availableMin: z.number().int().nonnegative(),
  /** >= 1 means it fits with room to spare. */
  fitRatio: z.number(),
  cost: Money,
  budget: Money.nullable(),
  /** Per-constraint pass/fail for the why-ledger. */
  checks: z.array(z.object({
    label: z.string(),
    pass: z.boolean(),
    detail: z.string(),
  })),
  /** Overall verdict for the card badge. */
  verdict: z.enum(["fits", "tight", "does_not_fit"]),
});
export type Fit = z.infer<typeof Fit>;

// ============================================================================
// PLAN — the packed itinerary
// ============================================================================

export const TravelLeg = z.object({
  fromId: z.string(),
  toId: z.string(),
  mode: z.enum(["walk", "auto", "transit", "ferry"]),
  minutes: z.number().int().nonnegative(),
  metres: z.number().int().nonnegative(),
  /** "Western Line, 4 stops" or "via Marine Drive". */
  detail: z.string().nullable(),
  /** True when the leg is a modelled estimate, not a live routing result. */
  estimated: z.boolean().default(true),
});
export type TravelLeg = z.infer<typeof TravelLeg>;

export const PlanStop = z.object({
  experienceId: z.string(),
  arriveMin: Minutes,
  departMin: Minutes,
  fit: Fit,
  score: ScoreBreakdown,
  /** Why this, in order of contribution. */
  why: z.array(z.string()),
  /** Slot index in the plan, 0-based. */
  order: z.number().int().nonnegative(),
});
export type PlanStop = z.infer<typeof PlanStop>;

export const RelaxationApplied = z.object({
  /** Named rung, so the UI can say exactly what gave. */
  rung: z.enum(["strict", "dropped_minimum", "greedy_fill", "single_best"]),
  label: z.string(),
  /** What we gave up to make it fit. */
  gaveUp: z.string(),
  /** The constraint that was relaxed. Null when nothing was. */
  relaxed: RejectionCode.nullable(),
});
export type RelaxationApplied = z.infer<typeof RelaxationApplied>;

export const Plan = z.object({
  id: z.string(),
  contextId: z.string(),
  stops: z.array(PlanStop),
  legs: z.array(TravelLeg),

  totalMin: z.number().int(),
  totalCost: Money,
  /** plannedMin / availableMin. Our headline quality metric. */
  utilisation: z.number(),
  /** Metres walked / driven across all legs. */
  totalMetres: z.number().int(),

  /** Everything that did not make it, with reasons. */
  rejected: z.array(Rejection),

  relaxations: z.array(RelaxationApplied).default([]),
  /** 0..100. From the Trip Stress Radar dimensions. */
  stressScore: z.number().min(0).max(100).default(0),
  stressFactors: z.array(z.object({
    dimension: z.string(),
    weight: z.number(),
    value: z.number(),
    /** The single highest-impact fix. Only for the worst factor. */
    rescue: z.string().nullable(),
  })).default([]),

  createdAt: z.string().datetime(),
  /** Which engine version produced this, for reproducibility. */
  engineVersion: z.string(),
});
export type Plan = z.infer<typeof Plan>;

// ============================================================================
// REPLAN — the swap diff
// ============================================================================

export const Swap = z.object({
  removedId: z.string().nullable(),
  addedId: z.string().nullable(),
  reason: z.string(),
  /** What it cost us in score, so the UI can say "slightly worse fit". */
  scoreDelta: z.number().default(0),
});
export type Swap = z.infer<typeof Swap>;

export const ReplanResult = z.object({
  plan: Plan,
  change: ContextChange,
  swaps: z.array(Swap),
  /** The original intent is preserved. This is the whole point. */
  preservedIntent: z.boolean().default(true),
  summary: z.string(),
});
export type ReplanResult = z.infer<typeof ReplanResult>;

// ============================================================================
// PROVIDER SIDE
// ============================================================================

export const Provider = z.object({
  id: z.string(),
  name: z.string(),
  /** Free text, so we are not limited to a fixed vertical taxonomy. */
  kind: z.string(),
  bio: z.string().nullable(),
  neighbourhood: z.string(),
  city: z.string().default("Mumbai"),
  contact: z.object({
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }).default({ email: null, phone: null }),
  /** 0..1, from listing completeness + response rate. */
  reliability: z.number().min(0).max(1).default(0.5),
  verified: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type Provider = z.infer<typeof Provider>;

/**
 * A bookable slot.
 *
 * NOTE, from pretix: there is deliberately NO `remaining` field. Availability is
 * derived by subtracting committed counts in priority order. That makes
 * overselling structurally impossible instead of merely unlikely, and it means
 * a cancellation needs no counter to reconcile.
 */
export const Slot = z.object({
  id: z.string(),
  providerId: z.string(),
  experienceId: z.string(),
  startMin: Minutes,
  endMin: Minutes,
  /** The ONLY capacity number. */
  capacity: z.number().int().positive(),
  pricePerPerson: Money,
  /** Committed counts, derived into availability. Never a remaining count. */
  held: z.object({
    pendingOrders: z.number().int().nonnegative().default(0),
    confirmedOrders: z.number().int().nonnegative().default(0),
    carts: z.number().int().nonnegative().default(0),
  }).default({ pendingOrders: 0, confirmedOrders: 0, carts: 0 }),
  status: z.enum(["ok", "ordered", "reserved", "gone"]).default("ok"),
});
export type Slot = z.infer<typeof Slot>;

/** Derived. Never stored. Order matters: confirmed wins over held. */
export const SlotAvailability = z.object({
  slotId: z.string(),
  status: z.enum(["ok", "ordered", "reserved", "gone"]),
  remaining: z.number().int(),
  derivedFrom: z.array(z.string()),
});
export type SlotAvailability = z.infer<typeof SlotAvailability>;

export const BookingState = z.enum([
  "requested",
  "confirmed",
  "declined",
  "cancelled",
  "completed",
]);
export type BookingState = z.infer<typeof BookingState>;

/**
 * The state machine. Transitions are enforced at runtime by a table that
 * throws on an illegal move — the Medusa pattern. See docs/ARCHITECTURE §7.
 */
export const BOOKING_TRANSITIONS: Record<BookingState, BookingState[]> = {
  requested: ["confirmed", "declined", "cancelled"],
  confirmed: ["completed", "cancelled"],
  declined: [],
  cancelled: [],
  completed: [],
};

export const BookingRequest = z.object({
  id: z.string(),
  slotId: z.string(),
  experienceId: z.string(),
  travellerName: z.string(),
  travellerContact: z.string(),
  partySize: z.number().int().positive(),
  state: BookingState.default("requested"),
  /** Free-text reason a provider declined. We ask; it is our reputation play. */
  declineReason: z.string().nullable().default(null),
  /** Set when the traveller is told. */
  travellerNotifiedAt: z.string().datetime().nullable().default(null),
  history: z.array(z.object({
    from: BookingState,
    to: BookingState,
    at: z.string().datetime(),
    by: z.string(),
    note: z.string().nullable(),
  })).default([]),
  createdAt: z.string().datetime(),
});
export type BookingRequest = z.infer<typeof BookingRequest>;

// ============================================================================
// PERSONALISATION — learned weights, visible to the user
// ============================================================================

/**
 * The bandit's arm. Weights are learned from the interaction stream and shown
 * to the traveller, because a recommendation you cannot interrogate is just a
 * vibe. Nothing is learned about a traveller without being shown to them.
 */
export const WeightProfile = z.object({
  version: z.string(),
  weights: z.record(z.string(), z.number()),
  /** Explicit (stated) vs learned (inferred). Never mix silently. */
  source: z.enum(["prior", "learned", "user_edited"]),
  updatedAt: z.string().datetime(),
  /** How many interactions the learned part rests on. Shown in the UI. */
  observations: z.number().int().nonnegative().default(0),
});
export type WeightProfile = z.infer<typeof WeightProfile>;

export const InteractionType = z.enum([
  "impression",
  "click",
  "save",
  "book_requested",
  "dismiss",
  "not_interested",
  "reported_inaccurate",
  "opened_directions",
  "shared",
]);
export type InteractionType = z.infer<typeof InteractionType>;

export const Interaction = z.object({
  travellerId: z.string(),
  experienceId: z.string(),
  type: InteractionType,
  /** Positive for good outcomes. Drives the reward. */
  reward: z.number(),
  at: z.string().datetime(),
  contextSnapshotId: z.string(),
});
export type Interaction = z.infer<typeof Interaction>;

// ============================================================================
// ANALYTICS — the provider-side flywheel
// ============================================================================

/**
 * A search that returned nothing usable. This is the single most valuable
 * dataset in the product: it is literally a list of what travellers want and
 * cannot get. Feeds the provider opportunity feed.
 */
export const UnmetDemand = z.object({
  id: z.string(),
  travellerId: z.string(),
  point: GeoPoint,
  neighbourhood: z.string().nullable(),
  at: z.string().datetime(),
  /** The context, minus anything identifying. */
  constraints: z.object({
    availableMin: z.number().int(),
    budgetMinor: z.number().int().nullable(),
    partySize: z.number().int(),
    accessNeeds: z.array(AccessNeed),
    interests: z.array(z.string()),
    weather: z.string(),
  }),
  /** 0 results returned. */
  shortfallCount: z.number().int(),
  /** Which constraint eliminated the most candidates. The actionable bit. */
  topBlockingCode: RejectionCode,
  /** How many candidates died on that one constraint. */
  topBlockingCount: z.number().int(),
});
export type UnmetDemand = z.infer<typeof UnmetDemand>;

export const ProviderOpportunity = z.object({
  providerId: z.string(),
  kind: z.enum(["unmet_search", "capacity_window", "listing_quality", "must_see_gap"]),
  /** A finished, actionable sentence. "Add a Thu 17:00 slot: 42 travellers near you
   *  wanted a step-free craft workshop under ₹500 and you were the only match." */
  headline: z.string(),
  /** The evidence. Never a claim without a count. */
  evidence: z.array(z.object({ label: z.string(), value: z.string() })),
  /** Measured effect, once we know it. Null until then. */
  estimatedImpact: z.string().nullable(),
  cta: z.string(),
});
export type ProviderOpportunity = z.infer<typeof ProviderOpportunity>;

// ============================================================================
// ENGINE IO — the three functions Abhijit owns
// ============================================================================

/** Retrieve -> narrow. Pure. No LLM. */
export const RetrieveInput = z.object({
  context: DiscoveryContext,
  catalogue: z.array(Experience),
  limit: z.number().int().positive().default(120),
});
export type RetrieveInput = z.infer<typeof RetrieveInput>;

/** Hard gate. Emits a rejection for EVERY survivor it drops. */
export const FeasibleResult = z.object({
  passed: z.array(z.string()),
  rejected: z.array(Rejection),
});
export type FeasibleResult = z.infer<typeof FeasibleResult>;

/**
 * Independent validation. Recomputes the objective from the plan and rejects on
 * any drift. This is the pattern that makes an LLM-adjacent system trustworthy,
 * and it is a build-failure risk if we skip it: every repo that let a model
 * influence ordering without a validator leaked.
 */
export const ValidationResult = z.object({
  ok: z.boolean(),
  /** Named violation classes, so the UI can be specific. */
  violations: z.array(z.object({
    code: z.string(),
    message: z.string(),
    /** Which stop/leg. */
    at: z.string().nullable(),
  })),
  /** Recomputed objective. Must match the packer's within tolerance. */
  recomputedObjective: z.number().nullable(),
  claimedObjective: z.number().nullable(),
  /** 0 when they agree. Non-zero means the packer is lying. */
  objectiveDelta: z.number().nullable(),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

// ============================================================================
// EVENTS — the analytics bus
// ============================================================================

export const AnalyticsEvent = z.object({
  name: z.string(),
  travellerId: z.string().nullable(),
  at: z.string().datetime(),
  props: z.record(z.string(), z.unknown()),
});
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

// ============================================================================
// TIER-0 SAFETY RAILS
// ============================================================================

/** Keys the LLM is allowed to affect in chat. Deliberately tiny. */
export const DialogueDecision = z.object({
  /** Patch to apply to the DiscoveryContext. Empty means just answer. */
  contextPatch: z.object({
    availableMin: z.number().int().positive().optional(),
    budgetMinor: z.number().int().nonnegative().nullable().optional(),
    partySize: z.number().int().positive().optional(),
    accessNeeds: z.array(AccessNeed).optional(),
    interests: z.array(z.string()).optional(),
    avoid: z.array(z.string()).optional(),
    indoorOnly: z.boolean().optional(),
    mood: z.string().optional(),
  }).default({}),
  /** Finished sentence to show. */
  reply: z.string(),
  /** Below this we ask rather than act. Mirrors Plan-It's confidence gate. */
  confidence: z.number().min(0).max(1),
  /** Chips the traveller can tap instead of typing. */
  suggestions: z.array(z.string()).default([]),
}).strict();
export type DialogueDecision = z.infer<typeof DialogueDecision>;

/**
 * LLM output must be parsed with a real parser, never JSON.parse on a string
 * we then trust. Tripsage hit a lastIndex bug from a dynamically built RegExp.
 */
export const LLM_ENVELOPE = z.object({
  ok: z.boolean(),
  data: z.unknown().nullable(),
  /** Why it failed, in words we can log. */
  error: z.string().nullable(),
  /** Which model actually answered, for the cost table. */
  model: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
  /** True when we fell back to a deterministic parser. */
  degraded: z.boolean().default(false),
}).strict();
export type LLMEnvelope = z.infer<typeof LLM_ENVELOPE>;

export const CITY_MANIFEST = z.object({
  slug: z.string(),
  displayName: z.string(),
  country: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  centre: GeoPoint,
  timezone: z.string(),
  currency: z.string().length(3),
  neighbourhoods: z.array(z.string()),
  /** Monsoon months, which flip the weather gate. */
  monsoonMonths: z.array(z.number().int().min(1).max(12)).default([]),
  /** Multiplier per corridor per time band. Documented heuristic, not truth. */
  congestionModel: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  transitCorridors: z.array(z.object({
    from: z.string(),
    to: z.string(),
    mode: z.enum(["train", "metro", "monorail", "ferry", "bus"]),
    line: z.string(),
    minutes: z.number().int().positive(),
    transfers: z.number().int().nonnegative().default(0),
  })).default([]),
});
export type CityManifest = z.infer<typeof CITY_MANIFEST>;

/** Schema version, bumped on any breaking change. */
export const CONTRACT_VERSION = "1.0.0" as const;
