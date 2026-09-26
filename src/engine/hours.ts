/**
 * OPENING HOURS — the adapter over npm `opening_hours`.
 *
 * WHY AN ADAPTER EXISTS (four reasons, all verified against v3.15.0):
 *
 * 1. The npm port is LGPL-3.0. Everything else in this app is a permissive
 *    licence, so we keep it behind this one module. If it is ever swapped, only
 *    this file changes.
 *
 * 2. It THROWS on real OSM data. Verified: `Mo-Fr 09:00-18:00 PH off`,
 *    `Mo-Fr 09:00-18:00 (ring the bell)` and `Mo-Fr 09:00-18:00 ; comment` all
 *    throw a string, not an Error. So does `hello world`. The rule in this
 *    codebase is that a visitor's scraped field never crashes a request: we
 *    detect the unsupported constructs, and anything we cannot evaluate becomes
 *    `status: 'unparsable'`, never an exception and never a silent 500.
 *
 * 3. It is TRI-STATE and it tells you so, but only if you read the third tuple
 *    element of getOpenIntervals, which is `getUnknown()` and NOT `isOpen()`.
 *    `false` there means "known open". An adapter that filtered on `true` would
 *    conclude nothing is ever open; one that ignored the flag entirely would
 *    claim "open" for windows it knows nothing about, which is the exact
 *    dishonesty this product exists to avoid.
 *
 * 4. It speaks `Date` in the SERVER's local timezone. A demo deployed to Vercel
 *    runs in UTC, so a naive call would evaluate a Mumbai shop's hours against
 *    UTC midnight. `wallClockDate()` below pins the probe dates so the library
 *    always reads IST regardless of where the code is running.
 *
 * The only `Date` objects in the engine enter and leave here.
 */

import opening_hours from "opening_hours";
import type { OpeningHours, Minutes } from "../contracts";
import { MINUTES_PER_DAY, CityClock, MUMBAI, type Weekday } from "../lib/time";

export type HoursStatus = OpeningHours["status"];

export interface Interval {
  startMin: Minutes;
  endMin: Minutes;
  /**
   * False when the library is certain the venue is open. True when the state is
   * genuinely unknown. Propagated all the way to the UI badge.
   */
  known: boolean;
}

export interface HoursEvaluation {
  status: HoursStatus;
  intervals: Interval[];
  /** Why we could not evaluate, for the debug log. Never shown raw to a user. */
  reason?: string;
}

/**
 * OSM constructs this npm port rejects. Checked BEFORE parsing so we can report
 * a specific reason instead of a generic "it threw".
 */
const UNSUPPORTED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bPH\b/i, reason: "public-holiday rule (PH) is unsupported" },
  { pattern: /[()]/, reason: "inline comment" },
  { pattern: /;/, reason: "semicolon comment" },
];

export function detectUnsupported(raw: string): string | undefined {
  for (const { pattern, reason } of UNSUPPORTED_PATTERNS) {
    if (pattern.test(raw)) return reason;
  }
  return undefined;
}

/**
 * A Date whose SYSTEM-LOCAL wall clock reads as the given city-local time.
 *
 * The library calls getHours()/getDay() on the Date we hand it, so by building
 * the Date in local terms we control exactly what it sees, independent of the
 * machine's timezone.
 */
export function wallClockDate(
  weekday: Weekday,
  minutes: number,
  clock: CityClock = MUMBAI,
  baseYear = 2026,
): Date {
  // 2026-01-05 is a Monday, so weekday 0 maps to day 5 of that month.
  const dayOfMonth = 5 + weekday;
  const d = new Date(baseYear, 0, dayOfMonth, 0, 0, 0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  void clock;
  return d;
}

function toMinutes(date: Date): Minutes {
  return (date.getHours() * 60 + date.getMinutes()) as Minutes;
}

/**
 * Parse an OSM opening_hours expression into the contract's OpeningHours.
 * NEVER throws. An absent or unusable value is a status, not an exception.
 */
export function parseHours(raw: string | null | undefined): OpeningHours {
  if (raw === null || raw === undefined) {
    return { raw: null, status: "absent", lastVerified: null };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { raw, status: "absent", lastVerified: null };
  }

  const unsupported = detectUnsupported(trimmed);
  if (unsupported) {
    return { raw, status: "unparsable", lastVerified: null };
  }

  try {
    const oh = new opening_hours(trimmed);
    // The constructor succeeding is not proof the value is useful. `nothing_useful`
    // and `vague` are the library telling us it guessed.
    const warnings = oh.getWarnings();
    if (warnings.some((w) => w.includes("nothing_useful") || w.includes("vague"))) {
      return { raw, status: "unparsable", lastVerified: null };
    }
    // A rule that parses but isn't week-stable carries date-specific state we
    // do not model, e.g. `Jan 1 off`. Usable, but never a confident 'ok'.
    const status: HoursStatus = oh.isWeekStable() ? "ok" : "partial";
    return { raw, status, lastVerified: null };
  } catch {
    return { raw, status: "unparsable", lastVerified: null };
  }
}

/**
 * Expand an expression into open intervals for ONE weekday.
 *
 * The window spans three days (previous, target, next) because a venue open
 * 22:00-02:00 is open at 01:00 on the target weekday thanks to the PREVIOUS
 * day's rule. Probing a single day would silently drop every night venue, and
 * night markets are most of what a Mumbai traveller plans.
 */
export function intervalsForWeekday(
  hours: OpeningHours,
  weekday: Weekday,
  clock: CityClock = MUMBAI,
): HoursEvaluation {
  if (hours.status === "absent" || hours.raw === null) {
    return { status: "absent", intervals: [] };
  }
  if (hours.status === "unparsable") {
    return { status: "unparsable", intervals: [], reason: "unsupported syntax" };
  }

  let oh: opening_hours;
  try {
    oh = new opening_hours(hours.raw);
  } catch (error) {
    // Defensive: parseHours already screened this, but a value that came from
    // the database rather than the harvest path might not have been.
    return {
      status: "unparsable",
      intervals: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const from = wallClockDate(((weekday + 6) % 7) as Weekday, 0, clock);
  const to = wallClockDate(((weekday + 1) % 7) as Weekday, 0, clock);

  let raw: ReturnType<typeof oh.getOpenIntervals>;
  try {
    raw = oh.getOpenIntervals(from, to);
  } catch (error) {
    return {
      status: "unparsable",
      intervals: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const dayStart = toMinutes(from);
  const dayEnd = toMinutes(to);
  const intervals: Interval[] = [];

  for (const [start, end, unknown] of raw) {
    if (end === undefined) continue;
    const s = toMinutes(start);
    const e = toMinutes(end);
    // Clip to the target day. A 24/7 rule yields one interval spanning all
    // three probe days, and without clipping it would produce nonsense here.
    const clippedStart = Math.max(s, dayStart);
    const clippedEnd = Math.min(e, dayEnd);
    if (clippedEnd <= clippedStart) continue;
    intervals.push({
      startMin: clippedStart as Minutes,
      endMin: clippedEnd as Minutes,
      known: !unknown,
    });
  }

  intervals.sort((a, b) => a.startMin - b.startMin);
  return { status: hours.status, intervals };
}

/**
 * Expand a whole week. This is what seed.ts writes into
 * `experience_open_interval`, so the Session 3 gate can range-query instead of
 * re-parsing 250 expressions on every request.
 */
export function intervalsForWeek(
  hours: OpeningHours,
  clock: CityClock = MUMBAI,
): { weekday: Weekday; startMin: Minutes; endMin: Minutes; known: boolean }[] {
  const rows: { weekday: Weekday; startMin: Minutes; endMin: Minutes; known: boolean }[] = [];
  for (let weekday = 0 as Weekday; weekday < 7; weekday = (weekday + 1) as Weekday) {
    for (const interval of intervalsForWeekday(hours, weekday, clock).intervals) {
      rows.push({ weekday, ...interval });
    }
  }
  return rows;
}

export interface OpenVerdict {
  /** True only when we can affirmatively say the venue is open throughout. */
  open: boolean;
  /**
   * True when we cannot tell. Distinct from `open: false`, which means we are
   * confident it is shut. The gate treats unknown as "ask the traveller", never
   * as "closed" and never as "open".
   */
  unknown: boolean;
  status: HoursStatus;
  /** Minutes of the requested window we could confirm as open. */
  coveredMin: number;
}

/**
 * Is the venue open for the WHOLE of [winStart, winEnd) on `weekday`?
 *
 * Partial overlap is NOT enough: a traveller who arrives with 90 minutes left
 * cannot be sent to a shop that shuts in 40. The gate needs full containment,
 * which is why this returns the covered minutes rather than a bare boolean.
 */
export function isOpenDuring(
  hours: OpeningHours,
  weekday: Weekday,
  winStart: Minutes,
  winEnd: Minutes,
  clock: CityClock = MUMBAI,
): OpenVerdict {
  if (winEnd <= winStart) {
    throw new Error(`isOpenDuring: window must be non-empty, got ${winStart}..${winEnd}`);
  }
  if (winEnd - winStart > MINUTES_PER_DAY) {
    throw new Error("isOpenDuring: window longer than a day is not modelled");
  }

  const { status, intervals } = intervalsForWeekday(hours, weekday, clock);

  if (status === "absent" || status === "unparsable") {
    return { open: false, unknown: true, status, coveredMin: 0 };
  }
  if (intervals.length === 0) {
    // Parsed cleanly and evaluates to closed. That is a real answer.
    return { open: false, unknown: false, status, coveredMin: 0 };
  }

  let covered = 0;
  let anyUnknown = false;
  for (const interval of intervals) {
    if (!interval.known) {
      anyUnknown = true;
      continue;
    }
    const overlap = Math.min(interval.endMin, winEnd) - Math.max(interval.startMin, winStart);
    if (overlap > 0) covered += overlap;
  }

  const required = winEnd - winStart;
  return {
    open: covered >= required,
    unknown: anyUnknown && covered < required,
    status,
    coveredMin: covered,
  };
}

/** Human-readable summary for the seed log. Not for the UI. */
export function describeHours(hours: OpeningHours, weekday: Weekday = 1): string {
  if (hours.raw === null) return "absent";
  const { intervals } = intervalsForWeekday(hours, weekday);
  if (intervals.length === 0) return `${hours.status} (closed on this weekday)`;
  return intervals
    .map((i) => `${String(Math.floor(i.startMin / 60)).padStart(2, "0")}:${String(i.startMin % 60).padStart(2, "0")}-${String(Math.floor(i.endMin / 60)).padStart(2, "0")}:${String(i.endMin % 60).padStart(2, "0")}${i.known ? "" : " (?)"}`)
    .join(", ");
}
