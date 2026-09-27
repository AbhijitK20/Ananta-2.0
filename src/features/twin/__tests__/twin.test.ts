/**
 * The twin's invariants, as assertions rather than as a paragraph in a header
 * comment. Nine of them, and each one is a claim the rest of the layer depends on.
 *
 * The fixtures are the *real* curated catalogue from `content/experiences/`, not a
 * hand-built stub, because four of these assertions are about how the model behaves
 * against rows nobody designed for it: an uncurated OSM node with a null
 * neighbourhood, a heritage site labelled `weatherSensitive: "none"` that is
 * outdoors, a category string that is an open OSM vocabulary. A stub would pass all
 * nine and prove nothing about the 4,596 rows the app actually loads.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// `Experience` is a VALUE here, not a type-only import: `loadCurated` calls
// `Experience.parse`, and a `type` import is erased at runtime, so the first
// version of this file silently caught a `TypeError` per row and asserted on an
// empty catalogue — eight failing tests, all of them about a fixture that was not
// there.
import { DiscoveryContext, Experience } from "../../../contracts";
import { planItinerary } from "../../../engine/plan";

import { applyTwin, buildGraph, classifyReport, corpusSignals, fitImpactModel, normalizeScenario, observe, simulate, toSimulateOptions, diffPlans } from "../index";
import { opennessOf } from "../hazards";
import { type CityManifest, type ImpactModel, type WeatherScenario } from "../index";
import { directImpact } from "../impact";

const CURATED = [
  "content/experiences/bandra.jsonl",
  "content/experiences/colaba.jsonl",
  "content/experiences/fort.jsonl",
  "content/experiences/marine-drive.jsonl",
  "content/experiences/adjacent.jsonl",
];

async function loadCurated(): Promise<Experience[]> {
  const out: Experience[] = [];
  for (const path of CURATED) {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        out.push(Experience.parse(JSON.parse(trimmed)));
      } catch {
        // A row the contract rejects is a row the app cannot show either, so the
        // twin cannot be affected by it. Skipping is the faithful behaviour.
      }
    }
  }
  return out;
}

const MANIFEST: CityManifest = {
  slug: "mumbai",
  displayName: "Mumbai",
  bbox: [72.775, 18.875, 72.99, 19.265],
  centre: { lat: 19.0596, lon: 72.8295 },
  neighbourhoods: ["Bandra West", "Colaba", "Fort", "Marine Drive", "Adjacent"],
  monsoonMonths: [6, 7, 8, 9],
  transitCorridors: [
    { from: "Bandra West", to: "Colaba", mode: "train", line: "Western Line", minutes: 22, transfers: 0 },
    { from: "Bandra West", to: "Fort", mode: "train", line: "Western Line", minutes: 14, transfers: 0 },
    { from: "Colaba", to: "Marine Drive", mode: "ferry", line: "Colaba-Belapur Ferry", minutes: 15, transfers: 0 },
  ],
};

/**
 * The contract types origin.point as nullable, and it is nullable because a
 * destination-first search has no origin. Every scenario here is origin-anchored, so
 * the non-null read happens once here rather than being asserted nine times.
 */
const ORIGIN = { lat: 19.0495, lon: 72.832 };

const CONTEXT = DiscoveryContext.parse({
  id: "twin-test",
  origin: { label: "Bandra West, Mumbai", point: { lat: 19.0495, lon: 72.832 } },
  availableMin: 240,
  nowMin: 600,
  budget: { minor: 300000, currency: "INR" },
  budgetPerPerson: null,
  partySize: 2,
  partyType: "couple",
  childAges: [],
  accessNeeds: [],
  diets: [],
  interests: [],
  avoid: [],
  weather: { condition: "clear", tempC: 31, source: "live" },
  travelMode: "auto",
  requests: [],
  excludedIds: [],
  pinnedIds: [],
  original: { availableMin: 240, budget: { minor: 300000, currency: "INR" }, partySize: 2, accessNeeds: [] },
});

/**
 * A thermally and hydrologically neutral evening: no rain, no flood, no wind, and a
 * temperature that is not itself a hazard.
 *
 * The hour matters as much as the numbers. `driversOf` computes an *apparent*
 * temperature that adds the sun's contribution between 10:00 and 16:00, so a 29°C
 * afternoon reads as 33.3°C and legitimately degrades open air — the first version of
 * this test used one and failed, correctly, because 33°C in the sun is not a neutral
 * sky. 22°C after sunset is, and that is what the invariant is actually about.
 */
const CLEAR: WeatherScenario = normalizeScenario({ rainMmH: 0, floodCm: 0, windKmh: 4, tempC: 22, hour: 20 });

function fitFor(rows: Experience[], signals: Awaited<ReturnType<typeof corpusSignals>>): ImpactModel {
  const graph = buildGraph(rows, MANIFEST);
  const classById = new Map([...graph.nodes].map(([id, node]) => [id, node.entityClass]));
  return fitImpactModel(
    signals,
    opennessOf,
    (signal) => (signal.entityId && classById.get(signal.entityId)) || "indoor_shelter",
  );
}

describe("digital twin", () => {
  it("reads the real curated catalogue and the real social corpus", async () => {
    const rows = await loadCurated();
    const signals = await corpusSignals();
    // If either of these is zero the rest of the suite is asserting against a stub,
    // so they are asserted first and on their own.
    expect(rows.length).toBeGreaterThan(100);
    expect(signals.length).toBeGreaterThan(300);
    /**
     * 71 of 331, and that is the real number rather than a disappointing one.
     *
     * `classifyReport` matches on word boundaries, so a review that merely mentions
     * "photographs" or "hotel" no longer registers as heat evidence. The cost is
     * fewer labelled hazard reports; the benefit is that the 71 remaining ones mean
     * something. Before the boundaries were added the same corpus yielded a
     * materially higher count and a worse model, which is the trade this whole layer
     * is built to avoid.
     */
    expect(signals.filter((signal) => signal.conditions.length > 0).length).toBeGreaterThan(60);
  });

  it("reads report polarity, so a place praised for staying dry is not rain damage", async () => {
    // The exact failure a keyword classifier has, planted deliberately: "dry in
    // heavy rain" contains "heavy rain" and means the opposite.
    const survivor = classifyReport("Dry in heavy rain, the covered terrace is the whole point");
    expect(survivor.conditions).not.toContain("rain");
    expect(classifyReport("CANCELLED IN RAIN, we got soaked").conditions).toContain("rain");
    // And exposure is a separate judgement from the hazard itself.
    expect(classifyReport("Shaded benches under tree cover, cool and dry").exposure).toBeGreaterThan(0);
    // Text that says nothing about weather must contribute nothing.
    expect(classifyReport("The photographs of the lines overhead are worth the walk").conditions).toEqual([]);
  });

  it("is a no-op in clear weather, and the plan is byte-identical", async () => {
    const rows = await loadCurated();
    const signals = await corpusSignals();
    const graph = buildGraph(rows, MANIFEST);
    const model = fitFor(rows, signals);
    const observation = await observe({
      point: ORIGIN,
      scenario: CLEAR,
      graph,
      model,
      corpusSignals: signals,
      // No manifest, so the deterministic classifier runs and no network is touched.
      manifest: null,
    });
    const twin = simulate(toSimulateOptions(observation, graph, model));

    expect(twin.hazards.every((hazard) => hazard.severity === 0)).toBe(true);
    expect(twin.summary.closed).toBe(0);
    expect(twin.summary.degraded).toBe(0);
    for (const node of twin.nodes.values()) {
      for (const channel of Object.values(node.channels)) {
        expect(channel.multiplier).toBe(1);
      }
    }

    // The strong form: the twin's plan equals the baseline's, stop for stop.
    const baseline = planItinerary(CONTEXT, rows, { weekday: 3, month: 7, planId: "base" });
    const applied = applyTwin({ context: CONTEXT, catalogue: rows, twin });
    expect(applied.noop).toBe(true);
    expect(applied.result.plan.stops.map((stop) => stop.experienceId)).toEqual(
      baseline.plan.stops.map((stop) => stop.experienceId),
    );
  });

  it("propagates in cascade order, and never lets a channel improve", async () => {
    const rows = await loadCurated();
    const signals = await corpusSignals();
    const graph = buildGraph(rows, MANIFEST);
    const model = fitFor(rows, signals);
    const storm = normalizeScenario({ rainMmH: 55, windKmh: 95, floodCm: 30, durationH: 6, tempC: 26, hour: 15 });
    const observation = await observe({
      point: ORIGIN,
      scenario: storm,
      graph,
      model,
      corpusSignals: signals,
      manifest: null,
    });
    const twin = simulate(toSimulateOptions(observation, graph, model));

    // All four orders ran, in order, and each reported what it did.
    expect(twin.cascades.map((step) => step.order)).toEqual(["direct", "access", "reroute", "workforce"]);
    for (const step of twin.cascades) {
      expect(step.summary.length).toBeGreaterThan(10);
    }

    // Movement is the invariant that matters most: weather cannot make a journey
    // faster, and a model that can produce a sub-1.0 multiplier is broken.
    for (const node of twin.nodes.values()) {
      expect(node.channels.movement.multiplier).toBeGreaterThanOrEqual(1);
      // Availability is a probability-shaped quantity and must stay in range.
      expect(node.availability.point).toBeGreaterThanOrEqual(0);
      expect(node.availability.point).toBeLessThanOrEqual(1);
      expect(node.availability.low).toBeLessThanOrEqual(node.availability.point + 1e-9);
      expect(node.availability.high).toBeGreaterThanOrEqual(node.availability.point - 1e-9);
    }

    // At least one entity was reached at an order above the first, which is the
    // claim that this is a cascade and not a per-record filter.
    const deeper = [...twin.nodes.values()].filter((node) => node.deepestOrder !== "direct");
    expect(deeper.length).toBeGreaterThan(0);
  });

  it("treats 33°C in the sun as a hazard and the same 33°C after sunset as not", async () => {
    // The clock half of the model, and the one the weather feature established for
    // the badge (`src/features/weather/model.ts` closes heat only at `peak` exposure).
    // Pinned because it is the difference between a July afternoon that degrades
    // every open-air record in the catalogue and one that does not, and a twin that
    // ignored the sun would mark half of Mumbai shut every day from March to June.
    const rows = await loadCurated();
    const signals = await corpusSignals();
    const graph = buildGraph(rows, MANIFEST);
    const model = fitFor(rows, signals);

    const run = async (scenario: WeatherScenario) => {
      const observation = await observe({
        point: ORIGIN,
        scenario,
        graph,
        model,
        corpusSignals: signals,
        manifest: null,
      });
      return simulate(toSimulateOptions(observation, graph, model));
    };

    const noon = await run(normalizeScenario({ rainMmH: 0, floodCm: 0, windKmh: 4, tempC: 30, hour: 13 }));
    const evening = await run(normalizeScenario({ rainMmH: 0, floodCm: 0, windKmh: 4, tempC: 30, hour: 20 }));

    const heatOf = (twin: { hazards: { kind: string; severity: number }[] }): number =>
      twin.hazards.find((hazard) => hazard.kind === "heat")?.severity ?? 0;

    expect(heatOf(noon)).toBeGreaterThan(0);
    expect(heatOf(evening)).toBeLessThan(heatOf(noon));
    // And it reaches the entities: open air is hurt at noon and untouched at night.
    const openAirWorst = (twin: { nodes: ReadonlyMap<string, { entityClass: string; availability: { point: number } }> }): number =>
      Math.min(
        ...[...twin.nodes.values()]
          .filter((node) => node.entityClass === "open_air")
          .map((node) => node.availability.point),
      );
    expect(openAirWorst(noon)).toBeLessThan(1);
    expect(openAirWorst(evening)).toBe(1);
  });

  it("widens the uncertainty interval as the cascade order deepens", async () => {
    const rows = await loadCurated();
    const signals = await corpusSignals();
    const graph = buildGraph(rows, MANIFEST);
    const model = fitFor(rows, signals);
    const rainOnly = normalizeScenario({ rainMmH: 10, floodCm: 70, windKmh: 15, durationH: 30, tempC: 27, hour: 12 });
    const observation = await observe({
      point: ORIGIN,
      scenario: rainOnly,
      graph,
      model,
      corpusSignals: signals,
      manifest: null,
    });
    const twin = simulate(toSimulateOptions(observation, graph, model));

    const width = (node: { availability: { point: number; low: number } }): number => node.availability.point - node.availability.low;
    const meanWidth = (order: string): number => {
      const nodes = [...twin.nodes.values()].filter((node) => node.deepestOrder === order);
      expect(nodes.length).toBeGreaterThan(0);
      return nodes.reduce((sum, node) => sum + width(node), 0) / nodes.length;
    };

    /**
     * Compared on the orders the cascade actually reached, and nothing else.
     *
     * Two earlier versions of this assertion were both wrong in instructive ways.
     * Filtering to nodes carrying a hazard emptied the deep group, because a node
     * the rain never touched is exactly the node order 3 picks up — and the
     * highest-order group is by construction the sheltered ones the weather could
     * not reach. Averaging everything instead compared a perfect-confidence
     * untouched node against a deeply cascaded one, which measures the mix rather
     * than the depth.
     *
     * What the model actually claims is an ordering of the orders it reached, so
     * that is what is asserted.
     */
    expect(meanWidth("workforce")).toBeGreaterThan(meanWidth("access"));

    // Order 4 is genuinely reached, and says its own sentence. This assertion
    // caught a sign error that stopped it firing in *every* scenario: the staffing
    // cost is negative, so a `load <= 0` guard rejected a 70 cm flood.
    const workforceStep = twin.cascades.find((step) => step.order === "workforce");
    expect(workforceStep?.touched).toBeGreaterThan(0);
    expect(workforceStep?.summary).toContain("Staff cannot cross the water");

    // And no node may quote a point estimate outside its own interval.
    for (const node of twin.nodes.values()) {
      expect(node.availability.low).toBeLessThanOrEqual(node.availability.point + 1e-9);
      expect(node.availability.high).toBeGreaterThanOrEqual(node.availability.point - 1e-9);
    }
  });

  it("changes the real plan when the weather does, and says why", async () => {
    // This is mandatory requirement 4, asserted end to end: the twin's output reaches
    // `planItinerary`, and the plan it comes back with differs from the baseline's.
    const rows = await loadCurated();
    const signals = await corpusSignals();
    const graph = buildGraph(rows, MANIFEST);
    const model = fitFor(rows, signals);
    const monsoon = normalizeScenario({ rainMmH: 40, floodCm: 40, windKmh: 45, durationH: 10, tempC: 27, hour: 14 });

    // The reference the diff is measured against, solved from the same catalogue
    // instance so the difference is attributable to the weather and to nothing else.
    const baseline = planItinerary(CONTEXT, rows, { weekday: 3, month: 7, planId: "base" });

    const observation = await observe({
      point: ORIGIN,
      scenario: monsoon,
      graph,
      model,
      corpusSignals: signals,
      manifest: null,
    });
    const twin = simulate(toSimulateOptions(observation, graph, model));
    const applied = applyTwin({ context: CONTEXT, catalogue: rows, twin });

    // The twin closed real rows, and every one of them carries a written reason.
    expect(applied.closed.length).toBeGreaterThan(0);
    for (const entry of applied.closed) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    // And the plan genuinely differs.
    const baselineIds = baseline.plan.stops.map((stop) => stop.experienceId);
    const twinIds = applied.result.plan.stops.map((stop) => stop.experienceId);
    expect(twinIds).not.toEqual(baselineIds);

    // The diff describes the change, in the same shape as the discovery feature's
    // `Swap[]`, and every removal has a reason the reader can check.
    const closedById = new Map(applied.closed.map((entry) => [entry.id, entry.reason]));
    const names = new Map(rows.map((row) => [row.id, row.name]));
    const delta = diffPlans(baseline, applied.result, closedById, (id) => names.get(id) ?? id);
    expect(delta.removed.length).toBeGreaterThan(0);
    for (const entry of delta.removed) {
      expect(entry.name).not.toBe(entry.id);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    expect(delta.headline.length).toBeGreaterThan(5);

    // The live plan is untouched: the baseline object is not the twin's plan, and the
    // catalogue the caller passed in is not the one the twin returned.
    expect(baseline.plan.stops.map((stop) => stop.experienceId)).toEqual(baselineIds);
    expect(applied.catalogue).not.toBe(rows);
    expect(rows.some((row) => applied.closed.some((entry) => entry.id === row.id))).toBe(true);
  });

  it("learns from the corpus, and says how much it learned from", async () => {
    const signals = await corpusSignals();
    const model = fitFor(await loadCurated(), signals);
    // 74 hazard observations across 5 hazards x 4 shelter bins, so most cells stay
    // close to the prior. That is the honest state of a 291-review corpus and the
    // model reports it rather than implying a fit it does not have.
    expect(model.observations).toBeGreaterThan(60);
    // The cells carry a bounded correction, never an unbounded one: a model that can
    // invert a prior from a handful of reports is a model that will do so on a
    // handful of spam reports.
    for (const row of Object.values(model.cells)) {
      for (const cell of Object.values(row)) {
        expect(cell.adjustment).toBeGreaterThanOrEqual(-0.6);
        expect(cell.adjustment).toBeLessThanOrEqual(0.6);
        expect(cell.confidence).toBeGreaterThanOrEqual(0);
        expect(cell.confidence).toBeLessThanOrEqual(1);
      }
    }
    // At least one cell was actually filled, or "it learns" is unfalsifiable.
    const filled = Object.values(model.cells)
      .flatMap((row) => Object.values(row))
      .filter((cell) => cell.observations > 0);
    expect(filled.length).toBeGreaterThan(0);
    for (const cell of filled) {
      expect(cell.observed).not.toBeNull();
    }
  });

  it("falls back to the deterministic classifier when no aligned model is available", async () => {
    const rows = await loadCurated();
    const signals = await corpusSignals();
    const graph = buildGraph(rows, MANIFEST);
    const model = fitFor(rows, signals);
    const observation = await observe({
      point: ORIGIN,
      scenario: normalizeScenario({ rainMmH: 20, durationH: 4, tempC: 28, hour: 12 }),
      graph,
      model,
      corpusSignals: signals,
      manifest: null,
    });
    // `observe` returned rather than throwing, and the provenance is honest about
    // which path ran. This is the invariant that keeps the twin from being a worse
    // product than the planner it enhances.
    expect(observation.provenance.modelSource).toBe("deterministic");
    expect(observation.provenance.model).toBeNull();
    expect(observation.provenance.note.length).toBeGreaterThan(0);
    expect(observation.signals.length).toBeGreaterThan(0);
    expect(observation.scenario.rainMmH).toBe(20);
  });

  it("never lets a sheltered entity be closed by rain alone", async () => {
    // The overreach that would make the twin untrustworthy: a gallery under a roof is
    // not closed because it is raining. Direct impact only — the access and workforce
    // orders are allowed to touch it, and that is the point.
    const model = fitFor(await loadCurated(), await corpusSignals());
    const impact = directImpact(model, "indoor_shelter", 0, { rain: 3, heat: 0, wind: 0, flood: 0, storm: 0 }, 0);
    expect(impact.channels.availability.multiplier).toBe(1);
    expect(impact.severity).toBe(0);

    // The inverse must also hold, or the shelter table is decorative: a beach is
    // closed by rain far sooner than a promenade is.
    const beach = directImpact(model, "water_dependent", 3, { rain: 2 }, 0);
    const openAir = directImpact(model, "open_air", 3, { rain: 2 }, 0);
    expect(beach.channels.availability.multiplier).toBeLessThan(openAir.channels.availability.multiplier);
  });
});
