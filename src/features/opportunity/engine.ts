/**
 * Demand -> opportunity. The half of the flywheel that turns logged searches
 * into one thing a provider can act on, and that takes it away again when they
 * do.
 *
 * Four rules, and the file is mostly these four rules:
 *
 *  1. **Nothing is emitted without a count.** `searches`, `travellers` and
 *     `blockedCandidates` come off real rows. There is no default, no fallback
 *     and no "—" pretending to be a number.
 *  2. **A traveller-side blocker is never an opportunity.** Being too far, or
 *     excluded by the traveller, or already in their plan — no listing change on
 *     earth fixes that, and an opportunity built on it teaches a provider to
 *     ignore the feed. `NEVER_AN_OPPORTUNITY` enumerates them so a test can hold
 *     the line.
 *  3. **The same predicate decides both directions.** `hardChecks` is the only
 *     test of whether a listing serves a gap, so "supply has arrived" means
 *     exactly what "the traveller found nothing" meant. As supply is added, a
 *     provider's record shrinks to `met` and drops out of the feed; when the
 *     last failing listing is fixed, the gap itself goes quiet.
 *  4. **The action is a field, not a sentence.** Every `open` record names the
 *     dotted path on `Experience` a provider would change, because "consider
 *     being more accessible" is not a task.
 *
 * `estimatedImpact` is always null. The contract reserves it for a measured
 * effect and we have none; a feed of predicted numbers is how a dashboard turns
 * into marketing copy.
 */
import type {
  AccessNeed,
  Category,
  Experience,
  Provider,
  ProviderOpportunity,
  RejectionCode,
  UnmetDemand,
} from "../../contracts";
import { minToLabel } from "../provider/time";
import { RADIUS_KM, distanceKm, hardChecks, inr, mins, plural, type SearchShape } from "./demand";
import { measureGap, type Measurement } from "./measure";
import {
  bucketOf,
  type Calendar,
  localDate,
  localMinutesOfDay,
  MUMBAI_TZ_OFFSET_MIN,
  type SlotSuggestion,
  type TimeBucket,
  verdictFor,
  type Window,
} from "./slots";

/** Searches behind an opportunity. Below this, we do not extrapolate. */
export const MIN_SEARCHES = 5;
/**
 * Distinct travellers behind an opportunity. One account searching six times is
 * one person's afternoon, not a market, and `UnmetDemand` carries no identity
 * beyond `travellerId` precisely so this can be checked.
 */
export const MIN_TRAVELLERS = 2;
/** How far back the window reaches from `asOf`. Injected, never `Date.now()`. */
export const WINDOW_DAYS = 14;

/** Whether a classification is a fact or a rule we applied. */
export type EvidenceTier = "observed" | "inferred";

/**
 * What the traveller asked for, in one place. Open vocabulary on `interests`
 * by design, so `category` is often a guess and says so.
 */
export interface DemandGap {
  /** `${neighbourhood}|${topBlockingCode}|${category ?? "any"}` */
  key: string;
  neighbourhood: string;
  /** Centroid of the member rows, so a radius check is a real distance. */
  point: { lat: number; lon: number };
  blockingCode: RejectionCode;
  category: Category | null;
  categoryTier: EvidenceTier;
  /** Logged rows in the cell. */
  searches: number;
  /** Distinct `travellerId`s. Never the ids themselves. */
  travellers: number;
  /** Sum of `topBlockingCount`: candidates that died on the binding code. */
  blockedCandidates: number;
  /** Median stated total budget, or null when nobody in the cell said one. */
  budgetMinor: number | null;
  availableMin: number;
  partySize: number;
  accessNeeds: AccessNeed[];
  weather: string;
  interests: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * Modal local quarter-hour the searches happened at, or null when no half of
   * the cell agrees on one. This is the raw material for the spec's own
   * headline — "add a 17:00 slot" — and it is the only time signal a logged row
   * carries, so it is either a real pattern or nothing.
   */
  hourMin: number | null;
  hourBucket: TimeBucket | null;
  /** Searches for this same cell in the window immediately before this one. */
  previousSearches: number;
  trend: "rising" | "falling" | "flat";
  /**
   * `coarse` when the cell is small enough that the exact hour and dates could
   * re-identify one of the people in it, per FEATURES §10. The record is still
   * shown; the fingerprint is what gets rounded off.
   */
  detail: "exact" | "coarse";
  /** true when the cell clears both bars. Nothing is built from a cell that does not. */
  reliable: boolean;
}

// --- category intent -------------------------------------------------------
//
// A small table, and deliberately not a copy of the one in
// `analytics/aggregate.ts`: that file is another feature's, this one is only
// used to narrow which listings a gap is about. A shared table belongs in
// `src/lib` — hoisted once, in one commit, when both sides can move together.

const CATEGORY_WORDS: ReadonlyArray<readonly [Category, readonly string[]]> = [
  ["craft_workshop", ["craft", "workshop", "pottery", "ceramic", "weaving", "loom", "print", "embroidery", "lantern", "kite"]],
  ["art_studio", ["art", "painting", "sketch", "portrait", "studio", "watercolour", "charcoal"]],
  ["music_live", ["music", "band", "ghazal", "jazz", "choir", "sitar", "live"]],
  ["street_food", ["street food", "chaat", "vada pav", "misal", "kebab", "snack"]],
  ["restaurant", ["meal", "lunch", "dinner", "brunch", "thali", "dining", "restaurant"]],
  ["cafe", ["cafe", "coffee", "chai", "bakery", "tea"]],
  ["market", ["market", "bazaar", "flea", "souk"]],
  ["heritage_site", ["heritage", "fort", "ruins", "monument", "palace", "colonial", "architecture"]],
  ["museum", ["museum", "collection", "archive"]],
  ["gallery", ["gallery", "exhibition"]],
  ["wellness", ["yoga", "spa", "massage", "wellness", "meditation"]],
  ["adventure", ["surfing", "kayak", "dive", "trek", "cycling", "paragliding"]],
  ["nature", ["park", "garden", "trail", "bird", "sunset point", "nature"]],
  ["nightlife", ["bar", "pub", "club", "nightlife", "cocktails"]],
  ["theatre", ["theatre", "play", "musical", "drama", "cinema", "movie"]],
  ["hidden_place", ["hidden", "secret", "offbeat", "lesser known", "quiet corner"]],
];

export interface CategoryIntent {
  category: Category | null;
  tier: EvidenceTier;
  /** The traveller's own word that produced the match. Evidence, not a guess. */
  matchedOn: string | null;
}

/** Exact contract category values count as observed; a keyword hit is inferred. */
const CATEGORY_TAGS = new Set<string>(CATEGORY_WORDS.map(([category]) => category));

export function categoryIntent(interests: readonly string[]): CategoryIntent {
  const cleaned = interests.map((text) => text.trim().toLowerCase()).filter((text) => text.length > 0);
  for (const raw of cleaned) {
    const normalised = raw.replace(/\s+/g, "_");
    if (CATEGORY_TAGS.has(raw) || CATEGORY_TAGS.has(normalised)) {
      return { category: raw as Category, tier: "observed", matchedOn: raw };
    }
  }
  let best: { category: Category; len: number; on: string } | null = null;
  for (const raw of cleaned) {
    for (const [category, words] of CATEGORY_WORDS) {
      for (const word of words) {
        if (raw.includes(word) && (best === null || word.length > best.len)) {
          best = { category, len: word.length, on: raw };
        }
      }
    }
  }
  return best === null
    ? { category: null, tier: "observed", matchedOn: null }
    : { category: best.category, tier: "inferred", matchedOn: best.on };
}

// --- aggregation -----------------------------------------------------------

export interface AggregateOptions {
  /** ISO datetime the window ends on. Nothing in this feature reads the clock. */
  asOf: string;
  windowDays?: number;
  minSearches?: number;
  minTravellers?: number;
  /** For turning a logged UTC timestamp into a local hour. Defaults to Mumbai. */
  tzOffsetMin?: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The condition the most searches in the cell were run in, ties broken on the
 * string. Not the alphabetically first one: "clear" sorts before "light_rain",
 * and a cell where three searches met the rain would silently be re-tested as a
 * dry-weather gap, which is how a rain blocker stops looking like a rain blocker.
 */
function modal(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "clear";
  let top = 0;
  for (const [value, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > top) {
      best = value;
      top = count;
    }
  }
  return best;
}

/**
 * The UNION of the members' access needs, not the intersection. A listing that
 * takes a stroller but not a wheelchair serves half the cell, and calling that
 * cell "met" would be a false claim on the half that still cannot book. The
 * cost is an opportunity that stays open while any one member's need is unmet,
 * which is the same thing said the honest way.
 */
function unionOfNeeds(members: readonly UnmetDemand[]): AccessNeed[] {
  return unique(members.flatMap((member) => member.constraints.accessNeeds)) as AccessNeed[];
}

/**
 * Below this many distinct travellers, the exact hour and dates stop being
 * evidence and start being a fingerprint: "one account, Bandra West, 17:03 on
 * the 12th" is a person, not a market. The record is still shown — the demand is
 * real — with the identifying detail rounded off.
 */
export const SUPPRESS_BELOW = 5;

/**
 * The quarter-hour most of the cell agrees on, or null when no half of it does.
 * A modal time a single search invented is worse than no time at all, because
 * the engine would then tell a provider to open at an hour nobody came for.
 * Ties break on the earlier hour.
 */
function modalQuarterHour(minutes: readonly number[]): number | null {
  const counts = new Map<number, number>();
  for (const minute of minutes) {
    const slot = Math.floor(minute / 15) * 15;
    counts.set(slot, (counts.get(slot) ?? 0) + 1);
  }
  let best: number | null = null;
  let top = 0;
  for (const [slot, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > top) {
      best = slot;
      top = count;
    }
  }
  return top * 2 >= minutes.length ? best : null;
}

/**
 * Group logged unmet searches into the unit an opportunity is built from: same
 * neighbourhood, same binding constraint, same category intent.
 *
 * Two windows are read, not one. The current window is what the gap is; the
 * window immediately before it is the same gap last week, which is the only
 * honest way to say whether a provider should act now or next month. A gap that
 * is shrinking and a gap that is tripling both read as "5 searches" otherwise.
 *
 * A cell below either bar is still returned — it is real demand and hiding it
 * would be its own kind of lie — but `reliable: false`, and nothing actionable
 * is built from it.
 */
export function aggregateGaps(rows: readonly UnmetDemand[], opts: AggregateOptions): DemandGap[] {
  const minSearches = opts.minSearches ?? MIN_SEARCHES;
  const minTravellers = opts.minTravellers ?? MIN_TRAVELLERS;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const tz = opts.tzOffsetMin ?? MUMBAI_TZ_OFFSET_MIN;
  const end = Date.parse(opts.asOf);
  const start = end - windowDays * 86_400_000;
  const previousStart = start - windowDays * 86_400_000;

  const current = new Map<string, UnmetDemand[]>();
  const previous = new Map<string, number>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at) || at > end) continue;
    const key = gapKeyOf(row);
    if (at < previousStart) continue;
    if (at < start) {
      previous.set(key, (previous.get(key) ?? 0) + 1);
      continue;
    }
    const bucket = current.get(key);
    if (bucket) bucket.push(row);
    else current.set(key, [row]);
  }

  const gaps: DemandGap[] = [];
  for (const [key, members] of current) {
    const first = members[0]!;
    const intent = categoryIntent(first.constraints.interests);
    const budgets = members
      .map((member) => member.constraints.budgetMinor)
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b);
    const weather = modal(members.map((member) => member.constraints.weather.trim().toLowerCase()).filter(Boolean));
    const hourMin = modalQuarterHour(members.map((member) => localMinutesOfDay(member.at, tz)));
    const before = previous.get(key) ?? 0;
    const travellers = new Set(members.map((member) => member.travellerId)).size;

    gaps.push({
      key,
      neighbourhood: first.neighbourhood?.trim() || "Unknown",
      point: {
        lat: round6(members.reduce((sum, member) => sum + member.point.lat, 0) / members.length),
        lon: round6(members.reduce((sum, member) => sum + member.point.lon, 0) / members.length),
      },
      blockingCode: first.topBlockingCode,
      category: intent.category,
      categoryTier: intent.tier,
      searches: members.length,
      travellers,
      blockedCandidates: members.reduce((sum, member) => sum + member.topBlockingCount, 0),
      budgetMinor: median(budgets),
      availableMin: median(members.map((member) => member.constraints.availableMin)),
      partySize: median(members.map((member) => member.constraints.partySize)),
      accessNeeds: unionOfNeeds(members),
      weather,
      interests: unique(members.flatMap((member) => member.constraints.interests)),
      firstSeenAt: members.reduce((a, member) => (member.at < a ? member.at : a), first.at),
      lastSeenAt: members.reduce((a, member) => (member.at > a ? member.at : a), first.at),
      hourMin,
      hourBucket: hourMin === null ? null : bucketOf(hourMin),
      previousSearches: before,
      trend: members.length > before ? "rising" : members.length < before ? "falling" : "flat",
      detail: travellers < SUPPRESS_BELOW ? "coarse" : "exact",
      reliable: members.length >= minSearches && travellers >= minTravellers,
    });
  }

  return gaps.sort((a, b) =>
    b.searches !== a.searches ? b.searches - a.searches : a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

// --- what a gap is asking for ----------------------------------------------

/** Human name for a gap's category. The singular reads better in a sentence. */
const CATEGORY_NAME: Readonly<Record<Category, string>> = {
  craft_workshop: "craft workshop",
  art_studio: "art studio",
  music_live: "live music session",
  street_food: "street food stop",
  restaurant: "restaurant",
  cafe: "cafe",
  market: "market",
  heritage_site: "heritage site",
  museum: "museum",
  gallery: "gallery",
  wellness: "wellness session",
  adventure: "adventure activity",
  nature: "outdoor spot",
  nightlife: "night spot",
  theatre: "theatre",
  dance_performance: "dance performance",
  hidden_place: "hidden place",
  church: "church",
  mosque: "mosque",
  temple: "temple",
  beach: "beach",
  shopping: "shopping",
  community_hosted: "community-hosted session",
  festival: "festival",
  event: "event",
};

/** Plural for the handful whose plural is not `+s`. Copy is the product's voice. */
const CATEGORY_PLURAL: Partial<Record<Category, string>> = {
  craft_workshop: "craft workshops",
  art_studio: "art studios",
  music_live: "live music sessions",
  wellness: "wellness sessions",
  adventure: "adventure activities",
  community_hosted: "community-hosted sessions",
  heritage_site: "heritage sites",
  hidden_place: "hidden places",
  theatre: "theatres",
  nightlife: "night spots",
  shopping: "shops",
  nature: "outdoor spots",
};

const withArticle = (word: string): string => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

export function categoryWord(gap: Pick<DemandGap, "category">): string {
  if (gap.category === null) return "experience";
  return CATEGORY_NAME[gap.category];
}

function categoryPlural(gap: Pick<DemandGap, "category">): string {
  if (gap.category === null) return "experiences";
  return CATEGORY_PLURAL[gap.category] ?? `${CATEGORY_NAME[gap.category]}s`;
}

function partyPhrase(size: number): string {
  return `${size} ${plural(size, "person", "people")}`;
}

function budgetPhrase(budgetMinor: number | null, partySize: number): string {
  if (budgetMinor === null) return "";
  const perHead = Math.round(budgetMinor / Math.max(1, partySize));
  return partySize > 1
    ? ` under ${inr(budgetMinor)} for all of them, ${inr(perHead)} a head`
    : ` under ${inr(budgetMinor)}`;
}

/** "wanted a craft workshop for 4 people in 3h under ₹4,000, ₹1,000 a head" */
function wantPhrase(gap: DemandGap): string {
  return `${withArticle(categoryWord(gap))} for ${partyPhrase(gap.partySize)} in ${mins(gap.availableMin)}${budgetPhrase(gap.budgetMinor, gap.partySize)}`;
}

// --- the fix a gap points at -----------------------------------------------

/**
 * Blocker -> the supply attribute a provider changes. A code missing from this
 * table produces no opportunity at all, which is the point: we would rather
 * show a provider nothing than show them something they cannot act on.
 */
const FIXES: Readonly<Partial<Record<RejectionCode, { field: string; label: string; capacity: boolean }>>> = {
  over_budget: { field: "pricePerPerson", label: "a lower price band", capacity: false },
  duration_exceeds_budget: { field: "durationMin", label: "a shorter version", capacity: false },
  capacity_exceeded: { field: "capacity", label: "room for a larger group", capacity: true },
  not_step_free: { field: "accessibility.stepFree", label: "step-free access", capacity: false },
  not_stroller_ok: { field: "accessibility.strollerOk", label: "stroller access", capacity: false },
  no_low_stairs: { field: "accessibility.lowStairs", label: "few stairs", capacity: false },
  no_hearing_loop: { field: "accessibility.hearingLoop", label: "a hearing loop", capacity: false },
  no_restroom: { field: "accessibility.restroomOnSite", label: "a restroom on site", capacity: false },
  weather_unsafe: { field: "indoorOutdoor", label: "an indoor option", capacity: false },
  requires_booking_not_available: { field: "booking.walkIn", label: "walk-ins", capacity: true },
  lead_time_too_short: { field: "booking.leadTimeMin", label: "less notice needed", capacity: true },
  too_far: { field: "location", label: "something closer", capacity: true },
};

export interface SupplyFix {
  field: string;
  label: string;
  /** `capacity_window` rather than `listing_quality`: a slot, not a field value. */
  capacity: boolean;
}

export function fixFor(code: RejectionCode): SupplyFix | null {
  return FIXES[code] ?? null;
}

/**
 * Blockers no listing change can fix. Enumerated rather than left as an absent
 * table entry, so a test can assert the set and a reader can see the reasoning.
 */
export const NEVER_AN_OPPORTUNITY: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  "too_far",
  "travel_time_exceeds_budget",
  "duplicate",
  "already_planned",
  "excluded_by_traveller",
  "mustsee_conflict",
  "diet_mismatch",
  "seasonal_mismatch",
  "sold_out",
  "closed_now",
  "closed_during_window",
  "hours_unverified",
  "inaccessible",
]);

// --- opportunity records ---------------------------------------------------

export type OpportunityStatus = "open" | "met";

export interface ProviderOpportunityRecord {
  id: string;
  status: OpportunityStatus;
  kind: ProviderOpportunity["kind"];
  /** null only for `must_see_gap`: there is no provider to push it at. */
  providerId: string | null;
  providerName: string | null;
  /** The frozen contract payload, verbatim. Nothing here widens it. */
  contract: ProviderOpportunity;
  /** The aggregated demand. Every number is a count or a median of real rows. */
  demand: Omit<DemandGap, "reliable">;
  missingSupply: { code: RejectionCode; field: string; label: string };
  /** The listing this record is about. null when nobody can serve the gap. */
  targetListingId: string | null;
  targetListingName: string | null;
  /** Codes the target still fails. Shrinks as the provider edits the listing. */
  targetBlockers: RejectionCode[];
  /** The concrete window to publish, when the fix is a slot rather than a field. */
  suggestedSlot: SlotSuggestion | null;
  /**
   * The gap's logged searches re-run against today's supply. Null when the
   * caller passed no rows, and the contract field stays null with it.
   */
  measurement: Measurement | null;
  /** Listings already serving this demand. Grows as supply arrives. */
  servedBy: string[];
  /** Listings in range that still fail. The remaining addressable work. */
  failingListingIds: string[];
  asOf: string;
}

export interface DetectOptions extends AggregateOptions {
  providers: readonly Provider[];
  radiusKm?: number;
  /** Named in the evidence, so a number is always traceable to a source. */
  datasetLabel?: string;
  /**
   * The providers' bookable calendars. Supplying this turns on slot-awareness:
   * a listing that passes every field check but has nothing bookable is then
   * reported as unmet supply, with a concrete window to publish. Omit it and the
   * engine stays field-only, which is weaker but not wrong.
   */
  supply?: Calendar;
  /**
   * The logged rows behind the gaps. Supplying them lets the engine MEASURE by
   * replaying each search against today's supply, instead of leaving
   * `estimatedImpact` null forever.
   */
  unmetDemand?: readonly UnmetDemand[];
}

/** The traveller shape a gap stands for: its medians, and nothing invented. */
function gapShape(gap: DemandGap, radiusKm: number): SearchShape {
  return {
    point: gap.point,
    radiusKm,
    availableMin: gap.availableMin,
    budgetMinor: gap.budgetMinor,
    partySize: gap.partySize,
    accessNeeds: gap.accessNeeds,
    weather: conditionOf(gap.weather),
  };
}

const byId = (a: Experience, b: Experience): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The fix for a gap whose fields all pass and whose calendar is empty. Not a
 * listing field at all, which is the point: the path a provider panel can
 * deep-link to is `slots`, and that is where the work actually is.
 */
const SLOT_FIX: SupplyFix = { field: "slots", label: "a bookable slot", capacity: true };

function fieldFailures(shape: SearchShape, listing: Experience): number {
  return hardChecks(shape, listing).length;
}

/** The cell key a logged row belongs to. One definition, used by both windows. */
function gapKeyOf(row: UnmetDemand): string {
  const intent = categoryIntent(row.constraints.interests);
  return `${row.neighbourhood?.trim() || "Unknown"}|${row.topBlockingCode}|${intent.category ?? "any"}`;
}

/** The logged rows behind one gap, or null when the caller supplied none. */
function rowsFor(gap: DemandGap, rows: readonly UnmetDemand[] | undefined): UnmetDemand[] | null {
  if (rows === undefined) return null;
  return rows.filter((row) => gapKeyOf(row) === gap.key);
}

/** A listing is in the trade when it is in range and in the right category. */
function inTrade(listing: Experience, gap: DemandGap, radiusKm: number): boolean {
  if (distanceKm(listing.location, gap.point) > radiusKm) return false;
  return gap.category === null || listing.category === gap.category;
}

const CONDITIONS = new Set([
  "clear",
  "cloudy",
  "light_rain",
  "heavy_rain",
  "storm",
  "heat",
  "wind",
]);

/** A gap's weather is a free string off the row; an unrecognised one reads dry. */
function conditionOf(raw: string): SearchShape["weather"] {
  const value = raw.trim().toLowerCase();
  return CONDITIONS.has(value) ? (value as SearchShape["weather"]) : "clear";
}

/** The change, twice: once naming the listing for the headline, once for the CTA. */
interface Change {
  headline: string;
  action: string;
}

function changeFor(
  gap: DemandGap,
  fix: SupplyFix,
  target: Experience | null,
  suggestion: SlotSuggestion | null = null,
): Change {
  const name = target?.name ?? "the listing";
  switch (fix.field) {
    case "pricePerPerson": {
      if (gap.budgetMinor === null) return { headline: `Review pricing on ${name}`, action: "review pricing" };
      const perHead = inr(Math.round(gap.budgetMinor / Math.max(1, gap.partySize)));
      return { headline: `Add a ${perHead} band to ${name}`, action: `add a ${perHead} band` };
    }
    case "durationMin":
      return {
        headline: `Add a ${mins(gap.availableMin)} version of ${name}`,
        action: `add a ${mins(gap.availableMin)} version`,
      };
    case "capacity":
      return { headline: `Add room for ${gap.partySize} on ${name}`, action: `add room for ${gap.partySize}` };
    case "booking.walkIn":
      return { headline: `Allow walk-ins on ${name}`, action: "allow walk-ins" };
    case "booking.leadTimeMin":
      return {
        headline: `Cut the notice on ${name} to ${mins(gap.availableMin)}`,
        action: `cut the notice to ${mins(gap.availableMin)}`,
      };
    case "indoorOutdoor":
      return { headline: `Add an indoor option to ${name}`, action: "add an indoor option" };
    case "slots": {
      // The spec's own headline. A concrete date and a concrete window, because
      // "be open more in the evening" is not a task anyone completes.
      if (suggestion === null) return { headline: `Publish a bookable slot for ${name}`, action: "publish a bookable slot" };
      return {
        headline: `Add a ${suggestion.label} slot on ${suggestion.date} at ${name}`,
        action: `add a ${suggestion.label} slot on ${suggestion.date}`,
      };
    }
    case "accessibility.stepFree":
    case "accessibility.strollerOk":
    case "accessibility.lowStairs":
    case "accessibility.hearingLoop":
    case "accessibility.restroomOnSite": {
      // Unknown and absent are different problems: one is a question, the other
      // is a change. `false` is a confirmed no, so the fix is to add it; `null`
      // is nobody has ever said, so the fix is to go and look.
      const key = fix.field.split(".")[1] as keyof Experience["accessibility"];
      const state = target === null ? null : target.accessibility[key];
      return state === false
        ? { headline: `Add ${fix.label} to ${name}`, action: `add ${fix.label}` }
        : { headline: `Confirm ${fix.label} at ${name}`, action: `confirm ${fix.label}` };
    }
    default:
      return { headline: `Review ${name}`, action: "review the listing" };
  }
}

interface EvidenceExtra {
  status: OpportunityStatus;
  /** The calendar verdict for the target, when a calendar was supplied. */
  calendar: { published: number; served: boolean; unusable: number; mismatch: number; suggestion: SlotSuggestion | null } | null;
  /** Replayed against today's supply. Absent when the caller passed no rows. */
  measurement: Measurement | null;
}

/**
 * Every claim a provider will read, each with its count. Two rules run through
 * all of it: nothing is printed without a number attached, and nothing is
 * printed that the data cannot support.
 */
function evidenceFor(
  gap: DemandGap,
  fix: SupplyFix,
  target: Experience | null,
  counts: { served: number; failing: number; trade: number },
  radiusKm: number,
  windowDays: number,
  datasetLabel: string,
  extra: EvidenceExtra,
): { label: string; value: string }[] {
  const { status, calendar, measurement } = extra;
  const rows: { label: string; value: string }[] = [
    { label: "searches", value: `${gap.searches} in the last ${windowDays} days` },
    { label: "travellers", value: `${gap.travellers} different ${plural(gap.travellers, "account", "accounts")}` },
    { label: "where", value: `${gap.neighbourhood}, within ${radiusKm} km` },
    {
      label: "category",
      value: gap.category === null ? "nothing recognisable in their words" : `${categoryPlural(gap)}, read as ${gap.categoryTier}`,
    },
    { label: "asked for", value: gap.interests.length === 0 ? "nothing in their words" : gap.interests.join(", ") },
    { label: "budget", value: gap.budgetMinor === null ? "none stated" : `${inr(gap.budgetMinor)} total, ${inr(Math.round(gap.budgetMinor / Math.max(1, gap.partySize)))} a head (median)` },
    { label: "window", value: `${mins(gap.availableMin)} (median)` },
    { label: "party", value: `${partyPhrase(gap.partySize)} (median)` },
    { label: "constraints", value: constraintPhrase(gap) },
    { label: "blocked on", value: gap.blockingCode.replace(/_/g, " ") },
    { label: "candidates blocked on it", value: `${gap.blockedCandidates}` },
    { label: gap.detail === "coarse" ? "time of day" : "time of day they searched", value: timeValue(gap) },
    { label: `versus the previous ${windowDays} days`, value: trendValue(gap) },
  ];

  // A cell small enough to fingerprint a person gets the window, not the dates.
  // The demand is still counted — coarsening the fingerprint is not hiding it.
  if (gap.detail === "coarse") {
    rows.push({
      label: "exact dates and times",
      value: `withheld: ${gap.travellers} ${plural(gap.travellers, "account", "accounts")} is few enough to identify someone`,
    });
  } else {
    rows.push({ label: "first seen", value: gap.firstSeenAt.slice(0, 10) });
    rows.push({ label: "last seen", value: gap.lastSeenAt.slice(0, 10) });
  }

  rows.push({
    label: `listings within ${radiusKm} km`,
    value: `${counts.trade} in this category, ${counts.served} already ${counts.served === 1 ? "serves" : "serve"} it, ${counts.failing} ${counts.failing === 1 ? "does" : "do"} not`,
  });

  if (calendar !== null && target !== null) {
    rows.push({ label: `your bookable calendar for ${target.name}`, value: calendarLine(calendar) });
  }

  // Only meaningful while there is work to do. On a `met` record the target has
  // changed, so printing the old verdict next to "now serves this" would be
  // two contradictory claims about the same field in one panel.
  if (target !== null && status === "open" && fix.field !== "slots") {
    rows.push({ label: `${target.name} — ${fix.field}`, value: targetState(target, fix) });
  }
  if (measurement !== null) {
    rows.push({
      label: "replayed against today's supply",
      value: measurement.estimatedImpact ?? `none of the ${measurement.total} would be served yet`,
    });
  }
  rows.push({ label: "source", value: datasetLabel });
  return rows;
}

/** The calendar, said the way a provider needs it: what exists, and what is wrong. */
function calendarLine(calendar: NonNullable<EvidenceExtra["calendar"]>): string {
  if (calendar.served) return `a slot they can book (${calendar.published} published)`;
  if (calendar.published === 0) return "nothing published at all";
  return `${calendar.published} published, none bookable at that hour: ${calendar.mismatch} at another hour, ${calendar.unusable} full, blocked or out of horizon`;
}

/** The time signal, or an honest "no pattern" — never a guess from one search. */
function timeValue(gap: DemandGap): string {
  if (gap.hourMin === null) return `no clear pattern across ${gap.searches} searches`;
  const bucket = gap.hourBucket?.replace(/_/g, " ") ?? "unknown";
  // Under the privacy bar the exact quarter-hour is the identifying part.
  return gap.detail === "coarse" ? `${bucket}, roughly` : `${minToLabel(gap.hourMin)} (${bucket})`;
}

function trendValue(gap: DemandGap): string {
  if (gap.previousSearches === 0) return `${gap.searches}, up from none recorded`;
  const delta = gap.searches - gap.previousSearches;
  if (delta === 0) return `unchanged at ${gap.searches}`;
  return `${gap.searches}, ${delta > 0 ? "up" : "down"} from ${gap.previousSearches} (${gap.trend})`;
}

function constraintPhrase(gap: DemandGap): string {
  const parts: string[] = [];
  if (gap.accessNeeds.length > 0) parts.push(gap.accessNeeds.map((need) => need.replace(/_/g, " ")).join(", "));
  if (gap.weather !== "clear") parts.push(`weather: ${gap.weather.replace(/_/g, " ")}`);
  return parts.length === 0 ? "none stated beyond the above" : parts.join("; ");
}

/** What the target actually says about the field, never a guess. */
function targetState(target: Experience, fix: SupplyFix): string {
  if (!fix.field.startsWith("accessibility.")) return "does not meet it";
  const key = fix.field.split(".")[1] as keyof Experience["accessibility"];
  const value = target.accessibility[key];
  if (value === true) return "already offered";
  return value === false ? "confirmed absent" : "never confirmed";
}

function buildRecord(args: {
  gap: DemandGap;
  status: OpportunityStatus;
  kind: ProviderOpportunity["kind"];
  provider: Provider | null;
  fix: SupplyFix;
  target: Experience | null;
  targetBlockers: RejectionCode[];
  servedBy: string[];
  failingListingIds: string[];
  counts: { served: number; failing: number; trade: number };
  radiusKm: number;
  windowDays: number;
  datasetLabel: string;
  asOf: string;
  extra: EvidenceExtra;
}): ProviderOpportunityRecord {
  const { gap, status, kind, provider, fix, target, servedBy, failingListingIds, counts, radiusKm, windowDays, datasetLabel, asOf, extra } = args;
  const searches = `${gap.searches} ${plural(gap.searches, "search", "searches")}`;
  const scope = `${searches} near ${gap.neighbourhood} wanted ${wantPhrase(gap)}`;

  const change = changeFor(gap, fix, target, extra.calendar?.suggestion ?? null);
  const supply =
    counts.trade === 0
      ? `there is no ${categoryPlural(gap)} within ${radiusKm} km at all`
      : counts.failing === 0
        ? `everything in range already ${counts.trade === 1 ? "covers it" : "cover it"}`
        : counts.trade === 1
          ? `it is the only ${categoryWord(gap)} within ${radiusKm} km`
          : `none of the ${counts.trade} ${categoryPlural(gap)} within ${radiusKm} km met it`;

  // A slot fix is a different sentence: the fields already pass, so the reason is
  // the calendar, and the hour is the whole content of the recommendation.
  const slotClause =
    fix.field === "slots" && gap.hourMin !== null
      ? `, and you publish nothing they can book around ${minToLabel(gap.hourMin)}`
      : "";

  const headline =
    status === "met"
      ? `${target?.name ?? "A new listing"} now serves this: ${scope}.`
      : provider === null
        ? `No provider can serve this yet: ${scope}, and ${supply}.`
        : `${change.headline} — ${scope}, and ${supply}${slotClause}.`;

  const cta =
    status === "met"
      ? `Nothing to do. ${target?.name ?? "The listing"} already covers this demand.`
      : provider === null
        ? `List ${withArticle(categoryWord(gap))} in ${gap.neighbourhood} — ${searches} in the last ${windowDays} days found nothing.`
        : fix.field === "slots"
          ? `Add a slot to ${target?.name ?? "the listing"}: ${change.action}.`
          : `Open ${target?.name ?? "the listing"} at ${fix.field} and ${change.action}.`;

  return {
    id: `opp-${status}-${gap.key}-${provider?.id ?? "acquisition"}`,
    status,
    kind,
    providerId: provider?.id ?? null,
    providerName: provider?.name ?? null,
    contract: {
      providerId: provider?.id ?? "",
      kind,
      headline,
      evidence: evidenceFor(gap, fix, target, counts, radiusKm, windowDays, datasetLabel, extra),
      // Only ever a measured number: `measurement` is a replay of real logged
      // searches, and it stays null when nothing has been acted on yet, because
      // estimating the effect of a fix nobody has made is a prediction.
      estimatedImpact: extra.measurement?.estimatedImpact ?? null,
      cta,
    },
    demand: gap,
    missingSupply: { code: gap.blockingCode, field: fix.field, label: fix.label },
    targetListingId: target?.id ?? null,
    targetListingName: target?.name ?? null,
    targetBlockers: args.targetBlockers,
    suggestedSlot: extra.calendar?.suggestion ?? null,
    measurement: extra.measurement,
    servedBy,
    failingListingIds,
    asOf,
  };
}

/**
 * Opportunities for every provider, best first, plus the gaps nobody can serve.
 *
 * Three outcomes per gap, and they are mutually exclusive per provider:
 *   - a provider owns a listing that still fails -> `open`, one record, named
 *     at the cheapest-to-fix listing of theirs that fails
 *   - a provider owns a listing that already serves it -> `met`, so the fix is
 *     visible instead of silently vanishing
 *   - nobody owns anything that can serve it -> `must_see_gap`, providerId null,
 *     which is the acquisition list, not a push at someone who cannot help
 *
 * Fully determined by the data: ordering is (searches, travellers, id), never
 * insertion order, so the feed does not reshuffle between renders.
 */
export function detectOpportunities(
  gaps: readonly DemandGap[],
  catalogue: readonly Experience[],
  opts: DetectOptions,
): ProviderOpportunityRecord[] {
  const radiusKm = opts.radiusKm ?? RADIUS_KM;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const datasetLabel = opts.datasetLabel ?? "Unmet-demand log";
  const tz = opts.tzOffsetMin ?? MUMBAI_TZ_OFFSET_MIN;
  const today = localDate(opts.asOf, tz);
  const out: ProviderOpportunityRecord[] = [];

  for (const gap of gaps) {
    if (!gap.reliable) continue;
    if (NEVER_AN_OPPORTUNITY.has(gap.blockingCode)) continue;
    const fix = fixFor(gap.blockingCode);
    if (fix === null) continue;

    const shape = gapShape(gap, radiusKm);
    // The traveller's free time, from the gap's medians. Null when no calendar
    // was supplied, or when the cell has no time pattern — and with no pattern
    // there is no honest slot advice to give.
    const window: Window | null =
      opts.supply !== undefined && gap.hourMin !== null
        ? { arriveMin: gap.hourMin, availableMin: gap.availableMin, partySize: gap.partySize }
        : null;

    // Sorted by id before anything counts it: the catalogue arrives in whatever
    // order a repository hands it over, and `servedBy` / `failingListingIds` are
    // part of a provider's record, so input order must not reach the output.
    const trade = catalogue.filter((listing) => inTrade(listing, gap, radiusKm)).sort(byId);
    const rows = rowsFor(gap, opts.unmetDemand);

    // `bookable` is the gate a calendar adds. Without one, a field-clean listing
    // is bookable in principle — the old behaviour, kept as a fallback rather
    // than promoted to a claim.
    const bookable = (listing: Experience): boolean =>
      window === null || verdictFor(listing, opts.supply!, today, window).served;

    const served = trade.filter((listing) => hardChecks(shape, listing).length === 0 && bookable(listing));
    const failing = trade.filter((listing) => !(hardChecks(shape, listing).length === 0 && bookable(listing)));
    const counts = { served: served.length, failing: failing.length, trade: trade.length };
    const kind: ProviderOpportunity["kind"] =
      trade.length === 0 ? "must_see_gap" : fix.capacity ? "capacity_window" : "listing_quality";

    const shared = {
      gap,
      fix,
      counts,
      servedBy: served.map((listing) => listing.id),
      failingListingIds: failing.map((listing) => listing.id),
      radiusKm,
      windowDays,
      datasetLabel,
      asOf: opts.asOf,
    };

    /** The calendar verdict for one listing, or null when no calendar was given. */
    const calendarFor = (listing: Experience | null): EvidenceExtra["calendar"] =>
      window === null || listing === null ? null : verdictFor(listing, opts.supply!, today, window);

    const measureFor = (listingId: string | null): Measurement | null =>
      rows === null
        ? null
        : measureGap(rows, catalogue, {
            asOf: opts.asOf,
            radiusKm,
            category: gap.category,
            ...(opts.supply === undefined ? {} : { calendar: opts.supply }),
            tzOffsetMin: tz,
            targetListingId: listingId,
          });

    let anyoneCanAct = false;
    for (const provider of opts.providers) {
      const mine = failing.filter((listing) => listing.providerId === provider.id);
      // Cheapest to fix first, id as the tie-break: a provider with two failing
      // listings is shown the one a single field change would close.
      const target = [...mine].sort((a, b) => {
        const failures = fieldFailures(shape, a) - fieldFailures(shape, b);
        return failures !== 0 ? failures : a.id < b.id ? -1 : 1;
      })[0];
      if (target === undefined) continue;
      anyoneCanAct = true;

      // A listing whose fields all pass and which has nothing bookable is a
      // calendar problem, not a field problem, and the fix is a window. One
      // opportunity per listing either way: two records for one listing is a
      // to-do list, and to-do lists get ignored.
      const fieldBlockers = hardChecks(shape, target);
      const calendarOnly = window !== null && fieldBlockers.length === 0;
      const effectiveFix = calendarOnly ? SLOT_FIX : fix;

      out.push(
        buildRecord({
          ...shared,
          fix: effectiveFix,
          status: "open",
          kind: calendarOnly ? "capacity_window" : kind,
          provider,
          target,
          targetBlockers: calendarOnly ? [] : fieldBlockers.map((rejection) => rejection.code),
          extra: { status: "open", calendar: calendarFor(target), measurement: measureFor(target.id) },
        }),
      );
    }

    for (const provider of opts.providers) {
      const servedByProvider = served.filter((listing) => listing.providerId === provider.id);
      if (servedByProvider.length === 0) continue;
      out.push(
        buildRecord({
          ...shared,
          status: "met",
          kind,
          provider,
          target: servedByProvider[0]!,
          targetBlockers: [],
          extra: {
            status: "met",
            calendar: calendarFor(servedByProvider[0]!),
            measurement: measureFor(servedByProvider[0]!.id),
          },
        }),
      );
    }

    // Nobody owns anything that could serve this AND nothing in range serves it
    // either. Per FEATURES §10 that is an acquisition gap, not a push at
    // someone who cannot help. The `served.length === 0` half matters: a gap
    // that supply has already answered is not an acquisition target, and saying
    // "no provider can serve this yet" next to a `met` record is a lie.
    if (!anyoneCanAct && served.length === 0) {
      out.push(
        buildRecord({
          ...shared,
          status: "open",
          kind: "must_see_gap",
          provider: null,
          target: null,
          targetBlockers: [],
          extra: { status: "open", calendar: null, measurement: measureFor(null) },
        }),
      );
    }
  }

  return out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    if (a.demand.searches !== b.demand.searches) return b.demand.searches - a.demand.searches;
    if (a.demand.travellers !== b.demand.travellers) return b.demand.travellers - a.demand.travellers;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// --- provider-facing retrieval ---------------------------------------------

export interface OpportunityQuery {
  providerId?: string;
  neighbourhood?: string;
  category?: Category | null;
  kind?: ProviderOpportunity["kind"];
  minSearches?: number;
  /** `met` records are evidence of a fix, not work. Off unless asked for. */
  includeMet?: boolean;
  limit?: number;
}

/**
 * The one call a provider feed makes. A pure filter over records already built,
 * so a panel can re-query on every render without re-running detection, and a
 * test can query the same way the UI does.
 */
export function queryOpportunities(
  records: readonly ProviderOpportunityRecord[],
  query: OpportunityQuery = {},
): ProviderOpportunityRecord[] {
  const out = records.filter((record) => {
    if (query.providerId !== undefined && record.providerId !== query.providerId) return false;
    if (query.neighbourhood !== undefined && record.demand.neighbourhood !== query.neighbourhood) return false;
    if (query.category !== undefined && record.demand.category !== query.category) return false;
    if (query.kind !== undefined && record.kind !== query.kind) return false;
    if (query.minSearches !== undefined && record.demand.searches < query.minSearches) return false;
    if (record.status === "met" && query.includeMet !== true) return false;
    return true;
  });
  return query.limit === undefined ? out : out.slice(0, query.limit);
}

/** A provider's own feed: their open work, best evidenced first. */
export function opportunitiesForProvider(
  records: readonly ProviderOpportunityRecord[],
  providerId: string,
  query: Omit<OpportunityQuery, "providerId"> = {},
): ProviderOpportunityRecord[] {
  return queryOpportunities(records, { ...query, providerId });
}

/** The acquisition list: reliable gaps no provider can serve yet. */
export function acquisitionGaps(records: readonly ProviderOpportunityRecord[]): ProviderOpportunityRecord[] {
  return queryOpportunities(records, { kind: "must_see_gap" });
}
