/**
 * Real itineraries for the health read, built through the contract's own
 * schemas so a contract change breaks here rather than silently making the
 * stress tests assert against a shape that no longer exists.
 *
 * These are not stubs. Each one is a plan an engine could actually have packed
 * for a stated context, with coherent arrive/depart times, legs that join the
 * stops, `Fit` arithmetic that adds up, and costs that sum. The point is that
 * the health numbers are read off real structure: if a dimension only moves
 * because a fixture was hand-edited into moving it, the test is worthless.
 */
import {
  DiscoveryContext as ContextSchema,
  Experience as ExperienceSchema,
  Plan as PlanSchema,
  PlanStop as PlanStopSchema,
  TravelLeg as LegSchema,
  type DiscoveryContext,
  type Experience,
  type Fit,
  type Money,
  type Plan,
  type PlanStop,
  type Rejection,
  type TravelLeg,
} from "../../contracts";

const AT = "2026-02-14T04:30:00.000Z";
const rupees = (minor: number): Money => ({ minor, currency: "INR" });
/** 900 m at a flat 4.5 km/h. */
const metresFor = (minutes: number): number => Math.round(minutes * 75);

export function context(overrides: Partial<DiscoveryContext> = {}): DiscoveryContext {
  const base = {
    id: "ctx-health",
    origin: { label: "Bandra West", point: { lat: 19.06, lon: 72.83 } as const },
    availableMin: 240,
    nowMin: 600,
    budget: rupees(200_000),
    partySize: 2,
    partyType: "couple" as const,
    weather: { condition: "clear" as const, tempC: 30, source: "live" as const },
    ...overrides,
  };
  return ContextSchema.parse({
    ...base,
    original: {
      availableMin: base.availableMin,
      budget: base.budget,
      partySize: base.partySize,
      accessNeeds: [],
    },
  });
}

export function exp(
  over: Partial<Experience> & Pick<Experience, "id" | "name">,
): Experience {
  return ExperienceSchema.parse({
    category: "heritage_site",
    location: { lat: 19.0, lon: 72.87 },
    durationMin: 60,
    pricePerPerson: rupees(20_000),
    capacity: null,
    hours: { raw: "Mo-Su 09:00-21:00", status: "ok", lastVerified: "2026-01-01" },
    indoorOutdoor: "covered",
    accessibility: {
      stepFree: true,
      strollerOk: true,
      lowStairs: true,
      seatingAvailable: true,
      hearingLoop: null,
      restroomOnSite: true,
    },
    kidFriendly: true,
    minAge: null,
    diets: [],
    cuisines: [],
    rating: { value: 4.5, count: 300, rawMean: 4.6 },
    blurb: null,
    description: null,
    keywords: [],
    perception: { landscape: [], activities: [], atmosphere: [] },
    bestTimeOfDay: ["morning", "evening"],
    requiresJourney: false,
    booking: { required: false, leadTimeMin: 0, walkIn: true },
    bestMonths: [],
    weatherSensitive: "none",
    provenance: {},
    providerId: null,
    neighbourhood: "Fort",
    city: "Mumbai",
    ...over,
  });
}

export type StopSpec = {
  id: string;
  /** Minutes from midnight, the plan's clock. */
  arrive: number;
  activityMin: number;
  /** Travel minutes booked to reach it, which is the preceding leg. */
  travelMin?: number;
  travelMode?: TravelLeg["mode"];
  bufferMin?: number;
  costMinor?: number;
  verdict?: Fit["verdict"];
  /** Replaces the ratio the schema default would give, for tight plans. */
  fitRatio?: number;
};

function stop(spec: StopSpec, availableMin: number, order: number): PlanStop {
  const activityMin = spec.activityMin;
  const bufferMin = spec.bufferMin ?? 15;
  const totalMin = (spec.travelMin ?? 0) + activityMin + bufferMin;
  const costMinor = spec.costMinor ?? 40_000;
  return PlanStopSchema.parse({
    experienceId: spec.id,
    arriveMin: spec.arrive,
    departMin: spec.arrive + activityMin,
    order,
    why: ["short hop from where you are", "open now"],
    fit: {
      experienceId: spec.id,
      travelMin: spec.travelMin ?? 0,
      activityMin,
      bufferMin,
      totalMin,
      availableMin,
      fitRatio: spec.fitRatio ?? round2(totalMin / Math.max(1, availableMin)),
      cost: rupees(costMinor),
      budget: rupees(200_000),
      checks: [
        { label: "Fits the window", pass: (spec.verdict ?? "fits") !== "does_not_fit", detail: `${totalMin} of ${availableMin} min` },
        { label: "Step-free", pass: true, detail: "curated" },
      ],
      verdict: spec.verdict ?? (totalMin <= availableMin ? "fits" : "tight"),
    },
    score: {
      experienceId: spec.id,
      total: 8.4,
      components: [{ key: "proximity", label: "Close by", value: 3, weight: 1 }],
      profileVersion: "w1",
    },
  });
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export type PlanSpec = {
  /** Omit for the two-stop default. `[]` is a real plan with nothing in it. */
  stops?: StopSpec[];
  legs?: TravelLeg[];
  totalMin?: number;
  availableMin?: number;
  costMinor?: number;
  rejected?: Rejection[];
  relaxations?: Plan["relaxations"];
  utilisation?: number;
  createdAt?: string;
};

export function plan(spec: PlanSpec = {}): Plan {
  const availableMin = spec.availableMin ?? 240;
  const specs: StopSpec[] =
    spec.stops ??
    [
      { id: "exp-fort", arrive: 615, activityMin: 45, travelMin: 8, bufferMin: 20, costMinor: 40_000 },
      { id: "exp-cafe", arrive: 700, activityMin: 45, travelMin: 8, bufferMin: 20, costMinor: 40_000 },
    ];

  const stops = specs.map((s, i) => stop(s, availableMin, i));

  // One leg per stop after the first, from the SPEC (which carries the travel
  // fields) rather than from the parsed stop, which only carries them under
  // `fit`. Building from the wrong object silently produces zero-minute legs.
  const legs =
    spec.legs ??
    specs.slice(1).map((s, i) =>
      LegSchema.parse({
        fromId: specs[i]?.id ?? "",
        toId: s.id,
        mode: s.travelMode ?? "walk",
        minutes: s.travelMin ?? 0,
        metres: metresFor(s.travelMin ?? 0),
        detail: null,
        estimated: false,
      }),
    );

  const totalMin = spec.totalMin ?? legs.reduce((sum, leg) => sum + leg.minutes, 0) + stops.reduce((sum, s) => sum + s.fit.totalMin - (s.fit.travelMin ?? 0), 0);
  const costMinor = spec.costMinor ?? stops.reduce((sum, s) => sum + s.fit.cost.minor, 0);

  return PlanSchema.parse({
    id: "plan-health",
    contextId: "ctx-health",
    stops,
    legs,
    totalMin,
    totalCost: rupees(costMinor),
    utilisation: spec.utilisation ?? round2(totalMin / availableMin),
    totalMetres: legs.reduce((sum, leg) => sum + leg.metres, 0),
    rejected: spec.rejected ?? [],
    relaxations: spec.relaxations ?? [],
    stressScore: 0,
    stressFactors: [],
    createdAt: spec.createdAt ?? AT,
    engineVersion: "test-1",
  });
}

export function rejection(over: Partial<Rejection> & Pick<Rejection, "experienceId" | "code">): Rejection {
  return {
    message: `${over.experienceId} did not make it.`,
    shortfall: null,
    unit: null,
    relaxable: true,
    ...over,
  } as Rejection;
}

// ---------------------------------------------------------------------------
// The catalogue the plans above point at. Real coordinates, real Mumbai spread.
// ---------------------------------------------------------------------------

export const CATALOGUE: Experience[] = [
  exp({ id: "exp-fort", name: "Bandra Fort", location: { lat: 19.0437, lon: 72.8397 } }),
  exp({
    id: "exp-cafe",
    name: "Toscanini",
    category: "cafe",
    location: { lat: 19.0451, lon: 72.8421 },
    durationMin: 45,
    pricePerPerson: rupees(60_000),
  }),
  exp({
    id: "exp-gallery",
    name: "Jehangir Art Gallery",
    category: "gallery",
    location: { lat: 19.0435, lon: 72.84 },
    indoorOutdoor: "indoor",
    durationMin: 90,
  }),
  exp({
    id: "exp-beach",
    name: "Chowpatty Beach",
    category: "beach",
    location: { lat: 18.9547, lon: 72.8035 },
    indoorOutdoor: "outdoor",
    weatherSensitive: "any",
    durationMin: 60,
  }),
  exp({
    id: "exp-market",
    name: "Crawford Market",
    category: "market",
    location: { lat: 18.9488, lon: 72.8342 },
    indoorOutdoor: "outdoor",
    weatherSensitive: "rain",
    durationMin: 45,
  }),
  exp({
    id: "exp-nature",
    name: "Sanjay Gandhi National Park",
    category: "nature",
    location: { lat: 19.1697, lon: 72.91 },
    indoorOutdoor: "outdoor",
    weatherSensitive: "any",
    durationMin: 150,
    booking: { required: true, leadTimeMin: 2_880, walkIn: false },
  }),
  exp({
    id: "exp-theatre",
    name: "Prithvi Theatre",
    category: "theatre",
    location: { lat: 19.0989, lon: 72.8214 },
    indoorOutdoor: "indoor",
    durationMin: 120,
    bestTimeOfDay: ["evening"],
    booking: { required: true, leadTimeMin: 1_440, walkIn: false },
  }),
  exp({
    id: "exp-museum",
    name: "Dr Bhau Daji Lad Museum",
    category: "museum",
    location: { lat: 18.9289, lon: 72.8347 },
    indoorOutdoor: "indoor",
    durationMin: 90,
  }),
  exp({
    id: "exp-showcase",
    name: "Kala Ghoda Art District",
    category: "gallery",
    location: { lat: 18.928, lon: 72.832 },
    indoorOutdoor: "mixed",
    weatherSensitive: "rain",
    durationMin: 60,
  }),
];

export const byId = new Map(CATALOGUE.map((e) => [e.id, e]));
