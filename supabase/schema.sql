-- Cloud saves: one row per account, holding the quest book and the itinerary.
--
-- Run this in Supabase → SQL Editor, AFTER Better Auth has created its own
-- tables (see the handoff notes in README.md). It references `"user"`, which
-- Better Auth's migration creates.
--
-- This file deliberately does NOT define Better Auth's tables. Those belong to
-- the library, they change between versions, and a hand-copied copy is a copy
-- that drifts. The library's own CLI generates and migrates them.

create table if not exists public.saves (
  -- The Better Auth user this belongs to. `on delete cascade` so deleting an
  -- account takes its saves with it: a row keyed to a user that no longer
  -- exists is a row nobody can ever delete or explain.
  user_id    text primary key references public."user"(id) on delete cascade,

  -- The two payloads, stored as received. See the note below on why they are
  -- not normalised on the way in.
  game       jsonb,
  trip       jsonb,

  -- One timestamp per payload, not one for the row. A player who collects
  -- stamps on their phone and plans the trip on a laptop writes the game on one
  -- device and the trip on the other; with a single row timestamp the second
  -- device to sync would look like the newer save of both and win the whole
  -- row, silently reverting the first device's work. Per-column timestamps let
  -- the client resolve each payload on its own merits.
  game_at    timestamptz,
  trip_at    timestamptz,

  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- ---------------------------------------------------------------------------
--
-- Enabled with no policies, which is the deny-by-default state: `anon` and
-- `authenticated` get nothing from PostgREST even with a valid Supabase JWT.
-- This app's anon key is never in a browser bundle anyway, but a table that is
-- only reachable through a session-checked API route should not depend on that
-- remaining true.
--
-- The server's own pool connects as the table owner, and an owner bypasses RLS,
-- so `/api/saves` still works. That is the intended single door.
--
-- To read these rows from the browser directly one day, add a policy keyed to
-- `auth.uid()::text = user_id` — not a blanket `using (true)`.
alter table public.saves enable row level security;

-- ---------------------------------------------------------------------------
-- WHY THE PAYLOADS ARE NOT COERCED ON WRITE
-- ---------------------------------------------------------------------------
--
-- `jsonb` is a deliberate choice over a set of typed columns. Running an
-- incoming save through this build's parser before storing it would be tidy and
-- would quietly destroy data: a client from a later version can carry fields
-- this build has never heard of, coercion drops them, and the next write
-- persists the loss. The same hazard is why `lib/game/storage.ts` refuses a save
-- from a newer version rather than reinterpreting it.
--
-- The client already validates what it reads — `parseSave` discards anything it
-- cannot use — so the server only has to guarantee the payload is a JSON object
-- and is not large enough to be an abuse. That check lives in
-- `app/api/saves/route.ts`.
