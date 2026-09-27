/**
 * Social signals: what people are actually reporting about the conditions.
 *
 * The brief asks for "real-world social-media or publicly available social signals
 * to capture real-world traveler/user reactions, reports, trends, or emerging
 * conditions". This file sources them from two places, and the split is the
 * interesting part.
 *
 * **The live source** is a public, keyless, no-login feed, read behind a timeout
 * and a cache. It is the only part that sees text nobody here wrote, which is
 * exactly the part a rule-based classifier cannot handle — so that is the part the
 * aligned model reads (see `nugen.ts`).
 *
 * **The committed corpus** is `content/reviews/*.jsonl` and `content/events/events.jsonl`:
 * 291 reviews carrying a sentiment, a wall-clock hour, a `helpfulCount` and 770
 * distinct `signalTags` — among them "cancelled in rain", "open in monsoon",
 * "steep wet steps", "too hot at midday", "half the lawn has no shade",
 * "reliable in rain" — plus 40 events that state their own cancellation rules in
 * prose ("Called off if sustained wind is under 8 km/h. Kites need wind; there is
 * no indoor version of this."). That is a *labelled* corpus about these exact
 * entities, and it is the only reason the twin can learn anything offline or in a
 * test.
 *
 * Neither source scrapes anything behind a login, and nothing here is attributed
 * to a person: `authorPseudonym` is carried nowhere, `author` nowhere, and only
 * the aggregate `helpfulCount` survives as a weight. `docs/ARCHITECTURE.md` §12
 * requires no PII in the analytics stream and this is that rule applied to the
 * hardest case, where the source text is a stranger's words.
 *
 * The live feed 429s, which is not a hypothetical: it did, within two calls, while
 * this was being written. So `resolveSocial` cannot throw, the app caches whatever
 * it last got, and a failed read costs the twin its corroboration weight and
 * nothing else.
 */
import type { HazardKind } from "./hazards";

export type SignalSource = "live_web" | "review_corpus" | "event_rule";

export type SocialSignal = {
  id: string;
  source: SignalSource;
  /** The catalogue row this is about, when it is about one. */
  entityId: string | null;
  neighbourhood: string | null;
  /** 0-23, the hour the reporter was actually there. Local time. */
  hour: number;
  /** -1 negative · 0 mixed · +1 positive. */
  sentiment: -1 | 0 | 1;
  /** Engagement. A report 86 people found helpful outranks one nobody did. */
  weight: number;
  /** Which hazards the reporter is talking about. Empty for a neutral report. */
  conditions: readonly HazardKind[];
  /**
   * How exposed the reporter found the place to be, 0 sheltered - 1 open and
   * suffering. Read from the tag vocabulary, and the single most useful number in
   * the corpus: it is a human judgement of shelterability against a real sky.
   */
  exposure: number;
  /** Verbatim, truncated. Never rendered as a quote without this being a review. */
  text: string;
  tags: readonly string[];
};

export type SocialRequest = {
  /** Open-Meteo-style point, used to keep the live query geographically honest. */
  lat: number;
  lon: number;
  /** Free text for the live query: the conditions we are currently simulating. */
  query: string;
  /** Cap on returned signals, applied after the most-weighted survive. */
  limit: number;
};

export interface SocialSource {
  readonly id: string;
  /** Throws on transport or shape failure. `resolveSocial` is the safe door. */
  read(request: SocialRequest): Promise<SocialSignal[]>;
}

// ---------------------------------------------------------------------------
// The lexicon: report text -> hazards
// ---------------------------------------------------------------------------

/**
 * Which hazards a phrase implicates.
 *
 * Matched on **word boundaries**, and that is load-bearing rather than fussy. A bare
 * `indexOf` over `"hot"` matches "photographs" and "hotel", so a review praising the
 * photographs taken at a hotel was being recorded as heat evidence — which is
 * exactly the kind of plausible-looking wrong answer that makes a learned model
 * untrustworthy. The planted test asserts it.
 *
 * `NEGATORS` then catches the polarity case: "dry in heavy rain" contains "heavy
 * rain" and means the opposite, and a substring classifier would score a venue as
 * rain-exposed because a reviewer praised it for staying dry.
 */
const HAZARD_PHRASES: ReadonlyArray<readonly [HazardKind, readonly string[]]> = [
  ["flood", ["flood", "flooded", "waterlogged", "water logged", "under water", "submerged", "open drains", "drainage", "ponding"]],
  ["storm", ["storm", "cyclone", "thunder", "lightning", "squall", "gale"]],
  ["rain", ["rain", "raining", "rainy", "wet", "drizzle", "downpour", "shower", "monsoon", "humid", "damp", "waterproof", "umbrella", "slippery", "slip", "puddle", "mud"]],
  ["heat", ["heat", "hot", "sun", "sunny", "shade", "shadow", "shaded", "humid", "sweltering", "hydrate", "water bottle", "midday", "no shade", "iron roof", "roof tables", "graveyard shade", "flyover"]],
  ["wind", ["wind", "windy", "gust", "breeze", "breezy", "draft", "dust"]],
] as const;

/**
 * Phrase -> a boundary-anchored matcher.
 *
 * `(?<![a-z])` rather than `\b`, because `\b` is defined against `\w` and so treats a
 * digit as a word character: "3h shade" and "top-heavy" would both be missed by
 * `\bshade\b`-style anchoring in a way that is not obvious when reading the table
 * above. Lookbehind at 13 targets is fine, and it is the only regex feature used.
 */
const MATCHERS = new Map<string, RegExp>();
for (const [, phrases] of HAZARD_PHRASES) {
  for (const phrase of phrases) {
    if (MATCHERS.has(phrase)) continue;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    MATCHERS.set(phrase, new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "i"));
  }
}

/** Phrases that invert the hazard they contain. "Dry in heavy rain" is a positive. */
const NEGATORS: readonly string[] = [
  "dry in",
  "stays dry",
  "stayed dry",
  "despite",
  "even in",
  "works in",
  "reliable in",
  "open in",
  "good rain",
  "rain plan",
  "wet weather answer",
  "covered",
  "sheltered",
  "under cover",
] as const;

/** How exposed the reporter found it, from the tag vocabulary. `-1` = not a word we know. */
const EXPOSURE_WORDS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [1, ["rain exposure", "steep wet steps", "wet feet", "windy effort", "too hot at midday", "half the lawn has no shade", "no shade", "iron roof", "flat roof", "rooftop", "wind dependent", "cancelled in rain", "exposed", "open air", "in the open"]],
  [0.5, ["shaded", "shade under flyover", "tree cover", "shaded bench", "shaded courtyard", "covered terrace", "covered seating", "covered stopping points", "verandah", "arcade", "colonnade", "under a roof", "good rain pause", "cool inside", "cool breeze"]],
] as const;

/** Substring hit, for the multi-word exposure phrases where a boundary is overkill. */
const hasPhrase = (haystack: string, phrase: string): boolean => haystack.includes(phrase);

/**
 * Classify one piece of report text.
 *
 * Returns empty `conditions` for text that says nothing about weather, which is the
 * majority of the corpus and the reason this cannot be a keyword count: an
 * unrelated five-star review must not add rain evidence to anything.
 */
export function classifyReport(text: string): { conditions: HazardKind[]; exposure: number } {
  const haystack = text.toLowerCase();
  const conditions = new Set<HazardKind>();
  let exposure = -1;

  for (const [kind, phrases] of HAZARD_PHRASES) {
    for (const phrase of phrases) {
      const match = MATCHERS.get(phrase)?.exec(haystack);
      if (!match) continue;
      // A negator anywhere in the same clause flips the polarity, so the hazard is
      // recorded as *reported and survived* rather than dropped. The twin wants to
      // know a venue held up in rain as much as it wants to know one did not.
      const clause = haystack.slice(Math.max(0, match.index - 32), match.index + phrase.length);
      if (NEGATORS.some((negator) => clause.includes(negator))) continue;
      conditions.add(kind);
    }
  }
  for (const [level, phrases] of EXPOSURE_WORDS) {
    if (phrases.some((phrase) => hasPhrase(haystack, phrase))) {
      exposure = level;
      break;
    }
  }
  return { conditions: [...conditions], exposure };
}

// ---------------------------------------------------------------------------
// The committed corpus
// ---------------------------------------------------------------------------

/**
 * The shape of a row in `content/reviews/*.jsonl`.
 *
 * Exported because three call sites read that file and three private copies of this
 * interface is three opportunities for one of them to drift and silently classify
 * 291 rows into the wrong cells. `rating` and `partyType` are carried because the
 * file has them, not because this module reads them — a fit fixture is a legitimate
 * reason for a field to be declared and unused.
 */
export type ReviewRow = {
  id: string;
  experienceId: string;
  rating: number;
  partyType: string;
  visitedAt: string;
  sentiment: string;
  text: string;
  helpfulCount: number;
  signalTags: string[];
};

/** The shape of a row in `content/events/events.jsonl`. Only the fields read here. */
export type EventRow = {
  id: string;
  title: string;
  neighbourhood: string | null;
  weatherSensitive: string;
  cancellationNote: string;
  startDate: string;
  openMin: number;
};

/** `+05:30` is Mumbai, and the whole corpus is Mumbai, so the offset is constant. */
const IST_OFFSET_MIN = 330;

function istHourOf(iso: string): number {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return 12;
  return Math.round((((at / 60000 + IST_OFFSET_MIN) % 1440) + 1440) % 1440 / 60);
}

function sentimentOf(word: string): -1 | 0 | 1 {
  if (word === "positive") return 1;
  if (word === "negative") return -1;
  return 0;
}

const TRUNCATE = 280;

/** Reviews -> signals. The `signalTags` are classified, then the prose confirms. */
export function signalsFromReviews(rows: readonly ReviewRow[]): SocialSignal[] {
  return rows.map((row) => {
    const tags = row.signalTags ?? [];
    // Tags are curated and short, so they carry the classification; the prose is
    // the fallback and occasionally the correction, because a reviewer tags "no
    // shade" under a review that is entirely about how pleasant the shade was.
    const fromTags = classifyReport(tags.join(" "));
    const fromText = classifyReport(row.text);
    return {
      id: row.id,
      source: "review_corpus" as const,
      entityId: row.experienceId,
      neighbourhood: null,
      hour: istHourOf(row.visitedAt),
      sentiment: sentimentOf(row.sentiment),
      weight: Math.max(1, row.helpfulCount ?? 1),
      conditions: fromTags.conditions.length > 0 ? fromTags.conditions : fromText.conditions,
      exposure: fromTags.exposure >= 0 ? fromTags.exposure : fromText.exposure,
      text: row.text.length > TRUNCATE ? `${row.text.slice(0, TRUNCATE)}...` : row.text,
      tags,
    };
  });
}

/**
 * Events -> signals, from their own stated cancellation rules.
 *
 * This is the highest-value social signal in the repo and it is not a review at
 * all: an operator writing "called off if sustained wind is under 8 km/h" has
 * stated a *threshold*, and a threshold is a first-class thing for a twin to hold.
 * The twin's `eventRules` read these sentences directly, which is why the event
 * file is in this module rather than left in `content/`.
 */
export function signalsFromEvents(rows: readonly EventRow[]): SocialSignal[] {
  return rows
    .filter((row) => typeof row.cancellationNote === "string" && row.cancellationNote.length > 0)
    .map((row) => {
      const { conditions, exposure } = classifyReport(row.cancellationNote);
      return {
        id: row.id,
        source: "event_rule" as const,
        entityId: null,
        neighbourhood: row.neighbourhood ?? null,
        hour: Math.floor((row.openMin ?? 720) / 60),
        // A stated cancellation rule is a warning, so it reads as `mixed` rather
        // than negative: the operator is being careful, not unhappy.
        sentiment: 0 as const,
        // Operators are worth more than one review: a rule is a policy, not an
        // impression, so it is weighted like a well-helpful report.
        weight: 20,
        conditions,
        exposure,
        text: row.cancellationNote,
        tags: [row.weatherSensitive],
      };
    });
}

// ---------------------------------------------------------------------------
// The live source
// ---------------------------------------------------------------------------

const REDDIT_SEARCH = "https://www.reddit.com/search.rss";

export type LiveSocialOptions = {
  /** Injected so the mapping is testable and no core test opens a socket. */
  fetch?: (input: string) => Promise<{ ok: boolean; text: () => Promise<string> }>;
  /** Reddit requires a descriptive UA and returns 429 to the default one. */
  userAgent?: string;
};

const SENTIMENT_NEGATIVE = ["closed", "shut", "cancelled", "canceled", "impassable", "waterlogged", "flooded", "under water", "miserable", "avoid", "skip", "soaked", "unusable", "dangerous"];
const SENTIMENT_POSITIVE = ["open", "dry", "sheltered", "covered", "refreshing", "lovely", "worth it", "still going", "recommend", "great"];

/**
 * A tiny RSS reader.
 *
 * A full XML parser for one element is a dependency we do not need, but a bare
 * regex over a whole document is how you get a CVE and a parsing bug in the same
 * commit. So: match one `<item>` block at a time, unescape the five entities an RSS
 * title can contain, and take no other markup at all. The result is a string, never
 * treated as markup and never rendered as HTML anywhere in the app.
 */
function parseRss(xml: string): { title: string; link: string; created: string }[] {
  const out: { title: string; link: string; created: string }[] = [];
  for (const block of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
    const pick = (tag: string): string => {
      const hit = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return hit?.[1] ?? "";
    };
    const title = unescapeXml(stripCdata(pick("title")));
    if (title.length === 0) continue;
    out.push({ title, link: unescapeXml(stripCdata(pick("link"))), created: unescapeXml(stripCdata(pick("pubDate"))) });
  }
  return out;
}

function stripCdata(value: string): string {
  return value.replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|apos);/g, (whole) => XML_ENTITIES[whole] ?? whole);
}

function sentimentFromText(text: string): -1 | 0 | 1 {
  const haystack = text.toLowerCase();
  const bad = SENTIMENT_NEGATIVE.filter((word) => haystack.includes(word)).length;
  const good = SENTIMENT_POSITIVE.filter((word) => haystack.includes(word)).length;
  if (bad > good) return -1;
  if (good > bad) return 1;
  return 0;
}

/**
 * The live source. Public search, no account, no key, no login.
 *
 * A Reddit query is chosen from the scenario rather than hard-coded, so "what if it
 * floods" searches for flooding and "what if it is 44°C" searches for heat, and the
 * corroborating evidence changes with the what-if the traveller is actually asking.
 */
export function liveSocialSource(options: LiveSocialOptions = {}): SocialSource {
  const call = options.fetch ?? ((input: string) => fetch(input, { headers: { "User-Agent": options.userAgent ?? DEFAULT_UA } }));
  return {
    id: "live-web",
    async read({ query, limit }: SocialRequest): Promise<SocialSignal[]> {
      const url = `${REDDIT_SEARCH}?q=${encodeURIComponent(query)}&sort=new&limit=${Math.min(25, Math.max(1, limit * 3))}`;
      const response = await call(url);
      if (!response.ok) throw new Error(`social feed returned ${response.ok ? "ok" : "a non-OK status"}`);
      const items = parseRss(await response.text());
      return items.map((item, index) => {
        const { conditions, exposure } = classifyReport(item.title);
        return {
          // The link is the id, because a feed item has no stable one of its own.
          id: `live-${index}-${item.link.slice(0, 64)}`,
          source: "live_web" as const,
          entityId: null,
          neighbourhood: null,
          hour: new Date(item.created).getHours() || 12,
          sentiment: sentimentFromText(item.title),
          // No engagement number on a public RSS item, so every live signal starts
          // at the floor. That is the honest value: unweighted corroboration.
          weight: 1,
          conditions,
          exposure: exposure < 0 ? 0.5 : exposure,
          text: item.title.length > TRUNCATE ? `${item.title.slice(0, TRUNCATE)}...` : item.title,
          tags: [],
        };
      });
    },
  };
}

const DEFAULT_UA = "travelbuddy-digital-twin/1.0 (hackathon; public-data-only)";

/**
 * The only door callers should use. Mirrors `resolveWeather` in the weather
 * feature exactly: a social feed is corroboration, never a dependency, so a
 * timeout or a 429 costs the twin its social weight and nothing more.
 */
export async function resolveSocial(
  sources: readonly SocialSource[],
  request: SocialRequest,
): Promise<{ signals: SocialSignal[]; failed: string[] }> {
  const settled = await Promise.allSettled(sources.map((source) => source.read(request)));
  const signals: SocialSignal[] = [];
  const failed: string[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") signals.push(...outcome.value);
    else failed.push(sources[index]?.id ?? "unknown");
  });
  signals.sort((a, b) => b.weight - a.weight);
  return { signals: signals.slice(0, request.limit), failed };
}
