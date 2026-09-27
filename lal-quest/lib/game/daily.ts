/**
 * Days, streaks and the daily challenge.
 *
 * ---------------------------------------------------------------------------
 * WHY DAY KEYS ARE LOCAL, NOT UTC
 * ---------------------------------------------------------------------------
 *
 * A streak is a promise to a person about *their* days. "Yesterday" means the
 * day before the one they are living through, which is their local calendar day,
 * not UTC's. Storing `new Date().toISOString().slice(0, 10)` would roll a
 * player's streak over at 00:00 UTC — roughly five in the evening in Kolkata,
 * and it would reset while they were still playing. So a day key is built from
 * the local getters, and the day arithmetic below is done on the parsed
 * calendar date rather than by adding 86 400 000 ms.
 *
 * The millisecond shortcut is not just a timezone bug. In any timezone with DST
 * — which is most of them — a local day is 23 or 25 hours long, so adding a day
 * in milliseconds lands on the wrong date twice a year, right when someone is
 * most likely to notice a streak that skipped a day.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DAILY PICK IS SAVED
 * ---------------------------------------------------------------------------
 *
 * `dailyPickFor` is a pure function of the day key, so it is deterministic and
 * needs no storage. It is stored anyway. A player who stamps the daily place,
 * sees the confetti, and reloads must not be offered a second place because the
 * hash seed moved — and one who has already stamped every place the day could
 * have drawn should see an honest "come back tomorrow" rather than a reroll
 * loop. The saved value is the display source of truth; the pure function is
 * only its fallback for a player with no save yet.
 */

import { PLACES } from "../content";
import type { DayKey } from "./types";

/* -------------------------------------------------------------------------- *
 * Day keys
 * -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` in the runtime's own timezone. */
export function dayKey(date: Date = new Date()): DayKey {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayKey(): DayKey {
  return dayKey();
}

/**
 * Parse a day key to a UTC-noon `Date`.
 *
 * Noon rather than midnight on purpose: `new Date("2026-01-01")` is midnight
 * UTC, and adding a day to that in a western timezone lands on the *previous*
 * local date. Noon has twelve hours of slack on either side, so day arithmetic
 * on these dates is right in every real timezone.
 */
function parseDay(key: DayKey): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function formatDay(date: Date): DayKey {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The day key `n` days **before** `key`. `n = 1` is yesterday.
 *
 * Named `daysBefore` rather than `shiftDay` because the sign convention cost a
 * bug: a generic-sounding `daysBefore(key, n)` reads to most people as "n days
 * from key", and every call site here wants the other direction. Two explicit
 * functions cannot be read the wrong way round.
 */
export function daysBefore(key: DayKey, n: number): DayKey {
  const date = parseDay(key);
  date.setUTCDate(date.getUTCDate() - n);
  return formatDay(date);
}

/** The day key `n` days **after** `key`. `n = 1` is tomorrow. */
export function daysAfter(key: DayKey, n: number): DayKey {
  return daysBefore(key, -n);
}

/** Whole days from `a` to `b`. Positive when `b` is later. */
function daysBetween(a: DayKey, b: DayKey): number {
  const MS = 86_400_000;
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / MS);
}

/** "Tue 8 Sep" — for the streak strip and the daily card. */
export function formatDayLabel(key: DayKey): string {
  const date = parseDay(key);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/* -------------------------------------------------------------------------- *
 * Streaks
 * -------------------------------------------------------------------------- */

export type StreakState = {
  /** Consecutive active days ending today, or ending yesterday if today is not yet done. */
  current: number;
  /** Longest run ever recorded. */
  best: number;
  /**
   * True when the streak is alive but today has no stamp yet — the state a
   * player is in every morning. The UI needs it to say "keep it alive" rather
   * than "you have a streak", which would be a lie at 9am.
   */
  atRisk: boolean;
  /** The most recent active day, or null if nothing has ever been stamped. */
  lastActive: DayKey | null;
  /** The seven day keys ending today, oldest first, for the week strip. */
  week: DayKey[];
};

/**
 * Consecutive run ending at `anchor`, counting backwards.
 *
 * `sorted` is ascending, so the walk goes from the END of the array towards the
 * start. Iterating forwards instead is the natural-looking mistake and it is
 * silently wrong: the anchor is the *newest* day, so a forward loop compares
 * the oldest day against it, fails the equality test, sees it as "before the
 * anchor", and returns 0 for every streak in the game.
 */
function runBackwards(sorted: readonly DayKey[], anchor: DayKey): number {
  let run = 0;
  let expected = anchor;

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const day = sorted[i];
    if (day === expected) {
      run += 1;
      expected = daysBefore(expected, 1);
    } else if (day < expected) {
      // Anything older than the day we are looking for is a gap, and the run
      // ends. Sorted ascending, so nothing further back can close it.
      break;
    }
    // day > expected cannot happen in an ascending array walked backwards; if
    // it ever did the right move is to keep going, which falling through does.
  }

  return run;
}

/**
 * Current and best streak from the set of active days.
 *
 * The current streak deliberately tolerates "today not stamped yet". Breaking a
 * streak at midnight for a player who has not opened the app yet would mean
 * every streak in the game was effectively one day shorter than it looked, and
 * the fix — anchor on yesterday instead of today — is the standard one.
 */
export function streakState(activeDays: Iterable<DayKey>, today: DayKey = todayKey()): StreakState {
  const sorted = [...new Set(activeDays)].sort();
  const active = new Set(sorted);

  const yesterday = daysBefore(today, 1);
  const todayDone = active.has(today);
  const yesterdayDone = active.has(yesterday);

  const current = todayDone
    ? runBackwards(sorted, today)
    : yesterdayDone
      ? runBackwards(sorted, yesterday)
      : 0;

  // Best is a max over every run, found by walking forward and timing each
  // break. Linear and allocation-free, which matters because this runs on every
  // render of the shell's streak chip.
  let best = 0;
  let run = 0;
  let previous: DayKey | null = null;
  for (const day of sorted) {
    if (previous !== null && daysBetween(previous, day) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > best) best = run;
    previous = day;
  }

  const week: DayKey[] = [];
  for (let n = 6; n >= 0; n -= 1) week.push(daysBefore(today, n));

  return {
    current,
    best: Math.max(best, current),
    atRisk: current > 0 && !todayDone,
    lastActive: sorted.length ? sorted[sorted.length - 1] : null,
    week,
  };
}

/** Convenience for the achievements evaluator, which only wants the ceiling. */
export function longestStreak(activeDays: Iterable<DayKey>, today: DayKey = todayKey()): number {
  return streakState(activeDays, today).best;
}

/* -------------------------------------------------------------------------- *
 * The daily challenge
 * -------------------------------------------------------------------------- */

/**
 * FNV-1a over the day key.
 *
 * Any stable hash works. This one is a named function rather than a bare
 * `hashCode()` because the daily pick is *persisted* — changing the algorithm
 * later would silently hand every player a different "today" than the one they
 * stamped this morning, so it needs a name that says "this is load-bearing".
 */
function hashDay(key: DayKey): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * The place the game nominates for `day`.
 *
 * The pool excludes nothing: every one of the 890 places is eligible,
 * including ones the player has already stamped. A daily that filtered out
 * completed places would reroll onto an empty pool for someone near the end of
 * the collection, and the honest version of "you have finished the dataset" is
 * to say so rather than to keep serving up things they have already done.
 */
export function dailyPickFor(day: DayKey) {
  return PLACES[hashDay(day) % PLACES.length];
}

