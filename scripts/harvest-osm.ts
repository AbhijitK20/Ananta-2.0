/**
 * HARVEST — pull OpenStreetMap data for the city bbox into a local cache.
 *
 *   npm run db:harvest                     harvest the manifest bbox
 *   npm run db:harvest -- --bbox w,s,e,n   harvest an explicit bbox
 *   npm run db:harvest -- --dry-run        print the query, hit nothing
 *   npm run db:harvest -- --no-cache       force a live fetch
 *   npm run db:harvest -- --stat           show what is already cached
 *
 * WHY THIS SCRIPT IS CAREFUL. Four hard-won rules, each from a way a naive
 * Overpass client breaks in production:
 *
 * 1. NEVER CACHE A RESPONSE CARRYING A `remark`.
 *    Overpass signals a partial or timed-out result by adding a top-level
 *    `remark` field while STILL returning HTTP 200 and a plausible-looking
 *    `elements` array. Cache that and you have permanently poisoned the cache
 *    with a truncated city: every later run reads the same incomplete data and
 *    the gap never heals. This is the single most important rule in the file.
 *
 * 2. FAIL OVER BETWEEN MIRRORS. The public instances rate-limit, time out, and
 *    go down. A single-mirror client fails the whole harvest on a bad afternoon.
 *
 * 3. 429 AND 504 GET A 55-SECOND BACKOFF, NOT AN IMMEDIATE RETRY. Both mean
 *    "you are asking too much". Retrying straight away extends the ban. Other
 *    errors back off exponentially.
 *
 * 4. THE CACHE KEY IS THE BBOX ROUNDED TO 6 DECIMAL PLACES. Raw float bbox
 *    arithmetic produces keys that differ in the 15th digit, so the cache never
 *    hits and the rate limiter eats the quota for nothing. 6dp is about 10cm,
 *    far finer than anything Overpass filters on.
 *
 * Output is raw JSON in `data/cache/osm/`. It is NOT loaded into the catalogue
 * by this script: OSM cannot supply durationMin (1% coverage) and has no
 * ratings at all, so a scraped row cannot be packed. Harvest is for discovery
 * and for the curator's reference, not for the demo path.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CITY_MANIFEST, type CityManifest } from "../src/contracts";
import { networkTimeoutMs } from "../src/lib/env";
import { shortHash } from "../src/lib/id";
import { nowIso } from "../src/lib/time";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CACHE_DIR = join(ROOT, "data", "cache", "osm");
const MANIFEST_FILE = join(ROOT, "data", "cities", "mumbai", "manifest.json");

const flags = new Set(process.argv.slice(2));
const DRY_RUN = flags.has("--dry-run");
const NO_CACHE = flags.has("--no-cache");
const STAT_ONLY = flags.has("--stat");

/** Tried in order. Each is a full Overpass instance. */
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
] as const;

/**
 * Verbatim: Overpass asks for ~10s of work and 1GB, and punishing that is rude.
 *
 * The trailing `;` is REQUIRED and is easy to lose. Without it the interpreter
 * fails with `line 1: parse error: ';' expected`, HTTP 400. It was missing here
 * until 2026-09-26, which is why this harvester had never once completed a
 * live fetch despite having a comprehensive test suite.
 */
const OVERPASS_SETTINGS = "[out:json][timeout:180];";

/**
 * What we ask for, transcribed from research/findings/04-data-retrieval.md §3.5
 * ("The production Overpass QL template"). Three deliberate departures, all
 * verified against a live probe on 2026-09-26:
 *
 * 1. `nwr` not `node`/`way`/`relation`. The probe returned 359 elements in one
 *    Bandra West cell: 283 node, 75 way, 1 relation. A `node`-only query throws
 *    away 21% of the city, because malls, temples and market sheds are mapped as
 *    ways. `nwr` is exactly equivalent to the three statements written out by
 *    hand, and it is what the research template uses.
 *
 * 2. `["name"]` on every statement. The research calls this out explicitly: a
 *    cheap existence check "cuts our 9% nameless features at the source". A row
 *    we cannot name is not a row the map can render usefully, so we never pay to
 *    transfer it. Kept OFF the deliberately-vocabulary-free statements where
 *    the parent value already implies a real place, and off `cuisine`/`craft`
 *    hygiene queries (those select by a tag that only named places carry).
 *
 * 3. `duration` is still not requested. The original comment was right: OSM has
 *    it ~1% of the time and a wrong duration is worse than none. The projector
 *    infers it from category instead and marks it `inferred` so the UI badges it.
 *
 * `out center` gives a way's centroid as `center`, which is what we need to place
 * a polygon on the map; a bare `out body` would give only the node IDs.
 */
function selectStatements(bboxLiteral: string): string {
  return [
    // A. EAT / DRINK
    `nwr["amenity"~"^(restaurant|cafe|fast_food|bar|pub|ice_cream|food_court|biergarten)$"]["name"](${bboxLiteral});`,
    `nwr["cuisine"](${bboxLiteral});`,
    `nwr["shop"~"^(bakery|confectionery|tea|juice)$"]["name"](${bboxLiteral});`,
    // B. SEE / DO
    `nwr["tourism"~"^(attraction|museum|gallery|viewpoint|artwork|theme_park|zoo|aquarium)$"]["name"](${bboxLiteral});`,
    `nwr["historic"](${bboxLiteral});`,
    `nwr["amenity"~"^(theatre|cinema|nightclub|casino|public_bath|planetarium)$"]["name"](${bboxLiteral});`,
    `nwr["leisure"~"^(park|garden|pitch|playground|bird_park|nature_reserve|golf_course|sports_centre|marina|slipway|water_park)$"]["name"](${bboxLiteral});`,
    `nwr["natural"~"^(beach|peak|hill|waterfall|cave_entrance|rock|spring)$"]["name"](${bboxLiteral});`,
    `nwr["man_made"~"^(pier|breakwater|lighthouse|tower|obelisk)$"]["name"](${bboxLiteral});`,
    // C. MAKE / SHOP — the long tail, and the group the old query missed entirely
    // except for a lone `craft`. §2.3: "under-mapped AND under-modelled".
    `nwr["craft"](${bboxLiteral});`,
    `nwr["shop"~"^(craft|bicycle|kayak|surfboard|books|record_shop|antiques|art|charity|second_hand|electronics|mobile_phone|computer|boutique|jewelry|department_store|garden_centre)$"]["name"](${bboxLiteral});`,
    `nwr["amenity"~"^(marketplace|arts_centre|social_centre|swimming_pool|diving|boat_rental)$"]["name"](${bboxLiteral});`,
    `nwr["office"~"^(company|government|coworking|tourism)$"]["name"](${bboxLiteral});`,
    // D. SPIRITUAL / COMMUNITY — 41 place_of_worship in one Bandra cell alone,
    // so this is not a niche, it is the single densest category in the city.
    `nwr["amenity"~"^(place_of_worship|grave_yard|shrine|drinking_water|fountain|toilets)$"]["name"](${bboxLiteral});`,
    `nwr["amenity"~"^(cafe|restaurant|fast_food)$"]["cuisine"~"^(vegan|vegetarian)$"](${bboxLiteral});`,
  ].join("\n  ");
}

function buildQuery(bbox: [number, number, number, number]): string {
  // Overpass bbox order is (south, west, north, east) — the same order the
  // research template documents: "bbox order: (S, W, N, E)".
  //
  // We receive the manifest bbox in (W, S, E, N) order, which is the order
  // GeoJSON polygons and the rest of our code use, so it is transposed here at
  // the boundary. Getting this wrong is silent: the query still parses and
  // returns HTTP 200 with `elements: []`, so a transposed bbox looks exactly
  // like "this city has no restaurants". It was wrong here until 2026-09-26.
  const [W, S, E, N] = bbox;
  const literal = [S, W, N, E].map((v) => v.toFixed(6)).join(",");
  // Every select statement is unioned, then output ONCE at the end. An `out`
  // inside the union is a parse error; so is an `out` per statement, which
  // would re-emit the whole union once per statement.
  return `${OVERPASS_SETTINGS}\n(\n${selectStatements(literal)}\n);\nout center tags;\n`;
}

/** 6dp, then trailing zeros trimmed. The cache-key rule. */
export function normaliseBbox(bbox: [number, number, number, number]): string {
  return bbox
    .map((v) => {
      if (!Number.isFinite(v)) throw new Error(`bbox value ${v} is not finite`);
      return Number(v.toFixed(6)).toString();
    })
    .join(",");
}

function cacheKey(query: string): string {
  return `${createHash("sha256").update(query).digest("hex").slice(0, 16)}-${shortHash(query)}`;
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string };
  remark?: string;
  elements?: unknown[];
}

/**
 * RULE 1, as a testable function.
 *
 * Overpass signals a partial or timed-out result by adding a top-level `remark`
 * while STILL returning HTTP 200 and a plausible `elements` array. Caching that
 * permanently poisons the cache with a truncated city, and because the key is
 * content-derived every later run reads the same incomplete data and the gap
 * never heals. So this throws rather than returning, and the caller has no way
 * to accidentally persist the result.
 *
 * Exported so tests/harvest.test.ts can prove the rule without a network.
 */
export function parseOverpassResponse(body: unknown): OverpassResponse {
  if (typeof body !== "object" || body === null) {
    throw new Error("response is not a JSON object");
  }
  const candidate = body as OverpassResponse;
  if (typeof candidate.remark === "string" && candidate.remark.length > 0) {
    throw new Error(`server returned a remark: ${candidate.remark}`);
  }
  if (!Array.isArray(candidate.elements)) {
    throw new Error("response has no elements array");
  }
  return candidate;
}

class AllMirrorsFailed extends Error {
  constructor(public readonly attempts: { url: string; error: string }[]) {
    super(
      `All ${attempts.length} Overpass mirrors failed:\n` +
        attempts.map((a) => `    ${a.url}\n      ${a.error}`).join("\n"),
    );
    this.name = "AllMirrorsFailed";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 429 and 504 get the long, fixed wait. Everything else backs off exponentially. */
function backoffFor(status: number | null, attempt: number): number {
  if (status === 429 || status === 504) return 55_000;
  return Math.min(2 ** attempt * 1_000, 30_000);
}

async function fetchOnce(url: string, query: string): Promise<OverpassResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), networkTimeoutMs() + 15_000);
  try {
    const res = await fetch(`${url}?data=${encodeURIComponent(query)}`, {
      signal: controller.signal,
      headers: { "User-Agent": "TravelBuddy/0.1 (one-week prototype; contact: local)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseOverpassResponse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFailover(query: string): Promise<{ data: OverpassResponse; mirror: string }> {
  const attempts: { url: string; error: string }[] = [];
  for (let i = 0; i < MIRRORS.length; i++) {
    const url = MIRRORS[i]!;
    process.stdout.write(`    ${url} ... `);
    try {
      const data = await fetchOnce(url, query);
      console.log(`ok, ${data.elements?.length ?? 0} elements`);
      return { data, mirror: url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAILED (${message})`);
      attempts.push({ url, error: message });
      if (i < MIRRORS.length - 1) {
        const wait = backoffFor(
          /HTTP (\d+)/.exec(message)?.[1] ? Number(/HTTP (\d+)/.exec(message)![1]) : null,
          i,
        );
        console.log(`      waiting ${Math.round(wait / 1000)}s before the next mirror`);
        await sleep(wait);
      }
    }
  }
  throw new AllMirrorsFailed(attempts);
}

interface TagSummary {
  total: number;
  withName: number;
  withOpeningHours: number;
  withWheelchair: number;
  withFee: number;
  withCuisine: number;
  withWebsite: number;
  withPhone: number;
}

function summarise(elements: Record<string, unknown>[]): TagSummary {
  const s: TagSummary = {
    total: elements.length, withName: 0, withOpeningHours: 0, withWheelchair: 0,
    withFee: 0, withCuisine: 0, withWebsite: 0, withPhone: 0,
  };
  for (const el of elements) {
    const t = (el.tags ?? {}) as Record<string, string>;
    if (t.name) s.withName++;
    if (t.opening_hours) s.withOpeningHours++;
    if (t.wheelchair) s.withWheelchair++;
    if (t.fee) s.withFee++;
    if (t.cuisine) s.withCuisine++;
    if (t.website || t["contact:website"]) s.withWebsite++;
    if (t.phone || t["contact:phone"]) s.withPhone++;
  }
  return s;
}

const pct = (n: number, total: number) => (total === 0 ? "0.0" : ((n / total) * 100).toFixed(1));

function main(): void {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`  Missing ${MANIFEST_FILE}`);
    process.exit(1);
  }
  const parsed = CITY_MANIFEST.safeParse(JSON.parse(readFileSync(MANIFEST_FILE, "utf8")));
  if (!parsed.success) {
    console.error("  manifest.json is invalid");
    process.exit(1);
  }
  const manifest = parsed.data as CityManifest;

  const bboxFlag = process.argv.find((a) => a.startsWith("--bbox="));
  const bbox: [number, number, number, number] = bboxFlag
    ? (bboxFlag.slice("--bbox=".length).split(",").map(Number) as [number, number, number, number])
    : (manifest.bbox as [number, number, number, number]);

  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    console.error("  --bbox must be four numbers: west,south,east,north");
    process.exit(1);
  }
  const [w, s, e, n] = bbox;
  if (!(s < n) || !(w < e)) {
    console.error(`  bbox is not west<east and south<north: ${bbox.join(",")}`);
    process.exit(1);
  }

  const query = buildQuery(bbox);
  const key = cacheKey(query);
  const cacheFile = join(CACHE_DIR, `${key}.json`);

  console.log(`\n  city      ${manifest.displayName} (${manifest.slug})`);
  console.log(`  bbox      ${normaliseBbox(bbox)}   [W S E N]`);
  console.log(`  key       ${key}`);
  console.log(`  query     ${query.length} bytes, sha256 ${key.slice(0, 16)}`);

  if (DRY_RUN) {
    console.log("\n  --dry-run, query follows:\n");
    console.log(query);
    return;
  }

  mkdirSync(CACHE_DIR, { recursive: true });

  if (STAT_ONLY) {
    const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
    console.log(`\n  cache: ${CACHE_DIR}`);
    console.log(`  ${files.length} cached response(s)`);
    for (const f of files.sort()) {
      const st = statSync(join(CACHE_DIR, f));
      const body = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8")) as OverpassResponse;
      console.log(`    ${f}  ${body.elements?.length ?? 0} elements  ${(st.size / 1024).toFixed(0)} KB  ${st.mtime.toISOString().slice(0, 16)}`);
    }
    console.log();
    return;
  }

  if (existsSync(cacheFile) && !NO_CACHE) {
    const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as OverpassResponse;
    const elements = (cached.elements ?? []) as Record<string, unknown>[];
    console.log(`\n  cache hit (${(statSync(cacheFile).size / 1024).toFixed(0)} KB), --no-cache to refetch`);
    report(elements, cached);
    return;
  }

  console.log("\n  fetching:");
  const fromFile = process.argv.find((a) => a.startsWith("--from-file="));
  if (fromFile) {
    // Ingest a saved Overpass response. Useful for reproducing a curator's
    // capture on a machine with no route to Overpass, and it is how
    // tests/harvest.test.ts exercises the pipeline with no network at all.
    const path = fromFile.slice("--from-file=".length);
    if (!existsSync(path)) {
      console.error(`  --from-file: no such file ${path}`);
      process.exit(1);
    }
    try {
      const data = parseOverpassResponse(JSON.parse(readFileSync(path, "utf8")));
      const elements = (data.elements ?? []) as Record<string, unknown>[];
      writeFileSync(
        cacheFile,
        JSON.stringify(
          { ...data, _harvest: { mirror: `file:${path}`, fetchedAt: nowIso(), bbox: normaliseBbox(bbox), key } },
          null,
          1,
        ),
        "utf8",
      );
      console.log(`\n  ingested ${path}`);
      console.log(`  cached to ${cacheFile.replace(ROOT + "/", "")}`);
      report(elements, data);
    } catch (error) {
      console.error(`\n  refused to cache: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  void (async () => {
    try {
      const { data, mirror } = await fetchWithFailover(query);
      const elements = (data.elements ?? []) as Record<string, unknown>[];
      // Only now, after we know there is no remark, do we touch the disk.
      writeFileSync(
        cacheFile,
        JSON.stringify({ ...data, _harvest: { mirror, fetchedAt: nowIso(), bbox: normaliseBbox(bbox), key } }, null, 1),
        "utf8",
      );
      console.log(`\n  cached to ${cacheFile.replace(ROOT + "/", "")}`);
      report(elements, data);
    } catch (error) {
      if (error instanceof AllMirrorsFailed) {
        console.error(`\n  ${error.message}\n`);
        console.error("  Nothing was cached. A later run will try again from scratch.\n");
      } else {
        console.error(`\n  harvest failed: ${String(error)}\n`);
      }
      process.exitCode = 1;
    }
  })();
}

function report(elements: Record<string, unknown>[], meta: OverpassResponse): void {
  const s = summarise(elements);
  console.log(`\n  elements   ${s.total}`);
  console.log(`    name              ${s.withName} (${pct(s.withName, s.total)}%)`);
  console.log(`    opening_hours     ${s.withOpeningHours} (${pct(s.withOpeningHours, s.total)}%)`);
  console.log(`    wheelchair        ${s.withWheelchair} (${pct(s.withWheelchair, s.total)}%)`);
  console.log(`    fee               ${s.withFee} (${pct(s.withFee, s.total)}%)`);
  console.log(`    cuisine           ${s.withCuisine} (${pct(s.withCuisine, s.total)}%)`);
  console.log(`    website           ${s.withWebsite} (${pct(s.withWebsite, s.total)}%)`);
  console.log(`    phone             ${s.withPhone} (${pct(s.withPhone, s.total)}%)`);
  if (meta.osm3s?.timestamp_osm_base) {
    console.log(`\n  OSM data as of ${meta.osm3s.timestamp_osm_base}`);
  }
  console.log(`\n  Note: no durationMin and no ratings exist in OSM. A harvested row cannot be`);
  console.log(`  packed, so harvest output is for curation reference, not the demo catalogue.\n`);
}

main();
