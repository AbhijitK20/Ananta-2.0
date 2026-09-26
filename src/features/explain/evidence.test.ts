/**
 * The explainability tests. The claim under test is narrow and falsifiable:
 *
 *   planner decision -> evidence -> explanation, with no step invented.
 *
 * So the test builds a scenario in which every candidate fails for exactly one
 * REAL reason, runs a gate over it, packs the survivors into a plan, and then
 * asserts that the explanation for each one names the constraint that actually
 * stopped it — carrying the number the gate computed from the data, not a number
 * the test typed into a sentence.
 *
 * On the harness below: `src/engine/**` belongs to another stream and is not on
 * this branch, so there is nothing to call. `referenceFeasible` is the smallest
 * thing that emits a real `Rejection` per real constraint failure, and it lives in
 * the test because a second engine under `src/**` is exactly what this repo
 * forbids. It is not the code under test and nothing in `src/features/explain`
 * imports it. Delete it the day the real engine lands: every assertion below is
 * written against `RejectionCode` and against the plan the gate produced, so it
 * keeps working when the real filter and the real packer answer instead.
 *
 * One rule the harness has to respect, because the audit enforces it: a rejection
 * message may only quote a figure the PLAN records. The plan holds the shortfall,
 * the ceiling it was measured against and the window — never the rejected
 * candidate's own total, because a candidate that never passed the gate was never
 * fitted. So the messages below state the overspend and the shortfall, and the
 * test that checks the audit has teeth quotes a number nothing backs.
 */
import { describe, expect, it } from "vitest";
import {
  DiscoveryContext,
  Experience as ExperienceSchema,
  Plan as PlanSchema,
  type Experience,
  type Fit,
  type GeoPoint,
  type Plan,
  type Rejection,
  type RejectionCode,
  type ScoreBreakdown,
} from "../../contracts";
import { auditLedger, explainOne, explainPlan, type Explanation, type ExplanationLedger } from ".";

// ---------------------------------------------------------------------------
// The traveller: 14:00, two hours, ₹1,500, four people, a wheelchair, heavy rain
// ---------------------------------------------------------------------------

const CTX: DiscoveryContext = DiscoveryContext.parse({
  id: "ctx-explain",
  origin: { label: "Colaba", point: { lat: 19.0, lon: 72.87 } },
  availableMin: 120,
  nowMin: 840,
  budget: { minor: 150_000, currency: "INR" },
  partySize: 4,
  partyType: "family_with_children",
  childAges: [6],
  accessNeeds: ["wheelchair"],
  diets: ["vegetarian"],
  interests: ["craft_workshop", "street_food"],
  avoid: ["crowded"],
  weather: { condition: "heavy_rain", tempC: 27, source: "simulated" },
  travelMode: "auto",
  requests: [],
  excludedIds: ["dropped"],
  pinnedIds: ["already"],
  original: {
    availableMin: 120,
    budget: { minor: 150_000, currency: "INR" },
    partySize: 4,
    accessNeeds: ["wheelchair"],
  },
});

const ORIGIN: GeoPoint = { lat: 19.0, lon: 72.87 };
const rupees = (minor: number) => ({ minor, currency: "INR" as const });
const clock = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

function metresBetween(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const h =
    Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Door to door by auto. Deterministic, and slower the further the pin. */
const travelTo = (from: GeoPoint, to: GeoPoint): number => Math.round(metresBetween(from, to) / 200) + 4;

function exp(overrides: Partial<Experience> & Pick<Experience, "id" | "name">): Experience {
  return ExperienceSchema.parse({
    category: "craft_workshop",
    location: ORIGIN,
    durationMin: 40,
    pricePerPerson: rupees(30_000),
    capacity: null,
    hours: { raw: "Mo-Su 09:00-22:00", status: "ok", lastVerified: null },
    indoorOutdoor: "indoor",
    accessibility: {
      stepFree: true,
      strollerOk: true,
      lowStairs: true,
      seatingAvailable: true,
      hearingLoop: false,
      restroomOnSite: true,
    },
    kidFriendly: true,
    minAge: null,
    diets: ["vegetarian"],
    cuisines: [],
    rating: { value: 4.6, count: 310, rawMean: 4.7 },
    blurb: null,
    description: null,
    keywords: [],
    neighbourhood: "Colaba",
    city: "Mumbai",
    booking: { required: false, leadTimeMin: 0, walkIn: true },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The scenario: one candidate per distinct real reason
// ---------------------------------------------------------------------------

/** Pinned so the travel arithmetic is checkable, not guessed at. */
const AT_NEAR = { lat: 19.002, lon: 72.874 };
const AT_SECOND = { lat: 19.006, lon: 72.878 };
const AT_TEN_MIN = { lat: 19.01, lon: 72.87 };
const AT_FAR = { lat: 19.09, lon: 72.87 };

const CATALOGUE: Experience[] = [
  // Selected. Clears every hard gate.
  exp({ id: "chosen", name: "Step-free pottery studio", durationMin: 40, location: AT_NEAR }),
  // Selected, and thin: the window fits but the engine's margin check does not.
  exp({
    id: "chosen_tight",
    name: "Small print room",
    category: "gallery",
    durationMin: 55,
    location: AT_SECOND,
    pricePerPerson: rupees(6_000),
    rating: { value: 4.3, count: 90, rawMean: 4.4 },
    provenance: { durationMin: "inferred", hours: "osm" },
  }),
  // Shuts at 14:00, and ten minutes of travel means a 14:10 arrival.
  exp({
    id: "closes_early",
    name: "Lunch counter",
    category: "cafe",
    location: AT_TEN_MIN,
    hours: { raw: "Mo-Su 09:00-14:00", status: "ok", lastVerified: null },
  }),
  // Seats two; four are coming.
  exp({ id: "too_small", name: "Six-seat counter", capacity: 2 }),
  // ₹600 x 4 = ₹2,400 against a ₹1,500 ceiling.
  exp({ id: "pricey", name: "Tasting menu", category: "restaurant", pricePerPerson: rupees(60_000) }),
  // No vegetarian option.
  exp({ id: "meat", name: "Grill house", category: "restaurant", diets: [] }),
  // Not step-free, and the party needs step-free.
  exp({
    id: "no_steps",
    name: "Old fort walk",
    category: "heritage_site",
    accessibility: { stepFree: false, strollerOk: null, lowStairs: false, seatingAvailable: null, hearingLoop: null, restroomOnSite: null },
  }),
  // Outdoors, in heavy rain.
  exp({ id: "rainy", name: "Open-air amphitheatre", category: "music_live", indoorOutdoor: "outdoor", weatherSensitive: "rain" }),
  // Needs ten hours' notice; the window is two.
  exp({
    id: "needs_notice",
    name: "Brochure walk",
    durationMin: 30,
    booking: { required: true, leadTimeMin: 600, walkIn: false },
  }),
  // 6 + 200 + 10 = 216 min of need against 120 available.
  exp({ id: "long", name: "Full-day trek", category: "adventure", durationMin: 200, weatherSensitive: "none" }),
  // Ten kilometres out, and no time to make it.
  exp({ id: "distant", name: "Escarpment viewpoint", category: "nature", durationMin: 20, location: AT_FAR, weatherSensitive: "none" }),
  // Pinned, and ruled out by the traveller. Neither reaches a data check.
  exp({ id: "already", name: "The one you asked for" }),
  exp({ id: "dropped", name: "The one you ruled out" }),
];

const catalogueMap = new Map(CATALOGUE.map((item) => [item.id, item]));

// ---------------------------------------------------------------------------
// The reference gate: real decisions, so there is something real to explain
// ---------------------------------------------------------------------------

/** Past this the gate stops considering a pin at all. */
const REACH_METRES = 5_000;
/** Fixed overhead, so a plan is not knife-edge. */
const BUFFER_MIN = 10;
/** Below this much slack the engine says the margin is too thin. */
const MARGIN_MIN = 60;

type Gate = { feasible: Experience[]; rejected: Rejection[] };

/** `"Mo-Su 09:00-22:00"` -> `[540, 1320]`. The real adapter is `src/engine/hours.ts`. */
function openingWindow(raw: string | null): [number, number] | null {
  const match = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(raw ?? "");
  if (!match) return null;
  return [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])];
}

function reject(
  id: string,
  code: RejectionCode,
  message: string,
  extra: { shortfall?: number; unit?: Rejection["unit"]; relaxable?: boolean } = {},
): Rejection {
  return {
    experienceId: id,
    code,
    message,
    shortfall: extra.shortfall ?? null,
    unit: extra.unit ?? null,
    relaxable: extra.relaxable ?? false,
  };
}

/**
 * The hard gate, in a fixed order, one rejection per dropped candidate. The order
 * is the gate's, so the first constraint an id fails is the one it is rejected for
 * — which is exactly what `Explanation.blocking` reports.
 */
function referenceFeasible(ctx: DiscoveryContext, catalogue: readonly Experience[]): Gate {
  const feasible: Experience[] = [];
  const rejected: Rejection[] = [];
  const wet = ["light_rain", "heavy_rain", "storm"].includes(ctx.weather.condition);

  for (const item of catalogue) {
    const metres = ctx.origin.point ? metresBetween(ctx.origin.point, item.location) : 0;
    const travel = travelTo(ctx.origin.point ?? item.location, item.location);
    const arrive = ctx.nowMin + travel;
    const total = travel + item.durationMin + BUFFER_MIN;
    const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;
    const [opens, closes] = openingWindow(item.hours.raw) ?? [];

    if (ctx.excludedIds.includes(item.id)) {
      rejected.push(reject(item.id, "excluded_by_traveller", "You told us to leave it out."));
    } else if (ctx.pinnedIds.includes(item.id)) {
      rejected.push(reject(item.id, "already_planned", "It is already in your plan."));
    } else if (opens !== undefined && (arrive < opens || arrive + item.durationMin > closes!)) {
      rejected.push(
        reject(item.id, "closed_during_window", `It shuts at ${clock(closes!)} and you would not get there until ${clock(arrive)}.`, {
          shortfall: arrive - closes!,
          unit: "minutes",
          relaxable: true,
        }),
      );
    } else if (item.capacity !== null && item.capacity < ctx.partySize) {
      rejected.push(
        reject(item.id, "capacity_exceeded", `It seats ${item.capacity} and there are ${ctx.partySize} of you.`, {
          shortfall: ctx.partySize - item.capacity,
          unit: "people",
        }),
      );
    } else if (ctx.budget && cost > ctx.budget.minor) {
      rejected.push(
        reject(item.id, "over_budget", `It is ₹${Math.round((cost - ctx.budget.minor) / 100)} over your ₹${Math.round(ctx.budget.minor / 100)} ceiling.`, {
          shortfall: cost - ctx.budget.minor,
          unit: "minor_units",
          relaxable: true,
        }),
      );
    } else if (ctx.diets.length > 0 && !ctx.diets.some((diet) => item.diets.includes(diet))) {
      rejected.push(reject(item.id, "diet_mismatch", `No ${ctx.diets.join(" or ")} option on the menu.`));
    } else if (ctx.accessNeeds.includes("wheelchair") && item.accessibility.stepFree !== true) {
      rejected.push(reject(item.id, "not_step_free", "There are steps at the entrance and no ramp."));
    } else if (wet && (item.indoorOutdoor === "outdoor" || ["rain", "any"].includes(item.weatherSensitive))) {
      rejected.push(reject(item.id, "weather_unsafe", "Heavy rain, and there is no cover.", { relaxable: true }));
    } else if (item.booking.required && !item.booking.walkIn && item.booking.leadTimeMin > ctx.availableMin) {
      rejected.push(
        reject(item.id, "lead_time_too_short", `It needs ${item.booking.leadTimeMin - ctx.availableMin} min more notice than you have.`, {
          shortfall: item.booking.leadTimeMin - ctx.availableMin,
          unit: "minutes",
          relaxable: true,
        }),
      );
    } else if (total > ctx.availableMin) {
      rejected.push(
        reject(item.id, "duration_exceeds_budget", `It needs ${total - ctx.availableMin} min more than you have.`, {
          shortfall: total - ctx.availableMin,
          unit: "minutes",
          relaxable: true,
        }),
      );
    } else if (metres > REACH_METRES) {
      rejected.push(
        reject(item.id, "too_far", `It is ${(metres / 1000).toFixed(1)} km from ${ctx.origin.label}.`, {
          shortfall: metres - REACH_METRES,
          unit: "metres",
          relaxable: true,
        }),
      );
    } else {
      feasible.push(item);
    }
  }
  return { feasible, rejected };
}

// ---------------------------------------------------------------------------
// The reference packer: the survivors, scheduled and scored for real
// ---------------------------------------------------------------------------

function scoreFor(ctx: DiscoveryContext, item: Experience): ScoreBreakdown {
  const metres = ctx.origin.point ? metresBetween(ctx.origin.point, item.location) : 0;
  const partyCost = item.pricePerPerson ? item.pricePerPerson.minor * ctx.partySize : 0;
  const asked = ctx.interests.includes(item.category);
  const components = [
    {
      key: "rating",
      label: "Rating",
      value: item.rating.value,
      weight: 1,
      reason: `${item.rating.value} from ${item.rating.count} ratings.`,
    },
    {
      key: "proximity",
      label: "Close by",
      value: Math.round((5 - metres / 200) * 10) / 10,
      weight: 1.2,
      reason: `${metres} m from ${ctx.origin.label}.`,
    },
    {
      key: "interest",
      label: "Matches what you asked for",
      value: asked ? 2 : -1,
      weight: 1,
      reason: asked ? `${item.category} is on your list.` : `You did not ask for ${item.category}.`,
    },
    {
      key: "access_fit",
      label: "Works for the access needs in your party",
      value: ctx.accessNeeds.length > 0 && item.accessibility.stepFree === true ? 2 : 0,
      weight: 0.8,
      reason: ctx.accessNeeds.length > 0 ? (item.accessibility.stepFree === true ? "Step-free, as needed." : "Not step-free.") : "",
    },
    {
      key: "price",
      label: "Price against your ceiling",
      value: item.pricePerPerson ? -Math.round(item.pricePerPerson.minor / 30_000) : 0,
      weight: 0.6,
      reason: partyCost > 0 ? `₹${Math.round(partyCost / 100)} for the party.` : "Free.",
    },
  ];
  return {
    experienceId: item.id,
    total: Math.round(components.reduce((sum, part) => sum + part.value * part.weight, 0) * 100) / 100,
    // The engine publishes them by descending impact, ties broken by key. The
    // explanation re-ranks the same way, and the test asserts the two agree.
    components: [...components].sort(
      (a, b) => Math.abs(b.value) - Math.abs(a.value) || (a.key < b.key ? -1 : 1),
    ),
    profileVersion: "explain-test-1",
    learnedComponents: ["proximity"],
  };
}

function fitFor(ctx: DiscoveryContext, item: Experience, travel: number): Fit {
  const total = travel + item.durationMin + BUFFER_MIN;
  const cost = (item.pricePerPerson?.minor ?? 0) * ctx.partySize;
  const slack = ctx.availableMin - total;
  const arrive = ctx.nowMin + travel;
  return {
    experienceId: item.id,
    travelMin: travel,
    activityMin: item.durationMin,
    bufferMin: BUFFER_MIN,
    totalMin: total,
    availableMin: ctx.availableMin,
    fitRatio: Math.round((ctx.availableMin / total) * 100) / 100,
    cost: rupees(cost),
    budget: ctx.budget,
    checks: [
      {
        label: "Open when you arrive",
        pass: true,
        detail: `Open from ${clock(ctx.nowMin)} to ${clock(ctx.nowMin + ctx.availableMin)}, and you would be there at ${clock(arrive)}.`,
      },
      {
        label: "Fits your window",
        pass: true,
        detail: `${total} min of travel, time on site and buffer in a ${Math.round(ctx.availableMin / 60)} h window.`,
      },
      { label: "Room for the whole party", pass: true, detail: `Seats ${item.capacity ?? ctx.partySize}.` },
      {
        label: "Cheap enough",
        pass: ctx.budget === null || cost <= ctx.budget.minor,
        detail: ctx.budget ? `₹${Math.round(cost / 100)} of the ₹${Math.round(ctx.budget.minor / 100)} rupee ceiling.` : "No ceiling set.",
      },
      {
        label: "Comfortable margin",
        pass: slack >= MARGIN_MIN,
        detail: slack >= MARGIN_MIN
          ? `${slack} min of slack in a ${Math.round(ctx.availableMin / 60)} h window.`
          : `Only ${slack} min of slack in a ${Math.round(ctx.availableMin / 60)} h window.`,
      },
    ],
    verdict: total <= ctx.availableMin ? "fits" : "does_not_fit",
  };
}

/**
 * Chains the survivors in score order and never overruns the window: a stop that
 * would not fit in what is left is left out, with the gate's own reason for it.
 */
function buildPlan(ctx: DiscoveryContext, gate: Gate): Plan {
  const ranked = [...gate.feasible].sort(
    (a, b) => scoreFor(ctx, b).total - scoreFor(ctx, a).total || (a.id < b.id ? -1 : 1),
  );
  const stops: Plan["stops"] = [];
  const rejected = [...gate.rejected];
  let cursor = ctx.nowMin;
  let from = ctx.origin.point ?? ranked[0]?.location ?? ORIGIN;

  for (const item of ranked) {
    const travel = travelTo(from, item.location);
    const used = cursor - ctx.nowMin;
    if (used + travel + item.durationMin + BUFFER_MIN > ctx.availableMin) {
      const short = used + travel + item.durationMin + BUFFER_MIN - ctx.availableMin;
      rejected.push(
        reject(item.id, "duration_exceeds_budget", `It needs ${short} min more than you have left after the earlier stops.`, {
          shortfall: short,
          unit: "minutes",
          relaxable: true,
        }),
      );
      continue;
    }
    const arriveMin = cursor + travel;
    const order = stops.length;
    const fit = fitFor(ctx, item, travel);
    stops.push({
      experienceId: item.id,
      arriveMin,
      departMin: arriveMin + item.durationMin,
      fit,
      score: scoreFor(ctx, item),
      // Only figures the plan records. A `why` line that quotes a number nothing
      // else holds is the exact thing `auditLedger` refuses to render.
      why: [
        order === 0
          ? `Highest score of the ${gate.feasible.length} that passed every hard constraint.`
          : `Best remaining use of the ${fit.totalMin} min still free at that point.`,
      ],
      order,
    });
    cursor = arriveMin + item.durationMin;
    from = item.location;
  }

  const last = stops[stops.length - 1];
  const totalMin = (last?.departMin ?? ctx.nowMin) - ctx.nowMin;
  return PlanSchema.parse({
    id: "plan-explain",
    contextId: ctx.id,
    stops,
    legs: stops.slice(1).map((stop, index) => ({
      fromId: stops[index]?.experienceId ?? "",
      toId: stop.experienceId,
      mode: "auto",
      minutes: stop.fit.travelMin,
      metres: 900,
      detail: null,
      estimated: true,
    })),
    totalMin,
    totalCost: rupees(stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0)),
    utilisation: totalMin / ctx.availableMin,
    totalMetres: 1_376,
    rejected,
    relaxations: [
      { rung: "greedy_fill", label: "Filled what was left", gaveUp: "a third stop", relaxed: "duration_exceeds_budget" },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    engineVersion: "explain-test-1",
  });
}

// ---------------------------------------------------------------------------
// The scenario, decided
// ---------------------------------------------------------------------------

const GATE = referenceFeasible(CTX, CATALOGUE);
const PLAN = buildPlan(CTX, GATE);
const LEDGER: ExplanationLedger = explainPlan(PLAN, CTX, { catalogue: catalogueMap });

/** Every candidate, with the reason the gate gave for dropping it. */
const dropped = (): { id: string; explanation: Explanation }[] => {
  const selected = new Set(PLAN.stops.map((stop) => stop.experienceId));
  return CATALOGUE.filter((item) => !selected.has(item.id)).map((item) => ({
    id: item.id,
    explanation: LEDGER.byId.get(item.id) as Explanation,
  }));
};

const claimsOf = (ledger: ExplanationLedger): string[] =>
  ledger.explanations.flatMap((item) => [item.headline, ...item.evidence.map((entry) => entry.claim)]);

const rejectionIn = (plan: Plan, id: string): Rejection => {
  const row = plan.rejected.find((entry) => entry.experienceId === id);
  if (!row) throw new Error(`${id} was not rejected in this plan`);
  return row;
};

const blockingValue = (id: string): number | null => LEDGER.byId.get(id)?.blocking?.value ?? null;

// ---------------------------------------------------------------------------

describe("the gate decided what the scenario was built to decide", () => {
  it("passes exactly the two candidates with no hard failure", () => {
    expect(GATE.feasible.map((item) => item.id)).toEqual(["chosen", "chosen_tight"]);
    expect(PLAN.stops.map((stop) => stop.experienceId)).toEqual(["chosen", "chosen_tight"]);
    // Nothing was invented to fill the gap, and the window was not overrun.
    expect(PLAN.totalMin).toBeLessThanOrEqual(CTX.availableMin);
    expect(PLAN.totalCost.minor).toBeLessThanOrEqual(CTX.budget?.minor ?? 0);
  });

  it("fails eleven candidates, each on a different hard constraint", () => {
    const pairs = GATE.rejected.map((row) => `${row.experienceId}:${row.code}`).sort();
    expect(pairs).toEqual([
      "already:already_planned",
      "closes_early:closed_during_window",
      "distant:too_far",
      "dropped:excluded_by_traveller",
      "long:duration_exceeds_budget",
      "meat:diet_mismatch",
      "needs_notice:lead_time_too_short",
      "no_steps:not_step_free",
      "pricey:over_budget",
      "rainy:weather_unsafe",
      "too_small:capacity_exceeded",
    ]);
    // A scenario that quietly failed two candidates for the same reason would
    // make every assertion below weaker, so it is checked directly.
    expect(new Set(GATE.rejected.map((row) => row.code)).size).toBe(GATE.rejected.length);
  });
});

describe("a rejection is explained by the constraint that actually stopped it", () => {
  it("names the real failing code for all eleven, with the gate's own figure", () => {
    const rows = dropped();
    expect(rows).toHaveLength(11);

    for (const { id, explanation } of rows) {
      const row = rejectionIn(PLAN, id);
      expect(explanation.outcome, id).toBe("rejected");
      // The code, the sentence and the number all come off the engine's own row.
      expect(explanation.blocking?.key, id).toBe(`filter:${row.code}`);
      expect(explanation.blocking?.value, id).toBe(row.shortfall);
      expect(explanation.blocking?.unit, id).toBe(row.unit ?? "none");
      expect(explanation.headline, id).toBe(row.message);
      expect(explanation.evidence.length, id).toBe(1);
      expect(explanation.evidence.every((entry) => entry.polarity === "opposes"), id).toBe(true);
      expect(explanation.why, id).toEqual([]);
      expect(explanation.scoreVersion, id).toBeNull();
    }
  });

  it("reports the shortfall the data produced, not a round number", () => {
    // Four people against a two-seat counter.
    expect(blockingValue("too_small")).toBe(2);
    // ₹600 x 4 = ₹2,400 against a ₹1,500 ceiling.
    expect(blockingValue("pricey")).toBe(90_000);
    // 4 + 200 + 10 = 214 needed, 120 available.
    expect(blockingValue("long")).toBe(94);
    // Ten minutes of travel from somewhere that shuts at 14:00, now 14:00.
    expect(blockingValue("closes_early")).toBe(10);
    // 600 min of notice against a 120 min window.
    expect(blockingValue("needs_notice")).toBe(480);
    // Ten kilometres out, and the gate stops looking past five.
    expect(blockingValue("distant")).toBeGreaterThan(4_000);
    expect(blockingValue("distant")).toBeLessThan(6_000);
  });

  it("states a constraint with no figure rather than inventing one", () => {
    for (const id of ["meat", "no_steps", "rainy", "already", "dropped"]) {
      const blocking = LEDGER.byId.get(id)?.blocking;
      expect(blocking?.value, id).toBeNull();
      expect(blocking?.unit, id).toBe("none");
      expect(blocking?.claim, id).not.toMatch(/\d/);
    }
  });

  it("falls back to the code's own sentence when the gate emitted no message", () => {
    const silent = {
      ...PLAN,
      rejected: PLAN.rejected.map((row) => (row.experienceId === "long" ? { ...row, message: "" } : row)),
    };
    const long = explainPlan(silent, CTX, { catalogue: catalogueMap }).byId.get("long") as Explanation;
    expect(long.headline).toBe("It needs more time than you have left. Short by 1 h 34 min.");
    expect(long.blocking?.key).toBe("filter:duration_exceeds_budget");
    expect(auditLedger(explainPlan(silent, CTX, { catalogue: catalogueMap }), silent, CTX, { catalogue: catalogueMap }).ok).toBe(true);
  });

  it("offers a real context mutation, and only where relaxing would fix it", () => {
    const pricey = LEDGER.byId.get("pricey") as Explanation;
    expect(pricey.actions.map((action) => action.id)).toEqual(["raise_budget", "drop_it"]);
    // The arithmetic: the ceiling plus the exact overspend.
    expect(pricey.actions[0]?.patch).toEqual({ budgetMinor: 240_000 });
    expect(pricey.actions[0]?.label).toBe("Raise the ceiling by ₹900.");
    expect(pricey.actions[1]?.patch).toEqual({ excludedIds: ["dropped", "pricey"] });

    const long = LEDGER.byId.get("long") as Explanation;
    expect(long.actions[0]?.patch).toEqual({ availableMin: 214 });

    // `relaxable: false` means the engine said no relaxation fixes this, so
    // nothing is offered rather than pretending otherwise.
    expect(LEDGER.byId.get("too_small")?.actions).toEqual([]);
    expect(LEDGER.byId.get("no_steps")?.actions).toEqual([]);
  });

  it("answers for a tapped thing by id, selected or not", () => {
    expect(explainOne("chosen", PLAN, CTX)?.outcome).toBe("selected");
    expect(explainOne("no_steps", PLAN, CTX, { catalogue: catalogueMap })?.blocking?.key).toBe("filter:not_step_free");
    // A candidate the plan never saw has no explanation, and says so.
    expect(explainOne("never-retrieved", PLAN, CTX)).toBeNull();
  });
});

describe("a selection is explained by the constraints it actually satisfied", () => {
  it("leads with the negative contribution and still explains why it won", () => {
    const chosen = LEDGER.byId.get("chosen") as Explanation;
    expect(chosen.outcome).toBe("selected");
    expect(chosen.blocking).toBeNull();
    expect(chosen.actions).toEqual([]);
    // The price term is -1, so it is a real cost against the ceiling and it leads
    // the ledger rather than being quietly dropped.
    expect(chosen.evidence[0]?.key).toBe("score:price");
    expect(chosen.evidence[0]?.polarity).toBe("opposes");
    expect(chosen.evidence[0]?.value).toBe(-1);
    expect(chosen.evidence[0]?.weight).toBe(0.6);
    // The headline is the engine's own summary, not the caveat.
    expect(chosen.headline).toBe(PLAN.stops[0]?.why[0]);
    expect(chosen.why).toEqual(PLAN.stops[0]?.why);
  });

  it("reproduces the engine's own score components, in impact order, one for one", () => {
    for (const stop of PLAN.stops) {
      const explanation = LEDGER.byId.get(stop.experienceId) as Explanation;
      const scored = explanation.evidence.filter((entry) => entry.source === "score");
      // The engine's own ranking, with the cost against it hoisted to the front:
      // a caveat is read before the praise, but nothing is dropped or invented.
      const ranked = [
        ...stop.score.components.filter((component) => component.value < 0),
        ...stop.score.components.filter((component) => component.value >= 0),
      ];

      expect(scored.map((entry) => entry.key), stop.experienceId).toEqual(
        ranked.map((component) => `score:${component.key}`),
      );
      expect(scored.map((entry) => entry.value), stop.experienceId).toEqual(ranked.map((component) => component.value));
      expect(scored.map((entry) => entry.weight), stop.experienceId).toEqual(ranked.map((component) => component.weight));
      // The engine's own ledger line, verbatim.
      expect(scored.map((entry) => entry.claim), stop.experienceId).toEqual(ranked.map((component) => component.reason));
      expect(explanation.scoreVersion, stop.experienceId).toBe(stop.score.profileVersion);
    }
  });

  it("shows the feasibility meter from the Fit, not from a fresh calculation", () => {
    const stop = PLAN.stops[0] as NonNullable<Plan["stops"][number]>;
    const meter = (LEDGER.byId.get("chosen") as Explanation).evidence.filter((entry) => entry.source === "fit");
    const byKey = new Map(meter.map((entry) => [entry.key, entry]));

    expect(byKey.get("fit:window")?.value).toBe(stop.fit.totalMin - stop.fit.availableMin);
    expect(byKey.get("fit:window")?.polarity).toBe("supports");
    expect(byKey.get("fit:travel")?.value).toBe(stop.fit.travelMin);
    expect(byKey.get("fit:activity")?.value).toBe(stop.fit.activityMin);
    expect(byKey.get("fit:buffer")?.value).toBe(stop.fit.bufferMin);
    expect(byKey.get("fit:cost")?.value).toBe(stop.fit.cost.minor);
    expect(byKey.get("fit:cost")?.claim).toBe("₹1,200 of the ₹1,500 ceiling.");
    // Every per-constraint check the engine published, with its own verdict.
    expect(meter.filter((entry) => entry.key.startsWith("fit:check:")).length).toBe(stop.fit.checks.length);
  });

  it("keeps a failed check visible on a stop that was selected anyway", () => {
    const tight = LEDGER.byId.get("chosen_tight") as Explanation;
    const failing = tight.evidence.filter((entry) => entry.polarity === "opposes" && entry.key.startsWith("fit:check:"));
    const engineCheck = (PLAN.stops[1]?.fit.checks ?? []).find((check) => !check.pass);

    expect(engineCheck?.label).toBe("Comfortable margin");
    expect(failing).toHaveLength(1);
    // The engine's own words, because they are the ones carrying the number.
    expect(failing[0]?.claim).toBe(engineCheck?.detail);
    expect(failing[0]?.claim).toBe("Only 48 min of slack in a 2 h window.");
    // It still leads, so nobody reads the recommendation without the caveat.
    expect(tight.evidence[0]?.polarity).toBe("opposes");
  });

  it("badges a fact that was guessed rather than confirmed", () => {
    const tight = LEDGER.byId.get("chosen_tight") as Explanation;
    const provenance = tight.evidence.filter((entry) => entry.key.startsWith("provenance:"));
    expect(provenance.map((entry) => entry.key)).toEqual(["provenance:durationMin", "provenance:hours"]);
    expect(provenance[0]?.provenance).toBe("inferred");
    expect(provenance[0]?.claim).toBe("How long it takes was guessed from the listing text, not confirmed.");
    expect(provenance[1]?.claim).toBe("The opening hours came from OpenStreetMap.");

    // With no catalogue there is no name and no badge, and nothing is invented.
    const bare = explainPlan(PLAN, CTX).byId.get("chosen_tight") as Explanation;
    expect(bare.name).toBeNull();
    expect(bare.evidence.some((entry) => entry.key.startsWith("provenance:"))).toBe(false);
  });

  it("shows what the packer gave up to make the plan fit", () => {
    expect(LEDGER.relaxations.map((entry) => entry.claim)).toEqual(["Filled what was left — gave up a third stop."]);
    expect(LEDGER.relaxations[0]?.key).toBe("relaxation:greedy_fill:duration_exceeds_budget");
  });
});

describe("nothing in the layer is keyed on the experience", () => {
  it("produces the same sentences for the same data under different ids", () => {
    const ids = new Set(CATALOGUE.map((item) => item.id));
    const mapping = new Map<string, string>();
    let counter = 0;
    // One mapping per id, so a reference in `ctx.pinnedIds` and the row it points
    // at move together.
    const opaque = (id: string): string => {
      const seen = mapping.get(id);
      if (seen !== undefined) return seen;
      const next = `row_${(counter += 1).toString(36)}_${id.length}`;
      mapping.set(id, next);
      return next;
    };
    const rename = <T,>(value: T): T =>
      JSON.parse(JSON.stringify(value), (_key, raw) =>
        typeof raw === "string" && ids.has(raw) ? opaque(raw) : raw,
      ) as T;

    const otherCtx = rename(CTX);
    const otherCatalogue = rename(CATALOGUE);
    const otherGate = referenceFeasible(otherCtx, otherCatalogue);
    const otherLedger = explainPlan(buildPlan(otherCtx, otherGate), otherCtx, {
      catalogue: new Map(otherCatalogue.map((item) => [item.id, item])),
    });

    // The gate decided the same thing about the same data...
    expect(otherGate.rejected.map((row) => row.code)).toEqual(GATE.rejected.map((row) => row.code));
    // ...and every sentence a traveller would read is byte-identical. Nothing in
    // the layer can be reading an id.
    expect(claimsOf(otherLedger)).toEqual(claimsOf(LEDGER));
  });

  it("is deterministic, with and without the catalogue", () => {
    expect(explainPlan(PLAN, CTX, { catalogue: catalogueMap })).toEqual(LEDGER);
    expect(explainPlan(PLAN, CTX)).toEqual(explainPlan(PLAN, CTX));
    // A shuffled catalogue cannot reorder anything, because nothing sorts by input.
    expect(explainPlan(PLAN, CTX, { catalogue: new Map([...catalogueMap].reverse()) })).toEqual(LEDGER);
  });
});

describe("the audit holds the ledger to the plan", () => {
  it("passes a ledger it just built", () => {
    expect(auditLedger(LEDGER, PLAN, CTX, { catalogue: catalogueMap })).toEqual({ ok: true, violations: [] });
  });

  it("catches a candidate the plan dropped with no answer", () => {
    const trimmed: ExplanationLedger = {
      ...LEDGER,
      explanations: LEDGER.explanations.filter((item) => item.experienceId !== "no_steps"),
      byId: new Map([...LEDGER.byId].filter(([id]) => id !== "no_steps")),
    };
    expect(auditLedger(trimmed, PLAN, CTX, { catalogue: catalogueMap })).toEqual({
      ok: false,
      violations: [{ code: "missing_explanation", message: "No explanation for no_steps.", experienceId: "no_steps" }],
    });
  });

  it("catches a claim that no longer matches the plan's numbers", () => {
    const truth = LEDGER.byId.get("pricey") as Explanation;
    const forged: ExplanationLedger = {
      ...LEDGER,
      explanations: LEDGER.explanations.map((item) =>
        item.experienceId === "pricey"
          ? {
              ...item,
              blocking: item.blocking && { ...item.blocking, value: 100 },
              evidence: item.evidence.map((entry) => (entry.source === "filter" ? { ...entry, value: 100 } : entry)),
            }
          : item,
      ),
    };
    const audit = auditLedger(forged, PLAN, CTX, { catalogue: catalogueMap });
    expect(truth.blocking?.value).toBe(90_000);
    expect(audit.ok).toBe(false);
    const drift = audit.violations.find((v) => v.code === "evidence_drift");
    expect(drift?.experienceId).toBe("pricey");
    // The violation names the field, so it is actionable rather than a shrug.
    expect(drift?.message).toContain("evidence[0].value");
  });

  it("catches a plan that both selected and rejected the same thing", () => {
    const impossible: Plan = {
      ...PLAN,
      rejected: [...PLAN.rejected, { ...rejectionIn(PLAN, "rainy"), experienceId: "chosen", code: "sold_out", message: "It is sold out." }],
    };
    const audit = auditLedger(explainPlan(impossible, CTX, { catalogue: catalogueMap }), impossible, CTX, {
      catalogue: catalogueMap,
    });
    expect(audit.ok).toBe(false);
    expect(audit.violations.filter((v) => v.code === "plan_contradiction")).not.toEqual([]);
  });

  it("catches a figure in a sentence the plan does not contain", () => {
    // A freshly built ledger, not a tampered one: the engine's own rejection
    // sentence quotes 47 minutes and nothing in the plan backs it.
    const lying: Plan = {
      ...PLAN,
      rejected: PLAN.rejected.map((row) =>
        row.experienceId === "long" ? { ...row, message: "It needs 47 min more than you have left." } : row,
      ),
    };
    const audit = auditLedger(explainPlan(lying, CTX, { catalogue: catalogueMap }), lying, CTX, {
      catalogue: catalogueMap,
    });
    expect(audit.ok).toBe(false);
    const bad = audit.violations.find((v) => v.code === "ungrounded_claim");
    expect(bad?.message).toContain("47 min");
  });

  it("re-derives after a replan, and refuses a ledger built for the old one", () => {
    // Reality changed: the rain stopped and the open-air venue is feasible again.
    // Three stops no longer fit the window, so the packer drops the last one.
    const clear: DiscoveryContext = {
      ...CTX,
      weather: { condition: "clear", tempC: 32, source: "simulated" },
    };
    const gate = referenceFeasible(clear, CATALOGUE);
    const plan = buildPlan(clear, gate);
    const ledger = explainPlan(plan, clear, { catalogue: catalogueMap });

    expect(gate.rejected.map((row) => row.code)).not.toContain("weather_unsafe");
    expect(ledger.byId.get("rainy")?.outcome).toBe("selected");
    // The same id is now dropped for what it actually fails, not the old reason.
    expect(LEDGER.byId.get("rainy")?.blocking?.key).toBe("filter:weather_unsafe");
    expect(rejectionIn(plan, "chosen_tight").code).toBe("duration_exceeds_budget");
    expect(ledger.byId.get("chosen_tight")?.outcome).toBe("rejected");

    // The new ledger stands up against the new plan...
    expect(auditLedger(ledger, plan, clear, { catalogue: catalogueMap }).ok).toBe(true);
    // ...and yesterday's ledger does not, which is the whole point of re-deriving.
    const stale = auditLedger(LEDGER, plan, clear, { catalogue: catalogueMap });
    expect(stale.ok).toBe(false);
    expect(stale.violations.map((v) => v.code)).toContain("evidence_drift");
  });
});
