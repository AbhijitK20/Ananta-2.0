/**
 * The shared test catalogue and the helpers that drive the pipeline.
 *
 * Nine real records from `content/experiences/*.jsonl` — Gateway of India, the Tulip
 * verandah, the Monsoon Film Walk, Britannia, the Jazz Corner, the Solar Cafe lawn,
 * the Marine Drive promenade — with their weather fields, coordinates, ratings and
 * durations copied verbatim out of the shipped seed data. Three test files share
 * this one catalogue so a fix to a fixture cannot make two of them disagree.
 *
 * Deliberately NOT set on these records: `bestMonths` and `bestTimeOfDay`. The
 * original 29 assertions are about the sky, and a `bestTimeOfDay` on every fixture
 * would let the clock term move their rankings for reasons those tests are not
 * about. The season and timing tests use their own records instead, in
 * `forecast.test.ts`.
 */
import {
  type DiscoveryContext,
  type Experience,
  type WeatherNow,
  Experience as ExperienceSchema,
} from "../../../contracts";
import {
  createContext,
  createSession,
  discover,
  indexCatalogue,
  type ContextSeed,
  type EditorOp,
} from "../../discovery";
import { withWeather } from "..";
import { DEFAULT_WEIGHTS, planner } from "./planner";

const rupees = (minor: number) => ({ minor, currency: "INR" as const });

export function exp(overrides: Partial<Experience> & Pick<Experience, "id" | "name">): Experience {
  return ExperienceSchema.parse({
    category: "street_food",
    durationMin: 45,
    pricePerPerson: null,
    capacity: null,
    hours: { raw: "Mo-Su 09:00-22:00", status: "ok", lastVerified: null },
    indoorOutdoor: "outdoor",
    accessibility: {
      stepFree: null,
      strollerOk: null,
      lowStairs: null,
      seatingAvailable: null,
      hearingLoop: null,
      restroomOnSite: null,
    },
    kidFriendly: null,
    minAge: null,
    diets: [],
    cuisines: [],
    rating: { value: 4.1, count: 3, rawMean: 4.1 },
    blurb: null,
    description: null,
    keywords: [],
    neighbourhood: "Colaba",
    city: "Mumbai",
    ...overrides,
  });
}

/** `col-gateway-of-india`: the open plaza that a monsoon has to close. */
export const GATEWAY = exp({
  id: "col-gateway-of-india",
  name: "Gateway of India",
  category: "heritage_site",
  location: { lat: 18.932, lon: 72.8348 },
  durationMin: 45,
  indoorOutdoor: "outdoor",
  weatherSensitive: "any",
  rating: { value: 4.08, count: 3, rawMean: 4 },
  keywords: ["gateway of india", "gateway", "heritage", "apollo bunder"],
  neighbourhood: "Colaba",
});

/** `col-solar-cafe-apollo`: lawn dining, so rain-specific rather than any-weather. */
export const SOLAR_CAFE = exp({
  id: "col-solar-cafe-apollo",
  name: "Solar Cafe, Apollo Bandar",
  category: "restaurant",
  location: { lat: 18.9305, lon: 72.8336 },
  durationMin: 80,
  pricePerPerson: rupees(160000),
  indoorOutdoor: "outdoor",
  weatherSensitive: "rain",
  rating: { value: 4.08, count: 3, rawMean: 4 },
  keywords: ["apollo bunder cafe", "lawn dining", "seafood colaba"],
});

/** `col-cafe-tulip`: the covered verandah, which is the whole reason it is here. */
export const TULIP = exp({
  id: "col-cafe-tulip",
  name: "The Tulip â€” verandah tables",
  category: "cafe",
  location: { lat: 18.923, lon: 72.8298 },
  durationMin: 45,
  pricePerPerson: rupees(80000),
  indoorOutdoor: "covered",
  weatherSensitive: "rain",
  rating: { value: 4.01, count: 3, rawMean: 4 },
  keywords: ["tulip", "verandah", "covered seating", "light rain"],
});

/** `col-monsoon-film-walk`: a `covered` record the rain actually improves. */
export const FILM_WALK = exp({
  id: "col-monsoon-film-walk",
  name: "Monsoon Film Walk",
  category: "hidden_place",
  location: { lat: 18.9231, lon: 72.8327 },
  durationMin: 60,
  pricePerPerson: rupees(30000),
  indoorOutdoor: "covered",
  weatherSensitive: "rain",
  rating: { value: 4.08, count: 3, rawMean: 4 },
  keywords: ["monsoon", "rain photography", "covered walk"],
});

export const BRITANNIA = exp({
  id: "col-britannia-co",
  name: "Britannia & Co.",
  category: "restaurant",
  location: { lat: 18.924, lon: 72.8327 },
  durationMin: 75,
  pricePerPerson: rupees(220000),
  indoorOutdoor: "indoor",
  weatherSensitive: "none",
  rating: { value: 4.08, count: 3, rawMean: 4 },
  keywords: ["britannia", "parsi", "berry pulao"],
});

export const JAZZ = exp({
  id: "col-jazz-corner",
  name: "Colaba Jazz Corner",
  category: "music_live",
  location: { lat: 18.9268, lon: 72.8341 },
  durationMin: 90,
  pricePerPerson: rupees(90000),
  indoorOutdoor: "indoor",
  weatherSensitive: "none",
  rating: { value: 3.95, count: 3, rawMean: 3.33 },
  keywords: ["jazz", "live jazz", "colaba live"],
});

export const DISPENSARY = exp({
  id: "col-dispensary-reading-room",
  name: "Old Dispensary Reading Room",
  category: "hidden_place",
  location: { lat: 18.9284, lon: 72.8363 },
  durationMin: 30,
  indoorOutdoor: "indoor",
  weatherSensitive: "none",
  rating: { value: 4.08, count: 3, rawMean: 4 },
  keywords: ["dispensary", "heritage office", "sitting room"],
});

/** `md-promenade`: the heat half of the gate, from the Marine Drive set. */
export const PROMENADE = exp({
  id: "md-promenade",
  name: "Marine Drive promenade",
  category: "nature",
  location: { lat: 19.0449, lon: 72.8203 },
  durationMin: 40,
  indoorOutdoor: "outdoor",
  weatherSensitive: "heat",
  rating: { value: 4.1, count: 3, rawMean: 4 },
  keywords: ["marine drive", "promenade", "sea walk"],
  neighbourhood: "Marine Drive",
});

export const SEAVIEW = exp({
  id: "md-grand-hotel-seaview",
  name: "Grand Hotel sea-view cafe",
  category: "cafe",
  location: { lat: 19.0451, lon: 72.8205 },
  durationMin: 60,
  pricePerPerson: rupees(120000),
  indoorOutdoor: "indoor",
  weatherSensitive: "none",
  rating: { value: 4.2, count: 3, rawMean: 4.2 },
  keywords: ["grand hotel", "sea view", "cafe"],
  neighbourhood: "Marine Drive",
});

export const CATALOGUE = [GATEWAY, SOLAR_CAFE, TULIP, FILM_WALK, BRITANNIA, JAZZ, DISPENSARY, PROMENADE, SEAVIEW];
export const CATALOGUE_INDEX = indexCatalogue(CATALOGUE);

// ---------------------------------------------------------------------------
// One traveller, one clock, several skies
// ---------------------------------------------------------------------------

export const COLABA: ContextSeed = {
  id: "ctx-colaba",
  origin: { label: "Colaba, near the Taj", point: { lat: 18.9265, lon: 72.8247 } },
  availableMin: 120,
  nowMin: 1020,
  partySize: 2,
  interests: ["heritage"],
};

export const weather = (condition: WeatherNow["condition"], tempC: number): Partial<WeatherNow> =>
  ({ condition, tempC, source: "simulated" });

/** Scenario A and Scenario B: identical in every field except the sky. */
export const clearSeed: ContextSeed = { ...COLABA, weather: weather("clear", 28) };
export const rainSeed: ContextSeed = { ...COLABA, weather: weather("heavy_rain", 25) };

export const ctxOf = (seed: ContextSeed): DiscoveryContext => createContext(seed).ctx;

export function engineFor(seed: ContextSeed, options: { preferPreviousOrder?: boolean } = {}) {
  const engine = withWeather(planner({ catalogue: CATALOGUE, ...options }), { catalogue: CATALOGUE_INDEX });
  const session = createSession({ engine, seed, catalogue: CATALOGUE, weights: DEFAULT_WEIGHTS });
  return { engine, session };
}

/** The ids the pipeline would offer the packer, best first. */
export function rankedIds(ctx: DiscoveryContext, options: { preferPreviousOrder?: boolean } = {}): string[] {
  const engine = withWeather(planner({ catalogue: CATALOGUE, ...options }), { catalogue: CATALOGUE_INDEX });
  const shortlist = engine.retrieve({ context: ctx, catalogue: CATALOGUE, limit: 120 });
  const feasible = engine.filterFeasible(ctx, shortlist);
  const byId = new Map(shortlist.map((item) => [item.id, item]));
  const items = feasible.passed
    .map((id) => byId.get(id))
    .filter((item): item is Experience => item !== undefined);
  const rank = new Map(engine.score(ctx, items, DEFAULT_WEIGHTS).map((entry) => [entry.experienceId, entry.total]));
  return [...items].sort((a, b) => (rank.get(b.id) ?? 0) - (rank.get(a.id) ?? 0) || a.id.localeCompare(b.id))
    .map((item) => item.id);
}

export const plannedIds = (seed: ContextSeed, options: { preferPreviousOrder?: boolean } = {}): string[] => {
  const { engine, session } = engineFor(seed, options);
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`planner built nothing: ${first.reason}`);
  return first.plan.stops.map((stop) => stop.experienceId);
};

export const setSky = (condition: WeatherNow["condition"]): EditorOp[] =>
  [{ kind: "set_weather", condition }];

// ===========================================================================