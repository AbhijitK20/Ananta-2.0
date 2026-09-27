/**
 * The Digital Twin, wired into the app.
 *
 * Everything in `src/features/twin/**` is pure and testable; this is the only file
 * that reads the filesystem, talks to the network, and calls the real planner. The
 * split is deliberate and it is the same one `src/app/_lib/catalogue.ts` already
 * makes: a server module that assembles, and pure modules underneath that can be
 * exercised without a request.
 *
 * ## What one request costs, and why it is bounded
 *
 * | Step                                   | Cost                                   | Cached |
 * |----------------------------------------|----------------------------------------|--------|
 * | read the catalogue (4,596 rows)        | 4.5 MB of JSONL, ~40 ms               | process |
 * | read the city manifest                 | 2 KB                                   | process |
 * | read the social corpus (331 signals)   | 4.5 ms                                | process |
 * | fit the impact model                   | 331 signals, < 1 ms                   | process |
 * | build the entity graph                 | O(n) on a grid, ~15 ms                | process |
 * | live weather + live social feed        | two network calls, 6 s ceiling         | per scenario |
 * | Nugen aligned-model assessment         | one call, 12 s ceiling                 | per scenario |
 * | `planItinerary`, twice                 | ~30 ms each                            | no |
 *
 * Everything expensive and scenario-independent is memoised per process, so the
 * slider only ever re-pays the two network calls and the two plan solves. The
 * catalogue, the graph and the fit are the same objects across every request, which
 * is also what makes a what-if comparison meaningful: the baseline and the twin plan
 * are solved against the *same* catalogue instance.
 *
 * ## Failure policy
 *
 * `computeTwin` returns a report even when the live calls both fail, and
 * `report.provenance` says which ran. A twin that 500s because a public RSS feed
 * rate-limited would be a regression against the planner it enhances, so the only
 * thing that can fail is the accuracy of the answer, never the response.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DiscoveryContext, type Experience } from "@/contracts";
import { planItinerary, type PlanResult } from "@/engine/plan";

import {
  type CityManifest,
  type EntityGraph,
  type ImpactModel,
  type NodeImpact,
  type Observation,
  type PlanDelta,
  type TwinState,
  type WeatherScenario,
  applyTwin,
  buildGraph,
  corpusSignals,
  diffPlans,
  fitImpactModel,
  normalizeScenario,
  observe,
  opennessOf,
  readAlignmentManifest,
  scenarioFromParams,
  simulate,
  toSimulateOptions,
  type SocialSignal,
} from "@/features/twin";
import type { AlignmentManifest } from "@/llm/nugen";
import { loadCatalogue } from "./catalogue";
import { contextFromParams } from "./discovery";

/** Bandra West, the same origin the rest of the app uses. */
const DEFAULT_ORIGIN = { lat: 19.0495, lon: 72.832 } as const;

const CITY = "mumbai";

/**
 * What the map needs, and no more.
 *
 * 4,596 nodes serialised into an RSC payload is a multi-megabyte response to draw
 * 400 circles, so the map gets a viewport-limited, worst-first sample. `total` is
 * the real count and is displayed, so the map is honest about being a sample rather
 * than quietly pretending to be complete.
 */
export type MapNode = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  entityClass: string;
  neighbourhood: string | null;
  availability: number;
  low: number;
  high: number;
  severity: number;
  confidence: number;
  deepestOrder: string;
  reason: string;
  demand: number;
  movement: number;
  capacity: number;
  /** The deepest cascade order that reached it, so the map can draw the chain. */
  inPlan: boolean;
};

export type TwinReport = {
  context: DiscoveryContext;
  scenario: WeatherScenario;
  condition: string;
  observation: Observation;
  twin: TwinState;
  baseline: PlanResult;
  simulated: PlanResult;
  delta: PlanDelta;
  mapNodes: MapNode[];
  mapTotal: number;
  /** Ids in the simulated plan, for the map's route line. */
  planIds: string[];
  closedCount: number;
  stretchedCount: number;
  /** Milliseconds spent in this call, printed by the page so the cost is visible. */
  elapsedMs: number;
};

// ---------------------------------------------------------------------------
// Process-level caches
// ---------------------------------------------------------------------------

type Cached = {
  manifest: CityManifest;
  experiences: Experience[];
  graph: EntityGraph;
  model: ImpactModel;
  signals: SocialSignal[];
  alignment: AlignmentManifest | null;
};

let cache: Promise<Cached> | null = null;

/**
 * The immutable half of the twin, built once per process.
 *
 * A single promise rather than a value, so two concurrent first requests cannot both
 * parse 4.5 MB of JSONL — which is exactly what happens on a cold serverless start
 * with two requests in flight, and it is the reason this is a promise and not a
 * lazily-assigned module variable.
 */
async function foundation(): Promise<Cached> {
  const [manifestRaw, { experiences }, signals, alignment] = await Promise.all([
    readFile(join("data", "cities", CITY, "manifest.json"), "utf8"),
    loadCatalogue(),
    corpusSignals(),
    readAlignmentManifest(),
  ]);
  const manifest = JSON.parse(manifestRaw) as CityManifest;
  const graph = buildGraph(experiences, manifest);

  // The fit needs to know an entity's shelter class to bucket a report that did not
  // say. The lookup is by id and falls back to the reporter's own exposure, which
  // `fitImpactModel` already prefers when one is present — so a report about a
  // curated slug the harvested catalogue does not contain still lands in a cell.
  const classById = new Map<string, string>();
  for (const [id, node] of graph.nodes) classById.set(id, node.entityClass);
  const model = fitImpactModel(
    signals,
    opennessOf,
    (signal) => (signal.entityId ? ((classById.get(signal.entityId) as never) ?? "indoor_shelter") : "indoor_shelter"),
  );

  return { manifest, experiences, graph, model, signals, alignment };
}

export function twinFoundation(): Promise<Cached> {
  cache ??= foundation();
  return cache;
}

/** Test seam: drop the caches so a test can build a twin against different data. */
export function resetTwinCache(): void {
  cache = null;
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

export type ComputeOptions = {
  params: URLSearchParams;
  /**
   * Skip the live calls and simulate the scenario in the URL. `true` on a cold
   * render, `false` when a user has moved a slider — and the reason it exists is
   * that a slider which fires two HTTP calls per drag is a slider nobody drags.
   */
  live?: boolean;
};

/** How many nodes the map carries. Above this the payload stops being worth it. */
const MAP_NODE_LIMIT = 400;

export async function computeTwin(options: ComputeOptions): Promise<TwinReport> {
  const started = Date.now();
  const { params } = options;
  const foundationData = await twinFoundation();
  const { experiences, graph, model, signals, alignment } = foundationData;

  const context = contextFromParams(params);
  const scenario = scenarioFromParams(params);
  const live = options.live ?? false;

  // The baseline is solved against the *unmodified* catalogue and a context that
  // carries the twin's condition only as `simulated`. It is the honest "what the
  // planner would have done" reference, and it is solved from the same catalogue
  // instance as the twin plan so the diff is attributable to the weather alone.
  const baseline = planItinerary(context, experiences, {
    weekday: 1,
    month: Number(scenario.date.slice(5, 7)),
    planId: "twin-baseline",
  });

  const observation = await observe({
    point: DEFAULT_ORIGIN,
    scenario: live ? null : scenario,
    graph,
    model,
    corpusSignals: signals,
    manifest: alignment,
  });

  const twin = simulate(toSimulateOptions(observation, graph, model));
  const applied = applyTwin({ context, catalogue: experiences, twin });
  const simulated = applied.result;

  const closedById = new Map(applied.closed.map((entry) => [entry.id, entry.reason]));
  const nameById = new Map(experiences.map((row) => [row.id, row.name]));
  const delta = diffPlans(baseline, simulated, closedById, (id) => nameById.get(id) ?? id);

  const planIds = new Set(simulated.plan.stops.map((stop) => stop.experienceId));
  const mapNodes = selectMapNodes(twin, planIds);

  return {
    context,
    scenario,
    condition: twin.condition,
    observation,
    twin,
    baseline,
    simulated,
    delta,
    mapNodes,
    mapTotal: twin.nodes.size,
    planIds: [...planIds],
    closedCount: applied.closed.length,
    stretchedCount: applied.stretched.length,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Worst-first, capped.
 *
 * Severity descending and then confidence ascending, so the nodes that are both badly
 * affected and poorly known are the ones on the map — which are exactly the ones a
 * reader should be looking at, and are also the ones a random sample would never
 * surface. Ties broken by id so the map is stable across requests rather than
 * reshuffling on every render.
 */
function selectMapNodes(twin: TwinState, planIds: ReadonlySet<string>): MapNode[] {
  const ranked = [...twin.nodes.values()].sort(
    (a, b) =>
      b.severity - a.severity ||
      a.confidence - b.confidence ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const out: MapNode[] = [];
  for (const node of ranked) {
    if (out.length >= MAP_NODE_LIMIT) break;
    out.push(toMapNode(node, planIds.has(node.id)));
  }
  return out;
}

function toMapNode(node: NodeImpact, inPlan: boolean): MapNode {
  return {
    id: node.id,
    name: node.name,
    lat: node.point.lat,
    lon: node.point.lon,
    entityClass: node.entityClass,
    neighbourhood: node.neighbourhood,
    availability: node.availability.point,
    low: node.availability.low,
    high: node.availability.high,
    severity: node.severity,
    confidence: node.confidence,
    deepestOrder: node.deepestOrder,
    reason: node.reason,
    demand: node.channels.demand.multiplier,
    movement: node.channels.movement.multiplier,
    capacity: node.channels.capacity.multiplier,
    inPlan,
  };
}

/**
 * The corridor layer, as map-ready line geometry.
 *
 * Built here rather than in the client component because a corridor's two endpoints
 * are *neighbourhood names* in the twin and *coordinates* only in the graph, and the
 * client has no business walking the graph. `null` endpoint means the corridor names
 * an area with no rows, and it is dropped rather than drawn to (0, 0).
 */
export type MapCorridor = {
  line: string;
  from: string;
  to: string;
  multiplier: number;
  degraded: boolean;
  reason: string;
  coordinates: [number, number][];
};

export function mapCorridors(twin: TwinState, experiences: readonly Experience[]): MapCorridor[] {
  const byId = new Map(experiences.map((row) => [row.id, row.location]));
  const centroidOf = (name: string): [number, number] | null => {
    const points = experiences
      .filter((row) => row.neighbourhood === name && byId.has(row.id))
      .map((row) => byId.get(row.id)!);
    if (points.length === 0) return null;
    return [
      points.reduce((sum, point) => sum + point.lon, 0) / points.length,
      points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    ];
  };
  const cache = new Map<string, [number, number] | null>();
  const out: MapCorridor[] = [];
  for (const corridor of twin.corridors) {
    for (const name of [corridor.from, corridor.to]) {
      if (!cache.has(name)) cache.set(name, centroidOf(name));
    }
    const from = cache.get(corridor.from);
    const to = cache.get(corridor.to);
    if (!from || !to) continue;
    out.push({ ...corridor, coordinates: [from, to] });
  }
  return out;
}

/** Re-exported so the page does not import the feature barrel for one type. */
export type { NodeImpact, Observation, TwinState };
export { normalizeScenario };
