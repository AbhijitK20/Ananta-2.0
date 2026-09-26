/**
 * THE FEASIBILITY GATE — 12 hard constraints, zero exceptions.
 *
 * This is the module that makes the product honest. Everything downstream
 * (scoring, packing, the UI) may only *reorder* what survives here. Nothing
 * downstream is allowed to put something back.
 *
 * Three properties this file is built to guarantee:
 *
 *  1. TOTALITY. Every drop produces a `Rejection` carrying a FINISHED SENTENCE
 *     with a real number interpolated from actual values. "Needs 40 min more
 *     than you have left", never "constraint violated" and never a bare code
 *     name. If the traveller cannot read *why*, the gate has failed even when
 *     it returned the right answer.
 *
 *  2. PER-ATTRIBUTE ATTRIBUTION. When several constraints bind, the traveller
 *     is told the *shortfall* in its unit (minutes / minor_units / people), so
 *     the relaxation ladder in replanner.ts can offer the exact change that
 *     would fix it rather than a vague "try loosening something".
 *
 *  3. DETERMINISM. No clock reads, no network, no randomness, no model. Same
 *     (context, candidate) in, same verdict out. That is what lets
 *     validator.ts independently recompute our work in Session 4 and still
 *     agree — and it is why the LLM boundary test in tests/boundary.test.ts
 *     forbids any model import under src/engine/.
 *
 * ORDERING. Checks run cheapest-first: set lookups, then integer comparisons,
 * then field reads, and only last the opening-hours parse. With 250 candidates
 * that is the difference between an instant gate and a visible pause, and it
 * guarantees we never pay for a spec parse on something already excluded.
 *
 * UNKNOWN IS NOT FALSE. Where a source field is `null` we do not treat it as a
 * failing constraint. An accessibility flag nobody has surveyed is not evidence
 * of a step. A missing diet list is not proof the kitchen serves no vegan food.
 * We reject only what we can positively show to be a mismatch, and we say so
 * in the note below each check. The alternative — treating unknown as false —
 * silently deletes most of a real city catalogue, and a missing answer is
 * always more honest than a wrong one.
 */
import type {
  AccessNeed,
  DiscoveryContext,
  Experience,
  FeasibleResult,
  Rejection,
  RejectionCode,
  Slot,
} from "@/contracts";
import { formatMoney, totalForParty } from "@/lib/money";
import {
  MINUTES_PER_DAY,
  MUMBAI,
  formatDuration,
  isoWeekdayName,
  type Weekday,
} from "@/lib/time";
import { describe, isOpenDuring } from "./hours";

/**
 * A catalogue row plus the travel facts the gate needs. `retrieve.ts`
 * (Session 2) is contracted to return exactly this shape — travel time is
 * computed there and cached, never recomputed per-candidate here, because that
 * would turn a 250-row gate into 250 routing calls.
 */
export interface Candidate {
  experience: Experience;
  /** Origin -> venue travel time, minutes. From the routing facade. */
  travelMin: number;
  /** Origin -> venue distance in metres, for `too_far` copy. Null if unknown. */
  distanceM?: number | null;
  /** The bookable slot under consideration, when this experience needs one. */
  slot?: Slot | null;
}

export interface FilterOptions {
  /**
   * Day of week for the visit. **`Weekday` from `lib/time`, so 0 = MONDAY**,
   * matching OSM's `Mo..Su` ordering and `hours.ts`. This was previously
   * documented as "0 = Sunday", which was wrong: the value is forwarded
   * unchanged to `hours.isOpenDuring`, so a caller following the old docstring
   * silently evaluated Monday's hours on a Sunday. `lib/time` is the single
   * source of truth for this; use `weekdayOf(date)` rather than a literal.
   *
   * `DiscoveryContext` carries `nowMin` (minutes from local midnight) but no
   * calendar date, so the day of week is not derivable from it. Rather than
   * bake in a default that is silently wrong on six days out of seven, the
   * caller states it. The engine stays date-agnostic, which also makes the
   * tests deterministic.
   */
  weekday: Weekday;

  /**
   * Calendar month, 1-12, for the `seasonal_mismatch` check. Optional, and
   * omitting it DISABLES the season gate rather than guessing a month.
   *
   * Same reasoning as `weekday`: a wrong month would reject a good beach in
   * January. A skipped gate is recoverable; a wrong one is not. 250 records
   * that mostly carry an empty `bestMonths` means this rarely bites anyway.
   */
  month?: number | null;

  /**
   * Travel-time contour around the origin, in minutes. An isochrone *is* a
   * travel-time threshold, so `travelMin <= isochroneMin` is exactly the
   * geometric containment test, and it needs no geometry dependency.
   * Omit when the caller has no isochrone; `travel_time_exceeds_budget` then
   * carries the whole reachability burden and `too_far` never fires.
   */
  isochroneMin?: number | null;

  /**
   * Per-transition overhead, so a plan is not knife-edge: ticket queues, monsoon
   * walking, finding the entrance. Travel is also charged a mode-dependent
   * fraction, because a 40 min transit leg deserves more slack than a 6 min walk.
   * 10 min fixed + 15-25% of travel.
   */
  buffer?: { fixedMin: number; travelRatio: number };

  /**
   * Reject when opening hours are missing or unparsable, instead of letting the
   * item through with an "hours unverified" badge.
   *
   * Default FALSE, and deliberately so. OSM hours carry "PH off" and inline
   * comments that the parser cannot read; rejecting on those would hide real
   * venues because of a data-entry quirk in someone else's edit. Pass true for
   * eval runs where a hard guarantee is wanted.
   */
  strictHours?: boolean;

  /** Minutes of notice the traveller can still give. From the session start. */
  noticeMin?: number;
}

const DEFAULTS = {
  buffer: { fixedMin: 10, travelRatio: 0.2 },
  strictHours: false,
  noticeMin: 0,
} as const;

const CONDITION_COPY: Record<string, string> = {
  clear: "clear",
  cloudy: "overcast",
  light_rain: "raining lightly",
  heavy_rain: "pouring rain",
  storm: "a storm",
  heat: "extreme heat",
  wind: "high wind",
};

/** Mumbai only becomes genuinely unsafe above this, not at 30C. */
const HEAT_UNSAFE_C = 38;

/** How much slack to add on top of a travel leg. */
export function bufferFor(travelMin: number, mode: string, opts: FilterOptions): number {
  const b = opts.buffer ?? DEFAULTS.buffer;
  return b.fixedMin + Math.ceil(Math.max(0, travelMin) * b.travelRatio);
}

function reject(
  experienceId: string,
  code: RejectionCode,
  message: string,
  extra: { shortfall?: number; unit?: Rejection["unit"]; relaxable?: boolean } = {},
): Rejection {
  return {
    experienceId,
    code,
    message,
    shortfall: extra.shortfall ?? null,
    unit: extra.unit ?? null,
    relaxable: extra.relaxable ?? false,
  };
}

const pluralPeople = (n: number) => (n === 1 ? "person" : "people");

/** Cost of the whole party. Null price means "we do not know", not "free". */
export function partyCost(exp: Experience, partySize: number) {
  if (exp.pricePerPerson === null) return null;
  return totalForParty(exp.pricePerPerson, partySize);
}

/** Free slots remaining on a slot, computed rather than stored (see Slot). */
export function slotRemaining(slot: Slot): number {
  const h = slot.held;
  return slot.capacity - h.pendingOrders - h.confirmedOrders - h.carts;
}

// ---------------------------------------------------------------------------
// THE CHECKS
// ---------------------------------------------------------------------------

/** 1. The same venue appearing twice in one candidate list is a data bug. */
function checkDuplicate(c: Candidate, seen: ReadonlySet<string>): Rejection | null {
  if (!seen.has(c.experience.id)) return null;
  return reject(
    c.experience.id,
    "duplicate",
    `${c.experience.name} came back twice in the same search.`,
  );
}

/** 2. Explicitly avoided. Cheapest possible check, so it runs first. */
function checkExcluded(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  if (!ctx.excludedIds.includes(c.experience.id)) return null;
  return reject(
    c.experience.id,
    "excluded_by_traveller",
    `You asked to skip ${c.experience.name}, so we've left it out.`,
  );
}

/** 3. Already pinned by the traveller, so it is not up for selection. */
function checkAlreadyPlanned(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  if (!ctx.pinnedIds.includes(c.experience.id)) return null;
  return reject(
    c.experience.id,
    "already_planned",
    `${c.experience.name} is already in your plan, so it isn't a new option.`,
  );
}

/** 4. Hard capacity, from the catalogue. Null capacity means unknown, not zero. */
function checkCapacity(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  const cap = c.experience.capacity;
  if (cap === null) return null;
  if (cap >= ctx.partySize) return null;
  return reject(
    c.experience.id,
    "capacity_exceeded",
    `${c.experience.name} holds at most ${cap} ${pluralPeople(cap)}, and there are ${ctx.partySize} of you.`,
    { shortfall: ctx.partySize - cap, unit: "people", relaxable: true },
  );
}

/** 5a. Total party cost against the total budget. */
function checkBudget(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  if (ctx.budget === null) return null;
  const cost = partyCost(c.experience, ctx.partySize);
  if (cost === null) return null;
  if (cost.minor <= ctx.budget.minor) return null;
  const over = cost.minor - ctx.budget.minor;
  return reject(
    c.experience.id,
    "over_budget",
    `${c.experience.name} costs ${formatMoney(cost)} for ${ctx.partySize} ${pluralPeople(ctx.partySize)}, which is ${formatMoney({ minor: over, currency: cost.currency })} over your ${formatMoney(ctx.budget)} budget.`,
    { shortfall: over, unit: "minor_units", relaxable: true },
  );
}

/** 5b. Per-person price against a per-person budget. Distinct from 5a because
 *  a ₹400 plate is affordable for two and not for eight; a flat total would
 *  hide that. */
function checkBudgetPerPerson(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  if (ctx.budgetPerPerson === null) return null;
  const ppp = c.experience.pricePerPerson;
  if (ppp === null) return null;
  if (ppp.minor <= ctx.budgetPerPerson.minor) return null;
  const over = ppp.minor - ctx.budgetPerPerson.minor;
  return reject(
    c.experience.id,
    "over_budget_per_person",
    `${c.experience.name} is ${formatMoney(ppp)} a head, which is ${formatMoney({ minor: over, currency: ppp.currency })} over your ${formatMoney(ctx.budgetPerPerson)} per-person limit.`,
    { shortfall: over, unit: "minor_units", relaxable: true },
  );
}

/** 6. Seasonality. Empty `bestMonths` means year-round, which is the common
 *  case, so most records never reach a decision here. */
function checkSeason(c: Candidate, opts: FilterOptions): Rejection | null {
  const months = c.experience.bestMonths;
  if (months.length === 0) return null;
  const month = opts.month;
  if (month === null || month === undefined) return null;
  if (months.includes(month)) return null;
  return reject(
    c.experience.id,
    "seasonal_mismatch",
    `${c.experience.name} only runs in ${months.join(", ")}, and it's month ${month}.`,
  );
}

/** 7. Accessibility. Booleans, never a score — and never a soft penalty.
 *  A traveller who needs step-free access does not get a "mostly accessible"
 *  experience with a warning badge. */
const ACCESS_FIELD: Record<AccessNeed, keyof Experience["accessibility"]> = {
  wheelchair: "stepFree",
  stroller: "strollerOk",
  lowStairs: "lowStairs",
  hearingLoop: "hearingLoop",
  restroom: "restroomOnSite",
};

const ACCESS_CODE: Record<AccessNeed, RejectionCode> = {
  wheelchair: "not_step_free",
  stroller: "not_stroller_ok",
  lowStairs: "no_low_stairs",
  hearingLoop: "no_hearing_loop",
  restroom: "no_restroom",
};

const ACCESS_COPY: Record<AccessNeed, string> = {
  wheelchair: "has steps and no step-free entrance",
  stroller: "can't take a stroller",
  lowStairs: "has stairs with no low-stairs route",
  hearingLoop: "has no hearing loop",
  restroom: "has no restroom on site",
};

function checkAccessibility(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  if (ctx.accessNeeds.length === 0) return null;
  const failed = ctx.accessNeeds.filter((need) => {
    const v = c.experience.accessibility[ACCESS_FIELD[need]];
    return v === false;
  });
  if (failed.length === 0) return null;

  if (failed.length === 1) {
    const need = failed[0]!;
    return reject(
      c.experience.id,
      ACCESS_CODE[need],
      `${c.experience.name} ${ACCESS_COPY[need]}.`,
    );
  }
  const list = failed.map((n) => ACCESS_COPY[n]).join(", and ");
  return reject(c.experience.id, "inaccessible", `${c.experience.name} ${list}.`);
}

/** 8. Diet. Only rejects on a provable mismatch: both sides known, disjoint.
 *  A venue with an empty diet list is unknown, not non-vegan. */
function checkDiet(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  if (ctx.diets.length === 0) return null;
  const have = c.experience.diets;
  if (have.length === 0) return null;
  const ok = ctx.diets.some((d) =>
    have.some((h) => h.toLowerCase() === d.toLowerCase() || h.toLowerCase().includes(d.toLowerCase())),
  );
  if (ok) return null;
  return reject(
    c.experience.id,
    "diet_mismatch",
    `${c.experience.name} is listed as ${have.join(", ")}, which doesn't cover ${ctx.diets.join(", ")}.`,
  );
}

/** 9. Slot availability. Remaining capacity is computed, not stored, and carts
 *  are counted as taken because somebody is mid-checkout on them. */
function checkSlot(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  const slot = c.slot ?? null;
  if (slot !== null) {
    if (slot.status === "gone") {
      return reject(
        c.experience.id,
        "sold_out",
        `The ${MUMBAI.format(slot.startMin)} slot for ${c.experience.name} is sold out.`,
      );
    }
    const left = slotRemaining(slot);
    if (left < ctx.partySize) {
      return reject(
        c.experience.id,
        "sold_out",
        `${c.experience.name} has ${left} ${pluralPeople(left)} left in this slot, and there are ${ctx.partySize} of you.`,
        { shortfall: ctx.partySize - left, unit: "people", relaxable: true },
      );
    }
    return null;
  }

  if (!c.experience.booking.required) return null;
  if (c.experience.booking.walkIn) return null;
  return reject(
    c.experience.id,
    "requires_booking_not_available",
    `${c.experience.name} is booking-only, and there are no slots left for your window.`,
  );
}

/** 10. Booking notice. Walk-in venues are unaffected. */
function checkLeadTime(c: Candidate, opts: FilterOptions): Rejection | null {
  const b = c.experience.booking;
  if (!b.required) return null;
  const need = b.leadTimeMin;
  if (need <= 0) return null;
  const have = opts.noticeMin ?? DEFAULTS.noticeMin;
  if (have >= need) return null;
  return reject(
    c.experience.id,
    "lead_time_too_short",
    `${c.experience.name} needs ${formatDuration(need)} notice to book, and you have ${formatDuration(have)} left.`,
    { shortfall: need - have, unit: "minutes", relaxable: true },
  );
}

/** 11. Weather. An outdoor venue in a storm is a safety matter, not a
 *  preference, so this is a hard gate. Heat is judged against a real Mumbai
 *  threshold rather than any temperature, because 30C is simply Tuesday here. */
function checkWeather(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  const w = ctx.weather;
  if (w.source === "unknown") return null;

  const cond = w.condition;
  const sens = c.experience.weatherSensitive;
  const exposed = c.experience.indoorOutdoor === "outdoor";

  const wet = cond === "light_rain" || cond === "heavy_rain" || cond === "storm";
  const stormy = cond === "storm";
  const hot = cond === "heat" && w.tempC >= HEAT_UNSAFE_C;

  let unsafe: boolean;
  if (exposed) {
    // Anything genuinely wet, or genuinely dangerous heat, rules out being outside.
    unsafe = wet || hot;
  } else if (sens === "rain") {
    unsafe = wet;
  } else if (sens === "heat") {
    unsafe = hot;
  } else if (sens === "wind") {
    unsafe = stormy || cond === "wind";
  } else if (sens === "any") {
    unsafe = wet;
  } else {
    unsafe = false;
  }

  if (!unsafe) return null;
  return reject(
    c.experience.id,
    "weather_unsafe",
    `${c.experience.name} is ${exposed ? "outdoors" : "weather-sensitive"}, and right now it's ${CONDITION_COPY[cond] ?? cond}${hot ? ` at ${Math.round(w.tempC)}°C` : ""}.`,
    { relaxable: true },
  );
}

/** 12. Duration against the whole window. */
function checkDuration(c: Candidate, ctx: DiscoveryContext): Rejection | null {
  const d = c.experience.durationMin;
  if (d <= ctx.availableMin) return null;
  return reject(
    c.experience.id,
    "duration_exceeds_budget",
    `${c.experience.name} takes ${formatDuration(d)}, which is more than the ${formatDuration(ctx.availableMin)} you have in total.`,
    { shortfall: d - ctx.availableMin, unit: "minutes", relaxable: true },
  );
}

/** 13. Travel + buffer against what is left after the activity. Attributed
 *  precisely so the copy can name the binding side. */
function checkTravelTime(
  c: Candidate,
  ctx: DiscoveryContext,
  opts: FilterOptions,
): Rejection | null {
  const buffer = bufferFor(c.travelMin, ctx.travelMode, opts);
  const left = ctx.availableMin - c.experience.durationMin;
  if (left <= 0) return null; // checkDuration already spoke.
  const need = c.travelMin + buffer;
  if (need <= left) return null;
  return reject(
    c.experience.id,
    "travel_time_exceeds_budget",
    `Getting to ${c.experience.name} and finishing there takes ${formatDuration(need)} once you add ${formatDuration(buffer)} of slack, but that leaves only ${formatDuration(left)} — short by ${formatDuration(need - left)}.`,
    { shortfall: need - left, unit: "minutes", relaxable: true },
  );
}

/** 14. Isochrone reachability. A distance in metres when we have it, because
 *  that is the unit a human uses for "how far is that". */
function checkTooFar(c: Candidate, ctx: DiscoveryContext, opts: FilterOptions): Rejection | null {
  const iso = opts.isochroneMin;
  if (iso === null || iso === undefined) return null;
  if (c.travelMin <= iso) return null;
  const over = c.travelMin - iso;
  const where = c.distanceM != null ? ` (about ${(c.distanceM / 1000).toFixed(1)} km)` : "";
  return reject(
    c.experience.id,
    "too_far",
    `${c.experience.name} is ${formatDuration(c.travelMin)} from ${ctx.origin.label}${where}, which is ${formatDuration(over)} beyond the ${formatDuration(iso)} you can reach.`,
    { shortfall: over, unit: "minutes" },
  );
}

/** 15. Opening hours. Last, because it is the only check that parses a spec.
 *
 *  The window that must be covered is the time actually spent INSIDE, i.e.
 *  after travel, not the raw remaining window. A 14:00-17:00 window and a 40
 *  min journey means you need the doors open 14:40-17:00, not 14:00-17:00.
 *
 *  Nightlife crosses midnight, so the window is split at the day boundary and
 *  both halves must be covered on their own days. Checking a 23:00-01:00 visit
 *  as if it were same-day would reject every late bar in the city.
 */
function checkHours(
  c: Candidate,
  ctx: DiscoveryContext,
  opts: FilterOptions,
): Rejection | null {
  const h = c.experience.hours;
  const id = c.experience.id;
  const name = c.experience.name;
  const dayName = isoWeekdayName(opts.weekday);

  if (h.status === "unparsable" || h.status === "absent") {
    if (!opts.strictHours) return null;
    return reject(
      id,
      "hours_unverified",
      `We couldn't verify ${name}'s opening hours, so we won't promise it fits your window.`,
    );
  }

  const arrive = ctx.nowMin + c.travelMin;
  const stay = c.experience.durationMin;

  const first = ((arrive % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const overflow = arrive + stay - MINUTES_PER_DAY;

  const head = isOpenDuring(h, opts.weekday, first, MINUTES_PER_DAY);
  const tail =
    overflow > 0
      ? isOpenDuring(h, ((opts.weekday + 1) % 7) as Weekday, 0, overflow)
      : null;

  if (head.status === "absent" || head.status === "unparsable") {
    if (!opts.strictHours) return null;
    return reject(
      id,
      "hours_unverified",
      `We couldn't verify ${name}'s opening hours, so we won't promise it fits.`,
    );
  }

  const headOk = head.openForWholeVisit;
  const tailOk = tail === null || tail.openForWholeVisit;
  if (headOk && tailOk) return null;

  const openFor = head.openMinutesInVisit + (tail?.openMinutesInVisit ?? 0);

  if (openFor === 0) {
    return reject(
      id,
      "closed_now",
      `${name} is closed on ${dayName} (${describe(h, opts.weekday)}).`,
    );
  }

  return reject(
    id,
    "closed_during_window",
    `${name} is open for ${formatDuration(openFor)} on ${dayName}, but you need ${formatDuration(stay)} there, so you'd miss part of the visit.`,
    { shortfall: stay - openFor, unit: "minutes", relaxable: true },
  );
}


// ---------------------------------------------------------------------------
// PUBLIC API
// ---------------------------------------------------------------------------

/**
 * Apply every hard constraint. Returns the survivors and, for everything
 * dropped, a traveller-readable reason.
 *
 * `Rejection.relaxable` marks the drops the relaxation ladder in Session 4 can
 * act on. `too_far` and `excluded_by_traveller` are false by construction:
 * travelling further or overriding an explicit "not this" is a decision, not a
 * setting to nudge.
 */
export function filterFeasible(
  ctx: DiscoveryContext,
  candidates: readonly Candidate[],
  opts: FilterOptions,
): FeasibleResult {
  const passed: string[] = [];
  const rejected: Rejection[] = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const failure =
      checkDuplicate(c, seen) ??
      checkExcluded(c, ctx) ??
      checkAlreadyPlanned(c, ctx) ??
      checkCapacity(c, ctx) ??
      checkBudget(c, ctx) ??
      checkBudgetPerPerson(c, ctx) ??
      checkSeason(c, opts) ??
      checkAccessibility(c, ctx) ??
      checkDiet(c, ctx) ??
      checkSlot(c, ctx) ??
      checkLeadTime(c, opts) ??
      checkWeather(c, ctx) ??
      checkDuration(c, ctx) ??
      checkTravelTime(c, ctx, opts) ??
      checkTooFar(c, ctx, opts) ??
      checkHours(c, ctx, opts);

    seen.add(c.experience.id);

    if (failure === null) passed.push(c.experience.id);
    else rejected.push(failure);
  }

  return { passed, rejected };
}

/** One row of the meter's ledger, carrying the verdict it came from. */
interface LedgerRow {
  label: string;
  failure: Rejection | null;
  passDetail: string;
}

/**
 * One candidate, fully explained: the survival verdict, the per-check ledger the
 * feasibility meter renders, and the arithmetic behind the meter.
 *
 * Exists because the meter has to show *passing* constraints too — a traveller
 * deciding between two options needs to see what they are getting, not only what
 * was ruled out.
 */
export function explainFeasible(
  ctx: DiscoveryContext,
  c: Candidate,
  opts: FilterOptions,
): {
  ok: boolean;
  rejection: Rejection | null;
  checks: { label: string; pass: boolean; detail: string }[];
} {
  const exp = c.experience;
  const rows: LedgerRow[] = [];
  const add = (label: string, failure: Rejection | null, passDetail: string) => {
    rows.push({ label, failure, passDetail });
    return failure;
  };

  add(
    "Group size",
    checkCapacity(c, ctx),
    exp.capacity === null ? "No capacity limit listed" : `Holds up to ${exp.capacity}`,
  );

  const cost = partyCost(exp, ctx.partySize);
  add(
    "Budget",
    checkBudget(c, ctx),
    cost === null
      ? "Price not listed"
      : `${formatMoney(cost)} for ${ctx.partySize} of you${
          ctx.budget ? `, within ${formatMoney(ctx.budget)}` : ""
        }`,
  );

  add(
    "Accessibility",
    checkAccessibility(c, ctx),
    ctx.accessNeeds.length === 0
      ? "No access needs"
      : `Meets your ${ctx.accessNeeds.length} access ${ctx.accessNeeds.length === 1 ? "need" : "needs"}`,
  );

  add(
    "Food",
    checkDiet(c, ctx),
    ctx.diets.length === 0
      ? "No dietary requirements"
      : exp.diets.length === 0
        ? "No diet list yet"
        : exp.diets.join(", "),
  );

  add(
    "Weather",
    checkWeather(c, ctx),
    ctx.weather.source === "unknown"
      ? "Weather unknown, so no weather gate applied"
      : `${exp.indoorOutdoor} — fine in ${CONDITION_COPY[ctx.weather.condition] ?? ctx.weather.condition}`,
  );

  add(
    "Opening hours",
    checkHours(c, ctx, opts),
    `${describe(exp.hours, opts.weekday)} on ${isoWeekdayName(opts.weekday)}`,
  );

  const buffer = bufferFor(c.travelMin, ctx.travelMode, opts);
  const totalMin = c.travelMin + exp.durationMin + buffer;
  add(
    "Time",
    checkTravelTime(c, ctx, opts) ?? checkDuration(c, ctx),
    `${formatDuration(c.travelMin)} travel + ${formatDuration(exp.durationMin)} there + ${formatDuration(
      buffer,
    )} slack = ${formatDuration(totalMin)} of ${formatDuration(ctx.availableMin)}`,
  );

  const firstFailure = rows.find((r) => r.failure !== null)?.failure ?? null;

  return {
    ok: firstFailure === null,
    rejection: firstFailure,
    checks: rows.map((r) => ({
      label: r.label,
      pass: r.failure === null,
      detail: r.failure === null ? r.passDetail : r.failure.message,
    })),
  };
}
