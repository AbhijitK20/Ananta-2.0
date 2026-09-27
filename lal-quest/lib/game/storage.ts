/**
 * Reading and writing the save file.
 *
 * ---------------------------------------------------------------------------
 * STORAGE FAILURE IS AN ORDINARY CONDITION
 * ---------------------------------------------------------------------------
 *
 * `localStorage` throws in more situations than people expect: Safari private
 * browsing, a user who has blocked site data for the domain, a full quota, and
 * an iframe with a null origin all raise on the *read*, not just the write. A
 * collector that crashes on a player's phone because storage was unavailable
 * would be a far worse bug than a collector that forgets a session.
 *
 * So every access here is wrapped, and the module keeps an in-memory copy as a
 * fallback. A player with storage disabled still plays: their progress lives for
 * the tab's lifetime, they are told so once, and nothing throws. `storageWorks`
 * is what the UI checks to decide whether to say anything at all.
 *
 * ---------------------------------------------------------------------------
 * MIGRATION
 * ---------------------------------------------------------------------------
 *
 * There is exactly one version so far, so there is no migration ladder to walk.
 * What exists instead is the guard that matters when there *is* one: a save
 * from a future version is refused rather than reinterpreted. A newer build
 * added a field this build does not know about; reading it as if it were the old
 * shape would drop that field on the next write and destroy the data the newer
 * build had written. Refusing is loud and recoverable; guessing is silent and
 * is not.
 */

import { emptySave, SAVE_VERSION, type DayKey, type Save } from "./types";

const KEY = "lal-quest/save/v1";

/** Set false the first time any access to storage throws. Never set back. */
let storageWorks = true;

/** In-memory mirror. Authoritative when storage is unavailable. */
let memory: Save = emptySave();

export function isStorageAvailable(): boolean {
  return storageWorks;
}

/**
 * A window is not guaranteed: the module is imported by server components'
 * render pass, and `next build` will evaluate it there.
 */
function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function safeGet(key: string): string | null {
  if (!hasWindow()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    storageWorks = false;
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  if (!hasWindow()) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // A QuotaExceededError here is not worth retrying — the save is a few KB at
    // its largest, so a full quota means something else is using the space.
    storageWorks = false;
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === "string",
  );
}

function isNumberMap(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Coerce arbitrary parsed JSON into a `Save`, or return null if it cannot be.
 *
 * Field-by-field rather than a single shape check: a save that gained one field
 * in a later version should still load its stamps, and dropping a whole file
 * because one optional field is missing loses the part the player cares about.
 * The one thing that is not negotiable is `stamps` — a save without it is not a
 * save.
 */
function parseSave(raw: string): Save | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (!isStringMap(candidate.stamps)) return null;

  const save = emptySave();

  save.stamps = { ...candidate.stamps };
  save.claimedQuests = isStringArray(candidate.claimedQuests) ? candidate.claimedQuests : [];
  save.unlocked = isStringMap(candidate.unlocked) ? { ...candidate.unlocked } : {};
  save.activeDays = isStringArray(candidate.activeDays) ? candidate.activeDays : [];
  save.dailyCounts = isNumberMap(candidate.dailyCounts) ? { ...candidate.dailyCounts } : {};
  // Absent on any save written before the daily bonus was made derivable. An
  // empty list is the right default: those players genuinely completed no
  // tracked dailies, and defaulting to something invented would pay them XP
  // they were never granted.
  save.dailiesDone = isStringArray(candidate.dailiesDone) ? candidate.dailiesDone : [];

  const pick = candidate.dailyPick;
  if (
    typeof pick === "object" &&
    pick !== null &&
    typeof (pick as Record<string, unknown>).day === "string" &&
    typeof (pick as Record<string, unknown>).placeId === "string"
  ) {
    const p = pick as { day: DayKey; placeId: string };
    save.dailyPick = { day: p.day, placeId: p.placeId };
  }

  return save;
}

/* -------------------------------------------------------------------------- *
 * Public API
 * -------------------------------------------------------------------------- */

type LoadResult = {
  save: Save;
  /**
   * True when a stored save was found but discarded — unreadable, corrupt, or
   * written by a newer build. Surfaced so the shell can say the collection
   * started fresh rather than silently presenting an empty book as if the player
   * had never played.
   */
  discarded: boolean;
  /** Why, when `discarded`. For the console; never rendered to the player. */
  reason?: string;
};

export function load(): LoadResult {
  const raw = safeGet(KEY);
  if (raw === null) {
    memory = emptySave();
    return { save: memory, discarded: false };
  }

  const parsed = parseSave(raw);
  if (!parsed) {
    memory = emptySave();
    return { save: memory, discarded: true, reason: "unreadable" };
  }

  if (typeof parsed.version === "number" && parsed.version > SAVE_VERSION) {
    // Refuse rather than reinterpret. See the note at the top of the file.
    memory = emptySave();
    return { save: memory, discarded: true, reason: "from a newer version" };
  }

  memory = parsed;
  return { save: memory, discarded: false };
}

export function persist(save: Save): boolean {
  memory = save;
  return safeSet(KEY, JSON.stringify(save));
}

/** Used by the reset control. Clears both the mirror and the stored copy. */
export function clear(): Save {
  memory = emptySave();
  if (hasWindow()) {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      storageWorks = false;
    }
  }
  return memory;
}
