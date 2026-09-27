import type { NextRequest } from "next/server";

/**
 * The twin's window on the outside world.
 *
 * Everything the digital twin knows about weather and about what people are
 * saying arrives through this one route, for three reasons that are all really
 * one reason:
 *
 *  - **The key must not reach the browser.** The OpenWeather key is read from the
 *    environment here and nowhere else, so it is not in the client bundle. A
 *    `NEXT_PUBLIC_`-prefixed weather call would publish the key to anyone who
 *    opens the network tab, and OpenWeather's free tier is keyed per account, so
 *    that key would be spent by somebody else by the morning.
 *  - **The feeds rate-limit.** Reddit answers a burst from a shared address with
 *    429 for a long window. A page that polled three feeds from every client
 *    would get this project cut off from all of them within a day.
 *  - **Failure has to be reportable.** Every upstream here is a shared free
 *    service, and any of them can be down. So the response carries a per-source
 *    status and per-city errors, and the panel renders them. A route that
 *    returned a bare 500 would make an outage indistinguishable from a bug.
 *
 * The route is a *reader*. It holds no state, writes nothing, and has no memory
 * between calls — the simulation is a pure function of this response plus the
 * traveller's trip, which is what makes a what-if a what-if.
 */

import { readAllSources } from "../../../../lib/twin/feeds";
import { calibrate, PRIOR_WEIGHT } from "../../../../lib/twin/impact";
import {
  applyEvidence,
  bucketSignals,
  calibrationCount,
  type CityEvidence,
} from "../../../../lib/twin/signals";
import { buildObservation, type OwmCurrent, type OwmForecast } from "../../../../lib/twin/weather";
import type { CityObservation, SocialSignal } from "../../../../lib/twin/types";

/** A trip with more cities than this is a mis-clicked map, not a trip. */
const MAX_CITIES = 12;

/** Enough for a week of planning, which is as far as a what-if can honestly reach. */
const OWM_CACHE_SECONDS = 600;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { cities?: unknown };
  try {
    body = (await request.json()) as { cities?: unknown };
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const cities = parseCities(body.cities);
  if (!cities.length) {
    return Response.json(
      { error: "No cities to observe. Add a stop to the trip first." },
      { status: 400 },
    );
  }

  /* ---- signals, in parallel with the weather ---- */

  const placeNames = cities.map((c) => c.name).filter(Boolean);
  const query = placeNames.length ? placeNames.join(" OR ") : "weather travel storm";

  const [sources, weather] = await Promise.all([
    readAllSources({ reddit: query, hackernews: "weather storm travel flight cancelled" }),
    observeAll(cities),
  ]);

  /* ---- attach the signals that carry no place of their own ----
     GDACS alerts carry `georss:point`, so they find their city by position.
     Reddit posts and HN stories carry neither a coordinate nor a city field —
     the search *asked* about these cities, but a post that came back is not
     thereby about one of them, and treating it as though it were would put a
     stranger's bad morning in a café four hundred kilometres away.

     So they are matched by explicit mention: the city's own display name, on a
     word boundary, inside the post's own title. That is inspectable and it fails
     in the safe direction, leaving a post unattached rather than misattached.
     Names are tried longest-first, because "New York City" has to be tried
     before "York" or the shorter one eats the longer one's matches. */

  const byMention = tagByMention(sources.signals, cities);

  /* ---- build one observation per city ---- */

  const evidence = bucketSignals(
    byMention,
    cities.map((c) => ({ slug: c.slug, name: c.name, at: { lat: c.lat, lon: c.lon } })),
  );

  const raw: CityObservation[] = cities.map((city) => {
    const reading = weather.get(city.slug);
    const cityEvidence = evidence.get(city.slug);
    return buildObservation({
      city: city.slug,
      cityLabel: city.name,
      at: { lat: city.lat, lon: city.lon },
      current: reading?.current ?? null,
      forecast: reading?.forecast ?? null,
      alertFloodCm: cityEvidence?.floodCm ?? 0,
      error: reading?.error ?? null,
    });
  });

  const observations = applyEvidence(raw, evidence, calibrate);

  /* ---- only the signals that are actually about this trip ----
     GDACS publishes every emergency on the planet: 260 items on the day this
     was written, of which perhaps two are near the traveller. Shipping all of
     them would be a quarter of a megabyte of somebody else's problems, and the
     feed would then be dominated by alerts with nothing to do with the trip —
     which is how a signal feed becomes something a reader learns to skip. */

  const relevant = relevantSignals(sources.signals, evidence);

  return Response.json(
    {
      observedAt: new Date().toISOString(),
      observations,
      signals: relevant,
      status: relevantStatus(sources.status, relevant),
      calibration: {
        observations: calibrationCount(evidence),
        priorWeight: PRIOR_WEIGHT,
        cells: observations.filter((o) => o.hazards).length * 5,
      },
      weather: {
        source: "OpenWeather current conditions + 3-hour forecast",
        ok: [...weather.values()].filter((r) => r.current).length,
        failed: [...weather.values()].filter((r) => !r.current).length,
        note: "Flood depth is not a forecast field; it arrives from an alert or from your own scenario.",
      },
    },
    {
      headers: {
        // Public data, but not per-user. A short shared window is enough to keep
        // a re-render from spending a round trip, and the upstream call itself
        // carries its own cache header.
        "Cache-Control": `public, max-age=0, s-maxage=${OWM_CACHE_SECONDS}, stale-while-revalidate=${OWM_CACHE_SECONDS * 6}`,
      },
    },
  );
}

/* -------------------------------------------------------------------------- *
 * OpenWeather
 * -------------------------------------------------------------------------- */

/**
 * The key. Read from the environment so a deploy can supply its own, with the
 * hackathon key as the default so the page works on a fresh clone.
 *
 * This module is server-only — it is imported by nothing in `components/` — which
 * is the whole reason the default is safe to inline. If this file is ever imported
 * by a client component, the key becomes public and the fallback has to go.
 */
const OWM_KEY = process.env.OWM_API_KEY ?? "bf93d09b7f817eb3bc585658c8d5d5fb";

const OWM = "https://api.openweathermap.org/data/2.5";

type City = { slug: string; name: string; lat: number; lon: number };

type Reading = { current: OwmCurrent | null; forecast: OwmForecast | null; error: string | null };

async function observeAll(cities: readonly City[]): Promise<Map<string, Reading>> {
  const entries = await Promise.all(
    cities.map(async (city) => {
      const [current, forecast] = await Promise.all([
        owmJson<OwmCurrent>(`${OWM}/weather?lat=${city.lat}&lon=${city.lon}&units=metric`),
        owmJson<OwmForecast>(`${OWM}/forecast?lat=${city.lat}&lon=${city.lon}&units=metric`),
      ]);

      // A forecast that fails while the current observation succeeds is not a
      // failure of the city: the panel shows current conditions with the forecast
      // row marked unavailable, rather than blanking a city that is reporting
      // perfectly well right now.
      return [
        city.slug,
        {
          current,
          forecast,
          error: current ? null : "OpenWeather did not answer for this city.",
        } satisfies Reading,
      ] as const;
    }),
  );
  return new Map(entries);
}

async function owmJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(`${url}&appid=${OWM_KEY}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Offline, timed out, rate-limited, or a 401 from a spent key: all the same
    // to the caller, which gets a null and an honest "did not answer" row.
    return null;
  }
}

/* -------------------------------------------------------------------------- *
 * Relevance
 * -------------------------------------------------------------------------- */

/** How many of the relevant signals travel to the client. Enough to see a trend
 *  forming, few enough that the panel stays readable. */
const MAX_SIGNALS = 40;

/**
 * Give a city slug to any signal that names one of the trip's cities outright.
 *
 * Only for signals that arrived without a place of their own, so a GDACS alert
 * with a real coordinate keeps the geographic answer rather than being overridden
 * by a country name in its headline. "Bangkok" appearing in a title is weaker
 * evidence than an alert's `georss:point`, and the model is careful to treat it
 * as such: a mention only *routes* the signal to a city, it does not make the
 * signal authoritative, and the only field it can move is the report count.
 */
function tagByMention(signals: readonly SocialSignal[], cities: readonly City[]): SocialSignal[] {
  // Longest name first, so a place whose name contains another place's name is
  // tried first and cannot be shadowed by it.
  const ordered = [...cities].sort((a, b) => b.name.length - a.name.length);

  return signals.map((signal) => {
    if (signal.city || !signal.at) return signal;

    const haystack = signal.title.toLowerCase();
    for (const city of ordered) {
      if (!city.name) continue;
      if (containsWord(haystack, city.name.toLowerCase())) {
        return { ...signal, city: city.slug };
      }
    }
    return signal;
  });
}

/** A whole-word match, so "Goa" does not match "Goalkeeper" and "Lyon" does not
 *  match "Lyonnes". Accented and unaccented forms are tried both ways round,
 *  because a directory label carries diacritics ("Köln") and a social post
 *  usually does not. */
function containsWord(haystack: string, needle: string): boolean {
  const loose = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const a = loose(haystack);
  const b = loose(needle);
  const index = a.indexOf(b);
  if (index < 0) return false;
  const before = index === 0 ? " " : a[index - 1];
  const after = index + b.length >= a.length ? " " : a[index + b.length];
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * The signals that landed in a city bucket, ordered the way the feed shows them.
 *
 * The ordering lives in the client, in `SignalFeed`, so that the "which matters
 * most" judgement is inspectable in one place rather than half here and half
 * there. This function only answers the narrower question of relevance.
 */
function relevantSignals(
  signals: readonly SocialSignal[],
  evidence: ReadonlyMap<string, CityEvidence>,
): SocialSignal[] {
  const relevant: SocialSignal[] = [];
  for (const city of evidence.values()) {
    relevant.push(...city.signals);
  }
  return relevant.slice(0, MAX_SIGNALS);
}

/**
 * The per-source status, with the count of what actually travelled.
 *
 * `ok` deliberately keeps the meaning `readAllSources` gave it — did the source
 * answer at all — while `count` becomes the number that was relevant. Keeping
 * those two separate is the whole point: a source can answer perfectly and still
 * have nothing near this trip, and collapsing that into `count: 0` would tell
 * the traveller their trip is uncovered when the truth is that nothing is
 * happening near it. The note says which case it is.
 */
function relevantStatus(
  status: readonly { source: string; ok: boolean; count: number; note: string }[],
  sent: readonly SocialSignal[],
) {
  return status.map((row) => {
    const kept = sent.filter((s) => s.source === row.source).length;
    return {
      ...row,
      count: kept,
      note:
        kept === 0 && row.ok
          ? `${row.note} ${row.count} came back, none near this trip.`
          : row.note,
    };
  });
}

/* -------------------------------------------------------------------------- *
 * Input
 * -------------------------------------------------------------------------- */

/**
 * The cities to observe, validated.
 *
 * This is a public endpoint, so the input is treated as hostile: capped in count,
 * each coordinate range-checked, each name truncated, and the whole list dropped
 * if a single entry is malformed rather than partially honoured. A coordinate is
 * the only thing from the request that reaches an upstream URL, so it is the only
 * thing worth defending.
 */
function parseCities(input: unknown): City[] {
  if (!Array.isArray(input)) return [];

  const out: City[] = [];
  for (const item of input.slice(0, MAX_CITIES)) {
    if (typeof item !== "object" || item === null) continue;
    const { slug, name, lat, lon } = item as Record<string, unknown>;
    if (typeof slug !== "string" || !slug) continue;
    if (typeof lat !== "number" || typeof lon !== "number") continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    out.push({
      slug: slug.slice(0, 64),
      name: typeof name === "string" ? name.slice(0, 80) : slug.slice(0, 80),
      lat,
      lon,
    });
  }
  return out;
}

export type ObserveResponse = {
  observedAt: string;
  observations: CityObservation[];
  signals: SocialSignal[];
  status: { source: string; ok: boolean; count: number; note: string }[];
  calibration: { observations: number; priorWeight: number; cells: number };
  weather: { source: string; ok: number; failed: number; note: string };
};

export type { CityEvidence };
