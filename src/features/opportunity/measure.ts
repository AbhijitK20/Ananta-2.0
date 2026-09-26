/**
 * Measurement. The one thing the opportunity feed has never been able to say.
 *
 * `ProviderOpportunity.estimatedImpact` is documented as "Measured effect, once
 * we know it. Null until then", and it was null forever, because nothing in the
 * pipeline could turn "we told you to add a 17:00 slot" into a number. A field
 * that is always null is a field nobody should have added.
 *
 * This measures it by REPLAY. Every logged row in a gap is a real search that
 * really found nothing. Re-run each one against the supply that exists *now*,
 * with the same predicate the traveller's search used, and count how many would
 * now find something bookable. That is not a prediction of the future and never
 * claims to be: it is a statement about demand that already happened, re-tested
 * against supply that now exists. Those seven searches either would have been
 * served yesterday or they would not, and this says which.
 *
 * What it deliberately does NOT do: estimate what will happen *after* a provider
 * acts. That is a counterfactual, and an open opportunity therefore carries
 * `estimatedImpact: null` — nothing has been acted on yet, so there is nothing
 * measured to report. A number there would be a prediction wearing a
 * measurement's clothes.
 *
 * Reuses `hardChecks` — the same predicate that decided the search found nothing
 * — so "satisfied" means what "unsatisfied" meant. A different rule here would
 * make the two numbers incomparable and the whole measurement a decoration.
 */
import type { Category, Experience, UnmetDemand } from "../../contracts";
import { distanceKm, hardChecks, type SearchShape } from "./demand";
import { type Calendar, localDate, localMinutesOfDay, MUMBAI_TZ_OFFSET_MIN, usableSlots } from "./slots";

export interface Measurement {
  /** Logged searches in the gap. The denominator, always present. */
  total: number;
  /** How many would now find at least one listing they could actually book. */
  satisfied: number;
  /** Of those, how many `targetListingId` alone would have served. */
  byTarget: number;
  /** Listing ids that would serve at least one of them, deduped and sorted. */
  servedBy: string[];
  /** Rendered for the contract field. Null when nothing is served yet. */
  estimatedImpact: string | null;
}

export interface MeasureOptions {
  /** ISO datetime the window ends on. `today` for the calendar comes from here. */
  asOf: string;
  radiusKm: number;
  /** The gap's resolved category. Null means "any", and the trade is not narrowed. */
  category: Category | null;
  /** The provider's calendar. Omit to measure listings only, with no bookability. */
  calendar?: Calendar;
  tzOffsetMin?: number;
  /** Whose listing to attribute to, when the caller is asking about one provider. */
  targetListingId?: string | null;
}

/** The traveller's own shape, from their own row. Not the cell's medians. */
function shapeOf(row: UnmetDemand, radiusKm: number): SearchShape {
  return {
    point: row.point,
    radiusKm,
    availableMin: row.constraints.availableMin,
    budgetMinor: row.constraints.budgetMinor,
    partySize: row.constraints.partySize,
    accessNeeds: row.constraints.accessNeeds,
    weather: row.constraints.weather.trim().toLowerCase() as SearchShape["weather"],
  };
}

/** The centre of mass the trade is measured from, so a row keeps its own point. */
function centroid(rows: readonly UnmetDemand[]): { lat: number; lon: number } {
  return {
    lat: rows.reduce((sum, row) => sum + row.point.lat, 0) / Math.max(1, rows.length),
    lon: rows.reduce((sum, row) => sum + row.point.lon, 0) / Math.max(1, rows.length),
  };
}

/**
 * Replay every logged search in a gap against the supply that exists now.
 *
 * `byTarget` is deliberately not the whole of `satisfied`: when three listings in
 * range could each have taken the booking, crediting all of it to one provider's
 * dashboard is a lie, so the split is reported and the unattributed remainder is
 * left unattributed. `trade` is sorted by id so the attribution does not depend
 * on which listing happened to be handed over first.
 */
export function measureGap(
  rows: readonly UnmetDemand[],
  catalogue: readonly Experience[],
  opts: MeasureOptions,
): Measurement {
  const tz = opts.tzOffsetMin ?? MUMBAI_TZ_OFFSET_MIN;
  const today = localDate(opts.asOf, tz);
  const centre = centroid(rows);
  const trade = catalogue
    .filter(
      (listing) =>
        distanceKm(centre, listing.location) <= opts.radiusKm &&
        (opts.category === null || listing.category === opts.category),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let satisfied = 0;
  let byTarget = 0;
  const servedBy = new Set<string>();

  for (const row of rows) {
    const shape = shapeOf(row, opts.radiusKm);
    const window = {
      arriveMin: localMinutesOfDay(row.at, tz),
      availableMin: row.constraints.availableMin,
      partySize: row.constraints.partySize,
    };
    let hit: string | null = null;
    for (const listing of trade) {
      if (hardChecks(shape, listing).length > 0) continue;
      if (opts.calendar !== undefined && usableSlots(listing, opts.calendar, today, window).length === 0) continue;
      hit = listing.id;
      break;
    }
    if (hit === null) continue;
    satisfied += 1;
    servedBy.add(hit);
    if (opts.targetListingId != null && hit === opts.targetListingId) byTarget += 1;
  }

  return {
    total: rows.length,
    satisfied,
    byTarget,
    servedBy: [...servedBy].sort(),
    estimatedImpact: impactSentence(rows.length, satisfied, byTarget, opts.targetListingId ?? null),
  };
}

/**
 * The sentence lands in the contract field and will be read by a provider with no
 * context, so it names the denominator: "5 of 7" and "5" are different claims and
 * only one of them is honest. Says "would now find" rather than "found", because
 * nothing has been booked yet.
 */
function impactSentence(total: number, satisfied: number, byTarget: number, targetId: string | null): string | null {
  if (total === 0 || satisfied === 0) return null;
  const lead = `${satisfied} of the ${total} logged searches would now find something bookable`;
  const tail = targetId === null || byTarget === 0 ? "" : `, ${byTarget} of them on this listing alone`;
  return `${lead}${tail}. Measured by re-running those searches against today's listings and slots.`;
}
