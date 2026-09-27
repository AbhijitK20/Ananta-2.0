/**
 * Cloud sync for the quest book and the itinerary.
 *
 * Every store calls exactly two things here: `queuePush` from its persist effect,
 * and `syncOnLoad` once after hydration. `lib/auth/reconcile.ts` holds the
 * decision of what to do when the two copies disagree, and why local wins the
 * first time. The reasoning lives there; this file is the plumbing.
 */

import { authClient } from "../auth-client";
import { reconcile, type Kind } from "./reconcile";

type Envelope = { data: unknown; at: string } | null;

type CloudSaves = { game: Envelope; trip: Envelope };

const PENDING_KEY = "lal-sync/pending/v1";

/** Trailing debounce. A player tapping through ten places in a row is one push. */
const FLUSH_MS = 1500;

type Pending = Record<Kind, boolean>;

/**
 * The exact payload strings last known to be in the cloud. In memory only: it
 * exists to suppress the redundant write an adopt causes, which can only happen
 * within a single page life, so persisting it would be storage for nothing.
 */
const inCloud: Partial<Record<Kind, string>> = {};

let timer: number | null = null;
let queued: Partial<Record<Kind, unknown>> = {};

/* -------------------------------------------------------------------------- *
 * Pending flag
 *
 * A dirty flag per kind, in `localStorage`. Its whole job is to survive a
 * reload: without it, playing unsigned, stamping one place and closing the tab
 * would leave progress that the next visit pulls straight over.
 * -------------------------------------------------------------------------- */

function readPending(): Pending {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return { game: false, trip: false };
    const parsed = JSON.parse(raw) as Partial<Pending>;
    return { game: parsed.game === true, trip: parsed.trip === true };
  } catch {
    // Storage throws on the *read* in private browsing and with site data
    // blocked, and a corrupt value is no worse than a missing one: both mean
    // "assume clean", and the pull that follows is the same either way.
    return { game: false, trip: false };
  }
}

function writePending(next: Pending): void {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(next));
  } catch {
    // A failed write loses the flag, so a later load may pull over unsynced
    // progress. Not worth crashing a stamp over.
  }
}

function markPending(kind: Kind): void {
  const pending = readPending();
  if (pending[kind]) return;
  writePending({ ...pending, [kind]: true });
}

/** Records the payload now believed to be in the cloud. */
function markPushed(kind: Kind, payload: unknown): void {
  inCloud[kind] = JSON.stringify(payload);
}

/* -------------------------------------------------------------------------- *
 * Transport
 * -------------------------------------------------------------------------- */

async function isSignedIn(): Promise<boolean> {
  try {
    const { data } = await authClient.getSession();
    return Boolean(data?.user?.id);
  } catch {
    return false;
  }
}

async function pull(): Promise<CloudSaves> {
  const response = await fetch("/api/saves", { credentials: "same-origin" });
  if (!response.ok) throw new Error(`pull failed: ${response.status}`);
  const body = (await response.json()) as Partial<CloudSaves>;
  return { game: body.game ?? null, trip: body.trip ?? null };
}

/** Both kinds in one request, so a load that syncs the quest book and the
 *  itinerary costs a single round trip. */
async function push(batch: Partial<Record<Kind, unknown>>): Promise<void> {
  const response = await fetch("/api/saves", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(batch),
  });
  if (!response.ok) throw new Error(`push failed: ${response.status}`);
}

/* -------------------------------------------------------------------------- *
 * Flush
 * -------------------------------------------------------------------------- */

function scheduleFlush(): void {
  if (timer !== null) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

async function flush(): Promise<void> {
  if (!(await isSignedIn())) return;

  const batch = queued;
  queued = {};

  try {
    await push(batch);
    for (const kind of Object.keys(batch) as Kind[]) {
      markPushed(kind, batch[kind]);
      const pending = readPending();
      writePending({ ...pending, [kind]: false });
    }
  } catch (error) {
    // Put it back so the next flush, or the next visit, tries again. Sync being
    // briefly unavailable must not cost the player a stamp.
    for (const [kind, payload] of Object.entries(batch)) {
      queued[kind as Kind] = payload;
      markPending(kind as Kind);
    }
    console.warn("[sync] push failed, will retry:", error);
  }
}

/**
 * Called from a store's persist effect.
 *
 * The `inCloud` check is what keeps an adopt from looking like an edit. Adopting
 * a cloud copy writes it to `localStorage`, which fires the very same effect; if
 * that counted as a change, every page load would push a byte-identical save back
 * and leave the pending flag stuck on, so the visit after would push it again.
 */
export function queuePush(kind: Kind, payload: unknown): void {
  if (JSON.stringify(payload) === inCloud[kind]) return;
  markPending(kind);
  queued[kind] = payload;
  scheduleFlush();
}

/* -------------------------------------------------------------------------- *
 * Pull
 * -------------------------------------------------------------------------- */

/**
 * The pull half, run once per store after hydration.
 *
 * `adopt` is the store's own write path rather than a direct localStorage poke,
 * so a pulled save lands through exactly the same reducer and validation as a
 * local one. That is what stops a save from another device taking a path the app
 * has never exercised.
 */
export async function syncOnLoad(
  kind: Kind,
  local: unknown,
  adopt: (data: Record<string, unknown>) => void,
): Promise<void> {
  if (!(await isSignedIn())) return;

  let cloud: CloudSaves;
  try {
    cloud = await pull();
  } catch (error) {
    console.warn(`[sync] could not read the ${kind} save:`, error);
    return;
  }

  const decision = reconcile(kind, local, cloud[kind], readPending()[kind]);

  if (decision.push) {
    queuePush(kind, local);
    return;
  }
  if (decision.adopt !== null && decision.adopt !== undefined) {
    // Recorded before adopting, because adopting fires the store's persist
    // effect and that effect is what consults `inCloud`.
    markPushed(kind, decision.adopt);
    adopt(decision.adopt as Record<string, unknown>);
  }
}
