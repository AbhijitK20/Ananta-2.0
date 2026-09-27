/**
 * The decision of what to do when the local save and the cloud save disagree.
 *
 * Split out of `sync.ts` so it carries no browser or network imports. That is
 * what lets `tools/check-sync.mjs` exercise the one branchy piece of the sync
 * with nothing running but node.
 */

export type Kind = "game" | "trip";

export type Envelope = { data: unknown; at: string } | null;

/** What to do about one kind. */
export type Reconciliation =
  /** Use this payload as the new local save. */
  | { adopt: unknown; push: false }
  /** Keep the local save and send it. */
  | { adopt: null; push: true }
  /** The two already agree. Do nothing. */
  | { adopt: null; push: false };

/**
 * Unsigned progress is never overwritten by a cloud copy of unknown age.
 *
 * `lib/game/storage.ts` and `lib/plan/storage.ts` store a save with no
 * timestamp, and adding one would mean a new persisted field and a migration on
 * both shapes. So there is no honest way to ask which copy is newer, and the
 * answer given instead is that the local one is assumed to be. A player who
 * played unsigned and then signed in has unsynced progress, and losing it
 * because a cloud copy happened to exist is the one failure this feature must
 * not have. Their save overwriting the cloud one is the cheaper direction to be
 * wrong in.
 *
 * Once signed in, ordering is tracked properly by the per-column timestamps in
 * `supabase/schema.sql`, and `pending` is false for anything already synced.
 */
export function reconcile(
  _kind: Kind,
  local: unknown,
  cloud: Envelope,
  pending: boolean,
): Reconciliation {
  if (!cloud) return { adopt: null, push: false };
  if (pending) return { adopt: null, push: true };
  // Compared as text because both sides are plain JSON objects and key order is
  // stable across a stringify of the same object; anything richer needs a real
  // deep equal, which is not worth it for two blobs we produced ourselves.
  if (JSON.stringify(local) === JSON.stringify(cloud.data)) return { adopt: null, push: false };
  return { adopt: cloud.data, push: false };
}
