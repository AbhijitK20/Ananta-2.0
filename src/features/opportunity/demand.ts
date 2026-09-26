/**
 * Traveller request -> unmet demand. The top of the opportunity pipeline, and
 * the piece that did not exist: every `UnmetDemand` row in this repo until now
 * was hand-written seed data, so nothing proved the records could be produced
 * from a real search.
 *
 * One predicate does the work — `hardChecks` — and it is used in BOTH directions:
 * to decide a traveller got nothing, and to decide whether a listing now serves
 * a gap. That symmetry is load-bearing. If the two used different rules, "supply
 * has arrived" could mean two different things and the whole decline behaviour
 * would be a guess. So every check below reads only fields that `UnmetDemand`
 * actually logs (availableMin, budget, partySize, accessNeeds, weather, point),
 * which is also why a gap can be re-tested against supply later at all.
 *
 * Deterministic: no clock, no randomness, no I/O. Same request + same catalogue
 * always gives the same rejections and the same row.
 *
 * ponytail: ceiling — the check set is the eight hard constraints that a logged
 * `UnmetDemand` row can reproduce. Left out on purpose, because a gap could
 * never be re-tested against supply without them: `diet_mismatch` and
 * `minAge` (the row logs neither), `closed_now` / `hours_unverified` (needs the
 * real `opening_hours` adapter in `src/engine/hours.ts`, and a clock), and
 * `seasonal_mismatch` (needs a month). Add each with its column on `UnmetDemand`
 * when that contract change lands; a fix that cannot be re-tested is a fix that
 * cannot be shown to have worked.
 */
import {
  type AccessNeed,
  type DiscoveryContext,
  type Experience,
  type GeoPoint,
  type Rejection,
  type RejectionCode,
  UnmetDemand,
} from "../../contracts";

/** How far a traveller will travel. Beyond this, `too_far`. */
export const RADIUS_KM = 2;

/**
 * Great-circle distance in km. Duplicated from `analytics/aggregate.ts` on
 * purpose: cross-feature imports do not exist anywhere in this repo, and this
 * must not break when an unrelated feature moves. Hoist to `src/lib/geo.ts`
 * (Abhijit's path) when two call sites can agree on it in one commit.
 */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))) * 1000) / 1000;
}

export const inr = (minor: number | null): string =>
  minor === null ? "no limit" : `₹${(minor / 100).toLocaleString("en-IN")}`;

export const mins = (m: number): string => {
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
};

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** The conditions that make an outdoor experience unsafe. The logged weather. */
const WET = new Set<DiscoveryContext["weather"]["condition"]>(["light_rain", "heavy_rain", "storm"]);

/**
 * The traveller's situation, reduced to exactly the fields a logged
 * `UnmetDemand` row carries. `point` and `radiusKm` come from the request, not
 * from the traveller's words, and a gap reconstructs them from its own centroid.
 */
export interface SearchShape {
  point: GeoPoint;
  radiusKm: number;
  availableMin: number;
  budgetMinor: number | null;
  partySize: number;
  accessNeeds: readonly AccessNeed[];
  weather: DiscoveryContext["weather"]["condition"];
  /** Traveller-side exclusions. Never a supply signal; carried for the tally. */
  excludedIds?: readonly string[];
  alreadyPlannedIds?: readonly string[];
}

/** `wheelchair` is the traveller's word; `stepFree` is the listing's field. */
const ACCESS_CHECK: ReadonlyArray<readonly [AccessNeed, keyof Experience["accessibility"], RejectionCode, string]> = [
  ["wheelchair", "stepFree", "not_step_free", "step-free access"],
  ["stroller", "strollerOk", "not_stroller_ok", "stroller access"],
  ["lowStairs", "lowStairs", "no_low_stairs", "few stairs"],
  ["hearingLoop", "hearingLoop", "no_hearing_loop", "a hearing loop"],
  ["restroom", "restroomOnSite", "no_restroom", "a restroom on site"],
];

/**
 * Every hard constraint `listing` fails for this traveller, as contract
 * `Rejection`s. Order is fixed so two runs produce the same array.
 *
 * Accessibility rejects on `null` as well as `false`, and the message says which
 * it was. That is the whole reason `Accessibility` fields are three-valued: a
 * provider who has never surveyed step-free access cannot be promised it, so
 * the traveller is right to skip it — and the opportunity then says "confirm",
 * not "add".
 */
export function hardChecks(shape: SearchShape, listing: Experience): Rejection[] {
  const out: Rejection[] = [];
  const add = (
    code: RejectionCode,
    message: string,
    shortfall: number | null,
    unit: Rejection["unit"],
    relaxable: boolean,
  ): void => {
    out.push({ experienceId: listing.id, code, message, shortfall, unit, relaxable });
  };

  const km = distanceKm(shape.point, listing.location);
  if (km > shape.radiusKm) {
    add("too_far", `${km} km away, past the ${shape.radiusKm} km you are searching.`, Math.round((km - shape.radiusKm) * 1000), "metres", true);
  }

  if (listing.durationMin > shape.availableMin) {
    add(
      "duration_exceeds_budget",
      `Needs ${mins(listing.durationMin - shape.availableMin)} more than the ${mins(shape.availableMin)} you have.`,
      listing.durationMin - shape.availableMin,
      "minutes",
      true,
    );
  }

  const price = listing.pricePerPerson?.minor ?? null;
  const total = price === null ? null : price * shape.partySize;
  if (total !== null && shape.budgetMinor !== null && total > shape.budgetMinor) {
    add(
      "over_budget",
      `${inr(price)} a head for ${shape.partySize} ${plural(shape.partySize, "person", "people")} is ${inr(total)}, over your ${inr(shape.budgetMinor)}.`,
      total - shape.budgetMinor,
      "minor_units",
      true,
    );
  }

  if (listing.capacity !== null && listing.capacity < shape.partySize) {
    add(
      "capacity_exceeded",
      `Seats ${listing.capacity}; there ${shape.partySize === 1 ? "is 1 of you" : `are ${shape.partySize} of you`}.`,
      shape.partySize - listing.capacity,
      "people",
      true,
    );
  }

  for (const [need, field, code, label] of ACCESS_CHECK) {
    if (!shape.accessNeeds.includes(need)) continue;
    const value = listing.accessibility[field];
    if (value === true) continue;
    add(
      code,
      value === false ? `No ${label}.` : `${label.charAt(0).toUpperCase()}${label.slice(1)} has never been confirmed.`,
      null,
      null,
      true,
    );
  }

  if (WET.has(shape.weather) && (listing.weatherSensitive === "rain" || listing.weatherSensitive === "any") && listing.indoorOutdoor === "outdoor") {
    add("weather_unsafe", `Outdoors, and it is ${shape.weather.replace("_", " ")}.`, null, null, true);
  }

  if (listing.booking.required && !listing.booking.walkIn) {
    add("requires_booking_not_available", "Booking required, and walk-ins are not possible.", null, null, true);
  }

  if (listing.booking.required && listing.booking.leadTimeMin > shape.availableMin) {
    add(
      "lead_time_too_short",
      `Needs ${mins(listing.booking.leadTimeMin)} of notice; you have ${mins(shape.availableMin)}.`,
      listing.booking.leadTimeMin - shape.availableMin,
      "minutes",
      true,
    );
  }

  if (shape.excludedIds?.includes(listing.id) === true) {
    add("excluded_by_traveller", "You ruled this one out.", null, null, false);
  }
  if (shape.alreadyPlannedIds?.includes(listing.id) === true) {
    add("already_planned", "Already in your plan.", null, null, false);
  }

  return out;
}

/**
 * How far retrieval looks. This is a locality prior, not the search radius: a
 * traveller in Bandra is not shown a craft workshop in Fort, so those rows never
 * reach the feasibility check and never get to out-count the blockers that a
 * provider 400 m away could actually fix. The hard `radiusKm` gate stays in
 * `hardChecks` — this only decides what is worth checking.
 */
export const SEARCH_SPREAD_KM = 6;

/**
 * Retrieve -> feasibility, the two stages a real search goes through.
 *
 * Retrieval here is the catalogue matching its OWN vocabulary: a listing is a
 * candidate when the traveller's words hit its category, name, keywords or
 * blurb. No hand-written keyword table, because the catalogue is the vocabulary
 * and a table we invented would only encode our guesses about it. A traveller
 * who stated no interest gets the whole catalogue, which is what "no stated
 * interest" means.
 *
 * ponytail: ceiling — bag-of-words overlap, no ranking, no embeddings. Swap for
 * `engine.retrieve(RetrieveInput)` when `src/engine` lands; the stage boundary
 * below is already the one the port describes, so the swap deletes this function
 * and touches nothing else.
 */
export function retrieveCandidates(
  interests: readonly string[],
  catalogue: readonly Experience[],
  opts: { point?: GeoPoint; withinKm?: number } = {},
): Experience[] {
  const tokens = [...new Set(interests.flatMap((text) => text.toLowerCase().split(/[^a-z0-9+]+/)).filter((t) => t.length >= 3))].sort();
  const near = opts.point;
  const withinKm = opts.withinKm ?? SEARCH_SPREAD_KM;
  const inReach = (listing: Experience): boolean =>
    near === undefined || distanceKm(near, listing.location) <= withinKm;

  if (tokens.length === 0) return catalogue.filter(inReach);

  const scored: Array<{ listing: Experience; score: number }> = [];
  for (const listing of catalogue) {
    if (!inReach(listing)) continue;
    const haystack = [listing.category.replace(/_/g, " "), listing.name, listing.blurb ?? "", ...listing.keywords]
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const token of tokens) if (haystack.includes(token)) score += 1;
    if (score > 0) scored.push({ listing, score });
  }
  return scored
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.listing.id < b.listing.id ? -1 : 1))
    .map((entry) => entry.listing);
}

export interface TravellerRequest {
  travellerId: string;
  /** ISO datetime of the search. Injected, never `Date.now()`. */
  at: string;
  /** Where they are searching from. Required: a gap with no location is not actionable. */
  point: GeoPoint;
  neighbourhood: string | null;
  ctx: DiscoveryContext;
}

export interface SearchOutcome {
  travellerId: string;
  /** What retrieval offered the feasibility check. Evidence of what was searched. */
  retrieved: number;
  rejections: Rejection[];
  /** Listing ids that passed every hard check. Empty means the search found nothing. */
  passed: string[];
  /**
   * True when retrieval returned nothing at all, so there is no candidate and
   * therefore no constraint to blame. No `UnmetDemand` row is written for it:
   * the contract's `topBlockingCode` has no value for "nothing matched the
   * interest", and inventing one — `too_far` with a count of 0 — would put a
   * distance claim into the provider feed that nothing supports. Reported as a
   * contract gap instead. See `docs`-level note in the feature header.
   */
  nothingMatched: boolean;
  /** Present only when `passed` is empty AND there was a candidate to fail. */
  demand: UnmetDemand | null;
}

/**
 * The binding constraint, per the contract: whichever code eliminated the most
 * candidates. Ties break on the code string, not on insertion order, so the
 * same catalogue always names the same blocker.
 */
export function topBlocker(rejections: readonly Rejection[]): { code: RejectionCode; count: number } {
  const counts = new Map<RejectionCode, number>();
  for (const rejection of rejections) {
    counts.set(rejection.code, (counts.get(rejection.code) ?? 0) + 1);
  }
  let best: { code: RejectionCode; count: number } = { code: "too_far", count: 0 };
  for (const [code, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > best.count) best = { code, count };
  }
  return best;
}

/** Deterministic and stable: the same search logged twice is the same row. */
export function demandId(request: TravellerRequest): string {
  return `ud-${request.travellerId}-${Date.parse(request.at)}`;
}

/**
 * Run one real search and log it when it found nothing.
 *
 * `budgetMinor` is the traveller's total ceiling when they gave one. A
 * per-person-only budget is not logged: the contract has one budget column, and
 * filling it with a per-head figure would make the total check wrong for a party
 * of four. The cost of that choice is a missed signal, never a false one.
 */
export function searchTraveller(
  request: TravellerRequest,
  catalogue: readonly Experience[],
  opts: { radiusKm?: number } = {},
): SearchOutcome {
  const shape: SearchShape = {
    point: request.point,
    radiusKm: opts.radiusKm ?? RADIUS_KM,
    availableMin: request.ctx.availableMin,
    budgetMinor: request.ctx.budget?.minor ?? null,
    partySize: request.ctx.partySize,
    accessNeeds: request.ctx.accessNeeds,
    weather: request.ctx.weather.condition,
    excludedIds: request.ctx.excludedIds,
    alreadyPlannedIds: request.ctx.pinnedIds,
  };

  const candidates = retrieveCandidates(request.ctx.interests, catalogue, { point: request.point });
  const rejections: Rejection[] = [];
  const passed: string[] = [];
  for (const listing of candidates) {
    const failures = hardChecks(shape, listing);
    if (failures.length === 0) passed.push(listing.id);
    else rejections.push(...failures);
  }

  if (passed.length > 0 || rejections.length === 0) {
    return {
      travellerId: request.travellerId,
      retrieved: candidates.length,
      rejections,
      passed,
      nothingMatched: passed.length === 0,
      demand: null,
    };
  }

  const top = topBlocker(rejections);
  return {
    travellerId: request.travellerId,
    retrieved: candidates.length,
    rejections,
    passed,
    nothingMatched: false,
    demand: UnmetDemand.parse({
      id: demandId(request),
      travellerId: request.travellerId,
      point: request.point,
      neighbourhood: request.neighbourhood,
      at: request.at,
      constraints: {
        availableMin: request.ctx.availableMin,
        budgetMinor: request.ctx.budget?.minor ?? null,
        partySize: request.ctx.partySize,
        accessNeeds: [...request.ctx.accessNeeds],
        interests: [...request.ctx.interests],
        weather: request.ctx.weather.condition,
      },
      // Zero results returned. The useful count is `topBlockingCount`: the
      // contract keeps only the binding blocker, so "candidates eliminated in
      // total" is not recoverable from a logged row and is never claimed.
      shortfallCount: 0,
      topBlockingCode: top.code,
      topBlockingCount: top.count,
    }),
  };
}
