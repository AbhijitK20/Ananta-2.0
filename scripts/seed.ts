/**
 * SEED — load the curated catalogue into SQLite and build the search index.
 *
 *   npm run db:seed            load data/cities/mumbai/experiences.jsonl
 *   npm run db:seed -- --check validate only, write nothing
 *   npm run db:seed -- --truncate wipe the catalogue first
 *
 * Design decisions worth knowing:
 *
 * 1. VALIDATION IS A HARD GATE. Every line is parsed against the frozen
 *    `Experience` contract before anything is written. A malformed row fails the
 *    whole seed with a line number, because a catalogue that loads 39 of 40 rows
 *    and prints a warning is a catalogue whose missing row gets discovered
 *    during a demo.
 *
 * 2. IDEMPOTENT BY UPSERT, NOT BY DELETE. Re-seeding updates rows in place. That
 *    keeps `updatedAt` meaningful and means a provider row added in Session 5
 *    survives a re-seed of the curated file.
 *
 * 3. OPENING HOURS ARE EXPANDED ONCE, HERE. The raw OSM expression is stored
 *    for provenance AND expanded into `experience_open_interval` so the Session 3
 *    gate is a range query instead of 250 library calls per request.
 *
 * 4. A ROW WITH UNPARSABLE HOURS IS NOT DROPPED. It loads with
 *    hoursStatus='unparsable' and no intervals. An unknown schedule is a state we
 *    surface, not a reason to hide a place from a traveller.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Experience, CITY_MANIFEST, type CityManifest } from "../src/contracts";
import { openDatabase } from "../src/db/driver";
import { intervalsForWeek, parseHours } from "../src/engine/hours";
import { MUMBAI, nowIso } from "../src/lib/time";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CITY = "mumbai";
const DATA_DIR = join(ROOT, "data", "cities", CITY);
const SEED_FILE = join(DATA_DIR, "experiences.jsonl");
const MANIFEST_FILE = join(DATA_DIR, "manifest.json");
const DB_FILE = process.env.DB_FILE ?? join(ROOT, "data", "app.db");

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const TRUNCATE = args.has("--truncate");

interface LoadedRow {
  id: string;
  name: string;
  category: string;
  neighbourhood: string | null;
  lat: number;
  lon: number;
  durationMin: number;
  priceMinor: number | null;
  priceCurrency: string | null;
  capacity: number | null;
  hoursRaw: string | null;
  hoursStatus: string;
  hoursLastVerified: string | null;
  indoorOutdoor: string;
  accStepFree: number | null;
  accStrollerOk: number | null;
  accLowStairs: number | null;
  accHearingLoop: number | null;
  accSeatingAvailable: number | null;
  accRestroomOnSite: number | null;
  kidFriendly: number | null;
  minAge: number | null;
  requiresJourney: number;
  weatherSensitive: string;
  blurb: string | null;
  description: string | null;
  diets: string;
  cuisines: string;
  keywords: string;
  bestMonths: string;
  bestTimeOfDay: string;
  perception: string;
  booking: string;
  provenance: string;
  providerId: string | null;
  ratingValue: number;
  ratingCount: number;
  ratingRawMean: number | null;
  updatedAt: string;
}

const tri = (v: boolean | null | undefined): number | null =>
  v === null || v === undefined ? null : v ? 1 : 0;

function fail(line: number, message: string, issues?: string[]): never {
  console.error(`\n  experiences.jsonl line ${line}: ${message}`);
  if (issues) for (const i of issues) console.error(`    - ${i}`);
  console.error("\n  Seed aborted. Nothing was written.\n");
  process.exit(1);
}

function loadAndValidate(): { manifest: CityManifest; rows: LoadedRow[] } {
  if (!existsSync(MANIFEST_FILE)) {
    console.error(`  Missing ${MANIFEST_FILE}`);
    process.exit(1);
  }
  const manifestParsed = CITY_MANIFEST.safeParse(JSON.parse(readFileSync(MANIFEST_FILE, "utf8")));
  if (!manifestParsed.success) {
    console.error("  manifest.json does not satisfy CITY_MANIFEST:");
    for (const i of manifestParsed.error.issues) console.error(`    - ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }
  const manifest = manifestParsed.data as CityManifest;

  if (!existsSync(SEED_FILE)) {
    console.error(`  Missing ${SEED_FILE}`);
    process.exit(1);
  }

  const lines = readFileSync(SEED_FILE, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const rows: LoadedRow[] = [];
  const seenIds = new Set<string>();
  const problems: string[] = [];

  lines.forEach((text, index) => {
    const lineNo = index + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      fail(lineNo, `not valid JSON (${(e as Error).message})`);
    }

    const parsed = Experience.safeParse(raw);
    if (!parsed.success) {
      fail(lineNo, "does not satisfy the Experience contract", parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ));
    }
    const e = parsed.data;

    if (seenIds.has(e.id)) problems.push(`line ${lineNo}: duplicate id "${e.id}"`);
    seenIds.add(e.id);

    // A curated row whose every fact is a guess is a data smell worth failing on.
    const prov = Object.values(e.provenance);
    if (prov.length === 0) problems.push(`line ${lineNo}: "${e.id}" has no provenance entries`);

    // Hours: parse once, store the raw string AND the derived status.
    const hours = parseHours(e.hours.raw);
    if (e.hours.raw !== null && hours.status === "unparsable") {
      console.warn(`  ! line ${lineNo} "${e.id}": hours unparsable, loading with status=unparsable`);
    }

    rows.push({
      id: e.id,
      name: e.name,
      category: e.category,
      neighbourhood: e.neighbourhood,
      lat: e.location.lat,
      lon: e.location.lon,
      durationMin: e.durationMin,
      priceMinor: e.pricePerPerson?.minor ?? null,
      priceCurrency: e.pricePerPerson?.currency ?? null,
      capacity: e.capacity,
      hoursRaw: hours.raw,
      hoursStatus: hours.status,
      hoursLastVerified: e.hours.lastVerified,
      indoorOutdoor: e.indoorOutdoor,
      accStepFree: tri(e.accessibility.stepFree),
      accStrollerOk: tri(e.accessibility.strollerOk),
      accLowStairs: tri(e.accessibility.lowStairs),
      accHearingLoop: tri(e.accessibility.hearingLoop),
      accSeatingAvailable: tri(e.accessibility.seatingAvailable),
      accRestroomOnSite: tri(e.accessibility.restroomOnSite),
      kidFriendly: tri(e.kidFriendly),
      minAge: e.minAge,
      requiresJourney: e.requiresJourney ? 1 : 0,
      weatherSensitive: e.weatherSensitive,
      blurb: e.blurb,
      description: e.description,
      diets: JSON.stringify(e.diets),
      cuisines: JSON.stringify(e.cuisines),
      keywords: JSON.stringify(e.keywords),
      bestMonths: JSON.stringify(e.bestMonths),
      bestTimeOfDay: JSON.stringify(e.bestTimeOfDay),
      perception: JSON.stringify(e.perception),
      booking: JSON.stringify(e.booking),
      provenance: JSON.stringify(e.provenance),
      providerId: e.providerId,
      ratingValue: e.rating.value,
      ratingCount: e.rating.count,
      ratingRawMean: e.rating.rawMean,
      updatedAt: e.id === undefined ? nowIso() : (raw as { updatedAt?: string }).updatedAt ?? nowIso(),
    });
  });

  if (problems.length > 0) {
    console.error("\n  Data problems:");
    for (const p of problems) console.error(`    - ${p}`);
    console.error("\n  Seed aborted. Nothing was written.\n");
    process.exit(1);
  }

  return { manifest, rows };
}

function main(): void {
  const { manifest, rows } = loadAndValidate();

  const free = rows.filter((r) => r.priceMinor === null || r.priceMinor === 0).length;
  const unparsable = rows.filter((r) => r.hoursStatus === "unparsable").length;
  const absent = rows.filter((r) => r.hoursStatus === "absent").length;
  const categories = new Set(rows.map((r) => r.category));
  const hoods = new Set(rows.map((r) => r.neighbourhood));

  console.log(`\n  catalogue: ${rows.length} records`);
  console.log(`    categories      ${categories.size}`);
  console.log(`    neighbourhoods  ${hoods.size}`);
  console.log(`    free / unpriced ${free}`);
  console.log(`    hours ok        ${rows.length - unparsable - absent}`);
  console.log(`    hours unparsable ${unparsable}   absent ${absent}`);

  if (CHECK_ONLY) {
    console.log("\n  --check: validation passed, nothing written.\n");
    return;
  }

  mkdirSync(dirname(DB_FILE), { recursive: true });
  const handle = openDatabase(DB_FILE, manifest);

  try {
    if (TRUNCATE) {
      handle.raw.exec("DELETE FROM experience_open_interval; DELETE FROM experience;");
      console.log("\n  --truncate: catalogue cleared");
    }

    const upsert = handle.raw.prepare(`
      INSERT INTO experience (
        id, name, category, city, neighbourhood, lat, lon, duration_min,
        price_minor, price_currency, capacity, indoor_outdoor, kid_friendly, min_age,
        hours_raw, hours_status, hours_last_verified,
        rating_value, rating_count, rating_raw_mean,
        acc_step_free, acc_stroller_ok, acc_low_stairs, acc_hearing_loop,
        acc_seating_available, acc_restroom_on_site,
        requires_journey, weather_sensitive, blurb, description,
        diets, cuisines, keywords, best_months, best_time_of_day, perception,
        booking, provenance, provider_id, updated_at
      ) VALUES (
        ?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?
      )
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, category=excluded.category, neighbourhood=excluded.neighbourhood,
        lat=excluded.lat, lon=excluded.lon, duration_min=excluded.duration_min,
        price_minor=excluded.price_minor, price_currency=excluded.price_currency,
        capacity=excluded.capacity, indoor_outdoor=excluded.indoor_outdoor,
        kid_friendly=excluded.kid_friendly, min_age=excluded.min_age,
        hours_raw=excluded.hours_raw, hours_status=excluded.hours_status,
        hours_last_verified=excluded.hours_last_verified,
        rating_value=excluded.rating_value, rating_count=excluded.rating_count,
        rating_raw_mean=excluded.rating_raw_mean,
        acc_step_free=excluded.acc_step_free, acc_stroller_ok=excluded.acc_stroller_ok,
        acc_low_stairs=excluded.acc_low_stairs, acc_hearing_loop=excluded.acc_hearing_loop,
        acc_seating_available=excluded.acc_seating_available,
        acc_restroom_on_site=excluded.acc_restroom_on_site,
        requires_journey=excluded.requires_journey, weather_sensitive=excluded.weather_sensitive,
        blurb=excluded.blurb, description=excluded.description,
        diets=excluded.diets, cuisines=excluded.cuisines, keywords=excluded.keywords,
        best_months=excluded.best_months, best_time_of_day=excluded.best_time_of_day,
        perception=excluded.perception, booking=excluded.booking,
        provenance=excluded.provenance, provider_id=excluded.provider_id,
        updated_at=excluded.updated_at
    `);

    const insertInterval = handle.raw.prepare(`
      INSERT OR IGNORE INTO experience_open_interval (experience_id, weekday, start_min, end_min)
      VALUES (?,?,?,?)
    `);

    const clearIntervals = handle.raw.prepare(
      `DELETE FROM experience_open_interval WHERE experience_id = ?`,
    );

    let intervalCount = 0;
    handle.raw.exec("BEGIN");
    try {
      for (const r of rows) {
        upsert.run(
          r.id, r.name, r.category, CITY, r.neighbourhood, r.lat, r.lon, r.durationMin,
          r.priceMinor, r.priceCurrency, r.capacity, r.indoorOutdoor, r.kidFriendly, r.minAge,
          r.hoursRaw, r.hoursStatus, r.hoursLastVerified,
          r.ratingValue, r.ratingCount, r.ratingRawMean,
          r.accStepFree, r.accStrollerOk, r.accLowStairs, r.accHearingLoop,
          r.accSeatingAvailable, r.accRestroomOnSite,
          r.requiresJourney, r.weatherSensitive, r.blurb, r.description,
          r.diets, r.cuisines, r.keywords, r.bestMonths, r.bestTimeOfDay, r.perception,
          r.booking, r.provenance, r.providerId, r.updatedAt,
        );

        // Rebuild this row's intervals. Doing it per-row (rather than a blanket
        // delete) means a partial re-seed cannot leave a row with stale hours.
        clearIntervals.run(r.id);
        const hours = parseHours(r.hoursRaw);
        for (const iv of intervalsForWeek(hours, MUMBAI)) {
          insertInterval.run(r.id, iv.weekday, iv.startMin, iv.endMin);
          intervalCount++;
        }
      }
      handle.raw.exec("COMMIT");
    } catch (e) {
      handle.raw.exec("ROLLBACK");
      throw e;
    }

    // The FTS index is maintained by triggers, but a pre-existing database from
    // before the triggers existed would be out of sync. Rebuild when the counts
    // disagree rather than trusting them.
    const inDb = (handle.raw.prepare(`SELECT COUNT(*) AS c FROM experience`).get() as { c: number }).c;
    const inIdx = (handle.raw
      .prepare(`SELECT COUNT(*) AS c FROM experience_fts`)
      .get() as { c: number }).c;

    if (inDb !== inIdx) {
      handle.raw.exec(`INSERT INTO experience_fts(experience_fts) VALUES('rebuild')`);
      console.log(`  rebuilt FTS index (was ${inIdx} rows for ${inDb} experiences)`);
    }

    const final = handle.raw
      .prepare(`SELECT COUNT(*) AS c FROM experience`)
      .get() as { c: number };
    const idx = handle.raw
      .prepare(`SELECT COUNT(*) AS c FROM experience_fts`)
      .get() as { c: number };

    console.log(`\n  seeded ${final.c} experiences, ${intervalCount} open-hour intervals`);
    console.log(`  search index: ${idx.c} rows`);
    console.log(`  database:    ${DB_FILE}\n`);
  } finally {
    handle.close();
  }
}

main();
