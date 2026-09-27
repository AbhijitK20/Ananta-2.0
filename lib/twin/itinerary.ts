/**
 * What the weather does to the *plan*, as opposed to to the places.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CALLS THE PLANNER'S OWN SPLIT
 * ---------------------------------------------------------------------------
 *
 * The brief asks the twin to produce "a corresponding change in the team's
 * existing system". The cheapest way to fake that would be to reimplement the day
 * split here with a weather-shaped coefficient, and it would be wrong in the way
 * that matters: the number the traveller reads is `days` from `splitIntoDays`,
 * and a twin computing its own version of it would drift from the planner the
 * first time either one's rules changed.
 *
 * So this reimplements nothing. It hands weather-inflated leg times back to
 * `splitIntoDays` and `totalsFor` — the same functions, with the same daily
 * driving limit, the same "a leg longer than the cap cannot be split" rule, and
 * the same over-cap accounting — and reports the difference. If the planner's
 * rules move, the twin's answer moves with them, because there is only one rule.
 *
 * The traveller's own stops are never written to. `routed` is read; the
 * scenario's world is built beside it. A what-if that mutated the itinerary would
 * not be a what-if.
 */

import { estimateHours, estimateKm } from "../plan/geo";
import { splitIntoDays, totalsFor, formatHours } from "../plan/schedule";
import type { Leg, Stop, Trip } from "../plan/types";
import type { ItineraryEffect, Scenario } from "./types";

/**
 * The trimmed shape this module needs. Separate from the full `NodeImpact` so the
 * function can be exercised against a literal without constructing channels.
 */
export type TwinNodeImpactLite = {
  /** The stop id, without the `stop:` prefix the graph adds. */
  stopId: string;
  name: string;
  /** 0-1. 0 is shut. */
  availability: number;
  /** 0-3, for the "how bad" wording. */
  severity: number;
  /** Multiplier on 1.0. Above 1 means busier. */
  demand: number;
};

export type ItineraryInput = {
  trip: Trip;
  /** Non-skipped stops in visiting order — the same list the planner routes. */
  routed: readonly Stop[];
  legs: readonly Leg[];
  /** Weather-inflated hours keyed `"fromId>toId"`, from ./propagate. */
  adjustedLegHours: ReadonlyMap<string, number>;
  impacts: readonly TwinNodeImpactLite[];
  live: boolean;
};

export function itineraryEffect(input: ItineraryInput): ItineraryEffect {
  const { trip, routed, legs, adjustedLegHours, impacts, live } = input;

  const closed = impacts.filter((i) => i.availability <= 0.001).map((i) => i.name);
  const degraded = impacts.filter((i) => i.availability > 0.001 && i.availability < 0.85).map((i) => i.name);

  const empty: ItineraryEffect = {
    days: 0,
    nights: 0,
    driveHours: 0,
    closed,
    degraded,
    headline: null,
  };

  if (routed.length < 2) {
    return { ...empty, days: routed.length ? 1 : 0 };
  }

  const baselineDays = splitIntoDays(routed, legs, trip.dailyDriveHours, trip.nonStop);
  const baselineTotals = totalsFor(routed, legs, baselineDays, trip.dailyDriveHours);

  const closedIds = new Set(impacts.filter((i) => i.availability <= 0.001).map((i) => i.stopId));
  const surviving = routed.filter((s) => !closedIds.has(s.id));

  if (surviving.length < 2) {
    // Every leg is gone. The trip has lost its shape rather than shortened, and
    // saying so is more useful than reporting a one-day trip through three
    // closed stops.
    return {
      days: 0,
      nights: Math.max(0, baselineTotals.days - 1),
      driveHours: 0,
      closed,
      degraded,
      headline: `${live ? "As observed" : "Under this scenario"}, too much of the trip is shut to drive.`,
    };
  }

  const scenarioLegs = rebuildLegs(trip, routed, legs, surviving, adjustedLegHours);
  const days = splitIntoDays(surviving, scenarioLegs, trip.dailyDriveHours, trip.nonStop);
  const totals = totalsFor(surviving, scenarioLegs, days, trip.dailyDriveHours);

  return {
    days: totals.days,
    nights: Math.max(0, totals.days - 1),
    driveHours: totals.driveHours,
    closed,
    degraded,
    headline: describe(
      closed.length,
      degraded.length,
      totals.driveHours,
      baselineTotals.driveHours,
      live,
    ),
  };
}

/* -------------------------------------------------------------------------- *
 * Rebuilding the legs around the closures
 * -------------------------------------------------------------------------- */

/**
 * The legs of the surviving itinerary.
 *
 * Removing a middle stop does not delete a leg, it *joins* two of them: A→B→C
 * with B shut becomes one A→C leg. So this walks the surviving stops in order and
 * for each new hop collects the original legs that spanned it — including the ones
 * through closed stops — and sums their inflated hours.
 *
 * A hop that the original route never made at all (which cannot happen from a
 * closure, but can if a stop was reordered underneath us) falls back to the
 * planner's own straight-line estimate with `basis: "estimated"`, exactly as
 * `lib/plan/route` does when a leg could not be routed. That keeps the
 * routed/estimated distinction honest all the way through: a joined leg is only
 * `routed` if every piece of it was.
 */
function rebuildLegs(
  trip: Trip,
  routed: readonly Stop[],
  legs: readonly Leg[],
  surviving: readonly Stop[],
  adjustedLegHours: ReadonlyMap<string, number>,
): Leg[] {
  const position = new Map(routed.map((s, i) => [s.id, i]));

  // Original leg by the index pair it spans, with its inflated hours attached. A
  // leg with no entry in `adjustedLegHours` keeps its own hours, which is the
  // honest fallback: the twin did not score that leg, so it does not get to
  // change it.
  const byIndex = new Map<string, { leg: Leg; hours: number }>();
  legs.forEach((leg) => {
    const from = position.get(leg.fromId);
    const to = position.get(leg.toId);
    if (from === undefined || to === undefined) return;
    byIndex.set(`${from}>${to}`, {
      leg,
      hours: adjustedLegHours.get(`${leg.fromId}>${leg.toId}`) ?? leg.hours,
    });
  });

  const out: Leg[] = [];

  for (let i = 1; i < surviving.length; i++) {
    const a = surviving[i - 1];
    const b = surviving[i];
    const from = position.get(a.id);
    const to = position.get(b.id);
    if (from === undefined || to === undefined) continue;

    let hours = 0;
    let km = 0;
    let routedBasis = true;
    let geometry: [number, number][] | undefined;

    // Walk the original order from a to b, one adjacent step at a time, so a hop
    // across closed stops accumulates every leg it swallowed.
    for (let step = from; step < to; step++) {
      const piece = byIndex.get(`${step}>${step + 1}`);
      if (!piece) {
        routedBasis = false;
        continue;
      }
      hours += piece.hours;
      km += piece.leg.km;
      if (piece.leg.basis !== "routed") routedBasis = false;
      if (piece.leg.geometry) geometry = piece.leg.geometry;
    }

    if (hours === 0) {
      // The original route never covered this pair. The planner's own estimate,
      // labelled as an estimate.
      km = estimateKm(a.at, b.at, trip.mode);
      hours = estimateHours(km, trip.mode);
      routedBasis = false;
      geometry = undefined;
    }

    out.push({
      fromId: a.id,
      toId: b.id,
      km: Math.round(km * 100) / 100,
      hours: Math.round(hours * 100) / 100,
      basis: routedBasis ? "routed" : "estimated",
      geometry,
    });
  }

  return out;
}

/**
 * One sentence saying what changed, or null when nothing did.
 *
 * Returning null rather than "no change" is deliberate: the panel then shows
 * nothing, and a permanent "no change" line is how a status display becomes
 * furniture nobody reads.
 */
function describe(
  closedCount: number,
  degradedCount: number,
  driveHours: number,
  baseDriveHours: number,
  live: boolean,
): string | null {
  const parts: string[] = [];

  if (closedCount > 0) parts.push(`${closedCount} stop${closedCount === 1 ? "" : "s"} shut`);
  if (degradedCount > 0) parts.push(`${degradedCount} degraded`);
  if (driveHours > baseDriveHours + 0.05) {
    parts.push(
      `${formatHours(driveHours - baseDriveHours)} more driving than the ${formatHours(baseDriveHours)} the route takes now`,
    );
  }

  if (!parts.length) return null;
  const prefix = live ? "As observed" : "Under this scenario";
  return `${prefix}: ${parts.join(", ")}.`;
}
