/**
 * Geometry. Distances, Web-Mercator projection, point-in-polygon, the isochrone
 * reader, and the radius-graph primitive the packer clusters on.
 *
 * Two distance functions live here and they are NOT interchangeable, which is
 * the single most expensive mistake available in this module:
 *
 *   - `haversineMetres` is TRUE ground distance. Use it for feasibility
 *     decisions: is this within the travel budget, is this a hard reject.
 *   - `mercatorMetres` is PLANAR distance in Web Mercator. It is what a map
 *     draws, so it is correct for screen-space clustering and for nothing else.
 *     At Mumbai's latitude it inflates north-south by 1/cos(19 deg) = 5.8%.
 *
 * The module is deliberately free of any network call. Isochrones are read from
 * `data/reference/`, which is why the demo survives with the network off, and
 * why a 15-minute walk is a loaded polygon rather than a radius guess. A 3 km
 * disc is wrong in both directions at once in Mumbai: 3.2x too generous on foot
 * and it excludes 73% of the true 30-minute driving area. The two costings differ
 * by 11.7x in area at the same budget, so no single radius can be correct for
 * both. See data/reference/README.md for the measured table.
 */
import { readdirSync, readFileSync } from "node:fs";
import type { GeoPoint } from "@/contracts";
import { optionalEnv } from "@/lib/env";

/** IUGG mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_008.8;

/** Metres per degree of latitude. The convention used by data/reference. */
const M_PER_DEG_LAT = 111_320;

/** The shipped isochrone set is one neighbourhood, not a whole city. */
const DEFAULT_AREA = "bandra-west-mumbai";

export type Costing = "pedestrian" | "auto" | "bicycle" | "multimodal";

export interface BBox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

/** True great-circle distance on the sphere, metres. */
export function haversineMetres(a: GeoPoint, b: GeoPoint): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = lat2 - lat1;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Project to Web Mercator in METRES from the origin, not the unit square. */
export function toMercator(p: GeoPoint): { readonly x: number; readonly y: number } {
  const x = EARTH_RADIUS_M * ((p.lon * Math.PI) / 180);
  const y =
    EARTH_RADIUS_M *
    Math.log(Math.tan(Math.PI / 4 + (p.lat * Math.PI) / 360));
  return { x, y };
}

/**
 * Planar distance in Web-Mercator space, metres. Correct for screen-space
 * layout, ~5.8% inflated north-south at Mumbai's latitude relative to ground
 * distance. Never use this for a feasibility check.
 */
export function mercatorMetres(a: GeoPoint, b: GeoPoint): number {
  const pa = toMercator(a);
  const pb = toMercator(b);
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

export function bboxOf(points: Iterable<GeoPoint>): BBox {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  if (!Number.isFinite(minLon)) {
    throw new Error("bboxOf needs at least one point");
  }
  return { minLon, minLat, maxLon, maxLat };
}

export function bboxContains(box: BBox, p: GeoPoint): boolean {
  return (
    p.lon >= box.minLon && p.lon <= box.maxLon && p.lat >= box.minLat && p.lat <= box.maxLat
  );
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return (
    a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat
  );
}

/** Pad a box by a ground distance, degrees. Cheap and only ever a prefilter. */
export function bboxExpand(box: BBox, metres: number): BBox {
  const dLat = metres / M_PER_DEG_LAT;
  const meanLat = (box.minLat + box.maxLat) / 2;
  const dLon = metres / (M_PER_DEG_LAT * Math.cos((meanLat * Math.PI) / 180));
  return {
    minLon: box.minLon - dLon,
    minLat: box.minLat - dLat,
    maxLon: box.maxLon + dLon,
    maxLat: box.maxLat + dLat,
  };
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

/** Ray casting. Boundary counts as inside, which is what a visitor expects. */
export function pointInRing(point: GeoPoint, ring: readonly GeoPoint[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (pi === undefined || pj === undefined) continue;
    const straddles = pi.lat > point.lat !== pj.lat > point.lat;
    if (!straddles) continue;
    const cross =
      ((pj.lon - pi.lon) * (point.lat - pi.lat)) / (pj.lat - pi.lat) + pi.lon;
    if (point.lon < cross) inside = !inside;
  }
  return inside;
}

/** GeoJSON Polygon order: exterior ring first, then holes. */
export function pointInPolygon(point: GeoPoint, polygon: readonly (readonly GeoPoint[])[]): boolean {
  const exterior = polygon[0];
  if (exterior === undefined) return false;
  if (!pointInRing(point, exterior)) return false;
  for (let i = 1; i < polygon.length; i++) {
    const hole = polygon[i];
    if (hole !== undefined && pointInRing(point, hole)) return false;
  }
  return true;
}

/**
 * Planar shoelace area, square metres. Uses the mean latitude of the ring for
 * the longitude scale, matching the method recorded in
 * data/reference/isochrones/isochrone-metrics.json so our numbers are
 * comparable with the shipped ones (~1% error at neighbourhood scale).
 */
export function ringAreaSqm(ring: readonly GeoPoint[]): number {
  if (ring.length < 3) return 0;
  let latSum = 0;
  for (const p of ring) latSum += p.lat;
  const meanLat = latSum / ring.length;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((meanLat * Math.PI) / 180);
  let acc = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i];
    const pj = ring[j];
    if (pi === undefined || pj === undefined) continue;
    acc += (pj.lon - pi.lon) * ((pi.lat + pj.lat) / 2);
  }
  return Math.abs((acc * mPerDegLon * M_PER_DEG_LAT) / 2);
}

/** Total area of a GeoJSON Polygon, exterior minus holes, square metres. */
export function polygonAreaSqm(polygon: readonly (readonly GeoPoint[])[]): number {
  let area = ringAreaSqm(polygon[0] ?? []);
  for (let i = 1; i < polygon.length; i++) {
    area -= ringAreaSqm(polygon[i] ?? []);
  }
  return area;
}

// ---------------------------------------------------------------------------
// Isochrones
// ---------------------------------------------------------------------------

export interface Isochrone {
  readonly hub: GeoPoint;
  readonly hubName: string;
  readonly costing: Costing;
  readonly contourMinutes: number;
  readonly provider: string;
  readonly bbox: BBox;
  readonly polygon: readonly (readonly GeoPoint[])[];
}

interface RawFeature {
  properties?: {
    hub?: { lat?: number; lon?: number };
    hub_name?: string;
    costing?: string;
    contour_minutes?: number;
    provider?: string;
    bbox?: number[];
  };
  geometry?: { type?: string; coordinates?: unknown };
}

function ringFromUnknown(value: unknown): GeoPoint[] | null {
  if (!Array.isArray(value)) return null;
  const out: GeoPoint[] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const lon = pair[0];
    const lat = pair[1];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    out.push({ lat, lon });
  }
  return out.length >= 3 ? out : null;
}

/**
 * Parse a Valhalla isochrone FeatureCollection. GeoJSON orders coordinates
 * [lon, lat] and this is the one place in the codebase that has to remember it.
 */
export function parseIsochrone(raw: unknown): Isochrone {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("isochrone: not an object");
  }
  const features = (raw as { features?: unknown }).features;
  if (!Array.isArray(features) || features[0] === undefined) {
    throw new Error("isochrone: no features");
  }
  const feature = features[0] as RawFeature;
  const props = feature.properties ?? {};
  const hubRaw = props.hub;
  if (hubRaw?.lat === undefined || hubRaw.lon === undefined) {
    throw new Error("isochrone: missing hub");
  }
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords)) {
    throw new Error("isochrone: missing geometry.coordinates");
  }
  const polygon: GeoPoint[][] = [];
  for (const ringRaw of coords) {
    const ring = ringFromUnknown(ringRaw);
    if (ring !== null) polygon.push(ring);
  }
  if (polygon.length === 0) {
    throw new Error("isochrone: no usable rings");
  }
  const rawBox = props.bbox;
  const bbox: BBox =
    rawBox !== undefined && rawBox.length >= 4
      ? {
          minLon: rawBox[0] as number,
          minLat: rawBox[1] as number,
          maxLon: rawBox[2] as number,
          maxLat: rawBox[3] as number,
        }
      : bboxOf(polygon.flat());

  return {
    hub: { lat: hubRaw.lat, lon: hubRaw.lon },
    hubName: props.hub_name ?? "unknown",
    costing: (props.costing as Costing | undefined) ?? "pedestrian",
    contourMinutes: props.contour_minutes ?? 0,
    provider: props.provider ?? "unknown",
    bbox,
    polygon,
  };
}

export function isochroneContains(iso: Isochrone, point: GeoPoint): boolean {
  if (!bboxContains(iso.bbox, point)) return false;
  return pointInPolygon(point, iso.polygon);
}

/**
 * Tightest isochrone containing the point, i.e. the smallest budget that still
 * reaches it. Ordering by contourMinutes is what makes this the honest answer:
 * a place inside the 10-minute walk is genuinely 10 minutes away, and returning
 * the 30-minute envelope instead would inflate every travel estimate.
 */
export function smallestContaining(
  isochrones: readonly Isochrone[],
  point: GeoPoint,
): Isochrone | null {
  let best: Isochrone | null = null;
  for (const iso of isochrones) {
    if (!isochroneContains(iso, point)) continue;
    if (best === null || iso.contourMinutes < best.contourMinutes) best = iso;
  }
  return best;
}

export function isochroneAreaSqm(iso: Isochrone): number {
  return polygonAreaSqm(iso.polygon);
}

/** Default on-disk location, relative to DATA_DIR. */
export function isochroneDir(area: string = isoArea()): string {
  return `${dataDir()}/reference/isochrones/${area}`;
}

export function dataDir(): string {
  return optionalEnv("DATA_DIR") ?? "data";
}

export function isoArea(): string {
  return optionalEnv("ISOCHRONE_AREA") ?? DEFAULT_AREA;
}

const loadCache = new Map<string, Isochrone>();

/**
 * Read one cached isochrone. Synchronous on purpose: the file is committed to
 * the repo, so there is no I/O worth awaiting and the engine stays trivially
 * testable. Cached per path, and clearable for tests.
 */
export function loadIsochrone(
  hubName: string,
  costing: Costing,
  minutes: number,
  area: string = isoArea(),
): Isochrone {
  const key = `${area}/${hubName}/${costing}/${minutes}`;
  const hit = loadCache.get(key);
  if (hit !== undefined) return hit;

  const file = `${isochroneDir(area)}/${hubName}_${costing}_${minutes}min.geojson`;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `isochrone not found: ${file}. Precomputed isochrones are the offline path; ` +
        `fetch one from valhalla1.openstreetmap.de and commit it.`,
    );
  }
  const iso = parseIsochrone(JSON.parse(text) as unknown);
  loadCache.set(key, iso);
  return iso;
}

/** Every cached isochrone in the shipped set, parsed. */
export function loadAllIsochrones(area: string = isoArea()): Isochrone[] {
  const dir = isochroneDir(area);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    throw new Error(
      `isochrone dir not found: ${dir}. Commit the precomputed polygons; they are ` +
        `what lets the demo run with the network off.`,
    );
  }
  const out: Isochrone[] = [];
  for (const file of files) {
    if (!file.endsWith(".geojson")) continue;
    const match = /^(.+?)_(pedestrian|auto|bicycle|multimodal)_(\d+)min\.geojson$/.exec(file);
    if (match === null) continue;
    const [, hub, costing, minutes] = match;
    if (hub === undefined || costing === undefined || minutes === undefined) continue;
    out.push(loadIsochrone(hub, costing as Costing, Number(minutes), area));
  }
  return out;
}

export function clearIsochroneCache(): void {
  loadCache.clear();
}

// ---------------------------------------------------------------------------
// Cluster primitive
// ---------------------------------------------------------------------------

/**
 * Undirected radius graph over candidate points. This is the input the packer
 * clusters on, and it is O(n^2) in ground distance. Distances are stored
 * symmetrically and symmetrically valued on purpose: the max-clique peel in the
 * packer must not see a different number for (i, j) than for (j, i), or the
 * solver's objective stops being reproducible.
 */
export interface RadiusGraph {
  readonly points: readonly GeoPoint[];
  readonly radiusMetres: number;
  readonly adjacency: readonly (readonly number[])[];
  readonly distances: readonly (readonly number[])[];
}

export function buildRadiusGraph(
  points: readonly GeoPoint[],
  radiusMetres: number,
): RadiusGraph {
  const n = points.length;
  const distances: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const adjacency: number[][] = Array.from({ length: n }, () => []);

  for (let i = 0; i < n; i++) {
    const a = points[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < n; j++) {
      const b = points[j];
      if (b === undefined) continue;
      const d = haversineMetres(a, b);
      (distances[i] as number[])[j] = d;
      (distances[j] as number[])[i] = d;
      if (d <= radiusMetres) {
        (adjacency[i] as number[]).push(j);
        (adjacency[j] as number[]).push(i);
      }
    }
  }

  for (const row of adjacency) row.sort((x, y) => x - y);
  return { points, radiusMetres, adjacency, distances };
}

/**
 * Connected components, iterative so a long chain cannot blow the stack. Index
 * order is stable, which keeps the packer's output deterministic run to run.
 */
export function connectedComponents(graph: RadiusGraph): number[][] {
  const n = graph.points.length;
  const seen = new Array<boolean>(n).fill(false);
  const out: number[][] = [];
  const stack: number[] = [];

  for (let start = 0; start < n; start++) {
    if (seen[start] === true) continue;
    const component: number[] = [];
    seen[start] = true;
    stack.push(start);
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) break;
      component.push(node);
      for (const next of graph.adjacency[node] ?? []) {
        if (seen[next] === true) continue;
        seen[next] = true;
        stack.push(next);
      }
    }
    component.sort((a, b) => a - b);
    out.push(component);
  }
  return out;
}

/** Indices within `radiusMetres` of every point, itself included. */
export function neighbourhood(graph: RadiusGraph, i: number): number[] {
  if (i < 0 || i >= graph.points.length) return [];
  return [i, ...(graph.adjacency[i] ?? [])];
}
