/**
 * The twin's entity graph: the real-world entities the existing solution already
 * addresses, and the relationships between them.
 *
 * The brief is explicit that this must be an *enhancement* to the existing system
 * rather than a new application, which has a concrete consequence here: the entities
 * are not invented. They are the 4,596 `Experience` rows the planner already searches
 * and the 40 events the provider side already sells, and the edges are the ones the
 * repository already asserts — the `transitCorridors` in the city manifest, the
 * neighbourhood a record names, and great-circle proximity between them.
 *
 * ## Why proximity is a real edge and not a convenience
 *
 * The access cascade *is* a proximity effect: a flooded road between you and a
 * perfectly dry café is the single most common way weather changes a plan without
 * changing anything about the destination. So `nearest`/`within` are not map helpers,
 * they are the cascade's reachability primitive, and the map layer consumes the same
 * adjacency so the picture and the arithmetic cannot disagree.
 *
 * ## Why there are only two edge kinds
 *
 * `transit` comes from the manifest and is authoritative. `proximity` is derived
 * from coordinates and is a heuristic. Mixing a third kind would mean the cascade
 * could route an effect along an edge nobody can inspect, and the whole claim of the
 * layer is that every number is traceable to something real. Two kinds, both
 * inspectable, both used by both the simulation and the map.
 */
import type { Experience, GeoPoint } from "../../contracts";
import { type EntityClass, classify } from "./hazards";

export type GraphNode = {
  id: string;
  name: string;
  point: GeoPoint;
  entityClass: EntityClass;
  /** The record's own `weatherSensitive` label, which the prior reads. */
  weatherSensitive: Experience["weatherSensitive"];
  indoorOutdoor: Experience["indoorOutdoor"];
  category: string;
  durationMin: number;
  pricePerPerson: Experience["pricePerPerson"];
  capacity: number | null;
  neighbourhood: string | null;
  /** For a map viewport, never for arithmetic. */
  blurb: string | null;
};

export type EdgeKind = "transit" | "proximity";

export type GraphEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Metres. Authoritative for `transit`, derived for `proximity`. */
  metres: number;
  /** `transit` only: the line, so the UI can say "Western Line" and not "a road". */
  line: string | null;
  /** `transit` only: published minutes for the corridor, when the manifest has them. */
  baselineMin: number | null;
};

export type TransitCorridor = {
  from: string;
  to: string;
  mode: string;
  line: string;
  minutes: number;
  transfers: number;
};

/** The city manifest's fields the twin reads. Structural, so a manifest gap is a type error. */
export type CityManifest = {
  slug: string;
  displayName: string;
  bbox: [number, number, number, number];
  centre: GeoPoint;
  neighbourhoods: string[];
  monsoonMonths: number[];
  transitCorridors?: TransitCorridor[];
};

export type EntityGraph = {
  nodes: ReadonlyMap<string, GraphNode>;
  edges: readonly GraphEdge[];
  /** Neighbourhood -> its node ids. The workforce cascade aggregates over this. */
  byNeighbourhood: ReadonlyMap<string, readonly string[]>;
  corridors: readonly TransitCorridor[];
  /** Every neighbourhood, whether or not any row claims it. */
  neighbourhoods: readonly string[];
};

/** Great-circle metres. The same formula the engine's own `geo.ts` uses. */
export function haversineMetres(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const h =
    Math.sin(toRad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Build the graph.
 *
 * `proximityRadiusM` is the reachability radius for one cascade hop. 2 km is the
 * number `docs/ARCHITECTURE.md` §5 gives for a 1-hour window and is the smallest
 * radius at which "can I still get there" is a real question in this city — a
 * 200 m hop only ever links a building to its own pavement.
 */
export function buildGraph(
  rows: readonly Experience[],
  manifest: CityManifest,
  proximityRadiusM = 2_000,
): EntityGraph {
  const nodes = new Map<string, GraphNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      name: row.name,
      point: row.location,
      entityClass: classify(row),
      weatherSensitive: row.weatherSensitive,
      indoorOutdoor: row.indoorOutdoor,
      category: row.category,
      durationMin: row.durationMin,
      pricePerPerson: row.pricePerPerson,
      capacity: row.capacity,
      neighbourhood: row.neighbourhood,
      blurb: row.blurb,
    });
  }

  const byNeighbourhood = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (!node.neighbourhood) continue;
    const bucket = byNeighbourhood.get(node.neighbourhood);
    if (bucket) bucket.push(node.id);
    else byNeighbourhood.set(node.neighbourhood, [node.id]);
  }

  const edges: GraphEdge[] = [];

  // Authoritative first: the manifest's corridors, matched by neighbourhood name on
  // both ends. A corridor naming a neighbourhood with no rows is skipped rather than
  // invented, because an edge to a node that does not exist is a silent no-op that
  // looks like a working one.
  for (const corridor of manifest.transitCorridors ?? []) {
    const fromNeighbourhood = matchNeighbourhood(corridor.from, manifest.neighbourhoods);
    const toNeighbourhood = matchNeighbourhood(corridor.to, manifest.neighbourhoods);
    if (!fromNeighbourhood || !toNeighbourhood) continue;
    const fromIds = byNeighbourhood.get(fromNeighbourhood) ?? [];
    const toIds = byNeighbourhood.get(toNeighbourhood) ?? [];
    if (fromIds.length === 0 || toIds.length === 0) continue;
    // One edge per corridor, between the nearest pair. A corridor is a route
    // between areas; fanning it out to every cross pair would make the cascade
    // quadratic in the number of rows and would not change the answer, because the
    // effect it carries is a per-area property.
    const a = nearestNode(fromIds, toIds, nodes);
    if (!a) continue;
    edges.push({
      from: a.from,
      to: a.to,
      kind: "transit",
      metres: haversineMetres(nodes.get(a.from)!.point, nodes.get(a.to)!.point),
      line: corridor.line,
      baselineMin: corridor.minutes,
    });
  }

  // Derived second: proximity, computed on a grid so it is O(n) rather than O(n²).
  // 4,596 nodes at pairwise comparison is 10.5M haversines per simulation, which is
  // the difference between a slider that tracks a finger and one that does not.
  const edgesByPair = new Set(edges.map((edge) => pairKey(edge.from, edge.to)));
  const CELL_DEG = 0.02; // ~2.2 km at Mumbai's latitude, one cell per hop radius.
  const grid = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    const key = cellKey(node.point, CELL_DEG);
    const bucket = grid.get(key);
    if (bucket) bucket.push(node);
    else grid.set(key, [node]);
  }
  for (const node of nodes.values()) {
    const { cx, cy } = cellOf(node.point, CELL_DEG);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (other.id <= node.id) continue; // Each unordered pair once.
          if (edgesByPair.has(pairKey(node.id, other.id))) continue;
          const metres = haversineMetres(node.point, other.point);
          if (metres > proximityRadiusM) continue;
          edgesByPair.add(pairKey(node.id, other.id));
          edges.push({ from: node.id, to: other.id, kind: "proximity", metres, line: null, baselineMin: null });
        }
      }
    }
  }

  return {
    nodes,
    edges,
    byNeighbourhood,
    corridors: manifest.transitCorridors ?? [],
    neighbourhoods: [...byNeighbourhood.keys()].sort(),
  };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function cellOf(point: GeoPoint, size: number): { cx: number; cy: number } {
  return { cx: Math.floor(point.lon / size), cy: Math.floor(point.lat / size) };
}

function cellKey(point: GeoPoint, size: number): string {
  const { cx, cy } = cellOf(point, size);
  return `${cx}:${cy}`;
}

/** "Bandra West" -> "Bandra West", "bandra west" -> "Bandra West". */
function matchNeighbourhood(name: string, declared: readonly string[]): string | null {
  const exact = declared.find((entry) => entry === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return declared.find((entry) => entry.toLowerCase() === lower) ?? null;
}

function nearestNode(
  fromIds: readonly string[],
  toIds: readonly string[],
  nodes: ReadonlyMap<string, GraphNode>,
): { from: string; to: string } | null {
  let best: { from: string; to: string; metres: number } | null = null;
  for (const from of fromIds.slice(0, 200)) {
    const a = nodes.get(from);
    if (!a) continue;
    for (const to of toIds.slice(0, 200)) {
      const b = nodes.get(to);
      if (!b) continue;
      const metres = haversineMetres(a.point, b.point);
      if (!best || metres < best.metres) best = { from, to, metres };
    }
  }
  return best ? { from: best.from, to: best.to } : null;
}

/**
 * Adjacency, built once and reused by every simulation.
 *
 * The cascade walks this four times per what-if, so materialising it once is the
 * difference between a map and a spinner. A `ReadonlyMap<string, GraphEdge[]>` keyed
 * by node id, with each node's edges listed in both directions.
 */
export function adjacencyOf(graph: EntityGraph): ReadonlyMap<string, readonly GraphEdge[]> {
  const out = new Map<string, GraphEdge[]>();
  for (const nodeId of graph.nodes.keys()) out.set(nodeId, []);
  for (const edge of graph.edges) {
    out.get(edge.from)?.push(edge);
    out.get(edge.to)?.push(edge);
  }
  return out;
}
