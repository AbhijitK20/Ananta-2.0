/**
 * Migrations. Hand-rolled and ordered, not a migration library.
 *
 * Why hand-rolled: we have 3 tables, a one-week build, and 250 seed rows. A
 * migration framework would be more moving parts than the thing it manages. The
 * contract is instead:
 *   - `migrations` table records which versions have run
 *   - each migration is idempotent (IF NOT EXISTS) so a half-applied run repairs
 *     itself rather than wedging the seed
 *   - NEVER edit a shipped migration. Append a new one.
 *
 * FTS5 lives here rather than in schema.ts because Drizzle's sqlite-core has no
 * first-class virtual-table support; the virtual table and its triggers are raw
 * DDL, so they belong with the other raw DDL.
 */

import type { DatabaseSync } from "node:sqlite";
import type { CityManifest } from "../contracts";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "catalogue",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS experience (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          city TEXT NOT NULL DEFAULT 'Mumbai',
          neighbourhood TEXT,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          duration_min INTEGER NOT NULL CHECK (duration_min > 0),
          price_minor INTEGER,
          price_currency TEXT,
          capacity INTEGER,
          indoor_outdoor TEXT NOT NULL,
          kid_friendly INTEGER,
          min_age INTEGER,
          hours_raw TEXT,
          hours_status TEXT NOT NULL DEFAULT 'absent',
          hours_last_verified TEXT,
          rating_value REAL NOT NULL,
          rating_count INTEGER NOT NULL DEFAULT 0,
          rating_raw_mean REAL,
          acc_step_free INTEGER,
          acc_stroller_ok INTEGER,
          acc_low_stairs INTEGER,
          acc_hearing_loop INTEGER,
          acc_seating_available INTEGER,
          acc_restroom_on_site INTEGER,
          requires_journey INTEGER NOT NULL DEFAULT 0,
          weather_sensitive TEXT NOT NULL DEFAULT 'none',
          blurb TEXT,
          description TEXT,
          diets TEXT NOT NULL DEFAULT '[]',
          cuisines TEXT NOT NULL DEFAULT '[]',
          keywords TEXT NOT NULL DEFAULT '[]',
          best_months TEXT NOT NULL DEFAULT '[]',
          best_time_of_day TEXT NOT NULL DEFAULT '[]',
          perception TEXT NOT NULL DEFAULT '{"landscape":[],"activities":[],"atmosphere":[]}',
          booking TEXT NOT NULL DEFAULT '{"required":false,"leadTimeMin":0,"walkIn":true}',
          provenance TEXT NOT NULL DEFAULT '{}',
          provider_id TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_experience_geo_category
          ON experience (lat, lon, category);
        CREATE INDEX IF NOT EXISTS idx_experience_neighbourhood
          ON experience (city, neighbourhood);
        CREATE INDEX IF NOT EXISTS idx_experience_duration
          ON experience (duration_min);
        CREATE INDEX IF NOT EXISTS idx_experience_price
          ON experience (price_minor);
        CREATE INDEX IF NOT EXISTS idx_experience_category
          ON experience (category);

        CREATE TABLE IF NOT EXISTS experience_open_interval (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          experience_id TEXT NOT NULL REFERENCES experience(id) ON DELETE CASCADE,
          weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
          start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
          end_min INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440)
        );
        CREATE INDEX IF NOT EXISTS idx_open_interval_lookup
          ON experience_open_interval (experience_id, weekday);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_open_interval
          ON experience_open_interval (experience_id, weekday, start_min, end_min);

        CREATE TABLE IF NOT EXISTS harvest_run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          city TEXT NOT NULL,
          bbox TEXT NOT NULL,
          query_hash TEXT NOT NULL UNIQUE,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status TEXT NOT NULL,
          mirror_used TEXT,
          element_count INTEGER NOT NULL DEFAULT 0,
          note TEXT
        );
      `);
    },
  },
  {
    version: 2,
    name: "fts5_search_index",
    up(db) {
      // If a previous version of this migration created the table without the
      // current column list, drop and rebuild. The index is derived data, so
      // rebuilding it is always safe — the base table is the source of truth.
      const existing = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='experience_fts'`)
        .get() as { sql?: string } | undefined;
      if (existing?.sql && !existing.sql.includes("experience_id")) {
        db.exec(`DROP TABLE IF EXISTS experience_fts;`);
      }

      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS experience_fts USING fts5(
          name,
          neighbourhood,
          blurb,
          description,
          keywords,
          cuisines,
          category UNINDEXED,
          experience_id UNINDEXED,
          tokenize = 'porter unicode61'
        );
      `);

      // Triggers keep the index in lockstep with the base table. Without these,
      // a re-seed silently leaves stale rows in the index and retrieve() returns
      // experiences that no longer exist.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS experience_fts_ai AFTER INSERT ON experience BEGIN
          INSERT INTO experience_fts(rowid, name, neighbourhood, blurb, description, keywords, cuisines, category, experience_id)
          VALUES (new.rowid, new.name, new.neighbourhood, new.blurb, new.description, new.keywords, new.cuisines, new.category, new.id);
        END;
        CREATE TRIGGER IF NOT EXISTS experience_fts_ad AFTER DELETE ON experience BEGIN
          DELETE FROM experience_fts WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS experience_fts_au AFTER UPDATE ON experience BEGIN
          DELETE FROM experience_fts WHERE rowid = old.rowid;
          INSERT INTO experience_fts(rowid, name, neighbourhood, blurb, description, keywords, cuisines, category, experience_id)
          VALUES (new.rowid, new.name, new.neighbourhood, new.blurb, new.description, new.keywords, new.cuisines, new.category, new.id);
        END;
      `);
    },
  },
  {
    version: 3,
    name: "embeddings",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS experience_embedding (
          experience_id TEXT PRIMARY KEY REFERENCES experience(id) ON DELETE CASCADE,
          dim INTEGER NOT NULL,
          vector BLOB NOT NULL,
          model TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_embedding_model ON experience_embedding (model);
      `);
    },
  },
  {
    version: 4,
    name: "city_manifest",
    up(db) {
      // The manifest is a single row per city, stored as JSON. It is read whole
      // and never queried by field, so a table with columns would buy nothing.
      db.exec(`
        CREATE TABLE IF NOT EXISTS city_manifest (
          slug TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          timezone TEXT NOT NULL,
          utc_offset_minutes INTEGER NOT NULL,
          currency TEXT NOT NULL,
          manifest_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function appliedVersions(db: DatabaseSync): number[] {
  ensureMigrationsTable(db);
  const rows = db.prepare(`SELECT version FROM migrations ORDER BY version`).all() as {
    version: number;
  }[];
  return rows.map((r) => r.version);
}

/**
 * Apply every migration newer than the highest applied one.
 * Idempotent by construction, so a crashed run leaves no half-state.
 */
export function migrate(db: DatabaseSync, manifest?: CityManifest): number {
  ensureMigrationsTable(db);
  const done = new Set(appliedVersions(db));

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    migration.up(db);
    db.prepare(`INSERT OR REPLACE INTO migrations (version, name, applied_at) VALUES (?, ?, ?)`).run(
      migration.version,
      migration.name,
      new Date().toISOString(),
    );
  }

  if (manifest) upsertManifest(db, manifest);
  return LATEST_VERSION;
}

export function upsertManifest(db: DatabaseSync, manifest: CityManifest): void {
  db.prepare(
    `INSERT INTO city_manifest (slug, display_name, timezone, utc_offset_minutes, currency, manifest_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET
       display_name = excluded.display_name,
       timezone = excluded.timezone,
       utc_offset_minutes = excluded.utc_offset_minutes,
       currency = excluded.currency,
       manifest_json = excluded.manifest_json,
       updated_at = excluded.updated_at`,
  ).run(
    manifest.slug,
    manifest.displayName,
    manifest.timezone,
    utcOffsetMinutesFor(manifest.timezone),
    manifest.currency,
    JSON.stringify(manifest),
    new Date().toISOString(),
  );
}

function utcOffsetMinutesFor(timezone: string): number {
  // Only Mumbai in v1. India has had no DST since 1945, so a constant is
  // correct here and avoids shipping a tz-database dependency.
  if (timezone === "Asia/Kolkata") return 330;
  throw new Error(
    `No UTC offset known for ${timezone}. Add it to utcOffsetMinutesFor() rather than ` +
      `calling new Date().getTimezoneOffset(), which would return the SERVER's offset.`,
  );
}

export { LATEST_VERSION, MIGRATIONS };
