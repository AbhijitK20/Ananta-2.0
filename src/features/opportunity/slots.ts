/**
 * Calendar-aware supply. This is the missing half of the opportunity engine.
 *
 * `FEATURES.md` §10 writes the target headline as *"Add a Thursday 17:00 slot —
 * 42 travellers near you wanted a step-free craft workshop under ₹500 and you
 * were the only match within 2 km"*, and until now this engine could only ever
 * recommend editing a listing field. A marketplace whose providers publish no
 * bookable slot is not a marketplace, so a listing that satisfies every field
 * check and has nothing on the calendar is still unmet supply, and the fix is a
 * concrete window rather than an adjective.
 *
 * Everything here reuses the provider feature's own derivation rather than
 * re-deriving it: `deriveAvailability` owns capacity (pretix order: confirmed
 * beats held) and `slotViews` owns blocking. If a rule about when a seat is
 * sellable ever changes, this file changes with it or not at all — which is the
 * whole reason the opportunity feed and the booking inbox cannot disagree.
 *
 * Clock-free like the rest of the feature: `today` and the traveller's window
 * are inputs, never `Date.now()`.
 */
import type { Experience } from "../../contracts";
import { type AvailabilityBlock, type DatedSlot, deriveAvailability, slotViews } from "../provider/availability";
import { minToLabel } from "../provider/time";

/** Mumbai is UTC+5:30, and every `city` in the contracts defaults to Mumbai. */
export const MUMBAI_TZ_OFFSET_MIN = 330;

export type TimeBucket = Experience["bestTimeOfDay"][number];

/** What the provider feature stores against a booking request's outcome. */
export type Seats = { slotId: string; partySize: number; state: string };

/**
 * The provider's bookable calendar. Passing this to `detectOpportunities` turns
 * slot-awareness on; omitting it keeps the engine field-only, so a caller with
 * no calendar data yet gets the older, weaker answer rather than a wrong one.
 */
export interface Calendar {
  slots: readonly DatedSlot[];
  blocks: readonly AvailabilityBlock[];
  bookings: readonly Seats[];
  /**
   * How far ahead a traveller will book. A slot 40 days out does not serve
   * someone searching this weekend, and recommending one would be advice about
   * a date nobody is looking at.
   */
  horizonDays: number;
}

/** Minutes from local midnight for an ISO datetime. */
export function localMinutesOfDay(iso: string, tzOffsetMin: number = MUMBAI_TZ_OFFSET_MIN): number {
  const hours = Number(iso.slice(11, 13));
  const minutes = Number(iso.slice(14, 16));
  const utc = (Number.isNaN(hours) ? 0 : hours) * 60 + (Number.isNaN(minutes) ? 0 : minutes);
  return (((utc + tzOffsetMin) % 1440) + 1440) % 1440;
}

/** The local calendar date (YYYY-MM-DD) an ISO datetime falls on. */
export function localDate(iso: string, tzOffsetMin: number = MUMBAI_TZ_OFFSET_MIN): string {
  return new Date(Date.parse(iso) + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/**
 * The contract already names the five parts of a day, so this reuses its
 * vocabulary instead of inventing a sixth. Boundaries are on the hour and
 * cover 00:00-23:59 exactly once.
 */
export function bucketOf(minute: number): TimeBucket {
  if (minute < 240) return "night";
  if (minute < 540) return "early_morning";
  if (minute < 720) return "morning";
  if (minute < 1020) return "afternoon";
  if (minute < 1260) return "evening";
  return "night";
}

const DAY_MIN = 1440;
const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Dates a traveller could book, oldest first: `[today, today + horizonDays]`. */
export function bookableDates(today: string, horizonDays: number): string[] {
  return Array.from({ length: horizonDays + 1 }, (_unused, i) => addDays(today, i));
}

/**
 * The traveller's free time, which is the only thing that decides whether a
 * published slot is any use to them. Kept as one object so it cannot be passed
 * half-set: the bug this shape replaced was a 19:00 slot being reported as
 * usable to someone who searched at 11:00 with three hours left.
 */
export interface Window {
  /** Local minutes from midnight when the search happened. */
  arriveMin: number;
  /** Minutes they had from then until they had to leave. */
  availableMin: number;
  partySize: number;
}

export interface UsableSlot {
  dated: DatedSlot;
  remaining: number;
  /** Earliest they could join, given when they arrived. */
  earliest: number;
  /** Latest they could finish, given when they had to leave. */
  latestEnd: number;
  /** Minutes of the experience that still fit. Zero means it does not fit. */
  usableMin: number;
}

/**
 * Every slot of `listing` that this party's search could actually book.
 *
 * The five gates, in the order a traveller would hit them:
 *   1. the date is bookable at all (not past, inside the horizon)
 *   2. the provider has not blocked the window out
 *   3. enough seats remain for the whole party, derived not counted
 *   4. the slot overlaps the time the traveller actually had
 *   5. the listing's own duration fits inside that overlap
 *
 * Gates 4 and 5 are the ones that are easy to skip and expensive to skip. A
 * 19:00 slot does not serve someone who asked at 11:00 with three hours left,
 * and a 60-minute experience does not fit a 30-minute gap — a feed that says
 * otherwise sends a provider a booking that cannot happen.
 */
export function usableSlots(
  listing: Experience,
  calendar: Calendar,
  today: string,
  window: Window,
): UsableSlot[] {
  const allowed = new Set(bookableDates(today, calendar.horizonDays));
  const needed = listing.durationMin;
  const deadline = window.arriveMin + window.availableMin;
  const mine = calendar.slots.filter((dated) => dated.slot.experienceId === listing.id);

  return slotViews(mine, calendar.blocks, calendar.bookings)
    .filter((view) => view.blockedBy === undefined)
    .filter((view) => allowed.has(view.dated.date))
    .map((view) => {
      const earliest = Math.max(view.dated.slot.startMin, window.arriveMin);
      const latestEnd = Math.min(view.dated.slot.endMin, deadline);
      return {
        dated: view.dated,
        remaining: view.availability.remaining,
        earliest,
        latestEnd,
        usableMin: Math.max(0, latestEnd - earliest),
      };
    })
    .filter((slot) => slot.remaining >= window.partySize && slot.usableMin >= needed);
}

export interface SlotSuggestion {
  /** YYYY-MM-DD. The first bookable day the window fits on. */
  date: string;
  startMin: number;
  endMin: number;
  /** Finished label a provider can read: "17:00 to 19:30". */
  label: string;
  bucket: TimeBucket;
}

/**
 * The concrete window to publish: at the hour the demand actually happened, for
 * exactly as long as the experience takes. Not "evenings" — a range a provider
 * has to interpret is a range they will ignore.
 *
 * Rounded down to a quarter hour, because `11:07` is not a time anyone opens a
 * kiln at, and a suggestion that looks machine-generated gets skipped.
 */
export function suggestSlot(
  listing: Experience,
  window: Window,
  today: string,
  calendar: Calendar,
): SlotSuggestion | null {
  // Nothing to suggest when the experience outlasts the time the demand had.
  // That is a `durationMin` problem, and a slot cannot fix it.
  if (listing.durationMin > window.availableMin) return null;
  const startMin = Math.floor(window.arriveMin / 15) * 15;
  const endMin = startMin + listing.durationMin;
  if (endMin > DAY_MIN) return null;

  const taken = new Set(
    calendar.slots
      .filter((dated) => dated.slot.experienceId === listing.id)
      .map((dated) => `${dated.date}|${dated.slot.startMin}|${dated.slot.endMin}`),
  );
  for (const date of bookableDates(today, calendar.horizonDays)) {
    if (!taken.has(`${date}|${startMin}|${endMin}`)) {
      return {
        date,
        startMin,
        endMin,
        label: `${minToLabel(startMin)} to ${minToLabel(endMin)}`,
        bucket: bucketOf(startMin),
      };
    }
  }
  return null;
}

export interface CalendarVerdict {
  /** A slot the party could book right now. */
  served: boolean;
  /** Slots that exist and are free but do not fit this party's free time. */
  mismatched: number;
  /** Slots on the calendar that are full, blocked, or out of horizon. */
  unusable: number;
  published: number;
  suggestion: SlotSuggestion | null;
}

/**
 * One place that answers "can this gap be booked at all right now", so the
 * detector and the record builder can never hold two different opinions.
 */
export function verdictFor(
  listing: Experience,
  calendar: Calendar,
  today: string,
  window: Window,
): CalendarVerdict {
  const usable = usableSlots(listing, calendar, today, window);
  const mine = calendar.slots.filter((dated) => dated.slot.experienceId === listing.id);
  const blocked = countBlocked(mine, calendar, today);
  return {
    served: usable.length > 0,
    mismatched: Math.max(0, mine.length - usable.length - blocked),
    unusable: blocked,
    published: mine.length,
    suggestion: usable.length > 0 ? null : suggestSlot(listing, window, today, calendar),
  };
}

/** Slots the traveller could not book at all: blocked out, past, or out of horizon. */
function countBlocked(mine: readonly DatedSlot[], calendar: Calendar, today: string): number {
  const allowed = new Set(bookableDates(today, calendar.horizonDays));
  return slotViews(mine, calendar.blocks, calendar.bookings).filter(
    (view) => view.blockedBy !== undefined || !allowed.has(view.dated.date),
  ).length;
}

export { deriveAvailability };
