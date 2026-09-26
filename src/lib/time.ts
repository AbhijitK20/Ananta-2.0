/**
 * TIME — the only place in the codebase where `Date` and integer minutes meet.
 *
 * The engine speaks `Minutes` (integer minutes from local midnight, 0..1440)
 * because:
 *   - it is trivially unit-testable with no timezone involved
 *   - it cannot silently shift when serialised
 *   - 1440 is a natural bound, so an overflow is a type error not a wrap-around
 *
 * Invariant: no `Date` object ever enters or leaves the engine. `Date` appears
 * only in this module, in harvest/seed scripts, and in UI formatting. Enforced
 * by tests/time.test.ts.
 */

import { Minutes } from "../contracts";

export const MINUTES_PER_DAY = 1440;

export const TIME_BUCKETS = [
  "early_morning",
  "morning",
  "afternoon",
  "evening",
  "night",
] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

/**
 * Explicit city wall-clock. The reason we don't use `Date.getHours()`:
 * the engine must give the same answer for a traveller in Colaba and one
 * sitting in London looking at the same plan. Times are always the DESTINATION's
 * local time, because that's the time a shop's door actually cares about.
 */
export class CityClock {
  constructor(
    public readonly timezone: string,
    public readonly utcOffsetMinutes: number,
  ) {
    if (!Number.isInteger(utcOffsetMinutes)) {
      throw new Error(`CityClock: utcOffsetMinutes must be an integer, got ${utcOffsetMinutes}`);
    }
  }

  /** UTC instant -> local minutes from midnight. */
  fromDate(date: Date): Minutes {
    const shifted = new Date(date.getTime() + this.utcOffsetMinutes * 60_000);
    return (shifted.getUTCHours() * 60 + shifted.getUTCMinutes()) as Minutes;
  }

  /** Local minutes from midnight -> the UTC instant for that wall-clock time. */
  toDate(minutes: Minutes, onDay: Date = new Date()): Date {
    assertMinutes(minutes, "toDate()");
    const base = new Date(onDay.getTime());
    const utcDayStart = Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate(),
    );
    return new Date(utcDayStart + (minutes - this.utcOffsetMinutes) * 60_000);
  }

  /** Local minutes -> "09:30". */
  format(minutes: Minutes): string {
    assertMinutes(minutes, "format()");
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
}

/** Asia/Kolkata has no DST. India has used +05:30 since 1945. */
export const MUMBAI = new CityClock("Asia/Kolkata", 330);

export function assertMinutes(minutes: number, context = ""): asserts minutes is Minutes {
  if (!Number.isInteger(minutes)) {
    throw new Error(`${context} minutes must be an integer, got ${minutes}`);
  }
  if (minutes < 0 || minutes > MINUTES_PER_DAY) {
    throw new Error(`${context} minutes must be 0..${MINUTES_PER_DAY}, got ${minutes}`);
  }
}

/** "09:30" -> 570. Throws on anything malformed rather than guessing. */
export function parseClock(hhmm: string): Minutes {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`parseClock: expected HH:MM, got ${JSON.stringify(hhmm)}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) {
    throw new Error(`parseClock: out of range in ${JSON.stringify(hhmm)}`);
  }
  const total = hours * 60 + minutes;
  if (total > MINUTES_PER_DAY) {
    throw new Error(`parseClock: ${hhmm} exceeds 24:00`);
  }
  return total as Minutes;
}

/** Which bucket a wall-clock time falls in. Used for congestion + bestTime. */
export function bucketOf(minutes: Minutes): TimeBucket {
  assertMinutes(minutes, "bucketOf()");
  if (minutes < 6 * 60) return "early_morning";
  if (minutes < 12 * 60) return "morning";
  if (minutes < 17 * 60) return "afternoon";
  if (minutes < 21 * 60) return "evening";
  return "night";
}

/** Does [start, end) fully contain [winStart, winEnd)? Handles midnight wrap. */
export function windowContains(
  start: Minutes,
  end: Minutes,
  winStart: Minutes,
  winEnd: Minutes,
): boolean {
  if (winEnd <= winStart) throw new Error("windowContains: window must be non-empty");
  const overlaps = (a1: Minutes, a2: Minutes, b1: Minutes, b2: Minutes) =>
    a1 < b2 && b1 < a2;
  if (start <= end) {
    return overlaps(start, end, winStart, winEnd);
  }
  // The interval wraps past midnight, e.g. 22:00-02:00 for a night market.
  return overlaps(start, MINUTES_PER_DAY, winStart, winEnd) ||
    overlaps(0, end, winStart, winEnd);
}

/** Duration of [start, end) in minutes, accounting for a midnight wrap. */
export function spanMinutes(start: Minutes, end: Minutes): number {
  const raw = end - start;
  return raw >= 0 ? raw : raw + MINUTES_PER_DAY;
}

export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`formatDuration: expected non-negative, got ${minutes}`);
  }
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

/**
 * 7-day weekday index, **0 = MONDAY**. Matches OSM's `Mo..Su` ordering,
 * which is what `opening_hours` expressions are written in, so the value is
 * forwarded to `engine/hours` without conversion.
 *
 * NOT `Date.getDay()` (0 = Sunday). Conflating the two silently evaluates the
 * wrong day's opening hours, and the error is invisible because both are just
 * small integers. Use `weekdayOf(date)` to convert.
 */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function weekdayOf(date: Date): Weekday {
  return ((date.getUTCDay() + 6) % 7) as Weekday;
}

export function isoWeekdayName(weekday: Weekday): string {
  return ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"][weekday]!;
}
