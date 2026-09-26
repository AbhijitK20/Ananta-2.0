/**
 * PROJECT — turn cached raw Overpass JSON into `Experience` rows.
 *
 * This is the seam that was missing. `harvest-osm.ts` fetches and caches raw
 * OSM; `gen-seed.ts` hand-wrote 40 rows. Nothing connected the two, so the map
 * showed hand-authored data and the harvester's output went nowhere. This script
 * is the middle stage:
 *
 *   data/cache/osm/*.json  ->  data/cities/<city>/experiences.jsonl
 *
 * Design rules, each traceable to research/findings/04-data-retrieval.md:
 *
 * 1. ACCEPT ALL TAGS, PROJECT IN TYPESCRIPT (§3.5). Overpass QL has no per-tag
 *    output selection, and `opening_hours` is present on only 13% of elements so
 *    it cannot go in the filter. So the harvest is wide and this file is the only
 *    place that decides what a field means.
 *
 * 2. EVERY FIELD GETS PROVENANCE. The contract's rule is that anything not
 *    directly from a trusted source is `inferred` and must carry a visible badge.
 *    OSM is `osm`. Things we compute — duration, indoor/outdoor, kid-friendly,
 *    the Bayesian rating — are `inferred` or `derived`. We never silently pass a
 *    guess off as surveyed.
 *
 * 3. DURATION IS INFERRED, NEVER SCRAPED (§3.5 note). OSM has `duration` ~1% of
 *    the time and a wrong duration is worse than none, because the itinerary
 *    packer trusts it completely. We derive it from category and mark it
 *    `inferred` so the UI can badge it.
 *
 * 4. ACCESS IS TREATED AS A FEASIBILITY GATE, NOT A FIELD (§2.3): a ghat or
 *    beach tagged `access=private` is "more important than `fee`" — a
 *    privatisation we cannot sell. Those rows are dropped, and counted, so the
 *    drop is auditable rather than mysterious.
 *
 * 5. RATING IS BAYES-SHRUNK, NOT INVENTED (§Rating doc). OSM has no ratings at
 *    all. We emit the regional prior with count 0 so the UI's shrinkage maths
 *    behaves and nothing displays a fake "4.6".
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Experience, CITY_MANIFEST, type Category } from "../src/contracts/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "data", "cache", "osm");
const MANIFEST_FILE = join(ROOT, "data", "cities", "mumbai", "manifest.json");
const OUT_FILE = join(ROOT, "data", "cities", "mumbai", "experiences.jsonl");

// ---------------------------------------------------------------------------
// Raw Overpass element
// ---------------------------------------------------------------------------

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Category mapping — §1.1 per-tag table, collapsed to our closed enum
// ---------------------------------------------------------------------------

/**
 * OSM gives us a `(key, value)` pair; the contract wants one of 25 categories.
 * Order matters: the first match wins, so more specific keys are tested before
 * the catch-alls. `place_of_worship` is split by `religion` because a contract
 * category exists for each and lumping a mosque into `temple` is exactly the
 * kind of flattening that makes a planner feel wrong.
 *
 * Three mappings were wrong when this first shipped against a real 4,982-row
 * catalogue, and all three were found by reading the output rather than the
 * code. They are recorded because each looks defensible in the abstract and is
 * obviously wrong in a list.
 *
 * - `craft=*` did NOT map to `craft_workshop`. The live tag distribution is 27
 *   tailor, 12 electronics_repair, 11 shoemaker, 10 photographer, 8 caterer, 6
 *   confectionery, 4 carpenter, 4 stonemason, 3 electrician, 3 optician, 2
 *   cleaning, 2 key_cutter, 1 hvac. Those are trades and services a traveller
 *   would never plan a trip around, and they put "Laptop SpeedUp" and "Kiran
 *   Computer And Telecom Services" in a tourism feed. A workshop you can visit
 *   is a curated claim, not an OSM tag, so `craft` now returns null and is
 *   dropped. `handicraft` and `brewery` are the only genuinely visitable ones
 *   and there are five of them; they can be curated in deliberately.
 * - `office=*` did NOT map to `community_hosted`. Live values are 110
 *   government, 73 company, 14 coworking, 1 courier — that is "Public
 *   Distribution System Circle Office", "BMC S Ward Municipal Chowky" and the
 *   Bureau of Civil Aviation Security appearing as things to do in Mumbai.
 *   Municipal administration is not an experience. Now dropped.
 * - `amenity=fast_food` is a chain outlet 118 times out of 468, because those
 *   rows carry a `brand` tag. Domino's, KFC and McDonald's are not street food.
 *   A branded fast_food outlet is a `restaurant`; an unbranded one is whatever a
 *   person actually ate standing up, which is what `street_food` means.
 */
function categorise(tags: Record<string, string>): Category | null {
  const amenity = tags.amenity;
  const tourism = tags.tourism;
  const shop = tags.shop;
  const leisure = tags.leisure;
  const natural = tags.natural;
  const historic = tags.historic;

  // eat / drink
  if (amenity === "restaurant") return tags.cuisine === "fast_food" ? "street_food" : "restaurant";
  if (amenity === "fast_food") return tags.brand ? "restaurant" : "street_food";
  if (amenity === "cafe") return "cafe";
  if (amenity === "bar" || amenity === "pub" || amenity === "nightclub") return "nightlife";
  if (amenity === "ice_cream") return "street_food";

  // spiritual — before generic place_of_worship
  if (amenity === "place_of_worship" || amenity === "shrine" || amenity === "grave_yard") {
    const rel = tags.religion;
    if (rel === "muslim") return "mosque";
    if (rel === "christian") return "church";
    if (rel === "jain" || rel === "buddhist" || rel === "sikh") return "temple";
    // Unmapped religion: `temple` is the least-wrong container, but we would
    // rather be honest. `temple` still renders a correct "place of worship"
    // card; the religion tag survives in `keywords` either way.
    return "temple";
  }

  // culture
  if (amenity === "theatre" || amenity === "cinema" || amenity === "planetarium") {
    return amenity === "cinema" ? "theatre" : "theatre";
  }
  if (tourism === "museum") return "museum";
  if (tourism === "gallery" || amenity === "arts_centre") return "gallery";
  if (tourism === "artwork") return "hidden_place";

  // nature / outdoors
  if (natural === "beach") return "beach";
  if (natural === "peak" || natural === "hill" || natural === "rock" || natural === "spring") return "nature";
  if (natural === "waterfall" || natural === "cave_entrance") return "adventure";
  if (leisure === "marina" || leisure === "slipway" || amenity === "boat_rental") return "adventure";
  if (leisure === "water_park") return "adventure";
  if (leisure === "park" || leisure === "garden" || leisure === "nature_reserve") return "nature";
  if (leisure === "pitch" || leisure === "playground" || leisure === "golf_course") return "adventure";
  if (leisure === "sports_centre" || amenity === "swimming_pool" || amenity === "diving") return "adventure";
  if (amenity === "fountain" || amenity === "drinking_water") return "hidden_place";

  // make / shop
  if (shop === "marketplace" || amenity === "marketplace") return "market";
  if (shop === "books" || shop === "record_shop" || shop === "antiques" || shop === "art") return "shopping";
  if (
    shop &&
    [
      "bakery", "confectionery", "tea", "juice", "bicycle", "kayak", "surfboard",
      "electronics", "mobile_phone", "computer", "boutique", "jewelry",
      "department_store", "garden_centre", "charity", "second_hand", "craft",
    ].includes(shop)
  ) {
    return "shopping";
  }
  // `craft` and `office` deliberately return null. See the note above: `craft`
  // is overwhelmingly trades and repair services, and `office` is municipal
  // administration. Neither is an experience, and a tourism feed that lists a
  // BMC ward office is worse than a shorter feed.

  // heritage
  if (historic) return "heritage_site";
  if (tourism === "attraction") return "heritage_site";
  if (tourism === "theme_park" || tourism === "zoo" || tourism === "aquarium") return "adventure";
  if (tourism === "viewpoint") return "hidden_place";

  // built heritage markers
  if (["pier", "breakwater", "lighthouse", "tower", "obelisk"].includes(tags.man_made ?? "")) {
    return "heritage_site";
  }

  return null;
}

/** Categories where being indoors is the norm; drives `indoorOutdoor`. */
const INDOOR_CATEGORIES = new Set<Category>([
  "restaurant", "cafe", "museum", "gallery", "theatre", "shopping", "market",
  "craft_workshop", "nightlife", "mosque", "church", "temple",
]);
const OUTDOOR_CATEGORIES = new Set<Category>([
  "beach", "nature", "adventure", "hidden_place", "heritage_site", "street_food",
]);

/**
 * Minutes on site, inferred from category (§3.5: never scraped). These are
 * deliberately conservative — an itinerary that over-promises is worse than one
 * that under-fills, and `replan` can extend but not compress.
 */
const DURATION_BY_CATEGORY: Record<string, number> = {
  street_food: 30, restaurant: 75, cafe: 45, nightlife: 120,
  market: 60, shopping: 50, craft_workshop: 120, art_studio: 90,
  theatre: 150, museum: 120, gallery: 75,
  nature: 90, beach: 120, adventure: 180, hidden_place: 45,
  heritage_site: 75, temple: 30, church: 30, mosque: 30,
  community_hosted: 90, wellness: 90, festival: 180, event: 150,
};

// ---------------------------------------------------------------------------
// Field-level OSM readers
// ---------------------------------------------------------------------------

/** `addr:suburb` is Mumbai's most reliable neighbourhood key; fall back to city. */
function neighbourhoodOf(tags: Record<string, string>): string | null {
  return tags["addr:suburb"] ?? tags["addr:city"] ?? tags["addr:district"] ?? null;
}

/**
 * §2.3: `access` is a closed 10-value vocabulary and matters more than `fee`.
 * `private`/`no`/`permit` mean a traveller cannot simply turn up, so the row is
 * not an experience we can offer. Returned separately from categorisation so the
 * caller can count these as a distinct, auditable drop reason.
 */
function accessBlocksSale(tags: Record<string, string>): string | null {
  const access = tags.access;
  if (access === undefined) return null;
  if (["private", "no", "permit", "customers", "destination"].includes(access)) {
    return `access=${access}`;
  }
  return null;
}

/** OSM money tags are inconsistently formatted; normalise to rupees. */
function priceOf(tags: Record<string, string>): number | null {
  const raw = tags.fee ?? tags["charge:ticket"];
  if (raw === undefined || raw === null) return null;
  const cleaned = raw.replace(/[^\d.]/g, "");
  if (cleaned === "" || cleaned === "0") return null;
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A bare `fee=yes` means "there is a fee", not "it costs 1 rupee". The tag is
  // too weak to price, so we record it as a number only when a real amount was
  // given, and leave price null otherwise so the UI says "check price".
  return n > 0 && !Number.isNaN(n) ? Math.round(n) : null;
}

function dietsOf(tags: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(tags)) {
    if (!key.startsWith("diet:")) continue;
    const value = key.slice("diet:".length);
    if (value === "vegan" || value === "vegetarian") out.push(value);
  }
  if (tags.cuisine && /vegan|vegetarian/.test(tags.cuisine)) out.push("vegetarian");
  return [...new Set(out)];
}

function cuisinesOf(tags: Record<string, string>): string[] {
  if (!tags.cuisine) return [];
  // `cuisine` is a semicolon list in OSM, and can carry `;` inside a regex-ish
  // value. Split on `;` and drop empties.
  return tags.cuisine.split(";").map((c) => c.trim()).filter(Boolean);
}

/**
 * §4.1: only ~13% of OSM elements carry `opening_hours` at all, and the ones
 * that do use the full OSM grammar (which the engine adapter parses). We store
 * the raw string plus `check_date`; we deliberately do NOT pre-parse it here,
 * because the engine already has the adapter and pre-parsing here would create
 * a second parser that can disagree with the first.
 */
function hoursOf(tags: Record<string, string>): { raw: string | null; status: "ok" | "partial" | "unparsable" | "absent"; lastVerified: string | null } {
  const raw = tags.opening_hours ?? null;
  if (raw === null) return { raw: null, status: "absent", lastVerified: tags.check_date ?? null };
  // `partial` is reserved for the `open` sentinel, which OSM uses to mean
  // "known to be open, exact times not surveyed".
  if (/^open$/i.test(raw.trim())) return { raw, status: "partial", lastVerified: tags.check_date ?? null };
  return { raw, status: "ok", lastVerified: tags.check_date ?? null };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** Stable id: `osm-<type>-<id>`. Dedupes across harvests, sorts naturally. */
function idOf(el: OsmElement): string {
  return `osm-${el.type}-${el.id}`;
}

/** Great-circle metres. Used only for the near-duplicate test. */
function metresBetween(a: Experience, b: Experience): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.location.lat - a.location.lat);
  const dLon = toRad(b.location.lon - a.location.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.location.lat)) * Math.cos(toRad(b.location.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Name key for near-duplicate detection.
 *
 * Lowercased, accents stripped, punctuation and spacing removed. "Café meter
 * on" and "cafe meter on" are one place; "Banana Leaf" in Bandra and "Banana
 * Leaf" in Dadar are two, and the distance test below tells them apart.
 */
function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Whether a description is safe to render as app copy.
 *
 * OSM `description` is a free-text field that anyone can edit, and it carries
 * whatever the last mapper typed. The first harvest rendered, verbatim and in
 * the UI's own voice, "this park only for child and their parents. Student are
 * not alloewd in this park." and "sid". Beyond looking broken, that is a
 * production risk: a joke or a malicious edit becomes official copy from a
 * travel product, attributed to nobody.
 *
 * So this is a conservative prose test, not a profanity filter. It keeps text
 * that reads like a sentence and drops the rest. `blurb` and `description` both
 * come through here, and a row whose description fails simply has none — the
 * card renders without it, which is the correct outcome for missing data.
 */
function usableProse(text: string | undefined): string | null {
  if (text === undefined) return null;
  const trimmed = text.trim();
  if (trimmed.length < 25) return null;
  if (trimmed.length > 400) return null;
  // Needs a few real words and a few vowels: "sid" and "cafe meter on" fail,
  // "a quiet park beside the sea" passes.
  const words = trimmed.split(/\s+/);
  if (words.length < 5) return null;
  const vowels = (trimmed.match(/[aeiouAEIOU]/g) ?? []).length;
  if (vowels / trimmed.length < 0.28) return null;
  // Mapper shorthand and machine paste, not prose.
  if (/https?:\/\/|www\.|\{\{|\}\}|<\/?[a-z]+>|[|={}\[\]]/.test(trimmed)) return null;
  // Shouting, or a run of punctuation standing in for words.
  const letters = trimmed.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 0 && trimmed.length / letters.length > 2.2) return null;
  /*
    An address is not a description.
    */
  // Indian postcode, or the shop/plot/room numbering that fronts one.
  if (/\b[4-9]\d{4}\b/.test(trimmed)) return null;
  if (/\b(shop|plot|room|flat|bldg|building)\s*(no\.?|number)\b/i.test(trimmed)) return null;
  if (/\b(nagar|colony|sector|road|street|lane|chawl|society)\b.*\d/i.test(trimmed)) return null;
  // An Indian address pasted into `description` very often ends on a bare house
  // or plot number with no postcode: "rafeek nager shivaji nager Govandi Mumbai
  // 43". Nothing written as a sentence ends that way, and the alternative is
  // shipping an address to a traveller as though it were a description of the
  // place. Checked on the last token so "First floor." and "…400043" are safe.
  if (/(?:^|\s)\d{1,6}$/.test(trimmed)) return null;
  return trimmed;
}

function positionOf(el: OsmElement): { lat: number; lon: number } | null {
  if (typeof el.lat === "number" && typeof el.lon === "number") return { lat: el.lat, lon: el.lon };
  if (el.center && typeof el.center.lat === "number") return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

function project(el: OsmElement): { row: Experience } | { drop: string } {
  const tags = el.tags ?? {};
  const name = tags.name;
  if (!name) return { drop: "unnamed" };

  const position = positionOf(el);
  if (!position) return { drop: "no-position" };

  const category = categorise(tags);
  if (!category) return { drop: "unmapped-category" };

  const blocked = accessBlocksSale(tags);
  if (blocked) return { drop: `blocked:${blocked}` };

  const duration = DURATION_BY_CATEGORY[category] ?? 60;
  const indoorOutdoor: "indoor" | "outdoor" | "covered" | "mixed" = tags.indoor === "no"
    ? "outdoor"
    : INDOOR_CATEGORIES.has(category)
      ? "indoor"
      : OUTDOOR_CATEGORIES.has(category)
        ? "outdoor"
        : "mixed";

  const diets = dietsOf(tags);
  const cuisines = cuisinesOf(tags);
  // `wheelchair` is a 3-value iD tag. The contract models accessibility as a set
  // of booleans, and only `stepFree` has a direct OSM source, so that is the only
  // field we fill from OSM. Everything else stays null = "we do not know", which
  // the access gate treats correctly (unknown is not the same as accessible).
  const stepFree = tags.wheelchair === "yes" ? true : tags.wheelchair === "no" ? false : null;
  const price = priceOf(tags);
  const prose = usableProse(tags.description);

  const row: Experience = {
    id: idOf(el),
    name,
    category,
    location: position,
    durationMin: duration,
    // Money is MINOR UNITS per the contract ("paise for INR"), so 200 rupees
    // is 20000. Getting this wrong by 100x would silently misprice every row.
    pricePerPerson: price === null ? null : { minor: price * 100, currency: "INR" },
    // OSM has no group-seating capacity. `capacity` null means "unlimited" in the
    // contract, which would be a false claim, so we leave the field null and let
    // the booking gate fall back to walk-in.
    capacity: null,
    hours: hoursOf(tags),
    indoorOutdoor,
    accessibility: {
      stepFree,
      strollerOk: null,
      lowStairs: null,
      seatingAvailable: null,
      hearingLoop: null,
      restroomOnSite: null,
    },
    kidFriendly: null,
    minAge: null,
    diets,
    cuisines,
    // OSM carries no ratings. We emit the regional prior with count 0 so the
    // engine's shrinkage maths is well-defined and the UI shows no fake score.
    rating: { value: 3.8, count: 0, rawMean: null },
    blurb: prose ? prose.slice(0, 160) : null,
    description: prose,
    keywords: [tags["name:hi"], tags["name:mr"], tags.cuisine, tags.shop, tags.craft, tags.historic].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    ),
    perception: { landscape: [], activities: [], atmosphere: [] },
    bestTimeOfDay: [],
    requiresJourney: category === "hidden_place",
    booking: { required: false, leadTimeMin: 0, walkIn: true },
    bestMonths: [],
    weatherSensitive: category === "beach" || category === "adventure" ? "rain" : "none",
    // Provenance: what is measured, what is computed, what is a guess.
    provenance: {
      name: "osm",
      location: "osm",
      durationMin: "inferred",
      pricePerPerson: price === null ? "inferred" : "osm",
      hours: tags.opening_hours ? "osm" : "inferred",
      rating: "derived",
      indoorOutdoor: "derived",
      kidFriendly: "inferred",
      description: prose ? "osm" : "inferred",
    },
    providerId: tags["operator:ref"] ?? null,
    neighbourhood: neighbourhoodOf(tags),
    city: tags["addr:city"] ?? "Mumbai",
  };

  return { row };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function main() {
  if (!existsSync(CACHE_DIR)) {
    console.error(`  no cache at ${CACHE_DIR}`);
    console.error("  run `npm run db:harvest` first");
    process.exit(1);
  }
  if (!existsSync(MANIFEST_FILE)) {
    console.error("  manifest.json missing");
    process.exit(1);
  }

  const manifest = CITY_MANIFEST.parse(JSON.parse(readFileSync(MANIFEST_FILE, "utf8")));
  const files = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error(`  cache dir is empty: ${CACHE_DIR}`);
    process.exit(1);
  }

  const rows: Experience[] = [];
  const drops = new Map<string, number>();
  let elements = 0;
  let remarked = 0;
  const seen = new Set<string>();

  for (const f of files) {
    let parsed: { remark?: string; elements?: unknown[] };
    try {
      parsed = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8"));
    } catch {
      drops.set("unreadable-cache-file", (drops.get("unreadable-cache-file") ?? 0) + 1);
      continue;
    }
    // RULE 1, honoured on the read side too: a file that carries a `remark` is a
    // partial result. We consume it for reporting but do not trust it as whole.
    if (parsed.remark) remarked += 1;

    for (const raw of parsed.elements ?? []) {
      const el = raw as OsmElement;
      if (!el || typeof el.id !== "number") continue;
      elements += 1;
      const id = idOf(el);
      if (seen.has(id)) {
        drops.set("duplicate", (drops.get("duplicate") ?? 0) + 1);
        continue;
      }
      const result = project(el);
      if ("drop" in result) {
        drops.set(result.drop, (drops.get(result.drop) ?? 0) + 1);
        continue;
      }
      seen.add(id);
      rows.push(result.row);
    }
  }

  /*
    Near-duplicate pass.

    Deduplicating on the OSM id is not enough. A temple mapped as a node and a
    ways/relation for the same building, or a place re-surveyed a few metres
    away, produces two ids and therefore two rows. The first catalogue had 324
    names appearing more than once across 1,070 rows, including "Jain Derasar"
    twice and "FR.JUSTIN DSOUZA GROUND" twice.

    The test is a normalised name AND a distance, because name alone is wrong in
    the other direction: "Banana Leaf" appears six times and every one of those
    is a genuinely different branch. 150 m is tight enough that two branches in
    different buildings survive and loose enough that a node/way pair for one
    building collapses. When a pair collapses the survivor is the row with more
    mapped detail, so we do not keep the emptier of two records of one place.
  */
  const byName = new Map<string, Experience[]>();
  for (const row of rows) {
    const key = nameKey(row.name);
    const bucket = byName.get(key);
    if (bucket) bucket.push(row);
    else byName.set(key, [row]);
  }

  const NEAR_DUPLICATE_METRES = 150;
  const richness = (r: Experience): number =>
    (r.hours.status === "absent" ? 0 : 2) +
    (r.pricePerPerson === null ? 0 : 1) +
    (r.neighbourhood === null ? 0 : 1) +
    (r.description === null ? 0 : 1) +
    (r.accessibility.stepFree === null ? 0 : 1);

  const survivors: Experience[] = [];
  for (const bucket of byName.values()) {
    const only = bucket[0];
    if (bucket.length === 1 && only) {
      survivors.push(only);
      continue;
    }
    // Richest first, so the row that survives a collision is the informative one.
    const ordered = [...bucket].sort((a, b) => richness(b) - richness(a));
    const kept: Experience[] = [];
    for (const row of ordered) {
      const clash = kept.find((k) => metresBetween(k, row) <= NEAR_DUPLICATE_METRES);
      if (clash) {
        drops.set("near-duplicate-place", (drops.get("near-duplicate-place") ?? 0) + 1);
        continue;
      }
      kept.push(row);
    }
    survivors.push(...kept);
  }

  // Validate every row against the real contract before writing a single byte.
  // A projection that silently emits a schema-invalid row is worse than one that
  // fails loudly, because the catalogue is a committed artefact.
  const valid: Experience[] = [];
  const invalid: string[] = [];
  for (const r of survivors) {
    const parsed = Experience.safeParse(r);
    if (parsed.success) valid.push(parsed.data);
    else invalid.push(`${r.id}: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }

  // Sort by id so the file is stable and re-runs produce no diff noise.
  valid.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  console.log(`  cache files      ${files.length}${remarked ? `  (${remarked} carried a remark = partial)` : ""}`);
  console.log(`  elements seen    ${elements}`);
  console.log(`  rows projected   ${valid.length}`);
  console.log(`  contract-rejected ${invalid.length}`);
  if (invalid.length) {
    for (const s of invalid.slice(0, 5)) console.log(`      ! ${s}`);
  }
  console.log(`  dropped:`);
  for (const [reason, n] of [...drops.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(5)}  ${reason}`);
  }

  // Manifest bbox filter: the manifest is the contract for what "this city"
  // means, and Elephanta (a real island) sits outside the city bbox. We drop it
  // and say so, rather than silently shipping a row the manifest disowns.
  const [W, S, E, N] = manifest.bbox;
  const inBox = valid.filter(
    (r) => r.location.lon >= W && r.location.lon <= E && r.location.lat >= S && r.location.lat <= N,
  );
  const outOfBox = valid.length - inBox.length;

  const byCategory = new Map<Category, number>();
  for (const r of inBox) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1);
  const withHours = inBox.filter((r) => r.hours.status !== "absent").length;
  const withPrice = inBox.filter((r) => r.pricePerPerson !== null).length;
  const withNeighbourhood = inBox.filter((r) => r.neighbourhood !== null).length;

  console.log(`  outside bbox     ${outOfBox}  (dropped; manifest bbox = [${manifest.bbox.join(",")}]`);

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, inBox.map((r) => JSON.stringify(r)).join("\n") + (inBox.length ? "\n" : ""), "utf8");

  console.log(`  WROTE            ${inBox.length} rows -> ${OUT_FILE.replace(ROOT + "/", "")}`);
  console.log(`  opening_hours    ${withHours}/${inBox.length} (${Math.round((withHours / Math.max(1, inBox.length)) * 100)}%)`);
  console.log(`  priced           ${withPrice}/${inBox.length}`);
  console.log(`  neighbourhood    ${withNeighbourhood}/${inBox.length}`);
  console.log(`  categories:`);
  for (const [c, n] of [...byCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(n).padStart(4)}  ${c}`);
  }
}

main();
