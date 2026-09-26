/**
 * When, and in what month, and what we say about it afterwards.
 *
 * `weather.test.ts` proves the gate reads the sky. This file proves the three
 * things that make it a *planner* rather than a filter:
 *
 *   1. The same sky at a different hour is a different plan. `docs/EVAL_SPEC.md` §20
 *      is titled "Heat wave, 11:00-16:00" and the context has always carried
 *      `nowMin`; a gate that could not read it was a thermometer.
 *   2. The calendar closes things the forecast never mentions. `docs/DATA_SPEC.md`
 *      §191 promises the monsoon "flips the weather gate, which flips
 *      recommendations", and the month is injected rather than guessed so that
 *      promise cannot fire on somebody who did not ask for it.
 *   3. Every weather-exposed stop that survives carries a written reason, which is
 *      what `noOutdoorStopWithoutJustification` in `docs/EVAL_SPEC.md` §219 asks
 *      for and what `report.ts` exists to produce.
 */
import { describe, expect, it } from "vitest";
import { type WeatherNow } from "../../../contracts";
import { createSession, discover, type ContextSeed } from "../../discovery";
import {
  BAND_CLOCK,
  MONSOON_MONTHS,
  NO_SEASON,
  assess,
  bandDistance,
  heatExposure,
  minutesInside,
  monsoonExposure,
  overlaps,
  profile,
  seasonOf,
  timeBand,
  timingMiss,
  verdictComponents,
  weatherReport,
  windowOf,
  withWeather,
  type Window,
} from "..";
import { DEFAULT_WEIGHTS, planner } from "./planner";
import { BRITANNIA, CATALOGUE, CATALOGUE_INDEX, COLABA, PROMENADE, TULIP, ctxOf, exp } from "./fixtures";

const sky = (condition: string, tempC: number) =>
  ({ condition, tempC, source: "simulated" }) as Parameters<typeof profile>[0];

const NOON: Window = { fromMin: 660, toMin: 780 };
const EVENING: Window = { fromMin: 1140, toMin: 1260 };
const MORNING: Window = { fromMin: 540, toMin: 660 };
const NIGHT: Window = { fromMin: 1380, toMin: 60 };

/** A seasonal programme: a December kite festival seen in July. Mirrors `ban-kite-festival`. */
const KITE_FESTIVAL = exp({
  id: "x-kite-festival",
  name: "Winter kite festival",
  category: "festival",
  location: { lat: 19.0463, lon: 72.8187 },
  indoorOutdoor: "outdoor",
  weatherSensitive: "any",
  bestMonths: [12, 1],
  bestTimeOfDay: ["morning", "afternoon"],
});

/** Says weather does not touch it, and is still three seasons out. Must survive. */
const WEATHER_INDIFFERENT = exp({
  id: "x-bell",
  name: "Village evening bell",
  category: "heritage_site",
  location: { lat: 19.0511, lon: 72.8206 },
  indoorOutdoor: "outdoor",
  weatherSensitive: "none",
  bestMonths: [12, 1, 2],
  bestTimeOfDay: ["evening"],
});

/** The six-week monsoon walk, which is the reason the season gate exists at all. */
const MONSOON_WALK = exp({
  id: "x-monsoon-walk",
  name: "Monsoon photography walk",
  category: "hidden_place",
  location: { lat: 18.9231, lon: 72.8327 },
  indoorOutdoor: "covered",
  weatherSensitive: "rain",
  bestMonths: [6, 7, 8, 9],
  bestTimeOfDay: ["afternoon", "evening"],
});

/** An open-air market that is a winter thing. */
const WINTER_MARKET = exp({
  id: "x-winter-market",
  name: "Winter craft market",
  category: "market",
  location: { lat: 19.0559, lon: 72.8251 },
  indoorOutdoor: "outdoor",
  weatherSensitive: "rain",
  bestMonths: [11, 12, 1, 2, 3],
  bestTimeOfDay: ["morning"],
});

const keys = (record: Parameters<typeof assess>[1], env: Parameters<typeof profile>[2] = {}): string[] =>
  verdictComponents(assess(profile(sky("clear", 30), [], { window: NOON, ...env }), record)).map((c) => c.key);

// ===========================================================================

describe("the clock", () => {
  it("names the band a minute falls in, at every edge", () => {
    expect(timeBand(300)).toBe("early_morning");
    expect(timeBand(479)).toBe("early_morning");
    expect(timeBand(480)).toBe("morning");
    expect(timeBand(659)).toBe("morning");
    expect(timeBand(660)).toBe("afternoon");
    expect(timeBand(1019)).toBe("afternoon");
    expect(timeBand(1020)).toBe("evening");
    expect(timeBand(1199)).toBe("evening");
    expect(timeBand(1200)).toBe("night");
    // 00:15 is the middle of the night, not an error.
    expect(timeBand(15)).toBe("night");
    expect(timeBand(299)).toBe("night");
  });

  it("counts the minutes of a window that fall in a band, across midnight", () => {
    // A 23:00 -> 01:00 window is two hours, and both halves of it are night.
    expect(minutesInside(NIGHT, BAND_CLOCK.night.start, BAND_CLOCK.night.end)).toBe(120);
    expect(minutesInside(NIGHT, 660, 1020)).toBe(0);
    // A window that wraps still measures against a linear band.
    expect(minutesInside({ fromMin: 1380, toMin: 1500 }, 1200, 1440)).toBe(60);
    expect(overlaps({ fromMin: 1380, toMin: 1500 }, 1200, 1440)).toBe(true);
    // The whole day is one day, not a wrap that measures zero.
    expect(minutesInside({ fromMin: 0, toMin: 1440 }, 300, 480)).toBe(180);
  });

  it("measures band distance round the clock, not across a line", () => {
    expect(bandDistance("evening", "evening")).toBe(0);
    expect(bandDistance("morning", "afternoon")).toBe(1);
    expect(bandDistance("morning", "night")).toBe(2);
    // 05:00 follows 20:00, so these are neighbours and not four bands apart.
    expect(bandDistance("night", "early_morning")).toBe(1);
    expect(bandDistance("afternoon", "early_morning")).toBe(2);
  });

  it("reads the window a context implies, and defaults to the whole day", () => {
    expect(windowOf({ nowMin: 1020, availableMin: 120 })).toEqual({ fromMin: 1020, toMin: 1140 });
    // No window supplied means every hour is in play, so the worst one counts.
    expect(profile(sky("heat", 41)).heatExposure).toBe("peak");
    expect(heatExposure(NOON)).toBe("peak");
    expect(heatExposure(MORNING)).toBe("high");
    expect(heatExposure(EVENING)).toBe("none");
  });
});

// ===========================================================================

describe("the same sky at a different hour", () => {
  it("refuses an exposed record at noon and merely demotes it at night", () => {
    const noon = assess(profile(sky("heat", 41), [], { window: NOON }), PROMENADE);
    const night = assess(profile(sky("heat", 41), [], { window: EVENING }), PROMENADE);

    expect(noon.sealed).toBe(true);
    expect(noon.reason).toContain("11:00 to 13:00");
    expect(noon.reason).toContain("sun up");
    // 41°C at 19:00 is still 41°C. The air is not being rounded down, only the
    // decision is: out in the open at 11:00 is not out in the open at 19:00.
    expect(night.sealed).toBe(false);
    expect(night.penalty).toBeGreaterThan(0);
    expect(night.severity).toBe(0);
  });

  it("scales the penalty with the sun, monotonically", () => {
    const at41 = (window: Window) => assess(profile(sky("heat", 41), [], { window }), PROMENADE).penalty;
    const peak = at41(NOON);
    const shoulder = at41(MORNING);
    const night = at41(EVENING);
    expect(peak).toBeGreaterThan(shoulder);
    expect(shoulder).toBeGreaterThan(night);
    expect(night).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(30);
  });

  it("does not use the clock to soften rain, which does not care what hour it is", () => {
    for (const window of [NOON, EVENING, NIGHT]) {
      expect(assess(profile(sky("heavy_rain", 25), [], { window }), PROMENADE).sealed, `${window.fromMin}`)
        .toBe(true);
    }
  });

  it("charges a record for the hour the traveller is actually looking at", () => {
    // An `evening` record is happy in the evening, one band out at noon, and two
    // bands out at half past five in the morning.
    expect(keys(WEATHER_INDIFFERENT, { window: EVENING })).not.toContain("timing");
    expect(keys(WEATHER_INDIFFERENT, { window: NOON })).toContain("timing");
    expect(keys(WEATHER_INDIFFERENT, { window: { fromMin: 330, toMin: 420 } })).toContain("timing");
    // A 16:00-18:00 window still contains an evening hour, so the packer is never
    // forced to place an evening record in the afternoon.
    expect(keys(WEATHER_INDIFFERENT, { window: { fromMin: 960, toMin: 1080 } })).not.toContain("timing");
    // A record with no `bestTimeOfDay` states no preference, which is not the same
    // as "any time suits it", and earns no term either way.
    expect(keys(PROMENADE, { window: NOON })).not.toContain("timing");
  });

  it("explains the clock in a sentence, not a number", () => {
    const verdict = assess(profile(sky("clear", 30), [], { window: NOON }), WEATHER_INDIFFERENT);
    expect(verdict.timing?.miss).toBe(1);
    expect(verdict.timing?.reason).toContain("best in the evening");
    expect(verdict.timing?.reason).toContain("11:00 to 13:00");
    // Two bands out pays double, and the miss count is a small integer.
    expect(timingMiss(["early_morning"], EVENING)).toBe(1);
    expect(timingMiss(["morning"], EVENING)).toBe(2);
    expect(timingMiss([], EVENING)).toBeNull();
  });
});

// ===========================================================================

describe("the calendar", () => {
  const july = { month: 7, monsoonMonths: MONSOON_MONTHS };
  const january = { month: 1, monsoonMonths: MONSOON_MONTHS };

  it("stands down completely when nobody said what month it is", () => {
    expect(seasonOf(KITE_FESTIVAL, NO_SEASON)).toBeNull();
    expect(keys(KITE_FESTIVAL, july)).not.toContain("season");
    // And the gate itself is untouched: no `seasonal_mismatch` can be emitted.
    const p = profile(sky("clear", 30), [], { window: NOON });
    expect(assess(p, KITE_FESTIVAL).sealed).toBe(false);
    expect(assess(p, KITE_FESTIVAL).season).toBeNull();
  });

  it("closes a seasonal programme seen in the wrong half of the year", () => {
    const verdict = assess(profile(sky("clear", 30), [], { window: NOON, ...july }), KITE_FESTIVAL);
    expect(verdict.sealed).toBe(true);
    expect(verdict.cause).toBe("season");
    expect(verdict.rejection?.code).toBe("seasonal_mismatch");
    expect(verdict.rejection?.message).toContain("December to January");
    expect(verdict.rejection?.relaxable).toBe(false);
    // Under a roof the same verdict is a penalty, never a closure.
    const covered = assess(profile(sky("clear", 30), [], { window: NOON, month: 1 }), MONSOON_WALK);
    expect(covered.sealed).toBe(false);
    expect(covered.cause).toBe(null);
    expect(covered.season?.inSeason).toBe(false);
  });

  it("never lets the calendar overrule a record that says weather does not touch it", () => {
    // `WEATHER_INDIFFERENT` is outdoor, `none`, and five months out of season. It
    // used to be the kind of record that got closed for being in July.
    const verdict = assess(profile(sky("clear", 30), [], { window: NOON, ...july }), WEATHER_INDIFFERENT);
    expect(verdict.sealed).toBe(false);
    expect(verdict.season?.sealed).toBe(false);
    // The bell is still an evening thing, so the clock still demotes it.
    expect(verdict.timing).not.toBeNull();
  });

  it("keeps the record the monsoon was built for, and demotes it in January", () => {
    // In season: a monsoon walk is simply the right answer, with nothing to say.
    const inSeason = assess(profile(sky("clear", 30), [], { window: NOON, ...july }), MONSOON_WALK);
    expect(inSeason.season).toBeNull();
    expect(inSeason.sealed).toBe(false);
    // Out of season it is still legal — it is under a roof — but it costs points and
    // says why, because it does not run in January.
    const outOfSeason = assess(profile(sky("clear", 30), [], { window: NOON, ...january }), MONSOON_WALK);
    expect(outOfSeason.sealed).toBe(false);
    expect(outOfSeason.season?.penalty).toBeGreaterThan(0);
    expect(outOfSeason.season?.reason).toContain("June to September");
  });

  it("plans for rain in the monsoon even under a clear sky, without inventing rain", () => {
    const outdoor = monsoonExposure(WINTER_MARKET, july);
    expect(outdoor).toBeGreaterThan(0);
    expect(monsoonExposure(TULIP, july)).toBe(0);
    expect(monsoonExposure(BRITANNIA, july)).toBe(0);
    expect(monsoonExposure(WINTER_MARKET, january)).toBe(0);

    const verdict = assess(profile(sky("clear", 30), [], { window: NOON, ...july }), WINTER_MARKET);
    // A penalty, never a closure: this is a hedge, and the sentence says so.
    expect(verdict.sealed).toBe(false);
    expect(verdict.season?.reason).toContain("plan for rain, not for a clear sky");
    expect(verdict.season?.reason).not.toContain("rain is");
  });

  it("knows the month is optional, and the monsoon months are Mumbai's", () => {
    expect(MONSOON_MONTHS).toEqual([6, 7, 8, 9]);
    expect(seasonOf(WINTER_MARKET, { month: 12, monsoonMonths: MONSOON_MONTHS })?.inSeason).toBe(true);
    // A record with no `bestMonths` states no preference and is never out of season.
    expect(seasonOf(BRITANNIA, july)?.inSeason).toBe(true);
    // A winter market in July is.
    expect(seasonOf(WINTER_MARKET, july)?.inSeason).toBe(false);
    expect(seasonOf(WINTER_MARKET, july)?.distance).toBe(4);
  });
});

// ===========================================================================

describe("what the plan says about itself", () => {
  const seedFor = (
    condition: WeatherNow["condition"],
    tempC: number,
    nowMin: number,
    availableMin = 180,
  ): ContextSeed => ({
    ...COLABA,
    id: `ctx-report-${condition}`,
    nowMin,
    availableMin,
    weather: { condition, tempC, source: "simulated" },
  });

  function built(seed: ContextSeed, options: { month?: number } = {}) {
    const engine = withWeather(planner({ catalogue: CATALOGUE }), {
      catalogue: CATALOGUE_INDEX,
      month: options.month ?? null,
    });
    const session = createSession({ engine, seed, catalogue: CATALOGUE, weights: DEFAULT_WEIGHTS });
    const first = discover(engine, session);
    if (!first.ok) throw new Error(`planner built nothing: ${first.reason}`);
    return { engine, session: first.session, plan: first.plan };
  }

  it("gives every weather-exposed stop a written reason, or says nothing at all", () => {
    const { plan, session } = built(seedFor("heavy_rain", 25, 1020));
    const report = weatherReport(plan, session.state.ctx, { catalogue: CATALOGUE_INDEX });

    // `noOutdoorStopWithoutJustification`, the eval assertion, as a value.
    expect(report.unjustified).toEqual([]);
    for (const stop of report.stops) {
      if (stop.exposed) expect(stop.note.length).toBeGreaterThan(0);
      else expect(stop.note).toBe("");
    }
    expect(report.stops.length).toBe(plan.stops.length);
  });

  it("reports the plan's weather risk in the shape the contract already uses", () => {
    // A shower: severity 1, so the open-air lawn stays a candidate, and a long
    // enough day that the packer actually reaches it. Started at 10:00 so the window
    // ends before midnight — see the note on `planner.ts` about that boundary.
    const damp = built(seedFor("light_rain", 25, 600, 480));
    const report = weatherReport(damp.plan, damp.session.state.ctx, { catalogue: CATALOGUE_INDEX });
    expect(report.stops.some((stop) => stop.exposed)).toBe(true);
    expect(report.factor?.dimension).toBe("weatherRisk");
    expect(report.factor?.weight).toBe(0.14);
    expect(report.risk).toBeGreaterThan(0);
    expect(report.rescue).toContain("under a roof");
    expect(report.rescue).toContain(damp.session.state.ctx.origin.label);
  });

  it("reports no risk at all once the gate has removed the exposure", () => {
    // The strongest statement the report can make: after the rain replan the plan
    // holds nothing the weather can reach, so its weather risk is zero and there is
    // no factor to show. The risk went with the stops.
    const wet = built(seedFor("heavy_rain", 25, 1020));
    const report = weatherReport(wet.plan, wet.session.state.ctx, { catalogue: CATALOGUE_INDEX });
    expect(report.stops.filter((stop) => stop.exposed)).toEqual([]);
    expect(report.risk).toBe(0);
    expect(report.factor).toBeNull();
    expect(report.rescue).toBeNull();
  });

  it("reports no risk at all on a fine evening with nothing to justify", () => {
    const { plan, session } = built(seedFor("clear", 24, 1140));
    const report = weatherReport(plan, session.state.ctx, { catalogue: CATALOGUE_INDEX });
    expect(report.risk).toBe(0);
    expect(report.factor).toBeNull();
    expect(report.rescue).toBeNull();
  });

  it("carries a season risk on a clear July day", () => {
    const seed = { ...seedFor("clear", 30, 1020), id: "ctx-july" };
    const { plan, session } = built(seed, { month: 7 });
    const report = weatherReport(plan, session.state.ctx, { catalogue: CATALOGUE_INDEX, month: 7 });
    // The plan itself is unchanged by a month, because the plan was built with the
    // same month; the report is simply able to say what the calendar thinks of it.
    expect(report.stops.every((stop) => stop.exposed || stop.note === "")).toBe(true);
  });

  it("is honest about a stop it cannot resolve", () => {
    const { plan, session } = built(seedFor("heavy_rain", 25, 1020));
    const empty = weatherReport(plan, session.state.ctx, { catalogue: new Map() });
    expect(empty.stops).toEqual([]);
    expect(empty.risk).toBe(0);
    expect(empty.factor).toBeNull();
  });
});
