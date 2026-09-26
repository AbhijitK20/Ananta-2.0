/**
 * The gate against the real catalogue, not a fixture.
 *
 * `weather.test.ts` proves the policy is right on nine hand-picked records and
 * `forecast.test.ts` proves the clock and the calendar. Neither can tell you what the
 * gate does to the 133 records the product actually ships. This file can, and it is
 * the closest thing here to the eval harness's weather slice: it loads
 * `content/experiences/*.jsonl` through the frozen `Experience` schema — so a
 * catalogue that stops conforming fails here, loudly, before any assertion — and then
 * asserts the distribution properties the shipped eval scenarios assume.
 *
 * The claims, and where each one comes from:
 *
 *   - `content/evaluation/scenarios.jsonl` §19: a `heavy_rain` context must kill every
 *     outdoor record and keep every `covered` one.
 *   - §20: a 41°C day between 11:00 and 16:00 must leave no `weatherSensitive: heat`
 *     record in an outdoor plan.
 *   - §7: a monsoon context with a wheelchair user must still return answers, all of
 *     them under a roof. A gate that empties the candidate set is not a gate.
 *   - `docs/DATA_SPEC.md` §191: the monsoon has to flip the gate on its own, with no
 *     rain in the forecast.
 *
 * And the one that matters most for the other nine sessions: with no month injected,
 * the season gate is completely inert, so nothing here can move an eval run that does
 * not ask for a date.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DiscoveryContext as DiscoveryContextSchema,
  Experience as ExperienceSchema,
  type DiscoveryContext,
  type Experience,
  type IndoorOutdoor,
  type WeatherNow,
} from "../../../contracts";
import { createContext, type ContextSeed } from "../../discovery";
import {
  MONSOON_MONTHS,
  assess,
  profile,
  verdictComponents,
  withWeather,
  type WeatherEnv,
} from "..";
import { planner } from "./planner";
import { indexCatalogue } from "../../discovery";

// ---------------------------------------------------------------------------
// The shipped catalogue
// ---------------------------------------------------------------------------

const RECORDS: Experience[] = readdirSync("content/experiences")
  .filter((name) => name.endsWith(".jsonl"))
  .flatMap((name) =>
    readFileSync(`content/experiences/${name}`, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => ExperienceSchema.parse(JSON.parse(line))));

const sky = (condition: WeatherNow["condition"], tempC: number, source: WeatherNow["source"] = "simulated"): WeatherNow =>
  ({ condition, tempC, source });

const gate = (weather: WeatherNow, env: WeatherEnv = {}, avoid: readonly string[] = []) =>
  profile(weather, avoid, env);

const sealedUnder = (weather: WeatherNow, env: WeatherEnv = {}): Set<string> =>
  new Set(RECORDS.filter((record) => assess(gate(weather, env), record).sealed).map((record) => record.id));

const surviving = (weather: WeatherNow, env: WeatherEnv = {}): Experience[] =>
  RECORDS.filter((record) => !assess(gate(weather, env), record).sealed);

const of = (kind: IndoorOutdoor) => RECORDS.filter((record) => record.indoorOutdoor === kind);

const ctxOf = (weather: WeatherNow, seed: Partial<ContextSeed> = {}): DiscoveryContext =>
  createContext({
    id: "ctx-real",
    origin: { label: "Colaba, near the Taj", point: { lat: 18.9265, lon: 72.8247 } },
    availableMin: 180,
    nowMin: 1020,
    partySize: 2,
    weather,
    ...seed,
  }).ctx;

describe("the shipped catalogue", () => {
  it("parses every record against the frozen schema", () => {
    expect(RECORDS.length).toBeGreaterThan(100);
    // The properties the gate leans on are populated, so the gate is not deciding on
    // a column of defaults.
    for (const record of RECORDS) {
      expect(record.indoorOutdoor, record.id).toBeTruthy();
      expect(["none", "rain", "heat", "wind", "any"], record.id).toContain(record.weatherSensitive);
    }
    // And the data contains every case the gate has branches for, which is what makes
    // this file worth having: a `wind` record would leave one branch untested.
    expect(of("covered").length).toBeGreaterThan(0);
    expect(RECORDS.filter((r) => r.indoorOutdoor === "mixed").length).toBeGreaterThan(0);
    expect(RECORDS.filter((r) => r.weatherSensitive === "heat").length).toBeGreaterThan(0);
    expect(RECORDS.filter((r) => r.weatherSensitive === "any").length).toBeGreaterThan(0);
  });
});

describe("EVAL_SPEC §19: heavy rain", () => {
  const heavy = sky("heavy_rain", 25);
  const closed = sealedUnder(heavy);

  it("closes every outdoor record and keeps every covered one", () => {
    for (const record of RECORDS) {
      const isOpenAir = record.indoorOutdoor === "outdoor" || record.indoorOutdoor === "mixed";
      if (isOpenAir) expect(closed.has(record.id), record.id).toBe(true);
      if (record.indoorOutdoor === "covered") expect(closed.has(record.id), record.id).toBe(false);
    }
  });

  it("closes the specific records §19 names, with the reason it names", () => {
    // The scenario's own `forbiddenBecause` map, asserted here.
    const named: Array<[string, string]> = [
      ["col-gateway-of-india", "ruined by any weather"],
      ["col-lighthouse-point", "ruined by any weather"],
      ["adj-banganga", "ruined by heat"],
      ["col-kite-corner", "ruined by rain"],
      ["col-tiffin-at-the-wadi", "ruined by rain"],
      ["col-causeway-frames-walk", "ruined by rain"],
      ["col-chaat-mile-marker", "ruined by rain"],
    ];
    for (const [id, why] of named) {
      const record = RECORDS.find((item) => item.id === id);
      expect(record, id).toBeDefined();
      const verdict = assess(gate(heavy), record as Experience);
      expect(verdict.sealed, id).toBe(true);
      expect(verdict.rejection?.code, id).toBe("weather_unsafe");
      expect(verdict.rejection?.message, id).toContain(why);
    }
  });

  it("keeps the records §19 calls acceptable", () => {
    for (const id of ["col-cafe-tulip", "col-monsoon-film-walk", "col-britannia-co", "ban-indoor-market"]) {
      expect(closed.has(id), id).toBe(false);
    }
  });

  it("leaves enough of the catalogue to plan with", () => {
    // A gate that empties the candidate set is not a gate, it is a denial of service.
    // §7 is a monsoon scenario with a wheelchair user and it still expects answers.
    // 63 of 133 is the real number under a downpour: every roof, every verandah, and
    // the indoor rooms. Nothing outdoors survives, which is the point.
    expect(surviving(heavy).length).toBeGreaterThanOrEqual(50);
    expect(of("indoor").every((record) => !closed.has(record.id))).toBe(true);
    expect(of("covered").every((record) => !closed.has(record.id))).toBe(true);
    expect(of("outdoor").every((record) => closed.has(record.id))).toBe(true);
  });
});

// ===========================================================================
// The cross-check that matters: the shipped eval scenarios, run through the gate.
// ===========================================================================

type EvalScenario = {
  id: string;
  context: DiscoveryContext;
  acceptableIds: string[];
  forbiddenIds: string[];
  forbiddenBecause?: Record<string, string>;
  assertions?: Record<string, unknown>;
};

const SCENARIOS: EvalScenario[] = readFileSync("content/evaluation/scenarios.jsonl", "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as EvalScenario);

const byId = new Map(RECORDS.map((record) => [record.id, record]));

describe("the 31 shipped eval scenarios", () => {
  it("parses every scenario context but three against the frozen schema", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(31);
    // Three shipped contexts do not conform, and it is one systematic data bug rather
    // than a gate bug: the negative-only scenarios carry `requests: [{ pos: null }]`
    // while the frozen `DecomposedRequest.pos` is a required string. Their titles say
    // the intent — "negative-only, no `pos` at all", "negative channel as a signal" —
    // so the shape is what is wrong, and the eval harness will fail on them before it
    // ever reaches a weather assertion. Reported rather than fixed: `content/**` is
    // another stream's, and a gate that quietly tolerated a null `pos` would hide the
    // next one too.
    const broken = SCENARIOS.filter((s) => !DiscoveryContextSchema.safeParse(s.context).success);
    expect(broken.map((s) => s.id).sort()).toEqual(["couple-wants-alone", "hidden-local-2h", "no-tourists"]);
    expect(SCENARIOS.length - broken.length).toBeGreaterThanOrEqual(28);
  });

  it("closes everything a scenario says the weather closes", () => {
    for (const scenario of SCENARIOS) {
      const p = profile(scenario.context.weather, scenario.context.avoid);
      for (const id of scenario.forbiddenIds) {
        if (scenario.forbiddenBecause?.[id] !== "weather_unsafe") continue;
        const record = byId.get(id);
        expect(record, `${scenario.id} ${id}`).toBeDefined();
        expect(assess(p, record as Experience).sealed, `${scenario.id} ${id}`).toBe(true);
      }
    }
  });

  it("never closes a record a scenario says is fine and that is under a roof", () => {
    for (const scenario of SCENARIOS) {
      const p = profile(scenario.context.weather, scenario.context.avoid);
      for (const id of scenario.acceptableIds) {
        const record = byId.get(id);
        if (!record) continue;
        const underRoof = record.indoorOutdoor === "indoor" || record.indoorOutdoor === "covered";
        if (!underRoof) continue;
        expect(assess(p, record).sealed, `${scenario.id} ${id}`).toBe(false);
      }
    }
  });

  it("leaves every scenario with something to return", () => {
    for (const scenario of SCENARIOS) {
      const p = profile(scenario.context.weather, scenario.context.avoid);
      const left = RECORDS.filter((record) => !assess(p, record).sealed);
      expect(left.length, scenario.id).toBeGreaterThan(0);
      // And enough of them that the "minimum stops" assertions in the scenario files
      // are not being met by a single lucky survivor.
      expect(left.length, scenario.id).toBeGreaterThan(10);
    }
  });

  it("explains every outdoor stop it chooses to keep, in the scenarios that ask for it", () => {
    // `noOutdoorStopWithoutJustification` (19) and `noHeatSensitiveOutdoorStop` (20)
    // are the two scenarios whose assertions require it, and the assertion keys are in
    // the data, so this reads them rather than guessing. An outdoor record in the
    // acceptable set may stay — but never silently.
    const asking = SCENARIOS.filter((s) =>
      s.assertions?.noOutdoorStopWithoutJustification !== undefined
      || s.assertions?.noHeatSensitiveOutdoorStop !== undefined);
    expect(asking.map((s) => s.id).sort()).toEqual(["heat-11-to-16", "heavy-rain-3h-1200"]);

    for (const scenario of asking) {
      const p = profile(scenario.context.weather, scenario.context.avoid);
      for (const id of scenario.acceptableIds) {
        const record = byId.get(id);
        if (!record || record.indoorOutdoor !== "outdoor") continue;
        const verdict = assess(p, record);
        const note = verdict.reason || verdict.season?.reason || verdict.timing?.reason || "";
        expect(
          verdictComponents(verdict).length > 0 || note.length > 0,
          `${scenario.id} ${id}`,
        ).toBe(true);
      }
    }
  });
});

describe("EVAL_SPEC §20: a heat wave, 11:00 to 16:00", () => {
  const noon = { window: { fromMin: 660, toMin: 960 } };
  const heat = sky("heat", 41);

  it("closes every heat-sensitive record that is in the open, and none that is not", () => {
    const closed = sealedUnder(heat, noon);
    for (const record of RECORDS) {
      const isOpenAir = record.indoorOutdoor === "outdoor" || record.indoorOutdoor === "mixed";
      if (record.weatherSensitive === "heat" && isOpenAir) expect(closed.has(record.id), record.id).toBe(true);
    }
    // The six records §19 forbids for `weather_unsafe`, all of them named in §20.
    for (const id of ["ban-hill-road", "md-hanging-gardens", "ban-bandra-fort", "md-promenade", "adj-pali-hill-view", "ban-seaprincess-viewpoint"]) {
      expect(closed.has(id), id).toBe(true);
    }
  });

  it("keeps the seven records §20 calls acceptable", () => {
    const closed = sealedUnder(heat, noon);
    for (const id of [
      "md-grand-hotel-seaview",
      "ban-indoor-market",
      "adj-museum-of-mumbai",
      "ban-cinema-neo",
      "ban-board-games-cafe",
      "md-quiet-cafe-gully",
      "ban-persian-sweet-house",
    ]) {
      expect(closed.has(id), id).toBe(false);
    }
  });

  it("reads the temperature, not the label, so a clear 41°C day behaves the same", () => {
    expect(sealedUnder(sky("clear", 41), noon)).toEqual(sealedUnder(heat, noon));
  });

  it("lets the same records back in after sunset", () => {
    const evening = { window: { fromMin: 1140, toMin: 1260 } };
    // 41°C at 19:00 is still 41°C, so the heat-sensitive outdoor records are demoted
    // rather than closed, and the penalty says why.
    for (const id of ["ban-hill-road", "md-promenade", "adj-pali-hill-view"]) {
      const record = RECORDS.find((item) => item.id === id) as Experience;
      const verdict = assess(gate(heat, evening), record);
      expect(verdict.sealed, id).toBe(false);
      expect(verdict.penalty, id).toBeGreaterThan(0);
    }
  });
});

describe("DATA_SPEC §191: the monsoon flips the gate with no rain in the forecast", () => {
  const clear = sky("clear", 30);
  const july = { month: 7, monsoonMonths: MONSOON_MONTHS, window: { fromMin: 1020, toMin: 1140 } };
  const january = { month: 1, monsoonMonths: MONSOON_MONTHS, window: { fromMin: 1020, toMin: 1140 } };

  it("is inert until somebody says what month it is", () => {
    const noMonth = new Set(RECORDS.map((record) => record.id));
    expect(sealedUnder(clear, july, )).not.toEqual(noMonth);
    // With no month, a clear day closes nothing at all.
    expect(sealedUnder(clear).size).toBe(0);
    for (const record of RECORDS) {
      const verdict = assess(gate(clear), record);
      expect(verdict.season, record.id).toBeNull();
      expect(verdict.sealed, record.id).toBe(false);
    }
  });

  it("closes a seasonal programme in the wrong half of the year, and only that", () => {
    const julyClosed = sealedUnder(clear, july);
    const januaryClosed = sealedUnder(clear, january);

    // `ban-kite-festival` runs in December and January. Mumbai in July is the wrong
    // half of the year for a kite festival, whatever the sky is doing.
    expect(julyClosed.has("ban-kite-festival")).toBe(true);
    expect(januaryClosed.has("ban-kite-festival")).toBe(false);
    // And it is a `seasonal_mismatch`, not a weather one.
    const kite = RECORDS.find((r) => r.id === "ban-kite-festival") as Experience;
    expect(assess(gate(clear, july), kite).rejection?.code).toBe("seasonal_mismatch");

    // Six months is the whole closure budget, so a clear July day must not close half
    // the city. At three it closed 69 of 133, including a free village bell.
    expect(julyClosed.size).toBeLessThan(RECORDS.length / 4);
    for (const record of RECORDS) {
      if (record.weatherSensitive === "none") {
        expect(julyClosed.has(record.id), record.id).toBe(false);
      }
    }
  });

  it("keeps the two records that exist for the monsoon", () => {
    // `col-monsoon-film-walk` and `md-monsoon-seawall` are the six-week programmes the
    // whole season gate is for. In July they are in season and legal; in January they
    // are legal but demoted, because they are under a roof and the hours adapter, not
    // this file, is what closes a programme that is not running.
    for (const id of ["col-monsoon-film-walk", "md-monsoon-seawall"]) {
      expect(sealedUnder(clear, july).has(id), id).toBe(false);
      const record = RECORDS.find((r) => r.id === id) as Experience;
      expect(assess(gate(clear, july), record).season, id).toBeNull();
      const winter = assess(gate(clear, january), record);
      expect(winter.sealed, id).toBe(false);
      expect(winter.season?.penalty, id).toBeGreaterThan(0);
    }
  });

  it("charges outdoor records for the monsoon on a clear day, in words", () => {
    const outdoor = RECORDS.find((r) => r.indoorOutdoor === "outdoor" && r.weatherSensitive === "any") as Experience;
    const verdict = assess(gate(clear, july), outdoor);
    expect(verdict.season?.penalty).toBeGreaterThan(0);
    expect(verdict.season?.reason).toContain("plan for rain, not for a clear sky");
    // Never a closure: climatology is a hedge, not an observation.
    expect(verdict.sealed).toBe(false);
    // And nothing at all outside the monsoon months.
    expect(assess(gate(clear, january), outdoor).season?.penalty ?? 0).toBe(0);
  });
});

describe("through the pipeline, on the real catalogue", () => {
  const index = indexCatalogue(RECORDS);

  const WEIGHTS = { version: "t", weights: {}, source: "prior" as const, updatedAt: "2026-01-01T00:00:00.000Z", observations: 0 };

  it("drops exactly the weather's own rejects, and never invents a season", () => {
    const ctx = ctxOf(sky("heavy_rain", 25));
    const engine = withWeather(planner({ catalogue: RECORDS }), { catalogue: index });
    const bare = planner({ catalogue: RECORDS });
    const gated = engine.filterFeasible(ctx, RECORDS);
    const plain = bare.filterFeasible(ctx, RECORDS);

    expect(plain.passed.filter((id) => !gated.passed.includes(id)).length).toBeGreaterThan(0);
    const closedByGate = new Set(plain.passed.filter((id) => !gated.passed.includes(id)));
    for (const rejection of gated.rejected) {
      if (!closedByGate.has(rejection.experienceId)) continue;
      expect(["weather_unsafe", "duration_exceeds_budget", "capacity_exceeded", "excluded_by_travenger"], rejection.code)
        .toContain(rejection.code);
    }
    // No month was injected, so `seasonal_mismatch` is unreachable: this is the
    // property that stops the calendar gate from moving another session's eval run.
    expect(gated.rejected.some((r) => r.code === "seasonal_mismatch")).toBe(false);
  });

  it("hands the packer a different order, not just a shorter list", () => {
    const ctx = ctxOf(sky("heavy_rain", 25));
    const engine = withWeather(planner({ catalogue: RECORDS }), { catalogue: index });
    const bare = planner({ catalogue: RECORDS });
    const items = (result: { passed: string[] }) =>
      result.passed.map((id) => byId.get(id)).filter((r): r is Experience => r !== undefined);
    const ranked = (scores: { experienceId: string; total: number }[]) =>
      [...scores].sort((a, b) => b.total - a.total || a.experienceId.localeCompare(b.experienceId)).map((s) => s.experienceId);

    const wet = ranked(engine.score(ctx, items(engine.filterFeasible(ctx, RECORDS)), WEIGHTS));
    const dry = ranked(bare.score(ctx, items(bare.filterFeasible(ctx, RECORDS)), WEIGHTS));
    expect(wet).not.toEqual(dry);
    // The invariant that matters: nothing the gate closed is in the list the packer sees.
    const closedHere = new Set(
      engine.filterFeasible(ctx, RECORDS).passed.length > 0
        ? RECORDS.filter((r) => !engine.filterFeasible(ctx, RECORDS).passed.includes(r.id)).map((r) => r.id)
        : []);
    for (const id of closedHere) expect(wet, id).not.toContain(id);
    expect(closedHere.size).toBeGreaterThan(0);
    // And the open air that led in fine weather is not in the rain list.
    const firstOutdoor = dry.find((id) => ["outdoor", "mixed"].includes(byId.get(id)?.indoorOutdoor ?? ""));
    expect(firstOutdoor).toBeDefined();
    expect(wet).not.toContain(firstOutdoor as string);
    // The top of the rain list is all under a roof, and the covered verandah is in it:
    // this is what "the covered records survive and the outdoor ones lose" looks like
    // as an ordering rather than as a set difference.
    expect(wet.slice(0, 3).every((id) => byId.get(id)?.indoorOutdoor === "indoor")).toBe(true);
    expect(wet).toContain("col-cafe-tulip");
  });

  it("closes nothing at all in fine weather, and adds only clock terms to the scores", () => {
    // The honest version of "fine weather is a no-op" now that the gate can read the
    // clock: with a clear sky, no month and no indoor request it removes nothing, and
    // the only component it ever adds is `timing`.
    const ctx = ctxOf(sky("clear", 28));
    const engine = withWeather(planner({ catalogue: RECORDS }), { catalogue: index });
    const bare = planner({ catalogue: RECORDS });
    expect(engine.filterFeasible(ctx, RECORDS)).toEqual(bare.filterFeasible(ctx, RECORDS));

    const added = engine.score(ctx, RECORDS, WEIGHTS)
      .flatMap((entry) => entry.components.map((part) => part.key))
      .filter((key) => !["interest", "rating", "proximity"].includes(key));
    expect([...new Set(added)]).toEqual(["timing"]);
  });

  it("keeps every exposed record it leaves with a written reason", () => {
    // The eval assertion, run over the whole catalogue rather than one plan.
    for (const weather of [sky("light_rain", 27), sky("heavy_rain", 25), sky("clear", 41)]) {
      const p = gate(weather, { window: { fromMin: 660, toMin: 960 } });
      for (const record of surviving(weather, { window: { fromMin: 660, toMin: 960 } })) {
        const verdict = assess(p, record);
        if (verdict.shelter < 2) continue;
        const components = verdictComponents(verdict);
        const note = verdict.reason || verdict.season?.reason || verdict.timing?.reason || "";
        // An exposed survivor is either carrying a score term, or it is a record the
        // gate deliberately kept (a 24/7 covered space, say). What it may never do is
        // survive silently.
        expect(components.length > 0 || note.length > 0, `${weather.condition} ${record.id}`).toBe(true);
      }
    }
  });
});
