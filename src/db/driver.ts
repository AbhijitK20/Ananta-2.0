/**
 * Drizzle over Node's BUILT-IN `node:sqlite`.
 *
 * Why the shim: drizzle-orm 0.45.3 ships drivers for better-sqlite3, libsql,
 * bun-sqlite, durable-sqlite, expo-sqlite and op-sqlite — but NOT for
 * `node:sqlite`, which is what DECISIONS D2 committed us to. Its answer is
 * `drizzle-orm/sqlite-proxy`, which hands us every SQL string and expects rows
 * back. This file is that adapter, and it is the ONLY place in the app that
 * touches a raw driver.
 *
 * The payoff: zero native build steps. `node:sqlite` ships inside Node 24, so
 * a fresh clone runs `npm install` with no node-gyp, no prebuilds, no
 * platform-specific binaries. That is a real constraint for a three-person team
 * on a one-week build, and it is why we did not take better-sqlite3.
 *
 * Caveats of the proxy route, stated plainly:
 *   - every Drizzle call is async, even though the driver is synchronous. That
 *     is fine, our engine is async anyway, but do not expect sync queries.
 *   - transactions go through `BEGIN`/`COMMIT` on the same connection.
 */

import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema";
import type { CityManifest } from "../contracts";

export type SqlMethod = "run" | "all" | "values" | "get";

/**
 * node:sqlite returns INTEGER columns as JS numbers by default, which is what
 * we want. Booleans are stored as 0/1 and are mapped back in schema.ts's
 * column definitions rather than here, so that the mapping is visible where the
 * column is declared.
 *
 * `all` returns each row as an ARRAY OF VALUES, not as the object `node:sqlite`
 * hands back, and that is not a stylistic choice. Drizzle's sqlite-proxy maps
 * results **positionally** — `mapResultRow` in `drizzle-orm/utils.js` reads
 * `row[columnIndex]` — so an object row hands every decoder `undefined`.
 *
 * A decoder that tolerates `undefined` hides this: `integer({mode:"boolean"})`
 * turns `undefined` into `false` and nobody notices. `text({mode:"json"})` calls
 * `JSON.parse(undefined)` and throws `SyntaxError: "undefined" is not valid
 * JSON`, which is how this was found — the first Drizzle `select()` in the app
 * that touched a JSON column. The catalogue was read from JSONL files, so no
 * query had gone through here with one until the assistant's tables arrived.
 *
 * `Object.values` is safe because node:sqlite builds each row object in the
 * order of the statement's result columns, which is the order Drizzle generated.
 */
export function createRemoteCallback(db: DatabaseSync) {
  return async function remote(
    sql: string,
    params: unknown[],
    method: SqlMethod,
  ): Promise<{ rows: unknown[] }> {
    const statement = db.prepare(sql);
    try {
      if (method === "run") {
        statement.run(...(params as never[]));
        return { rows: [] };
      }
      if (method === "get") {
        const row = statement.get(...(params as never[]));
        return { rows: row === undefined ? [] : [Object.values(row)] };
      }
      const rows = statement.all(...(params as never[]));
      if (method === "values") {
        return { rows: rows.map((row) => Object.values(row as Record<string, unknown>)) };
      }
      return { rows: rows.map((row) => Object.values(row as Record<string, unknown>)) };
    } finally {
      // StatementSync is cheap and the driver handles finalisation, but being
      // explicit keeps memory flat across the 40k-row harvest.
      void statement;
    }
  };
}

export function createDatabase(url: string) {
  const isMemory = url === ":memory:" || url.startsWith("file::memory:");
  const db = new DatabaseSync(url, {
    // WAL is a real durability win for the Next.js dev server, which opens the
    // same file from two places. In-memory has no file to journal.
    ...(isMemory ? {} : {}),
  });
  db.exec("PRAGMA foreign_keys = ON;");
  if (!isMemory) {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  return db;
}

export function createDrizzle(db: DatabaseSync) {
  return drizzle(createRemoteCallback(db), { schema });
}

export type Db = ReturnType<typeof createDrizzle>;
export type RawDb = DatabaseSync;

export interface DbHandle {
  raw: RawDb;
  db: Db;
  manifest: CityManifest;
  close: () => void;
}

/**
 * Standard entry point for scripts and tests. The manifest is loaded eagerly
 * because nearly every consumer needs the city bbox, and a failed manifest load
 * should stop the process rather than surface later as an empty query result.
 */
export function openDatabase(dbPath: string, manifest: CityManifest): DbHandle {
  const raw = createDatabase(dbPath);
  migrate(raw, manifest);
  return {
    raw,
    db: createDrizzle(raw),
    manifest,
    close: () => raw.close(),
  };
}

// Imported last to avoid a cycle: migrations needs the schema's DDL, and the
// schema must not pull in the runtime.
import { migrate } from "./migrations";
