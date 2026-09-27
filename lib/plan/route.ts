/**
 * Legs between stops, from OSRM where a leg can honestly be routed and from a
 * stated estimate where it cannot.
 *
 * ---------------------------------------------------------------------------
 * WHY ONLY THE CAR PROFILE IS TRUSTED
 * ---------------------------------------------------------------------------
 *
 * The public OSRM demo server answers `/route/v1/bike/…` and `/route/v1/foot/…`
 * with HTTP 200 and a *car* route: same geometry, same distance, same duration
 * to the metre. Asking all three profiles for Vienna -> Rome and diffing the
 * responses returns three identical objects. It is not rejecting the profile, it
 * is ignoring it.
 *
 * That is a trap worth naming, because the failure is silent. A planner that fed
 * those numbers to a bicycle itinerary would tell a rider their 584km day takes
 * 5h50m at 100km/h, and nothing in the response would look wrong. So the car
 * profile is the only one this module routes, and bike and foot fall through to
 * the estimate with `basis: "estimated"` set — which the UI prints next to the
 * number.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS THE NORMAL PATH
 * ---------------------------------------------------------------------------
 *
 * The demo server is a shared free resource. It rate-limits, it times out, it is
 * occasionally down, and it is not reachable at all from an offline machine. A
 * trip planner that renders an empty map when a fetch fails has made the network
 * a hard dependency of its core function, so every failure here resolves to an
 * estimate and the caller never has to handle an error.
 */

import { estimateHours, estimateKm } from "./geo";
import type { Leg, LegBasis, LngLat, TravelMode } from "./types";

const OSRM = "https://router.project-osrm.org/route/v1";

/** Long enough to be worth waiting for a route, short enough that a dead host
 *  does not leave the itinerary spinning. */
const TIMEOUT_MS = 6000;

/** The only profile the demo server actually honours. See the file note. */
const ROUTABLE_MODES: ReadonlySet<TravelMode> = new Set<TravelMode>(["car"]);

/**
 * Requests are batched by OSRM, so one call covers the whole itinerary rather
 * than one per leg. N legs would be N round trips, and the demo server is the
 * wrong place to spend them.
 */
type OsrmLeg = { distance: number; duration: number };
type OsrmResponse = {
  code: string;
  routes?: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
    legs: OsrmLeg[];
  }[];
};

const cache = new Map<string, OsrmResponse | null>();

function cacheKey(points: readonly LngLat[], mode: TravelMode): string {
  return `${mode}|${points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";")}`;
}

async function fetchRoute(
  points: readonly LngLat[],
  mode: TravelMode,
  signal: AbortSignal,
): Promise<OsrmResponse | null> {
  const key = cacheKey(points, mode);
  if (cache.has(key)) return cache.get(key) ?? null;

  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `${OSRM}/driving/${coords}?overview=full&geometries=geojson`;

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const both = AbortSignal.any([signal, timeout]);

  let result: OsrmResponse | null = null;
  try {
    const res = await fetch(url, { signal: both, headers: { Accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as OsrmResponse;
      if (body.code === "Ok" && body.routes?.length) result = body;
    }
  } catch {
    // Offline, timed out, rate-limited, aborted, or unparseable: all the same to
    // the caller, which gets an estimate either way.
    result = null;
  }

  // Only successes are cached. A transient failure that stuck in the cache would
  // keep a whole session on estimates after one bad request.
  if (result) cache.set(key, result);
  return result;
}

/**
 * The straight-line fallback, for one leg.
 *
 * The ids matter: every consumer matches a leg to its stops by them. An earlier
 * version left them blank here, which worked for the routed path and silently
 * emptied the itinerary for every non-car mode — the leg had no endpoints, so it
 * matched no stop, rendered no row and drew no line.
 */
function estimatedLeg(
  from: { id: string; at: LngLat },
  to: { id: string; at: LngLat },
  mode: TravelMode,
): Leg {
  const km = estimateKm(from.at, to.at, mode);
  return {
    fromId: from.id,
    toId: to.id,
    km,
    hours: estimateHours(km, mode),
    basis: "estimated",
  };
}

/**
 * Route every leg of the itinerary in one request.
 *
 * `stops` is expected to be the non-skipped stops in visiting order. Returns one
 * leg per adjacent pair, so `legs.length === stops.length - 1`.
 */
export async function routeTrip(
  stops: readonly { id: string; at: LngLat }[],
  mode: TravelMode,
  signal?: AbortSignal,
): Promise<Leg[]> {
  if (stops.length < 2) return [];
  if (!ROUTABLE_MODES.has(mode)) {
    return adjacentPairs(stops).map(([a, b]) => estimatedLeg(a, b, mode));
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const body = await fetchRoute(
      stops.map((s) => s.at),
      mode,
      controller.signal,
    );

    const route = body?.routes?.[0];
    if (!route) {
      return adjacentPairs(stops).map(([a, b]) => estimatedLeg(a, b, mode));
    }

    const pairs = adjacentPairs(stops);
    return pairs.map(([a, b], i) => {
      const osrmLeg = route.legs?.[i];
      if (!osrmLeg) return estimatedLeg(a, b, mode);
      return {
        fromId: a.id,
        toId: b.id,
        km: osrmLeg.distance / 1000,
        hours: osrmLeg.duration / 3600,
        basis: "routed" as LegBasis,
        geometry: route.geometry?.coordinates,
      };
    });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function adjacentPairs(stops: readonly { id: string; at: LngLat }[]) {
  const pairs: [{ id: string; at: LngLat }, { id: string; at: LngLat }][] = [];
  for (let i = 1; i < stops.length; i++) pairs.push([stops[i - 1], stops[i]]);
  return pairs;
}

/** The `[lon, lat]` line for a set of legs, deduplicated. MapLibre wants one
 *  polyline; the legs share endpoints, so consecutive duplicates are dropped. */
export function routeLine(legs: readonly Leg[]): [number, number][] | null {
  const points: [number, number][] = [];
  for (const leg of legs) {
    const geometry = leg.geometry;
    if (!geometry) continue;
    for (const point of geometry) {
      const last = points[points.length - 1];
      if (last && last[0] === point[0] && last[1] === point[1]) continue;
      points.push(point);
    }
  }
  return points.length >= 2 ? points : null;
}

/** Furkot's navigation hand-off. Each is a public URL that takes a trip and
 *  opens it in someone else's app; none of them need a key. */
export const NAV_APPS = [
  { id: "osm", label: "OpenStreetMap", href: (gpx: string) => `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${gpx}` },
  { id: "google", label: "Google Maps", href: (gpx: string) => `https://www.google.com/maps/dir/?api=1&waypoints=${gpx}` },
] as const;

/** `lat,lon` waypoint string, which is the order both hand-offs expect. */
export function waypointString(stops: readonly { at: LngLat }[]): string {
  return stops.map((s) => `${s.at.lat},${s.at.lon}`).join("|");
}

/** A GPX track of the routed line, for the export button. */
export function toGpx(legs: readonly Leg[], name: string): string {
  const points = legs.flatMap((l) => l.geometry ?? []);
  const trk = points
    .map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Local Legends planner" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <trk><name>${name.replace(/[<>&]/g, "")}</name><trkseg>`,
    trk,
    "  </trkseg></trk>",
    "</gpx>",
    "",
  ].join("\n");
}
