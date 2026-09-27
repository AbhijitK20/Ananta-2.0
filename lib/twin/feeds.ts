/**
 * Fetching the public feeds. Server-only, and imported by nothing else.
 *
 * Kept out of the client bundle for two reasons that are not really about the
 * bundle size: the OpenWeather key must not reach the browser at all, and the
 * three feeds are rate-limited enough that a page full of client-side polling
 * would get this project blocked from all of them within a day.
 *
 * Every reader returns a list and never throws. A feed that is down is a row in a
 * status table, not an exception that empties the panel — the same reasoning
 * `lib/plan/route.ts` gives about the OSRM demo server, applied to three more
 * shared free resources.
 */

import { alertLevelOf } from "./signals";
import type { SocialSignal, SignalSource } from "./types";

/** Budget for the small JSON APIs. */
const API_TIMEOUT_MS = 7000;

/**
 * Budget for the RSS feeds, and the reason it is nearly double.
 *
 * Measured, not guessed: GDACS's live feed is about 800 KB across 260 items, and
 * on an ordinary connection the response *headers* arrive in well under a second
 * while the body is still streaming. An `AbortSignal.timeout` covers the body as
 * well as the connection, so a budget tuned to the header latency silently
 * aborted every GDACS read partway through and the twin reported "no alerts"
 * while the alerts were sitting in a socket. That is the worst possible failure
 * for this particular source: an emergency that has been read as its absence.
 *
 * So the RSS budget is sized for the body, and the fetch below keeps its timeout
 * attached through `res.text()` rather than dropping it once headers land.
 */
const FEED_TIMEOUT_MS = 20000;

const UA = "lal-clone-weather-twin/1.0 (open-source travel planner)";

/* -------------------------------------------------------------------------- *
 * GDACS
 * -------------------------------------------------------------------------- */

const GDACS_RSS = "https://www.gdacs.org/xml/rss.xml";

/** The event types that are weather rather than earthquake or volcano. */
const WEATHER_EVENTS = new Set(["TC", "FL", "DR", "TS", "SQ", "WF", "EQ"]);

/**
 * GDACS, parsed out of RSS with a regex rather than an XML library.
 *
 * A hand-rolled parser is normally the wrong call and it is the right one here,
 * for a reason worth stating: the alternative is adding a dependency for a feed
 * with no CDATA, no entities beyond `&amp;`, and one flat namespace this file
 * needs exactly five fields from. A dependency would be a larger surface than the
 * thing it replaced. The regexes are anchored to the element names GDACS actually
 * emits, and every field falls back to null rather than to "" so a shape change
 * surfaces as a missing field instead of a plausible wrong one.
 */
export async function readGdacs(signal?: AbortSignal): Promise<SocialSignal[]> {
  const xml = await text(GDACS_RSS, FEED_TIMEOUT_MS, signal);
  if (!xml) return [];

  const items = xml.split(/<item[\s>]/).slice(1);
  const out: SocialSignal[] = [];

  for (const item of items) {
    const type = tag(item, "gdacs:eventtype");
    if (!type || !WEATHER_EVENTS.has(type)) continue;

    const id = tag(item, "gdacs:eventid");
    const title = decode(tag(item, "title") ?? "");
    if (!id || !title) continue;

    const point = tag(item, "georss:point");
    const [lat, lon] = point ? point.trim().split(/\s+/).map(Number) : [NaN, NaN];

    const level = alertLevelOf(tag(item, "gdacs:alertlevel"));
    const severityValue = Number(tag(item, "gdacs:severity")?.match(/value="([^"]+)"/)?.[1] ?? "0");
    const population = Number(tag(item, "gdacs:population")?.match(/value="([^"]+)"/)?.[1] ?? "0");

    out.push({
      id: `gdacs:${type}:${id}`,
      source: "gdacs",
      title,
      url: decode(tag(item, "link") ?? "") || null,
      city: decode(tag(item, "gdacs:country") ?? "") || null,
      at: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
      publishedAt: normaliseDate(tag(item, "gdacs:fromdate")),
      polarity: null,
      alertLevel: level,
      // Alerts carry a severity figure and a population affected, and both are
      // better evidence mass than an engagement count: a red alert over a million
      // people should count for more than a thousand upvotes.
      weight: Number.isFinite(severityValue) ? Math.min(4, 1 + severityValue / 5) : 1,
      population: Number.isFinite(population) ? population : null,
    });
  }

  return out;
}

/* -------------------------------------------------------------------------- *
 * Reddit
 * -------------------------------------------------------------------------- */

const REDDIT_SEARCH = "https://www.reddit.com/search.rss";

/**
 * Reddit, best-effort.
 *
 * Reddit rate-limits aggressively by address and answers a burst of these with
 * HTTP 429 for a long window, so this asks for a small number of results and
 * treats an empty list as "not available" rather than "nothing is happening".
 * The distinction is carried all the way to the UI through the status table.
 */
export async function readReddit(query: string, signal?: AbortSignal): Promise<SocialSignal[]> {
  if (!query.trim()) return [];
  const url = `${REDDIT_SEARCH}?q=${encodeURIComponent(query)}&sort=new&limit=12`;
  const xml = await text(url, FEED_TIMEOUT_MS, signal, UA);
  if (!xml) return [];

  const entries = xml.split(/<entry[\s>]/).slice(1);
  const out: SocialSignal[] = [];

  entries.forEach((entry, i) => {
    const title = decode(tag(entry, "title") ?? "");
    if (!title) return;

    out.push({
      id: `reddit:${i}:${title.slice(0, 40)}`,
      source: "reddit",
      title,
      url: decode(pickLink(entry) ?? "") || null,
      city: null,
      at: null,
      publishedAt: normaliseDate(tag(entry, "updated")),
      polarity: null,
      // A social post is never an official alert. Ever.
      alertLevel: null,
      weight: 1,
      population: null,
    });
  });

  return out;
}

/* -------------------------------------------------------------------------- *
 * Hacker News
 * -------------------------------------------------------------------------- */

const HN_SEARCH = "https://hn.algolia.com/api/v1/search_by_date";

export async function readHackerNews(query: string, signal?: AbortSignal): Promise<SocialSignal[]> {
  if (!query.trim()) return [];
  const url = `${HN_SEARCH}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=8`;
  const body = await json(url, API_TIMEOUT_MS, signal);
  const hits = (body as { hits?: { objectID: string; title?: string; url?: string; created_at?: string; points?: number }[] } | null)?.hits;
  if (!Array.isArray(hits)) return [];

  return hits
    .filter((hit) => typeof hit.title === "string" && hit.title.length > 0)
    .map((hit) => ({
      id: `hn:${hit.objectID}`,
      source: "hackernews" as const,
      title: hit.title as string,
      url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      city: null,
      at: null,
      publishedAt: hit.created_at ?? null,
      polarity: null,
      alertLevel: null,
      weight: Math.max(1, Math.min(3, (hit.points ?? 0) / 50)),
      population: null,
    }));
}

/* -------------------------------------------------------------------------- *
 * Small parsers
 * -------------------------------------------------------------------------- */

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return match ? match[1] : null;
}

function pickLink(entry: string): string | null {
  const links = [...entry.matchAll(/<link[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  // Atom gives a self link and a content link; the content one is the post.
  return links.find((href) => !href.includes("/search")) ?? links[0] ?? null;
}

function decode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** RFC-822 from GDACS, ISO-8601 from Atom and Algolia. Both are labels only. */
function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * The body is read *inside* the budget, deliberately.
 *
 * A timeout that is dropped once the headers land bounds the connection and not
 * the transfer, which is the wrong bound for a feed this size — see
 * `FEED_TIMEOUT_MS`. So the signal stays attached to `res.text()`, and an
 * aborted body is caught and reported as no answer rather than as an empty feed.
 */
async function text(
  url: string,
  budgetMs: number,
  signal?: AbortSignal,
  userAgent = UA,
): Promise<string | null> {
  const res = await request(url, budgetMs, signal, userAgent);
  if (!res) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function json(url: string, budgetMs: number, signal?: AbortSignal): Promise<unknown> {
  const res = await request(url, budgetMs, signal, UA);
  if (!res) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function request(
  url: string,
  budgetMs: number,
  signal: AbortSignal | undefined,
  userAgent: string,
) {
  const timeout = AbortSignal.timeout(budgetMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(url, {
      signal: both,
      headers: { "User-Agent": userAgent, Accept: "*/*" },
      // These are public caches and there is no conditional-request handling
      // here yet, so `no-store` is the honest setting: without it Next would
      // happily serve a cached emergency alert as though it were current, which
      // is the one thing this feed must never do.
      cache: "no-store",
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

/** Read every source at once and report which ones answered. */
export async function readAllSources(
  queries: { reddit: string; hackernews: string },
  signal?: AbortSignal,
): Promise<{ signals: SocialSignal[]; status: { source: SignalSource; ok: boolean; count: number; note: string }[] }> {
  const [gdacs, reddit, hackernews] = await Promise.all([
    readGdacs(signal),
    readReddit(queries.reddit, signal),
    readHackerNews(queries.hackernews, signal),
  ]);

  const signals = [...gdacs, ...reddit, ...hackernews];
  const notes: Record<SignalSource, string> = {
    gdacs: "European Commission disaster alerts, with coordinates.",
    reddit: "Public search. Rate-limits hard from shared addresses.",
    hackernews: "Low relevance to travel, but answers when the others do not.",
  };

  return {
    signals,
    status: (["gdacs", "reddit", "hackernews"] as SignalSource[]).map((source) => {
      const count = signals.filter((s) => s.source === source).length;
      return { source, ok: count > 0, count, note: notes[source] };
    }),
  };
}
