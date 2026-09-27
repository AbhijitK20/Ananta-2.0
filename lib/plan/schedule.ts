/**
 * Splitting an ordered list of stops into days.
 *
 * This is the feature the rest of the planner hangs off. Furkot's pitch is that
 * you give it a daily driving limit and it works out where you have to stop for
 * the night; everything else — the day colours on the map, the per-day totals,
 * the overnight suggestion — is a consequence of this one function.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, AND WHY IT IS NOT "EVERY LEG UNDER THE CAP"
 * ---------------------------------------------------------------------------
 *
 A day closes when the next leg would push *driving* past the cap, and the stop
 * reached just before that leg becomes the overnight. Three consequences worth
 * stating because they surprise people:
 *
 *   - A leg longer than the cap still gets driven. It cannot be split — a stop is
 *     a place you chose to go to, not a point on a road — so an over-cap day is
 *     reported as over-cap rather than silently truncated. The alternative, a
 *     planner that quietly drops the last leg of a long day, produces an
 *     itinerary that is not the one the traveller built.
 *   - The cap counts driving, not time spent. Three hours in a museum is not
 *     three hours of driving, so a 4h drive capped at 6h with a full day at the
 *     destination is still one day. Capping total time would put a night in the
 *     middle of a city the traveller had budgeted a whole day for.
 *   - Every stop lands in some day, including a stop 30 minutes down the road.
 *     Two stops make two days of travel because you are going to two places.
 *
 * Skipped stops are not in the list this is called with. A "maybe" is on the map
 * and is not a leg of the route, so letting it close a day would invent a night
 * the traveller is not taking.
 */

import { hotelIn } from "./places";
import type { Day, Leg, Stop } from "./types";

/**
 * @param stops Non-skipped stops, in visiting order.
 * @param legs  One leg per adjacent pair, so `legs[i]` runs `stops[i]` to
 *              `stops[i + 1]`.
 */
export function splitIntoDays(
  stops: readonly Stop[],
  legs: readonly Leg[],
  dailyDriveHours: number,
  nonStop: boolean,
): Day[] {
  if (!stops.length) return [];

  const days: Day[] = [];

  let current: Day = {
    index: 0,
    stopIds: [stops[0].id],
    driveHours: 0,
    km: 0,
    overnight: null,
  };

  for (let i = 1; i < stops.length; i++) {
    const stop = stops[i];
    const leg = legs[i - 1];
    const driveAfter = current.driveHours + (leg?.hours ?? 0);

    // Three conditions, all needed. `current.driveHours > 0` stops the first leg
    // from opening a second day, which would leave an empty day one at the start.
    // `current.stopIds.length > 1` stops a day closing before it holds anything
    // beyond its first stop. And a zero-hour leg never closes a day on its own.
    const dayIsFull =
      !nonStop &&
      current.stopIds.length > 1 &&
      current.driveHours > 0 &&
      (leg?.hours ?? 0) > 0 &&
      driveAfter > dailyDriveHours;

    if (dayIsFull) {
      current.overnight = overnightFor(stops[i - 1]);
      days.push(current);
      current = { index: days.length, stopIds: [], driveHours: 0, km: 0, overnight: null };
    }

    current.stopIds.push(stop.id);
    current.driveHours += leg?.hours ?? 0;
    current.km += leg?.km ?? 0;
  }

  // The last day ends the trip rather than beginning a night somewhere.
  current.overnight = null;
  days.push(current);

  return days;
}

/**
 * Where the night would go, and whether the directory can help.
 *
 * `available: false` is a state the UI shows, not an error to swallow. The
 * directory holds 26 hotels across 202 cities, so most overnight suggestions
 * have nowhere to point, and pretending otherwise would be inventing lodging.
 */
function overnightFor(lastStopOfDay: Stop): Day["overnight"] {
  if (!lastStopOfDay.city) return null;
  return { city: lastStopOfDay.city, available: hotelIn(lastStopOfDay.city) !== null };
}

/* -------------------------------------------------------------------------- *
 * Totals
 * -------------------------------------------------------------------------- */

export type TripTotals = {
  stops: number;
  skipped: number;
  days: number;
  km: number;
  driveHours: number;
  /** Days whose driving exceeded the cap, and which therefore need a real look. */
  overCapDays: number;
  routed: boolean;
};

export function totalsFor(
  stops: readonly Stop[],
  legs: readonly Leg[],
  days: readonly Day[],
  dailyDriveHours: number,
): TripTotals {
  return {
    stops: stops.filter((s) => !s.skipped).length,
    skipped: stops.filter((s) => s.skipped).length,
    days: days.length,
    km: legs.reduce((sum, l) => sum + l.km, 0),
    driveHours: legs.reduce((sum, l) => sum + l.hours, 0),
    overCapDays: days.filter((d) => d.driveHours > dailyDriveHours).length,
    // "Routed" means every leg came back with real road geometry. One estimate in
    // the middle makes the total a blend, and the UI says so rather than
    // presenting a half-estimated distance as a routed one.
    routed: legs.length > 0 && legs.every((l) => l.basis === "routed"),
  };
}

/* -------------------------------------------------------------------------- *
 * Reordering
 * -------------------------------------------------------------------------- */

/** Move a stop from one index to another, returning a new array. */
export function moveStop<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const clamped = Math.max(0, Math.min(list.length - 1, to));
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved);
  return next;
}

/** Furkot's reverse-itinerary button. */
export function reverseStops(stops: readonly Stop[]): Stop[] {
  return [...stops].reverse();
}

/* -------------------------------------------------------------------------- *
 * Formatting
 * -------------------------------------------------------------------------- */

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString()} km`;
}

export function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m}`;
}
