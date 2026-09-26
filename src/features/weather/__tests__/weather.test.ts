/**
 * The weather gate, tested against the real pipeline.
 *
 * The shape of the proof, in order of how much it is worth:
 *
 *   1. The policy on its own — one table, every condition, every label.
 *   2. The same traveller, the same clock, two skies: the candidate list and the
 *      ranking must both move, and the plan the packer returns must move with
 *      them. This is the claim "weather is a planning constraint" or it is nothing.
 *   3. A real replan through `replanner.ts`, with the swap diff showing a stop
 *      leaving for a written weather reason.
 *   4. The same thing again against an engine that cannot see weather at all, so
 *      the change is provably the gate's and not the engine's politeness.
 *   5. Determinism, including that a live forecast and a simulated one produce the
 *      same plan.
 *
 * Nothing here opens a socket, reads a clock, or depends on a wall of `Date`.
 */
import { describe, expect, it } from "vitest";
import {
  type DiscoveryContext,
  type Experience,
  type WeatherNow,
  Experience as ExperienceSchema,
} from "../../../contracts";
import {
  ACTION_BY_ID,
  applyOpsAndReplan,
  createContext,
  createSession,
  discover,
  indexCatalogue,
  type ContextSeed,
  type EditorOp,
} from "../../discovery";
import { SWAP_BUDGET } from "../../discovery/reality";
import {
  UNKNOWN_WEATHER,
  WEATHER_POLICY_VERSION,
  assess,
  fixedSource,
  openMeteoSource,
  profile,
  profileFor,
  resolveWeather,
  withWeather,
} from "..";
import { DEFAULT_WEIGHTS, planner } from "./planner";

/** The one request shape these tests use. Fixed instant, so nothing reads a clock. */
const REQUEST = { point: { lat: 18.9265, lon: 72.8247 }, at: new Date("2026-07-14T12:00:00.000Z") };

// ---------------------------------------------------------------------------
// A catalogue of real Colaba and Marine Drive records, with the weather fields
// copied verbatim out of `content/experiences/*.jsonl`. The coordinates, the
// labels and the ratings are the shipped ones, so the gate is exercised against
// the values production will feed it, without these tests breaking every time
// somebody fixes a blurb in the seed data.
// ---------------------------------------------------------------------------

const rupees = (minor: number) => ({ minor, currency: "INR" as const });

function exp(overrides: Partial<Experience> & Pick<Experience, "id" | "name">): Experience {
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
const GATEWAY = exp({
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
const SOLAR_CAFE = exp({
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
const TULIP = exp({
  id: "col-cafe-tulip",
  name: "The Tulip — verandah tables",
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
const FILM_WALK = exp({
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

const BRITANNIA = exp({
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

const JAZZ = exp({
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

const DISPENSARY = exp({
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
const PROMENADE = exp({
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

const SEAVIEW = exp({
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

const CATALOGUE = [GATEWAY, SOLAR_CAFE, TULIP, FILM_WALK, BRITANNIA, JAZZ, DISPENSARY, PROMENADE, SEAVIEW];
const CATALOGUE_INDEX = indexCatalogue(CATALOGUE);

// ---------------------------------------------------------------------------
// One traveller, one clock, several skies
// ---------------------------------------------------------------------------

const COLABA: ContextSeed = {
  id: "ctx-colaba",
  origin: { label: "Colaba, near the Taj", point: { lat: 18.9265, lon: 72.8247 } },
  availableMin: 120,
  nowMin: 1020,
  partySize: 2,
  interests: ["heritage"],
};

const weather = (condition: WeatherNow["condition"], tempC: number): Partial<WeatherNow> =>
  ({ condition, tempC, source: "simulated" });

/** Scenario A and Scenario B: identical in every field except the sky. */
const clearSeed: ContextSeed = { ...COLABA, weather: weather("clear", 28) };
const rainSeed: ContextSeed = { ...COLABA, weather: weather("heavy_rain", 25) };

const ctxOf = (seed: ContextSeed): DiscoveryContext => createContext(seed).ctx;

function engineFor(seed: ContextSeed, options: { preferPreviousOrder?: boolean } = {}) {
  const engine = withWeather(planner({ catalogue: CATALOGUE, ...options }), { catalogue: CATALOGUE_INDEX });
  const session = createSession({ engine, seed, catalogue: CATALOGUE, weights: DEFAULT_WEIGHTS });
  return { engine, session };
}

/** The ids the pipeline would offer the packer, best first. */
function rankedIds(ctx: DiscoveryContext, options: { preferPreviousOrder?: boolean } = {}): string[] {
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

const plannedIds = (seed: ContextSeed, options: { preferPreviousOrder?: boolean } = {}): string[] => {
  const { engine, session } = engineFor(seed, options);
  const first = discover(engine, session);
  if (!first.ok) throw new Error(`planner built nothing: ${first.reason}`);
  return first.plan.stops.map((stop) => stop.experienceId);
};

const setSky = (condition: WeatherNow["condition"]): EditorOp[] =>
  [{ kind: "set_weather", condition }];

// ===========================================================================

describe("weather profile", () => {
  it("turns every condition into a hazard, and temperature into heat on its own", () => {
    const at = (condition: WeatherNow["condition"], tempC = 25) => profile({ condition, tempC, source: "simulated" });

    expect(at("clear").hazards).toEqual({ rain: 0, heat: 0, wind: 0 });
    expect(at("cloudy").hazards).toEqual({ rain: 0, heat: 0, wind: 0 });
    expect(at("light_rain").hazards).toEqual({ rain: 1, heat: 0, wind: 0 });
    expect(at("heavy_rain").hazards).toEqual({ rain: 2, heat: 0, wind: 0 });
    expect(at("storm").hazards).toEqual({ rain: 2, heat: 0, wind: 2 });
    expect(at("wind").hazards).toEqual({ rain: 0, heat: 0, wind: 1 });
    expect(at("heat").hazards).toEqual({ rain: 0, heat: 2, wind: 0 });

    // A clear forecast at 41°C is still a heatwave. The temperature is a fact the
    // condition does not get to overrule.
    expect(at("clear", 41).hazards.heat).toBe(2);
    expect(at("clear", 34).hazards.heat).toBe(1);
    expect(at("clear", 30).hazards.heat).toBe(0);
    // Rain and heat compose: a hot shower is both.
    expect(at("light_rain", 38).hazards).toEqual({ rain: 1, heat: 2, wind: 0 });
  });

  it("names the dominant hazard and never invents one", () => {
    expect(profile({ condition: "clear", tempC: 30, source: "simulated" }).dominant).toBeNull();
    expect(profile({ condition: "storm", tempC: 26, source: "simulated" }).dominant).toBe("rain");
    expect(profile({ condition: "clear", tempC: 41, source: "simulated" }).dominant).toBe("heat");
  });

  it("treats a simulated sky exactly like a live one", () => {
    const live = profile({ condition: "heavy_rain", tempC: 25, source: "live" });
    const simulated = profile({ condition: "heavy_rain", tempC: 25, source: "simulated" });
    expect(live.hazards).toEqual(simulated.hazards);
    expect(live.severity).toBe(simulated.severity);
    for (const item of CATALOGUE) {
      expect(assess(live, item).sealed).toBe(assess(simulated, item).sealed);
      expect(assess(live, item).penalty).toBe(assess(simulated, item).penalty);
    }
  });

  it("reads the traveller's own weather preferences out of the avoid tokens", () => {
    const plain = profileFor(ctxOf(clearSeed));
    expect(plain.averse).toBe(false);
    expect(plain.indoorOnly).toBe(false);

    const averse = profileFor(createContext({ ...clearSeed, prefs: { weatherSensitivity: "high" } }).ctx);
    expect(averse.averse).toBe(true);

    const indoors = profileFor(createContext({ ...clearSeed, prefs: { indoorOnly: true } }).ctx);
    expect(indoors.indoorOnly).toBe(true);
  });
});

describe("the gate", () => {
  const verdict = (condition: WeatherNow["condition"], tempC: number, item: Experience, avoid: string[] = []) =>
    assess(profile({ condition, tempC, source: "simulated" }, avoid), item);

  it("closes the street when it rains, and only the street", () => {
    for (const condition of ["light_rain", "heavy_rain", "storm"] as const) {
      expect(verdict(condition, 25, GATEWAY).sealed, condition).toBe(true);
      expect(verdict(condition, 25, SOLAR_CAFE).sealed, condition).toBe(true);
      // `covered` is the member of the enum that exists for exactly this.
      expect(verdict(condition, 25, TULIP).sealed, condition).toBe(false);
      expect(verdict(condition, 25, FILM_WALK).sealed, condition).toBe(false);
      // And nothing indoors is ever at the mercy of the weather.
      expect(verdict(condition, 25, BRITANNIA).sealed, condition).toBe(false);
      expect(verdict(condition, 25, JAZZ).sealed, condition).toBe(false);
    }
  });

  it("leaves the street alone in fine weather", () => {
    for (const condition of ["clear", "cloudy"] as const) {
      for (const item of CATALOGUE) {
        const result = verdict(condition, 28, item);
        expect(result.sealed, `${condition} ${item.id}`).toBe(false);
        // Zero penalty in fine weather is what makes "the weather changed nothing"
        // observable rather than assumed.
        expect(result.penalty, `${condition} ${item.id}`).toBe(0);
        expect(result.reason, `${condition} ${item.id}`).toBe("");
      }
    }
  });

  it("never seals a record whose own label says weather does not touch it", () => {
    for (const condition of ["light_rain", "heavy_rain", "storm", "heat", "wind"] as const) {
      expect(verdict(condition, 42, BRITANNIA).sealed, condition).toBe(false);
    }
  });

  it("treats heat as a gradient, not a switch", () => {
    // 35°C is a warning. 41°C closes the Hanging Gardens, per the record's own note.
    expect(verdict("clear", 35, PROMENADE).sealed).toBe(false);
    expect(verdict("clear", 35, PROMENADE).penalty).toBeGreaterThan(0);
    expect(verdict("heat", 41, PROMENADE).sealed).toBe(true);
    expect(verdict("clear", 41, PROMENADE).sealed).toBe(true);
    // 41°C does not close a covered verandah.
    expect(verdict("heat", 41, TULIP).sealed).toBe(false);
  });

  it("needs a real wind, not a breeze, to close a wind-sensitive record", () => {
    const windy = exp({
      id: "x-cliff-sail",
      name: "Cliff-edge sail",
      location: { lat: 18.9265, lon: 72.8298 },
      weatherSensitive: "wind",
    });
    expect(verdict("wind", 26, windy).sealed).toBe(false);
    expect(verdict("storm", 26, windy).sealed).toBe(true);
  });

  it("drops a traveller who says they hate weather one step sooner", () => {
    const averse = ["weather_averse"];
    // Heat at 34°C only warns a normal traveller...
    expect(verdict("clear", 34, PROMENADE).sealed).toBe(false);
    // ...and closes it for one who asked us to keep them out of it.
    expect(verdict("clear", 34, PROMENADE, averse).sealed).toBe(true);
    // Penalties double, and the same record is worse in the ledger.
    expect(verdict("heavy_rain", 25, TULIP, averse).penalty)
      .toBeGreaterThan(verdict("heavy_rain", 25, TULIP).penalty);
  });

  it("honours an indoors-only request whatever the sky is doing", () => {
    const indoors = ["indoors_only"];
    // Not a forecast: the traveller said it, so it holds in clear weather too.
    expect(verdict("clear", 28, GATEWAY, indoors).sealed).toBe(true);
    expect(verdict("clear", 28, GATEWAY, indoors).rejection?.code).toBe("excluded_by_traveller");
    expect(verdict("clear", 28, GATEWAY, indoors).reason).toContain("indoors only");
    // And the panel is never told the weather did it.
    expect(verdict("clear", 28, GATEWAY, indoors).rejection?.message).not.toContain("Clear skies");
    // A roof still beats a hedge.
    expect(verdict("light_rain", 25, TULIP, indoors).sealed).toBe(false);
    expect(verdict("clear", 28, TULIP, indoors).sealed).toBe(false);
  });

  it("writes a rejection a traveller can act on", () => {
    const result = verdict("heavy_rain", 25, GATEWAY);
    const rejection = result.rejection;
    expect(rejection?.code).toBe("weather_unsafe");
    expect(rejection?.experienceId).toBe("col-gateway-of-india");
    expect(rejection?.relaxable).toBe(false);
    // A finished sentence with the real numbers in it, not "constraint violated".
    expect(rejection?.message).toContain("Heavy rain, 25°C");
    expect(rejection?.message).toContain("Gateway of India");
    expect(rejection?.message).toContain("outdoors");
    expect(rejection?.message).toContain("ruined by any weather");
  });
});

// ===========================================================================

describe("the pipeline: one traveller, one clock, two skies", () => {
  it("Scenario A (normal) and Scenario B (rain) produce different candidate sets", () => {
    const { engine } = engineFor(clearSeed);
    const a = engine.filterFeasible(ctxOf(clearSeed), CATALOGUE);
    const b = engine.filterFeasible(ctxOf(rainSeed), CATALOGUE);

    expect(a.passed).toContain("col-gateway-of-india");
    expect(b.passed).not.toContain("col-gateway-of-india");
    expect(b.passed).not.toContain("col-solar-cafe-apollo");
    // Covered survives, which is the only reason `covered` is in the enum.
    expect(b.passed).toContain("col-cafe-tulip");
    expect(b.passed).toContain("col-monsoon-film-walk");

    const closed = b.rejected.filter((entry) => entry.code === "weather_unsafe");
    expect(closed.map((entry) => entry.experienceId).sort())
      .toEqual(["col-gateway-of-india", "col-solar-cafe-apollo"]);
    // The outdoor record that only fears heat is not a rain casualty.
    expect(b.passed).toContain("md-promenade");
  });

  it("reorders the candidates, not just the survivors", () => {
    const a = rankedIds(ctxOf(clearSeed));
    const b = rankedIds(ctxOf(rainSeed));

    // In fine weather the landmark wins on merit: interest, rating and proximity.
    expect(a[0]).toBe("col-gateway-of-india");
    expect(a.slice(0, 4)).toEqual([
      "col-gateway-of-india",
      "col-cafe-tulip",
      "col-britannia-co",
      "col-monsoon-film-walk",
    ]);

    // In rain it is not a candidate at all, and the room with the roof on it leads.
    expect(b.slice(0, 3)).toEqual([
      "col-britannia-co",
      "col-jazz-corner",
      "col-dispensary-reading-room",
    ]);
    // The covered records survive but are ranked under every indoor one.
    expect(b.indexOf("col-cafe-tulip")).toBeGreaterThan(b.indexOf("col-dispensary-reading-room"));
  });

  it("carries the penalty into the score breakdown, and only when there is weather", () => {
    const { engine } = engineFor(clearSeed);
    const fine = engine.score(ctxOf(clearSeed), CATALOGUE, DEFAULT_WEIGHTS);
    const wet = engine.score(ctxOf(rainSeed), CATALOGUE, DEFAULT_WEIGHTS);

    for (const entry of fine) {
      expect(entry.components.map((part) => part.key)).not.toContain("weather");
    }
    const tulip = wet.find((entry) => entry.experienceId === "col-cafe-tulip");
    expect(tulip?.components.map((part) => part.key)).toContain("weather");
    expect(tulip?.profileVersion).toContain(WEATHER_POLICY_VERSION);
    const term = tulip?.components.find((part) => part.key === "weather");
    expect(term?.value).toBeLessThan(0);
    expect(term?.reason).toContain("Heavy rain, 25°C");
  });

  it("adds nothing at all in fine weather", () => {
    const bare = planner({ catalogue: CATALOGUE });
    const { engine } = engineFor(clearSeed);
    const ctx = ctxOf(clearSeed);

    expect(engine.filterFeasible(ctx, CATALOGUE)).toEqual(bare.filterFeasible(ctx, CATALOGUE));
    expect(engine.score(ctx, CATALOGUE, DEFAULT_WEIGHTS)).toEqual(bare.score(ctx, CATALOGUE, DEFAULT_WEIGHTS));
  });

  it("changes the plan the packer returns, end to end through discover()", () => {
    const a = plannedIds(clearSeed);
    const b = plannedIds(rainSeed);

    expect(a).toContain("col-gateway-of-india");
    expect(b).not.toContain("col-gateway-of-india");
    expect(b).not.toContain("col-solar-cafe-apollo");
    expect(b).toContain("col-britannia-co");
    // Every stop in the rain plan is under a roof, which is the product claim.
    const shelter = b.map((id) => CATALOGUE_INDEX.get(id)?.indoorOutdoor);
    expect(shelter.every((value) => value === "indoor" || value === "covered")).toBe(true);
    expect(a).not.toEqual(b);
  });

  it("swaps the promenade out for the air-conditioned room in a heatwave", () => {
    const bandstand: ContextSeed = {
      id: "ctx-heat",
      origin: { label: "Marine Drive, Bandstand end", point: { lat: 19.0449, lon: 72.8203 } },
      availableMin: 120,
      nowMin: 660,
      partySize: 2,
      elderly: 1,
      accessNeeds: ["lowStairs"],
      weather: weather("heat", 41),
    };

    const mild = plannedIds({ ...bandstand, weather: weather("clear", 30) });
    const hot = plannedIds(bandstand);
    // A clear sky at 41°C is the same heatwave: the gate reads the thermometer as
    // well as the label, so a mislabelled forecast cannot smuggle a traveller out
    // into the sun.
    const clearButHot = plannedIds({ ...bandstand, weather: weather("clear", 41) });

    expect(mild).toContain("md-promenade");
    expect(hot).not.toContain("md-promenade");
    expect(hot).toContain("md-grand-hotel-seaview");
    expect(clearButHot).toEqual(hot);
  });
});

// ===========================================================================

describe("replanning when the sky turns", () => {
  function started(options: { preferPreviousOrder?: boolean } = {}) {
    const { engine, session } = engineFor(clearSeed, options);
    const first = discover(engine, session);
    if (!first.ok) throw new Error(`planner built nothing: ${first.reason}`);
    return { engine, session: first.session, before: first.plan };
  }

  it("replaces the outdoor stop and says why, in the swap diff", () => {
    const { engine, session, before } = started();
    expect(before.stops.map((stop) => stop.experienceId)).toContain("col-gateway-of-india");

    const outcome = applyOpsAndReplan(engine, session, setSky("heavy_rain"));
    if (!outcome.ok) throw new Error(`replan refused: ${outcome.reason}`);

    expect(outcome.change.kind).toBe("weather_changed");
    expect(outcome.session.plan?.stops.map((stop) => stop.experienceId))
      .not.toContain("col-gateway-of-india");

    const removed = outcome.diff.removed.map((stop) => stop.id);
    const added = outcome.diff.added.map((stop) => stop.id);
    expect(removed).toContain("col-gateway-of-india");
    // What the gate guarantees on the replan path is feasibility, not ordering: the
    // engine owns the re-solve and re-ranks from its own catalogue, so the promise
    // is that nothing the sky closed survives and everything that arrived is legal.
    // (Soft ordering reaches the packer on the `discover` path, where `score()` is
    // the input; see `pipeline.ts`.)
    expect(added.length).toBeGreaterThan(0);
    for (const id of removed) {
      expect(CATALOGUE_INDEX.get(id)?.indoorOutdoor).toBe("outdoor");
    }
    for (const id of added) {
      expect(["indoor", "covered"]).toContain(CATALOGUE_INDEX.get(id)?.indoorOutdoor);
    }

    // The removal leaves with the weather's own sentence, not a shrug. The chip
    // changes the condition and leaves the temperature alone, so the sentence
    // quotes the 28°C the context is actually holding.
    const gateway = outcome.diff.removed.find((stop) => stop.id === "col-gateway-of-india");
    expect(gateway?.reason).toContain("Heavy rain, 28°C");
    expect(gateway?.reason).toContain("Gateway of India");

    // A replan is not a free-for-all: the swap budget still holds.
    expect(outcome.diff.swapCount).toBeLessThanOrEqual(SWAP_BUDGET);
    expect(outcome.reality.warnings).toEqual([]);
    expect(outcome.reality.intentPreserved).toBe(true);
    expect(outcome.session.intent.original).toEqual(session.intent.original);
  });

  it("works the same against an engine that cannot see weather at all", () => {
    // This engine re-solves only the order it already had, so on its own the rain
    // would change nothing. Anything that changes is the gate.
    const { engine, session, before } = started({ preferPreviousOrder: true });
    expect(before.stops.map((stop) => stop.experienceId)).toContain("col-gateway-of-india");

    const outcome = applyOpsAndReplan(engine, session, setSky("heavy_rain"));
    if (!outcome.ok) throw new Error(`replan refused: ${outcome.reason}`);

    expect(outcome.diff.removed.map((stop) => stop.id)).toContain("col-gateway-of-india");
    expect(outcome.plan.stops.map((stop) => stop.experienceId)).not.toContain("col-gateway-of-india");
    expect(outcome.plan.stops.length).toBeGreaterThan(0);
  });

  it("keeps the plan when the weather improves again", () => {
    const { engine, session } = started();
    const rained = applyOpsAndReplan(engine, session, setSky("heavy_rain"));
    if (!rained.ok) throw new Error(`replan refused: ${rained.reason}`);
    const cleared = applyOpsAndReplan(engine, rained.session, setSky("clear"));
    if (!cleared.ok) throw new Error(`replan refused: ${cleared.reason}`);

    // Back to the fine-weather plan, from the same traveller and the same clock.
    expect(cleared.plan.stops.map((stop) => stop.experienceId))
      .toEqual(plannedIds(clearSeed));
  });

  it("is reachable from the shipped reality trigger, not only from the editor", () => {
    const { engine, session } = started();
    const outcome = applyOpsAndReplan(engine, session, [{ kind: "set_weather", condition: "heavy_rain" }]);
    if (!outcome.ok) throw new Error(`replan refused: ${outcome.reason}`);
    expect(outcome.reality.change.kind).toBe("weather_changed");
    // The chip in `actions.ts` sends travellers here, and it lands in the same place.
    expect(ACTION_BY_ID.get("rain")?.ops({
      state: session.state,
      plan: session.plan,
      nameOf: (id) => CATALOGUE_INDEX.get(id)?.name ?? "That place",
    })).toEqual([{ kind: "set_weather", condition: "heavy_rain", note: "Rain started." }]);
  });
});

// ===========================================================================

describe("determinism and the weather source", () => {
  it("produces byte-identical plans for the same input", () => {
    const first = engineFor(clearSeed);
    const a = discover(first.engine, first.session);
    const second = engineFor(clearSeed);
    const b = discover(second.engine, second.session);
    if (!a.ok || !b.ok) throw new Error("planner built nothing");
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
    expect(JSON.stringify(rankedIds(ctxOf(rainSeed)))).toBe(JSON.stringify(rankedIds(ctxOf(rainSeed))));
  });

  it("answers deterministically from a fixed source, with no network", async () => {
    const source = fixedSource({ condition: "heavy_rain", tempC: 25, source: "simulated" });
    const [a, b] = await Promise.all([source.read(REQUEST), source.read(REQUEST)]);
    expect(a).toEqual(b);
    // And the answer is a `WeatherNow` the frozen context accepts verbatim.
    expect(createContext({ ...clearSeed, weather: a }).ctx.weather).toEqual(a);
  });

  it("maps a live forecast onto the frozen enum, behind an injected fetch", async () => {
    const payload = { current: { temperature_2m: 25.4, weather_code: 65, wind_gusts_10m: 18 } };
    const source = openMeteoSource({ fetch: async () => ({ ok: true, json: async () => payload }) });
    const weather = await source.read(REQUEST);

    expect(weather).toEqual({ condition: "heavy_rain", tempC: 25.4, source: "live" });
    expect(assess(profile(weather), GATEWAY).sealed).toBe(true);
  });

  it("turns a gust into `wind` when the sky is otherwise clear", async () => {
    const source = openMeteoSource({
      fetch: async () => ({ ok: true, json: async () => ({ current: { temperature_2m: 31, weather_code: 0, wind_gusts_10m: 52 } }) }),
    });
    const weather = await source.read({ ...REQUEST, point: { lat: 19.0449, lon: 72.8203 } });
    expect(weather.condition).toBe("wind");
  });

  it("costs a badge and nothing else when the provider fails", async () => {
    const offline = openMeteoSource({ fetch: async () => { throw new Error("offline"); } });
    const weather = await resolveWeather(offline, REQUEST);
    expect(weather).toEqual(UNKNOWN_WEATHER);
    // Unknown weather is fine weather, never a guess in the traveller's favour.
    expect(assess(profile(weather), GATEWAY).sealed).toBe(false);
  });
});
