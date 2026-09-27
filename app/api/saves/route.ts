/**
 * Read and write the signed-in player's cloud save.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONLY DOOR TO THE SAVES TABLE
 * ---------------------------------------------------------------------------
 *
 * `supabase/schema.sql` enables RLS with no policies, so PostgREST returns
 * nothing to `anon` or `authenticated`. The server's Postgres pool connects as
 * the table owner and bypasses RLS, which makes this route — and the session
 * check at the top of it — the single thing standing between a caller and
 * someone else's quest book.
 *
 * So the ordering matters and is not negotiable: session first, body second.
 * Nothing about the request is trusted, logged or parsed until there is a
 * session, and the user id used in the query is the one Better Auth read from
 * the session cookie. It is never taken from the body or a query parameter,
 * because an id the caller supplies is an id the caller chose.
 */

import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { auth } from "../../../lib/auth";
import { query } from "../../../lib/db";

/** Node-only: `lib/db.ts` is `pg`, which has no browser build. */
export const runtime = "nodejs";

/** Both handlers read the session cookie, so neither may be cached or prerendered. */
export const dynamic = "force-dynamic";

/**
 * A real save is a few KB. 512 KB is roughly two orders of magnitude of slack
 * and two orders below the `jsonb` ceiling, so it cannot be used to fill the
 * database or to make Postgres chew on a payload for free.
 */
const MAX_BYTES = 512 * 1024;

/** One payload on the wire, with the timestamp that decides the merge. */
type Cloud = { data: unknown; at: string };

type CloudRow = {
  game: unknown;
  game_at: Date | null;
  trip: unknown;
  trip_at: Date | null;
};

/** `user_id` deliberately absent from the SELECT: it is not the caller's to read. */
const SELECT = "select game, game_at, trip, trip_at from public.saves where user_id = $1";

function asCloud(value: unknown, at: Date | null): Cloud | null {
  if (value === null || value === undefined || at === null) return null;
  return { data: value, at: at.toISOString() };
}

function toPayload(row: CloudRow | undefined) {
  if (!row) return { game: null, trip: null };
  return { game: asCloud(row.game, row.game_at), trip: asCloud(row.trip, row.trip_at) };
}

/**
 * A payload must be a JSON object.
 *
 * Not an array and not a primitive, because the clients write `Save` and `Trip`
 * objects and nothing else — and a primitive would make `Object.keys` and the
 * spread in the merge meaningless. Not `null`, which is how "absent" is spelled
 * and is handled by the caller before we get here.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function currentUserId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user.id ?? null;
}

/** GET — the caller's own row. 200 with nulls when they have never synced. */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { rows } = await query<CloudRow>(SELECT, [userId]);
  return NextResponse.json(toPayload(rows[0]));
}

/**
 * PUT — merge one or both payloads into the caller's row.
 *
 * A single statement, and a payload that was not sent is passed as SQL NULL so
 * that `coalesce(excluded.game, saves.game)` keeps what is already there. That
 * is why this is one upsert rather than a read followed by a write: a
 * read-then-write would lose whichever payload lost the race, and the whole
 * reason for the per-column timestamps in the schema is that two devices are
 * expected to be writing at once.
 *
 * `game_at`/`trip_at` are stamped by the database, never by the client, so a
 * device with a wrong clock cannot make its save win forever.
 */
export async function PUT(request: Request) {
  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }

  if (!isPlainObject(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  // Absent means "leave it alone". It is not the same as null, and there is no
  // way to express "delete my cloud save" through this endpoint on purpose: a
  // client that wanted that would be a client sending a null the merge cannot
  // tell from a mistake.
  const wantsGame = "game" in body;
  const wantsTrip = "trip" in body;

  if (!wantsGame && !wantsTrip) {
    return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
  }

  if (wantsGame && !isPlainObject(body.game)) {
    return NextResponse.json({ error: "`game` must be an object" }, { status: 400 });
  }
  if (wantsTrip && !isPlainObject(body.trip)) {
    return NextResponse.json({ error: "`trip` must be an object" }, { status: 400 });
  }

  const size = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (size > MAX_BYTES) {
    return NextResponse.json({ error: `Save is too large (${size} bytes)` }, { status: 413 });
  }

  const { rows } = await query<CloudRow>(
    `insert into public.saves as s (user_id, game, game_at, trip, trip_at, updated_at)
     values (
       $1,
       $2, case when $2::jsonb is null then null else now() end,
       $3, case when $3::jsonb is null then null else now() end,
       now()
     )
     on conflict (user_id) do update set
       game       = coalesce(excluded.game, s.game),
       game_at    = coalesce(excluded.game_at, s.game_at),
       trip       = coalesce(excluded.trip, s.trip),
       trip_at    = coalesce(excluded.trip_at, s.trip_at),
       updated_at = now()
     returning game, game_at, trip, trip_at`,
    [userId, wantsGame ? JSON.stringify(body.game) : null, wantsTrip ? JSON.stringify(body.trip) : null],
  );

  return NextResponse.json(toPayload(rows[0]));
}
