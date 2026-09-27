/**
 * Photon client: polite, cached, resumable.
 *
 * ── Why Photon and not Nominatim ─────────────────────────────────────────────
 * Nominatim was tried first and is the wrong tool for this dataset, twice over.
 *
 * 1. IT ANSWERS THE WRONG QUESTION. Nominatim is a gazetteer: it ranks
 *    populated places and administrative boundaries. This dataset is 892
 *    businesses -- "Xi'an Famous Foods", "Cervejaria Ramiro" -- and Nominatim
 *    returned *zero* results for the first one. Photon is a POI geocoder
 *    backed by the same OSM extract and returned it, with the house number.
 *
 * 2. IT FAILS SILENTLY, AND THE FAILURE IS THE DANGEROUS KIND. Querying
 *    "havana cuba" returns HTTP 200 and a well-formed result whose coordinates
 *    are 22.18N 113.54E -- a street in MACAU, China, where a venue is
 *    apparently named "Havana Cuba". Macau outranked the city of Havana. There
 *    is no error, no warning, and no way to tell from the response that the
 *    answer is a different continent. A batch of those, written to disk as
 *    truth, is indistinguishable from a good batch.
 *
 * So this client is built around the assumption that a 200 is not a result. It
 * returns raw candidates and never a single "the answer"; deciding which
 * candidate is believable is the gate's job, not the transport's.
 *
 * ── Why a cache ──────────────────────────────────────────────────────────────
 * A run is 202 city lookups plus 892 place lookups. Nominatim blocked this
 * client outright after a few hundred calls, so a partial run that cannot be
 * resumed is a run that has to start over. Every response is written to
 * data/geocode-cache/ keyed by the query, so re-running resumes for free and a
 * bad query can be re-asked without re-paying for the other 893.
 *
 * ── Rate limiting ────────────────────────────────────────────────────────────
 * PHOTON_CONCURRENCY (default 3) and PHOTON_DELAY_MS (default 200) are the two
 * knobs. The defaults are deliberately unhurried: a slow nine-minute run that
 * completes is better than a fast one that gets the client banned for the rest
 * of the session, which is the failure mode already documented above.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const UA =
  process.env.GEOCODE_UA ??
  "LocalGuide/1.0 (https://github.com/AbhijitK20/Ananta-2.0)";

const ENDPOINT = process.env.PHOTON_ENDPOINT ?? "https://photon.komoot.io/api/";
const CACHE_DIR = process.env.GEOCODE_CACHE ?? "data/geocode-cache";

const CONCURRENCY = int(process.env.PHOTON_CONCURRENCY, 3);
const DELAY_MS = int(process.env.PHOTON_DELAY_MS, 200);
const ATTEMPTS = int(process.env.PHOTON_ATTEMPTS, 4);
const TIMEOUT_MS = int(process.env.PHOTON_TIMEOUT_MS, 15_000);

function int(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Cache key over the *whole* request, not just the free-text query.
 *
 * Two lookups can share a `q` and want different answers: "paris" as a city
 * needs `osm_tag=place:city`, the same string as a neighbourhood does not.
 * Keying on `q` alone would let the first one poison the second, and the
 * failure would be invisible because the response is a well-formed array of
 * the wrong thing.
 */
function key(params) {
  const stable = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha256").update(ENDPOINT + "?" + stable).digest("hex").slice(0, 32);
}

let hits = 0;
let misses = 0;
export const stats = () => ({ hits, misses, requests: hits + misses });

async function cachePath(params) {
  return join(CACHE_DIR, `${key(params)}.json`);
}

async function readCache(params) {
  try {
    const raw = await readFile(await cachePath(params), "utf8");
    hits++;
    return { ...JSON.parse(raw), _fromCache: true };
  } catch {
    misses++;
    return null;
  }
}

async function writeCache(params, body) {
  const p = await cachePath(params);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(body));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Backoff is long on 429 because that status means "you are asking too much",
 * and retrying straight away extends the ban -- the same rule the OSM harvest
 * script learned the hard way. Transport errors back off exponentially.
 */
function backoffFor(status, attempt) {
  if (status === 429) return 15_000 * attempt;
  if (status >= 500) return 1_200 * 2 ** attempt;
  return 400 * attempt;
}

async function once(params) {
  const url = new URL(ENDPOINT);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt === ATTEMPTS) throw new Error(`transport: ${err.message}`);
      await sleep(backoffFor(0, attempt));
      continue;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt === ATTEMPTS) throw new Error(`HTTP ${res.status} after ${ATTEMPTS}`);
      await sleep(backoffFor(res.status, attempt));
      continue;
    }
    if (!res.ok) {
      // 4xx other than 429 will not fix itself. Surface it instead of retrying
      // four times against a query the service has already rejected.
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  }
  throw new Error("unreachable");
}

/**
 * @returns {Promise<{features: Array, _fromCache?: boolean}>}
 */
export async function lookup(params) {
  const cached = await readCache(params);
  if (cached) return cached;

  const body = await once(params);
  // Guard the cache against a shape we do not understand. Caching `{}` or an
  // error page would make a transient outage permanent for the whole dataset.
  if (!body || !Array.isArray(body.features)) {
    throw new Error("unexpected response shape (no features[])");
  }
  await writeCache(params, body);
  await sleep(DELAY_MS);
  return { ...body, _fromCache: false };
}

/**
 * Map with a bounded worker pool, preserving input order in the output.
 *
 * Sequential would be simpler and is what a polite client should default to,
 * but 1,094 sequential round-trips at 200ms of enforced spacing is 22 minutes
 * of mostly waiting. Three in flight keeps it under ten without behaving like
 * a scraper.
 */
export async function mapLimit(items, fn, concurrency = CONCURRENCY) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Distance in kilometres. Haversine, so no geometry dependency. */
export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export { DELAY_MS, CONCURRENCY };
