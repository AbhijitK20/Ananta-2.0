/**
 * The Supabase Postgres connection.
 *
 * ---------------------------------------------------------------------------
 * WHY THE POOL IS NULL RATHER THAN POINTING SOMEWHERE
 * ---------------------------------------------------------------------------
 *
 * With no `DATABASE_URL` there is no pool at all, and that is the whole safety
 * story. A `pg.Pool` does not connect until a query runs, so a pool aimed at a
 * plausible-looking default would leave the app booting cleanly and only failing
 * later, on whichever unlucky request happened to be first — the kind of
 * failure that reads as "auth is broken" rather than "auth is not configured".
 *
 * Aiming it at a closed port was the previous approach and was worse: it worked,
 * but it made an unconfigured app look configured right up until someone tried to
 * use it. Absent is honest.
 *
 * The alternative — defaulting to some development database — means a deploy that
 * forgot `DATABASE_URL` quietly writes real players' saves somewhere else.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO FALLBACK CREDENTIAL ANYWHERE
 * ---------------------------------------------------------------------------
 *
 * `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS and speaks PostgREST, not SQL. This
 * app already holds a SQL connection for Better Auth's own tables, so reaching
 * for a second, far more privileged credential to read four columns would add a
 * secret to the attack surface for no gain. The `saves` table is protected by
 * RLS instead (see `supabase/schema.sql`), and this pool connects as the table
 * owner.
 */

import { Pool, type QueryResultRow } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __lalPool: Pool | undefined;
}

const connectionString = process.env.DATABASE_URL;

/**
 * Cached on `globalThis` so a dev hot-reload does not open a fresh set of
 * connections on every edit until Postgres refuses new ones.
 *
 * `max: 5` because Supabase's pooler fronts a small backend and a serverless
 * function that opens a connection per request will exhaust it. TLS is left to
 * the connection string (`sslmode=…`) rather than forced here, so the choice
 * stays visible in `.env.example`.
 */
export const pool: Pool | null = connectionString
  ? (globalThis.__lalPool ?? new Pool({ connectionString, max: 5 }))
  : null;

if (pool && process.env.NODE_ENV !== "production") {
  globalThis.__lalPool = pool;
}

/**
 * A parameterised query. `text` and every `values` entry go to Postgres as bound
 * parameters, never string-interpolated, so a quote in a save's name is a quote
 * and not the end of the statement.
 */
export function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  if (!pool) {
    throw new Error(
      "DATABASE_URL is not set. Accounts and cloud saves need Supabase Postgres; see " +
        "the \"Accounts and cloud saves\" section of the README.",
    );
  }
  return pool.query<T>(text, values);
}
