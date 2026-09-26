/**
 * The gate: a deterministic `EnginePort` that implements all twelve feasibility
 * checks, and the test city it is exercised against.
 *
 * There are two reference engines in this folder and they are not duplicates:
 *
 *  - `referenceEngine.ts` drives the copilot. It re-packs from scratch and *skips*
 *    pinned ids, which is the right behaviour when there is no previous plan.
 *  - this one keeps pinned ids, with the times they already had, and then re-solves
 *    the rest. That is the only behaviour that can satisfy "a repair must not
 *    regenerate an activity the traveller has already done", so the repair tests
 *    need it and the copilot tests do not.
 *
 * Neither is a production engine. `src/engine/**` is Abhijit's path and is not in
 * the tree; Rule 2 says build against the contract and stub. Both files are replaced
 * wholesale when it lands, and the tests that use them assert on `DiscoveryContext`,
 * `Plan` and the `EnginePort` signature, none of which these files get to define.
 *
 * The point of this file is the twelve checks of `docs/FEATURES.md` §3. The contract
 * publishes 24 `RejectionCode`s, and before it, not one of them was produced by any
 * code in the repository: the gate was specified and unreachable at the same time.
 * Each check below emits the code the spec names, with a real number in the message
 * and in `shortfall`.
 *
 * Two of the twelve cannot be done properly, and that is a contract finding rather
 * than a gap in this file. `DiscoveryContext` carries `Minutes` — "minutes from local
 * midnight" — and no date, no weekday and no month. So "open for the whole visit
 * window" (check 3) and "in season" (check 12) have no calendar to ask. The engine
 * takes one as a parameter, defaults it, and puts it in the sentence it emits, so
 * the assumption is visible in the output instead of buried here. `isOpenDuring` in
 * the published engine API has the same hole: `hours, fromMin, toMin, lat, lon`, no
 * date. The fix is a date on `DiscoveryContext` and a date on `isOpenDuring`, which
 * is a Day 1 change to the frozen contract and not a call-site widening.
 */
import {
  type AccessNeed,
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type Fit,
  type GeoPoint,
  type Money,
  type Plan,
  type PlanStop,
  type Rejection,
  type RejectionCode,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type Slot,
  type SlotAvailability,
  type Swap,
  type TravelLeg,
  type ValidationResult,
  type WeightProfile,
  Plan as PlanSchema,
} from "../../../contracts";
import { INDOOR_TOKEN, WALK_TOKENS } from "../context";
import type { EnginePort, TravelMode } from "../engine";

export const ENGINE_VERSION = "gate-1";
const WET = new Set(["light_rain", "heavy_rain", "storm"]);

// ---------------------------------------------------------------------------
// The calendar the context cannot carry
// ---------------------------------------------------------------------------

export type Calendar = { weekday: number; month: number; name: string };

/** A Wednesday in February. Fixed, so a plan built twice is byte-identical. */
export const ASSUMED_CALENDAR: Calendar = { weekday: 3, month: 2, name: "Wednesday" };

/** Facts the engine holds that the traveller did not state. */
export type Facts = { slots: readonly Slot[]; calendar: Calendar };

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

const EARTH_M = 6_371_000;

/** Great-circle metres. The only source of distance in this file. */
export function metresBetween(from: GeoPoint, to: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a))));
}

/** m/min by mode. Walking is deliberately the slowest, which is the point. */
const SPEED: Record<TravelMode, number> = { walk: 75, auto: 320, transit: 260, ferry: 400 };

/** `travelMode` includes `"any"`, which is not a leg. The same map `diff.ts` uses. */
export const LEG_MODE: Record<DiscoveryContext["travelMode"], TravelMode> = {
  walk: "walk",
  auto: "auto",
  transit: "transit",
  any: "auto",
};

export const ORIGIN: GeoPoint = { lat: 19.0, lon: 72.87 };

export function legBetween(
  from: GeoPoint,
  to: GeoPoint,
  mode: TravelMode,
  fromId: string,
  toId: string,
): TravelLeg {
  const metres = metresBetween(from, to);
  return {
    fromId,
    toId,
    mode,
    minutes: Math.max(1, Math.round(metres / SPEED[mode])),
    metres,
    detail: null,
    estimated: true,
  };
}

const travelBetween = (from: GeoPoint, to: GeoPoint, mode: TravelMode): TravelLeg =>
  legBetween(from, to, mode, "from", "to");

const clock = (min: number): string =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------------------
// Check 1 — the walking limit, read back out of the tokens `context.ts` lowers into
// ---------------------------------------------------------------------------

/**
 * How far one stop may sit from the one before it, from the walking token in the
 * context. This is the engine's half of the `walking` preference: the feature writes
 * the token and this is the only code in the repo that acts on it. `Infinity` when
 * the traveller said nothing about walking.
 */
export function walkLimitPerLeg(ctx: DiscoveryContext): number {
  if (ctx.avoid.includes(WALK_TOKENS.minimal)) return 500;
  if (ctx.avoid.includes(WALK_TOKENS.low)) return 1200;
  return Number.POSITIVE_INFINITY;
}

const indoorsOnly = (ctx: DiscoveryContext): boolean => ctx.avoid.includes(INDOOR_TOKEN);

// ---------------------------------------------------------------------------
// Check 3 — opening hours
// ---------------------------------------------------------------------------

const DAY_INDEX: Record<string, number> = { su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6 };
const CLOSED_TOKENS = new Set(["off", "closed", "ph", "shut"]);

type Hours = { allDay: true } | { allDay: false; days: Set<number>; ranges: [number, number][] };

const hhmm = (token: string): number | null => {
  const match = /^(\d{1,2}):?(\d{2})$/.exec(token.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) return null;
  return Math.min(1440, hour * 60 + minute);
};

/**
 * The subset of the OSM grammar the fixtures need: `24/7`, `off`, day selectors,
 * multiple ranges, and a range that runs past midnight.
 *
 * Returns `null` for anything it does not fully understand, which the spec requires
 * to become `hours_unverified` rather than a crash or a silent pass. A two-ended
 * selector is a RUN of days, not a pair — see below, because getting that wrong looks
 * exactly like data quality.
 *
 * The real adapter is `src/engine/hours.ts` and wraps the npm `opening_hours` port.
 * This exists so the fixture is hermetic and deterministic, and it implements the same
 * contract: degrade, never throw.
 */
export function parseHours(raw: string): Hours | null {
  const text = raw.trim();
  // An empty expression is NOT "always open". It is no data, and no data has to become
  // `hours_unverified` rather than a 24/7 answer, or every row with a missing `raw`
  // would sail through the gate as if it were a theme park.
  if (text.toLowerCase() === "24/7") return { allDay: true };
  if (text === "") return null;

  const days = new Set<number>();
  const ranges: [number, number][] = [];
  let sawRule = false;

  for (const rule of text.split(";")) {
    const trimmed = rule.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split(/\s+/);
    const selector = (parts[0] ?? "").toLowerCase();
    // A bare `off` closes that rule. It is an answer, not an error.
    if (CLOSED_TOKENS.has(selector)) {
      sawRule = true;
      continue;
    }
    if (parts.length < 2) return null;

    // `Mo-Su off` is how OSM writes a closure, and it is an answer rather than a
    // failure: the selector is real, the times are not, and the row is shut all week.
    if (parts.slice(1).every((token) => CLOSED_TOKENS.has(token.toLowerCase()))) {
      sawRule = true;
      continue;
    }

    // A selector with two ends is a RUN, not a pair: `Mo-Su` is all seven days and
    // `Fr-Mo` wraps the weekend. Treating the ends as the only two days is the kind of
    // bug that looks like data quality — a shop open Monday to Sunday silently reported
    // shut on Wednesday — so the walk is explicit.
    const ends = selector.split("-");
    const indices: number[] = [];
    for (const day of ends) {
      const index = DAY_INDEX[day.trim().slice(0, 2)];
      if (index === undefined) return null;
      indices.push(index);
    }
    if (indices.length === 1) {
      days.add(indices[0] as number);
    } else {
      const [start, end] = indices as [number, number];
      for (let day = start; ; day = (day + 1) % 7) {
        days.add(day);
        if (day === end) break;
      }
    }
    for (const spec of parts.slice(1).join(" ").split(",")) {
      const [fromToken, toToken] = spec.trim().split("-");
      const from = hhmm(fromToken ?? "");
      const to = hhmm(toToken ?? "");
      if (from === null || to === null) return null;
      // An end before the start runs past midnight, and only the part on the named
      // day belongs to this rule.
      ranges.push([from, to <= from ? 1440 : to]);
    }
    sawRule = true;
  }

  if (!sawRule) return null;
  return { allDay: false, days, ranges };
}

/** Minutes of `[fromMin, toMin)` the place is open for. 0 means shut. */
export function openMinutes(hours: Hours, weekday: number, fromMin: number, toMin: number): number {
  if (hours.allDay) return Math.max(0, toMin - fromMin);
  if (!hours.days.has(weekday)) return 0;
  let open = 0;
  for (const [from, to] of hours.ranges) {
    open += Math.max(0, Math.min(toMin, to) - Math.max(fromMin, from));
  }
  return open;
}

export type HoursVerdict = {
  code: RejectionCode;
  message: string;
  shortfall: number | null;
  unit: Rejection["unit"];
  /** True when the candidate may still be packed despite the rejection. */
  soft: boolean;
};

/**
 * `hours_unverified` is **soft**. The spec (FEATURES §3, failure behaviour) says an
 * unparsable or absent `OpeningHours` emits it with `relaxable: true` and "degrades to
 * soft; it does not throw and it does not silently pass". `FeasibleResult` has no way
 * to mark a rejection as non-blocking, so the encoding is **present in both lists**:
 * the id is in `passed` so the packer can still use it, and in `rejected` so nothing is
 * silent. Worth raising at standup — a `soft: boolean` on `Rejection` would say this
 * outright instead of leaving it to a convention.
 */
export function hoursVerdict(
  item: Experience,
  calendar: Calendar,
  fromMin: number,
  toMin: number,
): HoursVerdict | null {
  const unverified = (why: string): HoursVerdict => ({
    code: "hours_unverified",
    message: `We have never checked when ${item.name} is open (${why}), so take the hours on trust.`,
    shortfall: null,
    unit: null,
    soft: true,
  });

  if (item.hours.raw === null || item.hours.status === "absent") return unverified("never surveyed");
  if (item.hours.status === "unparsable") return unverified("the OSM expression will not parse");
  const hours = parseHours(item.hours.raw);
  if (!hours) return unverified("the OSM expression will not parse");

  const window = Math.max(0, toMin - fromMin);
  const open = openMinutes(hours, calendar.weekday, fromMin, toMin);
  if (open === 0 && window > 0) {
    return {
      code: "closed_now",
      message: `${item.name} is shut at ${clock(fromMin)} on a ${calendar.name}.`,
      shortfall: null,
      unit: null,
      soft: false,
    };
  }
  if (open < window) {
    return {
      code: "closed_during_window",
      message: `${item.name} closes for ${window - open} min of the ${clock(fromMin)}-${clock(toMin)} you wanted.`,
      shortfall: window - open,
      unit: "minutes",
      soft: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check 8 — slots, and `SlotAvailability` for the first time
// ---------------------------------------------------------------------------

/**
 * Availability derived from committed counts, never stored. The contract's rule is
 * that `remaining` is subtractive so overselling is structurally impossible, and the
 * order matters: confirmed wins over held. `provider/availability.ts` does this for
 * one provider's inbox; the planner needs it too, and this is the first code in the
 * repo to answer "is this slot gone" for a plan.
 */
export function deriveSlotAvailability(slot: Slot): SlotAvailability {
  const remaining = Math.max(
    0,
    slot.capacity - slot.held.confirmedOrders - slot.held.pendingOrders - slot.held.carts,
  );
  return {
    slotId: slot.id,
    status: remaining === 0 || slot.status === "gone" ? "gone" : remaining <= 2 ? "ordered" : "ok",
    remaining,
    derivedFrom: [
      `capacity:${slot.capacity}`,
      `confirmed:${slot.held.confirmedOrders}`,
      `pending:${slot.held.pendingOrders}`,
      `carts:${slot.held.carts}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// The twelve checks
// ---------------------------------------------------------------------------

const reject = (
  id: string,
  code: RejectionCode,
  message: string,
  shortfall: number | null = null,
  unit: Rejection["unit"] = null,
  relaxable = true,
): Rejection => ({ experienceId: id, code, message, shortfall, unit, relaxable });

/** Check 6. `Accessibility` is tri-state, so `null` never fails. */
const ACCESS_CHECK: Partial<
  Record<AccessNeed, { field: keyof Experience["accessibility"]; code: RejectionCode; phrase: string }>
> = {
  wheelchair: { field: "stepFree", code: "not_step_free", phrase: "has steps" },
  stroller: { field: "strollerOk", code: "not_stroller_ok", phrase: "cannot take a stroller" },
  lowStairs: { field: "lowStairs", code: "no_low_stairs", phrase: "is up stairs" },
  hearingLoop: { field: "hearingLoop", code: "no_hearing_loop", phrase: "has no hearing loop" },
  restroom: { field: "restroomOnSite", code: "no_restroom", phrase: "has no restroom on site" },
};

/**
 * A LIST, not the first failure, because a candidate can be soft-failed and
 * hard-failed at once: a gallery whose hours were never surveyed and which also needs
 * 40 minutes more than you have left has two things wrong with it, and reporting only
 * the first hides one of them. `FeasibleResult` does not require `passed` and
 * `rejected` to be disjoint, which is what makes "soft" expressible at all.
 *
 * Ordered as the spec orders the checks, cheapest first, so the first failure is also
 * the most fundamental one and a test can assert on it. `from` is the last place
 * already accepted, which makes check 1 a nearest-neighbour constraint rather than a
 * radius from the centre of the city.
 */
export function check(
  ctx: DiscoveryContext,
  item: Experience,
  facts: Facts,
  from: GeoPoint | null,
): Rejection[] {
  const out: Rejection[] = [];
  const hard = (rejection: Rejection | null): void => {
    if (rejection) out.push(rejection);
  };

  // 1. distance
  const limit = walkLimitPerLeg(ctx);
  const walkMetres = from === null ? 0 : metresBetween(from, item.location);
  if (from !== null && walkMetres > limit) {
    hard(
      reject(
        item.id,
        "too_far",
        `${item.name} is ${walkMetres} m from the last stop, over the ${limit} m walking limit.`,
        walkMetres - limit,
        "metres",
      ),
    );
  }

  // 11. not already planned, not excluded. A pinned id is one the traveller has
  // already done or booked, so the packer must not produce it again; it survives
  // through `replan`, which copies it out of the previous plan with its real times.
  if (ctx.excludedIds.includes(item.id)) {
    hard(reject(item.id, "excluded_by_traveller", `${item.name} is off the list.`, null, null, false));
  } else if (ctx.pinnedIds.includes(item.id)) {
    hard(reject(item.id, "already_planned", `${item.name} is already in the plan.`, null, null, false));
  }

  // 6. access needs
  for (const need of ctx.accessNeeds) {
    const rule = ACCESS_CHECK[need];
    if (!rule) continue;
    if (item.accessibility[rule.field] === false) {
      hard(reject(item.id, rule.code, `${item.name} ${rule.phrase}, and we said we needed it sorted.`));
    }
  }
  if (item.minAge !== null && ctx.partySize < item.minAge) {
    hard(reject(item.id, "inaccessible", `${item.name} is not for a group of ${ctx.partySize}.`));
  }

  // 5. capacity
  if (item.capacity !== null && ctx.partySize > item.capacity) {
    hard(
      reject(
        item.id,
        "capacity_exceeded",
        `${item.name} seats ${item.capacity} and we are ${ctx.partySize}.`,
        ctx.partySize - item.capacity,
        "people",
      ),
    );
  }

  // 4. budget
  const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;
  if (ctx.budget !== null && cost > ctx.budget.minor) {
    hard(
      reject(
        item.id,
        "over_budget",
        `${item.name} costs ${cost} paise for ${ctx.partySize}, over the ${ctx.budget.minor} you have.`,
        cost - ctx.budget.minor,
        "minor_units",
      ),
    );
  }
  if (ctx.budgetPerPerson !== null && (item.pricePerPerson?.minor ?? 0) > ctx.budgetPerPerson.minor) {
    hard(
      reject(
        item.id,
        "over_budget_per_person",
        `${item.name} is ${item.pricePerPerson?.minor} paise each, over your ${ctx.budgetPerPerson.minor} per person.`,
        (item.pricePerPerson?.minor ?? 0) - ctx.budgetPerPerson.minor,
        "minor_units",
      ),
    );
  }

  // 7. diets
  for (const diet of ctx.diets) {
    if (item.diets.length > 0 && !item.diets.includes(diet)) {
      hard(reject(item.id, "diet_mismatch", `${item.name} does not do ${diet}.`));
    }
  }

  // 8. slot
  const slot = facts.slots
    .filter(
      (candidate) =>
        candidate.experienceId === item.id &&
        ctx.nowMin >= candidate.startMin - 120 &&
        ctx.nowMin <= candidate.endMin,
    )
    .sort((a, b) => a.startMin - b.startMin)[0];
  if (slot) {
    const available = deriveSlotAvailability(slot);
    if (available.status === "gone") {
      hard(
        reject(
          item.id,
          "sold_out",
          `The ${clock(slot.startMin)} slot at ${item.name} is gone: ${available.derivedFrom.join(", ")}.`,
          null,
          null,
          false,
        ),
      );
    } else if (available.remaining < ctx.partySize) {
      hard(
        reject(
          item.id,
          "capacity_exceeded",
          `Only ${available.remaining} left on the ${clock(slot.startMin)} slot at ${item.name}, and we are ${ctx.partySize}.`,
          ctx.partySize - available.remaining,
          "people",
        ),
      );
    }
  }

  // 9. booking notice
  if (item.booking.required && !item.booking.walkIn && item.booking.leadTimeMin > ctx.availableMin) {
    hard(
      reject(
        item.id,
        "lead_time_too_short",
        `${item.name} needs booking ${item.booking.leadTimeMin} min ahead and you have ${ctx.availableMin}.`,
        item.booking.leadTimeMin - ctx.availableMin,
        "minutes",
      ),
    );
  }

  // 10. weather
  if (
    WET.has(ctx.weather.condition) &&
    item.weatherSensitive !== "none" &&
    item.indoorOutdoor === "outdoor"
  ) {
    hard(
      reject(
        item.id,
        "weather_unsafe",
        `${ctx.weather.condition.replace("_", " ")} and ${item.name} has no cover.`,
      ),
    );
  }
  if (indoorsOnly(ctx) && item.indoorOutdoor === "outdoor") {
    hard(reject(item.id, "excluded_by_traveller", `${item.name} is outside, and we said indoors only.`));
  }

  // 12. season
  if (item.bestMonths.length > 0 && !item.bestMonths.includes(facts.calendar.month)) {
    hard(
      reject(
        item.id,
        "seasonal_mismatch",
        `${item.name} is a month-${item.bestMonths.join("/")} place and we are in month ${facts.calendar.month}.`,
      ),
    );
  }

  // 2. duration, the coarse form; the precise one is in `packStops`
  if (item.durationMin > ctx.availableMin) {
    hard(
      reject(
        item.id,
        "duration_exceeds_budget",
        `${item.name} needs ${item.durationMin} min and ${ctx.availableMin} min are left.`,
        item.durationMin - ctx.availableMin,
        "minutes",
      ),
    );
  }

  // 3. hours. The split is deliberate and load-bearing:
  //    - `closed_now` is decidable HERE, from the start of the window, so the gate drops
  //      the row and the plan can say why without ever considering it;
  //    - `closed_during_window` needs an arrival time, which does not exist until the
  //      packer has chosen a slot, so it is enforced there instead;
  //    - `hours_unverified` is neither, and is recorded without dropping the row.
  const hours = hoursVerdict(
    item,
    facts.calendar,
    ctx.nowMin,
    ctx.nowMin + Math.min(60, ctx.availableMin),
  );
  if (hours) out.push(rejectionFrom(item.id, hours));
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function tokensOf(item: Experience): string[] {
  return [item.category, ...item.keywords, ...item.cuisines, ...item.diets, ...item.perception.activities]
    .map((token) => token.toLowerCase());
}

/** How many of the traveller's interests this place speaks to, 0..1. */
export function interestHit(ctx: DiscoveryContext, item: Experience): number {
  if (ctx.interests.length === 0) return 0.5;
  const tokens = new Set(tokensOf(item));
  const hits = ctx.interests.filter((interest) => tokens.has(interest.toLowerCase())).length;
  return Math.min(1, hits / Math.min(2, ctx.interests.length));
}

export function minutesFromOrigin(ctx: DiscoveryContext, item: Experience): number {
  return travelBetween(ctx.origin.point ?? ORIGIN, item.location, LEG_MODE[ctx.travelMode]).minutes;
}

/**
 * A weighted sum over the profile's own keys, so the weight profile is load-bearing
 * rather than decorative. A key the profile does not carry scores nothing; this never
 * invents a default weight.
 */
export function scoreOf(
  ctx: DiscoveryContext,
  item: Experience,
  weights: WeightProfile,
): ScoreBreakdown {
  const w = weights.weights;
  const minutes = minutesFromOrigin(ctx, item);
  const avoided = ctx.avoid.filter((token) => tokensOf(item).includes(token)).length;
  const parts = [
    {
      key: "interest",
      label: "Matches what you asked for",
      value: interestHit(ctx, item),
      weight: w.interest ?? 0,
    },
    {
      key: "proximity",
      label: `${minutes} min from where you are`,
      value: 1 / (1 + minutes / 15),
      weight: w.proximity ?? 0,
    },
    { key: "rating", label: `Rated ${item.rating.value}`, value: item.rating.value / 5, weight: w.rating ?? 0 },
    { key: "avoided", label: "Something you said to avoid", value: -avoided, weight: 1 },
  ];
  return {
    experienceId: item.id,
    total: Math.round(parts.reduce((sum, part) => sum + part.value * part.weight, 0) * 1000) / 1000,
    components: parts.map((part) => ({ ...part })),
    profileVersion: weights.version,
    learnedComponents: weights.source === "learned" ? ["proximity"] : [],
  };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const rupees = (minor: number): Money => ({ minor: Math.max(0, Math.round(minor)), currency: "INR" });

/** Deterministic timestamp. `new Date()` would make every run unreproducible. */
const stampOf = (ctx: DiscoveryContext): string =>
  new Date(Date.UTC(2026, 0, 1, Math.floor(ctx.nowMin / 60) % 24, ctx.nowMin % 60)).toISOString();

function fitOf(ctx: DiscoveryContext, item: Experience, travelMin: number): Fit {
  const totalMin = travelMin + item.durationMin + 5;
  const cost = rupees((item.pricePerPerson?.minor ?? 0) * ctx.partySize);
  const fitRatio = ctx.availableMin === 0 ? 0 : totalMin / ctx.availableMin;
  return {
    experienceId: item.id,
    travelMin,
    activityMin: item.durationMin,
    bufferMin: 5,
    totalMin,
    availableMin: ctx.availableMin,
    fitRatio: Math.round(fitRatio * 1000) / 1000,
    cost,
    budget: ctx.budget,
    checks: [
      {
        label: "Fits the time you have left",
        pass: item.durationMin + travelMin <= ctx.availableMin,
        detail: `${item.durationMin} min on site, ${travelMin} min to get there, ${ctx.availableMin} min left.`,
      },
      {
        label: "Inside budget",
        pass: ctx.budget === null || cost.minor <= ctx.budget.minor,
        detail: `${cost.minor} paise of ${ctx.budget?.minor ?? "no ceiling"}.`,
      },
    ],
    verdict: fitRatio <= 0.75 ? "fits" : fitRatio <= 1 ? "tight" : "does_not_fit",
  };
}

/**
 * A sit-down between stops. Not decoration: a day of consecutive stops with no break
 * in it is not a day anybody can do, and the plan has to say when the break is. It
 * is also what stops `Plan.stops` being one unbroken block, which is the difference
 * between a plan and a queue.
 */
export const REST_MIN = 30;

/**
 * Greedy fill, in the order it is handed. A candidate that does not fit the window or
 * the budget is skipped and the walk carries on to the next one, so a shorter window
 * gives a shorter day rather than a different day.
 *
 * Every skip leaves a `Rejection` behind: `Plan.rejected` is "everything that did not
 * make it, with reasons", and a stop that vanished silently is exactly the bug that
 * field exists to prevent. This is also where check 3 finally has an arrival time, so
 * `closed_during_window` can be decided against the real window rather than the start
 * of the day.
 */
export function packStops(
  ctx: DiscoveryContext,
  ordered: readonly Experience[],
  weights: WeightProfile,
  facts: Facts,
): { stops: PlanStop[]; legs: TravelLeg[]; rejected: Rejection[] } {
  const mode = LEG_MODE[ctx.travelMode];
  const ceiling = ctx.budget?.minor ?? Number.POSITIVE_INFINITY;
  const stops: PlanStop[] = [];
  const legs: TravelLeg[] = [];
  const rejected: Rejection[] = [];

  let cursor = ctx.nowMin;
  let hereId = "origin";
  let here: GeoPoint = ctx.origin.point ?? ORIGIN;
  let spend = 0;

  for (const item of ordered) {
    const travel = legBetween(here, item.location, mode, hereId, item.id);
    const arrive = cursor + travel.minutes;
    const depart = arrive + item.durationMin;
    const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;

    if (depart - ctx.nowMin > ctx.availableMin) {
      rejected.push(
        reject(
          item.id,
          "duration_exceeds_budget",
          `${item.name} would end ${depart - ctx.availableMin} min after you have to leave.`,
          depart - ctx.nowMin - ctx.availableMin,
          "minutes",
        ),
      );
      continue;
    }
    if (spend + cost > ceiling) {
      rejected.push(
        reject(
          item.id,
          "over_budget",
          `${item.name} costs ${cost} paise for ${ctx.partySize}, over the ${ceiling} left.`,
          spend + cost - ceiling,
          "minor_units",
        ),
      );
      continue;
    }
    const hours = hoursVerdict(item, facts.calendar, arrive, depart);
    if (hours && !hours.soft) {
      rejected.push(rejectionFrom(item.id, hours));
      continue;
    }
    if (hours?.soft) rejected.push(rejectionFrom(item.id, hours));

    const score = scoreOf(ctx, item, weights);
    stops.push({
      experienceId: item.id,
      arriveMin: arrive,
      departMin: depart,
      fit: fitOf(ctx, item, travel.minutes),
      score,
      why: [score.components.find((part) => part.key === "interest")?.label ?? `Rated ${item.rating.value}.`],
      order: stops.length,
    });
    legs.push(travel);
    // The break belongs to the day, so it is charged to the day.
    cursor = depart + REST_MIN;
    hereId = item.id;
    here = item.location;
    spend += cost;
  }
  return { stops, legs, rejected };
}

const rejectionFrom = (id: string, verdict: HoursVerdict): Rejection => ({
  experienceId: id,
  code: verdict.code,
  message: verdict.message,
  shortfall: verdict.shortfall,
  unit: verdict.unit,
  relaxable: true,
});

export function measureStress(
  plan: Pick<Plan, "stops" | "legs" | "utilisation">,
  ctx: DiscoveryContext,
): { score: number; factors: Plan["stressFactors"] } {
  const hops = Math.max(1, plan.stops.length - 1);
  const rides = plan.legs.filter((item) => item.mode !== "walk").length;
  const factors: Plan["stressFactors"] = [
    {
      dimension: "utilisation",
      weight: 0.4,
      value: plan.utilisation,
      rescue: plan.utilisation > 0.9 ? "Drop the lowest-scoring stop." : null,
    },
    {
      dimension: "transfers",
      weight: 0.35,
      value: rides / hops,
      rescue: hops > 2 ? "Move the stops into one cluster." : null,
    },
    { dimension: "walking", weight: 0.25, value: ctx.travelMode === "walk" ? 1 : 0, rescue: null },
  ];
  return {
    score: Math.max(0, Math.min(100, Math.round(factors.reduce((s, f) => s + f.value * f.weight * 100, 0)))),
    factors,
  };
}

function buildPlan(
  ctx: DiscoveryContext,
  stops: readonly PlanStop[],
  legs: readonly TravelLeg[],
  rejected: readonly Rejection[],
): Plan {
  const last = stops.at(-1)?.departMin ?? ctx.nowMin;
  const totalMin = Math.max(0, last - ctx.nowMin);
  const draft = PlanSchema.parse({
    id: `plan-${ctx.id}-${ctx.nowMin}`,
    contextId: ctx.id,
    stops: [...stops],
    legs: [...legs],
    totalMin,
    totalCost: rupees(stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0)),
    utilisation: ctx.availableMin === 0 ? 0 : Math.round((totalMin / ctx.availableMin) * 1000) / 1000,
    totalMetres: legs.reduce((sum, item) => sum + item.metres, 0),
    rejected: [...rejected],
    relaxations: [],
    stressScore: 0,
    stressFactors: [],
    createdAt: stampOf(ctx),
    engineVersion: ENGINE_VERSION,
  });
  const { score, factors } = measureStress(draft, ctx);
  return PlanSchema.parse({ ...draft, stressScore: score, stressFactors: factors });
}

// ---------------------------------------------------------------------------
// Validation — recompute, then compare
// ---------------------------------------------------------------------------

/**
 * Independent recompute, in the spirit of `docs/ARCHITECTURE.md` §7: the plan is
 * checked against its own contents, not against the packer's word. It can and does
 * contradict `pack`, which is the only way a guard is worth anything. Everything here
 * is computable from the `Plan` alone, because `EnginePort.validate` is handed nothing
 * else — so it deliberately says nothing about the window, the budget or the
 * catalogue, which `validate` cannot see.
 */
export function validatePlan(plan: Plan): ValidationResult {
  const violations: ValidationResult["violations"] = [];
  const seen = new Set<string>();

  plan.stops.forEach((stop, index) => {
    if (seen.has(stop.experienceId)) {
      violations.push({ code: "duplicate", message: `${stop.experienceId} is in the plan twice.`, at: stop.experienceId });
    }
    seen.add(stop.experienceId);
    if (stop.order !== index) {
      violations.push({ code: "order_mismatch", message: `Stop ${index} claims order ${stop.order}.`, at: stop.experienceId });
    }
    if (stop.departMin < stop.arriveMin) {
      violations.push({ code: "negative_dwell", message: `${stop.experienceId} leaves before it arrives.`, at: stop.experienceId });
    }
  });

  const cost = plan.stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
  if (cost !== plan.totalCost.minor) {
    violations.push({ code: "cost_mismatch", message: `The stops cost ${cost} paise; the plan claims ${plan.totalCost.minor}.`, at: null });
  }
  const metres = plan.legs.reduce((sum, item) => sum + item.metres, 0);
  if (metres !== plan.totalMetres) {
    violations.push({ code: "metres_mismatch", message: `The legs cover ${metres} m; the plan claims ${plan.totalMetres} m.`, at: null });
  }
  for (const item of plan.legs) {
    if (!seen.has(item.toId)) {
      violations.push({ code: "leg_dangling", message: `A leg arrives at ${item.toId}, which is not in the plan.`, at: item.toId });
    }
  }

  return { ok: violations.length === 0, violations, recomputedObjective: null, claimedObjective: null, objectiveDelta: 0 };
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

export type FixtureOptions = {
  /** The rows `retrieve` draws from. `EnginePort.replan` gets no catalogue. */
  catalogue: readonly Experience[];
  weights: WeightProfile;
  /** Facts the engine holds that the traveller did not state. */
  facts?: Facts;
  limit?: number;
};

export function deterministicEngine(options: FixtureOptions): EnginePort {
  const { weights } = options;
  const limit = options.limit ?? 120;
  const facts = options.facts ?? { slots: [], calendar: ASSUMED_CALENDAR };

  const retrieve = (input: RetrieveInput): Experience[] =>
    [...input.catalogue]
      .filter((item) => !input.context.excludedIds.includes(item.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, input.limit || limit);

  /**
   * The hard gate. `passed` and `rejected` are **not** disjoint: a candidate whose
   * hours are merely unverified appears in both, because the spec says that gate
   * degrades to soft and `FeasibleResult` has no `soft` flag to say so. Any other
   * failure drops it — being unverified about the hours is not a licence to ignore a
   * closed gate.
   */
  const filterFeasible = (ctx: DiscoveryContext, items: Experience[]): FeasibleResult => {
    const passed: string[] = [];
    const rejected: Rejection[] = [];
    let here: GeoPoint | null = ctx.origin.point ?? ORIGIN;
    for (const item of items) {
      const failures = check(ctx, item, facts, here);
      rejected.push(...failures);
      if (failures.every((entry) => entry.code === "hours_unverified")) {
        passed.push(item.id);
        here = item.location;
      }
    }
    return { passed, rejected };
  };

  const score = (ctx: DiscoveryContext, items: Experience[]): ScoreBreakdown[] =>
    items.map((item) => scoreOf(ctx, item, weights));

  /** retrieve -> filter -> score, in the documented order, in one place. */
  const solve = (ctx: DiscoveryContext, taken: readonly string[]) => {
    const shortlist = retrieve({ context: ctx, catalogue: [...options.catalogue], limit });
    const byId = new Map(shortlist.map((item) => [item.id, item]));
    const feasible = filterFeasible(ctx, shortlist);
    const items = feasible.passed
      .map((id) => byId.get(id))
      .filter((item): item is Experience => item !== undefined && !taken.includes(item.id));
    const rank = new Map(score(ctx, items).map((entry) => [entry.experienceId, entry.total]));
    return {
      ordered: [...items].sort(
        (a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.id.localeCompare(b.id),
      ),
      rejected: feasible.rejected,
    };
  };

  const pack = (ctx: DiscoveryContext, ordered: Experience[]): Plan => {
    const { stops, legs, rejected } = packStops(ctx, ordered, weights, facts);
    // `EnginePort.pack(ctx, items)` is handed no rejections, and `Plan.rejected` is
    // "everything that did not make it, with reasons". So the gate is run again here to
    // recover the accounts for the rows the caller filtered out. Deterministic and
    // cheap, and the alternative is a plan that silently drops 90% of the catalogue's
    // reasons on the floor.
    const gate = filterFeasible(
      ctx,
      retrieve({ context: ctx, catalogue: [...options.catalogue], limit }),
    );
    return buildPlan(ctx, stops, legs, [...gate.rejected, ...rejected]);
  };

  /**
   * Keep everything pinned, at the times it already had, and re-solve the rest from
   * where the day has actually got to. The residual context keeps the same `id`, so the
   * plan it returns still belongs to this trip and passes `admit`.
   *
   * This is the only code in the repo that holds both the previous plan and the packing
   * rules, which is why the residual re-solve lives here and not in the feature: the
   * feature can only say what must not move.
   */
  const replan = (prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult => {
    const held = prev.stops
      .filter((stop) => ctx.pinnedIds.includes(stop.experienceId))
      .sort((a, b) => a.order - b.order);
    const taken = held.map((stop) => stop.experienceId);
    // A rest after the last held stop, exactly as `packStops` puts one after every other
    // stop. Without it the traveller is dropped from a finished activity straight into a
    // transfer, which is both wrong and a load-model violation.
    const from = Math.max(ctx.nowMin, (held.at(-1)?.departMin ?? ctx.nowMin - REST_MIN) + REST_MIN);
    const residual: DiscoveryContext = {
      ...ctx,
      nowMin: from,
      availableMin: Math.max(1, ctx.availableMin - (from - ctx.nowMin)),
      pinnedIds: [],
    };

    const { ordered, rejected } = solve(residual, taken);
    const suffix = packStops(residual, ordered, weights, facts);

    const stops = [...held, ...suffix.stops].map((stop, index) => ({ ...stop, order: index }));
    const legs = [...prev.legs.filter((item) => taken.includes(item.toId)), ...suffix.legs];
    const kept = new Set(stops.map((stop) => stop.experienceId));
    // Anything the traveller took off the list is the engine's own account to record,
    // because `retrieve` is where it happened and that has no rejection channel.
    const dropped: Rejection[] = options.catalogue
      .filter((item) => ctx.excludedIds.includes(item.id) && !kept.has(item.id))
      .map((item) => reject(item.id, "excluded_by_traveller", `${item.name} is off the list.`, null, null, false));
    // Only this re-solve's account. A shortfall measured against the old window is not
    // a shortfall against this one, and a repaired plan quoting it would be quoting a
    // number nobody can re-derive.
    const plan = buildPlan(ctx, stops, legs, [...rejected, ...suffix.rejected, ...dropped]);

    const before = new Set(prev.stops.map((stop) => stop.experienceId));
    const swaps: Swap[] = [
      ...prev.stops
        .filter((stop) => !kept.has(stop.experienceId))
        .map((stop) => ({
          removedId: stop.experienceId,
          addedId: null,
          reason:
            plan.rejected.find((entry) => entry.experienceId === stop.experienceId)?.message ?? change.narrative,
          scoreDelta: -stop.score.total,
        })),
      ...stops
        .filter((stop) => !before.has(stop.experienceId))
        .map((stop) => ({ removedId: null, addedId: stop.experienceId, reason: stop.why[0] ?? change.narrative, scoreDelta: stop.score.total })),
    ];

    return { plan, change, swaps, preservedIntent: true, summary: change.narrative };
  };

  return {
    retrieve,
    filterFeasible,
    score,
    pack,
    validate: validatePlan,
    replan,
    computeFit(ctx, item) {
      return fitOf(ctx, item, travelBetween(ctx.origin.point ?? ORIGIN, item.location, LEG_MODE[ctx.travelMode]).minutes);
    },
    stress(plan, ctx) {
      return measureStress(plan, ctx);
    },
    travelBetween,
  };
}
