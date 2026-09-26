/**
 * Deterministic demand aggregation. Pure functions, no clock, no randomness, no
 * I/O — the same `UnmetDemand[]` and the same `asOf` always produce the same
 * object, byte for byte. Everything sorts by (count desc, key asc) so insertion
 * order can never leak into output.
 *
 * The honesty contract, enforced here:
 *   - every bar carries `tier` and `sampleSize`
 *   - every dimension carries its own denominator `n`
 *   - below `minSample` the dimension reports `reliable: false` and the UI is
 *     expected to say "not enough signal" instead of drawing a chart
 *   - category is `observed` only when the traveller's own words contained a
 *     category tag; a keyword match is `inferred` and is badged as such
 */
import type { Category, RejectionCode, UnmetDemand } from "../../contracts";
import { formatInr, formatMinutes, timeBucketLabel, timeBucketOf } from "./format";
import type {
  ClaimTier,
  DemandAggregation,
  DemandBar,
  DemandCell,
  DemandDimension,
} from "./types";

/** Below this many searches a claim is not a claim. */
export const MIN_SAMPLE = 5;
/** How far back the analytics window reaches from `asOf`. */
export const WINDOW_DAYS = 14;
/** Radius, in km, for "how many other listings could have served this". */
export const RADIUS_KM = 2;
/** Mumbai is UTC+5:30, and every `city` in the contracts defaults to Mumbai. */
export const MUMBAI_TZ_OFFSET_MIN = 330;

const DAY_MS = 86_400_000;

/** Round to 3dp so JSON snapshots and tests stay stable. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function byCountThenKey(a: DemandBar, b: DemandBar): number {
  if (b.value !== a.value) return b.value - a.value;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** `not_step_free` -> "Not step free". The fallback for every code. */
export function humanise(code: string): string {
  const [first = code, ...rest] = code.split("_");
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  return rest.length > 0 ? `${head} ${rest.join(" ")}` : head;
}

export function rejectionLabel(code: RejectionCode | string): string {
  return humanise(String(code));
}

// --- category intent ------------------------------------------------------
//
// `UnmetDemand.constraints.interests` is an open-vocabulary string array. Two
// ways to read it, and the difference is the whole point: an exact category tag
// is something the traveller actually said (observed), a keyword match is a rule
// we wrote (inferred).

/** Keyword -> category. Small on purpose: every entry is a claim we can defend. */
const CATEGORY_KEYWORDS: ReadonlyArray<readonly [Category, readonly string[]]> = [
  ["street_food", ["chaat", "vada pav", "pav bhaji", "street food", "snack", "kebab", "misal"]],
  ["restaurant", ["meal", "lunch", "dinner", "brunch", "thali", "food", "dining"]],
  ["cafe", ["coffee", "chai", "bakery", "cafe", "tea", "pastry"]],
  ["market", ["bazaar", "market", "souk", "flea", "sourcing"]],
  ["craft_workshop", ["workshop", "pottery", "block print", "block printing", "textile", "craft", "embroidery", "zari", "chintz", "banarasi", "tie-dye", "handloom"]],
  ["art_studio", ["art", "painting", "sketch", "portrait", "studio", "watercolour", "charcoal", "calligraphy"]],
  ["music_live", ["music", "live music", "band", "ghazal", "jazz", "sitar", "tabla"]],
  ["dance_performance", ["dance", "kathak", "performance", "folk dance"]],
  ["theatre", ["theatre", "play", "musical", "drama"]],
  ["temple", ["temple", "mandir", "shiv", "durga", "ganesh", "aarti"]],
  ["church", ["church", "basilica", "cathedral", "christian"]],
  ["mosque", ["mosque", "masjid", "islamic"]],
  ["heritage_site", ["heritage", "fort", "ruins", "architecture", "monument", "palace", "colonial", "temple rock"]],
  ["museum", ["museum", "collection", "archive"]],
  ["gallery", ["gallery", "exhibition hall", "art gallery"]],
  ["nature", ["park", "garden", "nature", "trail", "bird", "hill", "sunset point", "lookout"]],
  ["beach", ["beach", "seafront", "promenade", "marine drive"]],
  ["adventure", ["surfing", "kayak", "dive", "scuba", "paragliding", "trek", "rafting", "cycling"]],
  ["wellness", ["yoga", "spa", "massage", "wellness", "meditation"]],
  ["nightlife", ["bar", "pub", "club", "nightlife", "cocktails", "live band"]],
  ["shopping", ["shopping", "mall", "souvenirs", "flea market"]],
  ["community_hosted", ["community", "locals", "storytelling", "home meal", "family meal"]],
  ["festival", ["festival", "ganpati", "procession", "fair"]],
  ["event", ["event", "concert", "meetup", "screening", "talk"]],
  ["hidden_place", ["hidden", "secret", "offbeat", "lesser known", "quiet corner", "unusual"]],
];

/** Exact contract category values we accept as an observed intent. */
const CATEGORY_TAGS: ReadonlySet<string> = new Set(CATEGORY_KEYWORDS.map(([c]) => c));

export interface CategoryIntent {
  category: Category | null;
  tier: ClaimTier;
  /** The interest string that produced the match. Evidence, not a guess. */
  matchedOn: string | null;
}

/**
 * Read a category out of free-text interests. An exact tag wins and is
 * `observed`; otherwise the longest keyword match wins (so "craft workshop"
 * beats "workshop") and is `inferred`; nothing recognisable gives null, and the
 * row still counts in every other dimension.
 */
export function categoryIntent(interests: readonly string[]): CategoryIntent {
  const cleaned = interests.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
  for (const raw of cleaned) {
    const normalised = raw.replace(/\s+/g, "_");
    if (CATEGORY_TAGS.has(raw) || CATEGORY_TAGS.has(normalised)) {
      return { category: raw as Category, tier: "observed", matchedOn: raw };
    }
  }
  let best: { category: Category; len: number; on: string } | null = null;
  for (const raw of cleaned) {
    for (const [category, words] of CATEGORY_KEYWORDS) {
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

// --- banded dimensions ----------------------------------------------------

export interface Band {
  key: string;
  label: string;
}

/** Upper edges in rupees. A null budget is its own honest band, not a zero. */
const PRICE_EDGES_RUPEES: readonly number[] = [250, 500, 1000, 1500, 2500, 5000];

export function priceBandOf(budgetMinor: number | null): Band {
  if (budgetMinor === null) return { key: "no_limit", label: "No limit stated" };
  const rupees = budgetMinor / 100;
  for (let i = 0; i < PRICE_EDGES_RUPEES.length; i += 1) {
    const edge = PRICE_EDGES_RUPEES[i]!;
    if (rupees <= edge) {
      const lower = i === 0 ? 0 : PRICE_EDGES_RUPEES[i - 1]!;
      return {
        key: `${lower}-${edge}`,
        label: lower === 0 ? `Up to ${formatInr(edge * 100)}` : `${formatInr(lower * 100)} to ${formatInr(edge * 100)}`,
      };
    }
  }
  return { key: "5000+", label: `Over ${formatInr(5000 * 100)}` };
}

const DURATION_EDGES: readonly number[] = [60, 120, 180, 240, 480];

export function durationBandOf(min: number): Band {
  for (let i = 0; i < DURATION_EDGES.length; i += 1) {
    const edge = DURATION_EDGES[i]!;
    if (min <= edge) {
      const lower = i === 0 ? 0 : DURATION_EDGES[i - 1]!;
      return {
        key: `${lower}-${edge}`,
        label: lower === 0 ? `Up to ${formatMinutes(edge)}` : `${formatMinutes(lower)} to ${formatMinutes(edge)}`,
      };
    }
  }
  return { key: "480+", label: "Over 8h" };
}

export function partyBandOf(size: number): Band {
  if (size <= 1) return { key: "1", label: "Travelling alone" };
  if (size === 2) return { key: "2", label: "Pair" };
  if (size <= 4) return { key: "3-4", label: "Small group, 3 to 4" };
  return { key: "5+", label: "Large group, 5 or more" };
}

const KID_WORDS: ReadonlySet<string> = new Set([
  "family",
  "kids",
  "kid",
  "children",
  "toddler",
  "child friendly",
  "kid_friendly",
  "school holiday",
  "birthday",
]);

// --- aggregation ----------------------------------------------------------

interface Accumulator {
  key: string;
  label: string;
  value: number;
  tier: ClaimTier;
}

function push(acc: Map<string, Accumulator>, key: string, label: string, tier: ClaimTier): void {
  const existing = acc.get(key);
  if (existing) {
    existing.value += 1;
    if (existing.tier === "inferred" && tier === "observed") existing.tier = "observed";
    return;
  }
  acc.set(key, { key, label, value: 1, tier });
}

function toDimension(
  dimension: DemandDimension["dimension"],
  acc: Map<string, Accumulator>,
  n: number,
  minSample: number,
): DemandDimension {
  const bars: DemandBar[] = [...acc.values()]
    .map((a) => ({
      key: a.key,
      label: a.label,
      value: a.value,
      share: n > 0 ? round3(a.value / n) : 0,
      tier: a.tier,
      sampleSize: a.value,
    }))
    .sort(byCountThenKey);
  return { dimension, n, reliable: n >= minSample, bars };
}

export interface AggregateOptions {
  asOf: string;
  minSample?: number;
  windowDays?: number;
  /** Local offset for time bucketing. Defaults to Mumbai. */
  tzOffsetMin?: number;
}

export function windowStart(asOf: string, windowDays: number): number {
  return Date.parse(asOf) - windowDays * DAY_MS;
}

/**
 * The whole demand picture from zero-result searches. Every number traces back to
 * a row in `UnmetDemand`. The two places we derive something — category from
 * free text, and a modal search time — are tiered, never presented as fact.
 */
export function aggregateDemand(rows: readonly UnmetDemand[], opts: AggregateOptions): DemandAggregation {
  const minSample = opts.minSample ?? MIN_SAMPLE;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const tz = opts.tzOffsetMin ?? MUMBAI_TZ_OFFSET_MIN;
  const start = windowStart(opts.asOf, windowDays);
  const end = Date.parse(opts.asOf);

  const inWindow: UnmetDemand[] = [];
  let outsideWindow = 0;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) {
      outsideWindow += 1;
      continue;
    }
    if (at > end || at < start) {
      outsideWindow += 1;
      continue;
    }
    inWindow.push(row);
  }

  const category = new Map<string, Accumulator>();
  const locality = new Map<string, Accumulator>();
  const time = new Map<string, Accumulator>();
  const price = new Map<string, Accumulator>();
  const constraint = new Map<string, Accumulator>();
  const access = new Map<string, Accumulator>();
  const party = new Map<string, Accumulator>();
  const weather = new Map<string, Accumulator>();
  const duration = new Map<string, Accumulator>();
  let categoryN = 0;

  for (const row of inWindow) {
    const intent = categoryIntent(row.constraints.interests);
    if (intent.category !== null) {
      categoryN += 1;
      push(category, intent.category, humanise(intent.category), intent.tier);
    }

    const hood = row.neighbourhood?.trim();
    if (hood) push(locality, hood, hood, "observed");
    if (!hood) push(locality, "unknown", "Unspecified area", "observed");

    const bucket = timeBucketOf(localMinutesOfDay(row.at, tz));
    push(time, bucket, timeBucketLabel(bucket), "observed");

    const pb = priceBandOf(row.constraints.budgetMinor);
    push(price, pb.key, pb.label, "observed");

    push(constraint, row.topBlockingCode, rejectionLabel(row.topBlockingCode), "observed");
    for (const need of row.constraints.accessNeeds) push(access, need, humanise(need), "observed");

    const sb = partyBandOf(row.constraints.partySize);
    push(party, sb.key, sb.label, "observed");

    const w = row.constraints.weather.trim().toLowerCase();
    if (w) push(weather, w, humanise(w), "observed");

    const db = durationBandOf(row.constraints.availableMin);
    push(duration, db.key, db.label, "observed");
  }

  return {
    total: inWindow.length,
    outsideWindow,
    minSample,
    windowDays,
    asOf: opts.asOf,
    byCategory: toDimension("category", category, categoryN, minSample),
    byLocality: toDimension("locality", locality, inWindow.length, minSample),
    byTime: toDimension("time", time, inWindow.length, minSample),
    byPrice: toDimension("price", price, inWindow.length, minSample),
    byConstraint: toDimension("constraint", constraint, inWindow.length, minSample),
    byAccessNeed: toDimension("access_need", access, inWindow.length, minSample),
    byPartySize: toDimension("party_size", party, inWindow.length, minSample),
    byWeather: toDimension("weather", weather, inWindow.length, minSample),
    byDuration: toDimension("duration", duration, inWindow.length, minSample),
  };
}

/** Local minutes from midnight of an ISO datetime. */
export function localMinutesOfDay(iso: string, tzOffsetMin: number = MUMBAI_TZ_OFFSET_MIN): number {
  const h = Number(iso.slice(11, 13));
  const m = Number(iso.slice(14, 16));
  const utc = (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
  return (((utc + tzOffsetMin) % 1440) + 1440) % 1440;
}

/** Local calendar date (YYYY-MM-DD) of an ISO datetime. */
export function localDate(iso: string, tzOffsetMin: number = MUMBAI_TZ_OFFSET_MIN): string {
  const shifted = new Date(Date.parse(iso) + tzOffsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// --- cells ----------------------------------------------------------------

export interface CellOptions {
  asOf: string;
  minSample?: number;
  windowDays?: number;
  tzOffsetMin?: number;
}

/**
 * Group unmet searches into the unit an opportunity is built from: same
 * neighbourhood, same binding constraint, same category intent.
 *
 * A cell smaller than `minSample` is still returned — the caller decides — but it
 * reports `reliable: false` and anything derived from it is tiered `inferred`.
 */
export function buildCells(rows: readonly UnmetDemand[], opts: CellOptions): DemandCell[] {
  const minSample = opts.minSample ?? MIN_SAMPLE;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const tz = opts.tzOffsetMin ?? MUMBAI_TZ_OFFSET_MIN;
  const start = windowStart(opts.asOf, windowDays);
  const end = Date.parse(opts.asOf);

  const groups = new Map<string, UnmetDemand[]>();
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at) || at > end || at < start) continue;
    const intent = categoryIntent(row.constraints.interests);
    const key = `${row.neighbourhood?.trim() || "Unknown"}|${row.topBlockingCode}|${intent.category ?? "any"}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const cells: DemandCell[] = [];
  for (const [key, members] of groups) {
    const first = members[0]!;
    const intent = categoryIntent(first.constraints.interests);
    const budgets = members
      .map((m) => m.constraints.budgetMinor)
      .filter((b): b is number => b !== null)
      .sort((a, b) => a - b);
    const modal = modalValue(members.map((m) => timeBucketOf(localMinutesOfDay(m.at, tz))));
    const interests = sortedUnique(members.flatMap((m) => m.constraints.interests));
    const latestAt = members.reduce((a, m) => (m.at > a ? m.at : a), first.at);
    const hasTime = modal.count >= minSample;

    cells.push({
      key,
      neighbourhood: first.neighbourhood?.trim() || "Unknown",
      point: centroid(members.map((m) => m.point)),
      blockingCode: first.topBlockingCode,
      category: intent.category,
      categoryTier: intent.tier,
      n: members.length,
      blockedCandidates: members.reduce((a, m) => a + m.topBlockingCount, 0),
      budgetMinor: median(budgets),
      availableMin: median(members.map((m) => m.constraints.availableMin)),
      partySize: median(members.map((m) => m.constraints.partySize)),
      timeBucket: hasTime ? modal.value : null,
      timeTier: hasTime ? "observed" : "inferred",
      accessNeeds: sortedUnique(members.flatMap((m) => m.constraints.accessNeeds)),
      weather: sortedUnique(members.map((m) => m.constraints.weather.trim().toLowerCase()).filter((w) => w.length > 0)),
      interests,
      kidSignal:
        members.some((m) => m.constraints.partySize >= 3) ||
        interests.some((i) => KID_WORDS.has(i.toLowerCase())),
      reliable: members.length >= minSample,
      latestAt,
    });
  }

  return cells.sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    if (b.blockedCandidates !== a.blockedCandidates) return b.blockedCandidates - a.blockedCandidates;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function modalValue<T extends string>(values: readonly T[]): { value: T | null; count: number } {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: { value: T; count: number } | null = null;
  for (const [value, count] of counts) {
    if (best === null || count > best.count || (count === best.count && value < best.value)) {
      best = { value, count };
    }
  }
  return best === null ? { value: null, count: 0 } : best;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

function centroid(points: readonly { lat: number; lon: number }[]): { lat: number; lon: number } {
  return {
    lat: round6(points.reduce((a, p) => a + p.lat, 0) / points.length),
    lon: round6(points.reduce((a, p) => a + p.lon, 0) / points.length),
  };
}

/** Great-circle distance in km. Two lines, so we never claim a radius we cannot check. */
export function distanceKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return round3(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
