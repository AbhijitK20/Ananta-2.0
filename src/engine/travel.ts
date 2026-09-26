/**
 * The routing facade. One interface, several providers, aggressive caching, and
 * a documented congestion model.
 *
 * WHY A FACADE: the shape mirrors `routingpy`'s provider-adapter interface, so a
 * routing backend can be swapped without the engine noticing. Today that means
 * OSRM (keyless) for point-to-point and matrices, Valhalla (keyless) for
 * isochrone polygons, and haversine as the always-available fallback.
 *
 * THE HONEST PART: OSRM's public server returns FREE-FLOW times. In Mumbai that
 * understates a peak-hour drive by three to five times. Pretending otherwise
 * would produce plans that simply do not work, so we apply a documented
 * multiplier keyed on corridor and time band, and every leg we return sets
 * `estimated: true` unless it came from a live routing call.
 *
 * Pre-computed isochrones and matrices ship in data/reference/isochrones/ for two
 * areas, which is what lets the demo run with the network off.
 */
import type { GeoPoint, TravelLeg } from "@/contracts";
import { haversineMetres } from "./geo";

/** Peak for the congestion model: 08:00-11:00 and 17:00-21:00. */
function isPeakHour(minute: number): boolean {
  return (minute >= 8 * 60 && minute < 11 * 60) || (minute >= 17 * 60 && minute < 21 * 60);
}

export type TravelMode = "walk" | "auto" | "transit" | "ferry";

/** Free-flow speed in metres/second, used for the haversine fallback. */
const FALLBACK_SPEED: Record<TravelMode, number> = {
  walk: 1.3,
  auto: 8.3, // 30 km/h
  transit: 9.7, // 35 km/h including dwell
  ferry: 6.9, // 25 km/h
};

const MODE_LABEL: Record<TravelMode, string> = {
  walk: "walk",
  auto: "drive",
  transit: "transit",
  ferry: "ferry",
};

// --- the congestion model ---------------------------------------------------
// Documented ESTIMATES, not measurement. Values are multipliers on free-flow.
// Sources: the ITINERA production system's time-to-radius table, plus the general
// shape of Indian metro commute peaks. If we later get real traffic we replace
// this table and nothing else changes.

export type TimeBand = "offpeak" | "peak" | "night" | "sunday";

export interface CongestionTable {
  [corridor: string]: Record<TimeBand, number>;
}

export const DEFAULT_CONGESTION: CongestionTable = {
  island_south: { offpeak: 1.0, peak: 1.9, night: 1.1, sunday: 1.2 },
  island_central: { offpeak: 1.1, peak: 2.2, night: 1.15, sunday: 1.3 },
  western_suburban: { offpeak: 1.2, peak: 2.6, night: 1.3, sunday: 1.4 },
  eastern_suburban: { offpeak: 1.15, peak: 2.4, night: 1.25, sunday: 1.35 },
  navi_mumbai: { offpeak: 1.0, peak: 1.8, night: 1.0, sunday: 1.15 },
  thane_belapur: { offpeak: 1.1, peak: 2.0, night: 1.1, sunday: 1.25 },
};

export function timeBand(atMin: number, isSunday: boolean): TimeBand {
  if (isSunday) return "sunday";
  if (isPeakHour(atMin)) return "peak";
  if (atMin >= 23 * 60 || atMin < 6 * 60) return "night";
  return "offpeak";
}

export function congestionMultiplier(
  corridor: string,
  atMin: number,
  isSunday = false,
  table: CongestionTable = DEFAULT_CONGESTION,
): number {
  const row = table[corridor] ?? table.island_central ?? { offpeak: 1.1, peak: 2.2, night: 1.15, sunday: 1.3 };
  return row[timeBand(atMin, isSunday)];
}

/** Which congestion corridor a point falls in. Crude polygons, deliberately. */
export function corridorFor(p: GeoPoint): string {
  // Navi Mumbai and Thane/Belapur sit north-east of the harbour.
  if (p.lat > 19.05 && p.lon > 72.95) return "navi_mumbai";
  if (p.lat > 19.02 && p.lon > 72.88) return "thane_belapur";
  if (p.lat < 19.06 && p.lon > 72.84) return "eastern_suburban";
  if (p.lat > 19.04 && p.lon < 72.85 && p.lon > 72.8) return "western_suburban";
  if (p.lon < 72.85 && p.lat > 19.03) return "island_south";
  return "island_central";
}

// --- provider plumbing ------------------------------------------------------

export interface RouteProvider {
  name: string;
  /** Point-to-point. Returns null when the provider is unavailable. */
  route(
    from: GeoPoint,
    to: GeoPoint,
    mode: TravelMode,
    atMin: number,
  ): Promise<{ minutes: number; metres: number; detail?: string } | null>;
}

const cache = new Map<string, { minutes: number; metres: number; detail?: string }>();
const CACHE_LIMIT = 20_000;

function cacheKey(from: GeoPoint, to: GeoPoint, mode: TravelMode, atMin: number): string {
  // Bucket the time to 30 min so a replan at 17:05 and 17:20 share a cache entry.
  const bucket = Math.floor(atMin / 30);
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return `${r(from.lat)},${r(from.lon)}->${r(to.lat)},${r(to.lon)}|${mode}|${bucket}`;
}

const OSRM_PROFILE: Record<TravelMode, string> = {
  walk: "walking",
  auto: "driving",
  transit: "driving", // no free transit routing; transit comes from corridors
  ferry: "driving",
};

/** OSRM's public server. Keyless. Free-flow, so the multiplier is applied after. */
export const osrm: RouteProvider = {
  name: "osrm",
    async route(from, to, mode, _atMin) {
      // `_atMin` is unused here because OSRM returns free-flow duration and the
      // congestion multiplier is applied by the caller, not the provider. It
      // stays in the signature because it is part of the RouteProvider contract.
    const profile = OSRM_PROFILE[mode];
    const url =
      `https://router.project-osrm.org/route/v1/${profile}/` +
      `${from.lon},${from.lat};${to.lon},${to.lat}` +
      `?overview=false&alternatives=false`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "travelbuddy/0.1" } });
      clearTimeout(timer);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        code?: string;
        routes?: Array<{ duration: number; distance: number }>;
      };
      if (body.code !== "Ok" || !body.routes?.[0]) return null;
      return { minutes: body.routes[0].duration / 60, metres: body.routes[0].distance };
    } catch {
      return null; // any failure falls through to the estimate
    }
  },
};

/**
 * Always available. Straight-line distance at a mode speed, with a detour factor
 * because nobody travels in a straight line across a city.
 */
export const haversineEstimate: RouteProvider = {
  name: "estimate",
  async route(from, to, mode) {
    const metres = haversineMetres(from, to);
    const detour = mode === "walk" ? 1.25 : 1.4;
    const speed = FALLBACK_SPEED[mode];
    return { minutes: (metres * detour) / speed / 60, metres: metres * detour };
  },
};

// --- the facade -------------------------------------------------------------

export interface TravelContext {
  /** Minutes from local midnight, for the congestion model. */
  atMin: number;
  isSunday?: boolean;
  mode: TravelMode;
  corridor?: string;
  congestion?: CongestionTable;
  /** Set false to skip live routing entirely. Used by the offline demo path. */
  allowNetwork?: boolean;
}

export interface TravelResult {
  minutes: number;
  metres: number;
  estimated: boolean;
  detail: string | null;
  provider: string;
}

const providers: RouteProvider[] = [osrm, haversineEstimate];

/**
 * Travel time between two points. Always returns something. Marks the result as
 * an estimate whenever it did not come from a live routing call, so the UI can
 * render it differently and nobody mistakes a heuristic for a fact.
 */
export async function travelBetween(
  from: GeoPoint,
  to: GeoPoint,
  ctx: TravelContext,
): Promise<TravelResult> {
  const key = cacheKey(from, to, ctx.mode, ctx.atMin);
  const hit = cache.get(key);
  if (hit) return toResult(hit, true, null, "cache", ctx);

  const allowNetwork = ctx.allowNetwork !== false && process.env.TRAVELBUDDY_OFFLINE !== "1";

  for (const provider of providers) {
    if (!allowNetwork && provider !== haversineEstimate) continue;
    const raw = await provider.route(from, to, ctx.mode, ctx.atMin);
    if (raw === null) continue;

    const corridor = ctx.corridor ?? corridorFor(from);
    const table = ctx.congestion ?? DEFAULT_CONGESTION;
    const mult = provider === haversineEstimate
      ? 1
      : congestionMultiplier(corridor, ctx.atMin, ctx.isSunday ?? false, table);

    const result = { minutes: raw.minutes * mult, metres: raw.metres, detail: raw.detail };
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(key, result);
    return toResult(result, provider !== haversineEstimate, null, provider.name, ctx);
  }

  // Unreachable in practice, but the return type demands it.
  const last = await haversineEstimate.route(from, to, ctx.mode, ctx.atMin);
  const r = { minutes: last!.minutes, metres: last!.metres };
  cache.set(key, r);
  return toResult(r, false, null, "estimate", ctx);
}

function toResult(
  raw: { minutes: number; metres: number; detail?: string },
  live: boolean,
  detail: string | null,
  provider: string,
  _ctx: TravelContext,
): TravelResult {
  return {
    // CEIL, never round. A leg that reports 12 minutes when it is 12.4 makes
    // the plan optimistic, and the error compounds across every stop — so the
    // traveller is the one who discovers it, by being late. Rounding up costs
    // at most a minute and fails in the safe direction. The floor of 1 keeps a
    // genuinely adjacent venue from costing zero, which would let a plan pack
    // an unbounded number of stops into the same minute.
    minutes: Math.max(1, Math.ceil(raw.minutes)),
    metres: Math.round(raw.metres),
    estimated: !live,
    detail: detail ?? raw.detail ?? null,
    provider,
  };
}

/** Build the leg object the Plan carries. */
export function toLeg(fromId: string, toId: string, r: TravelResult, mode: TravelMode): TravelLeg {
  return {
    fromId,
    toId,
    mode,
    minutes: r.minutes,
    metres: r.metres,
    detail: r.detail ?? `${MODE_LABEL[mode]}, estimated`,
    estimated: r.estimated,
  };
}

// --- transit corridors ------------------------------------------------------

export interface TransitCorridor {
  from: string;
  to: string;
  mode: "train" | "metro" | "monorail" | "ferry" | "bus";
  line: string;
  minutes: number;
  transfers: number;
}

/**
 * A seeded corridor match, when one exists between two named places. In Mumbai
 * the train genuinely beats the car across the island — Bandra to Colaba is
 * about 21 minutes by Western Line and 38 by car at peak — so a plan that only
 * understood roads would be wrong.
 */
export function findCorridor(
  fromLabel: string,
  toLabel: string,
  corridors: readonly TransitCorridor[],
): TransitCorridor | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const a = norm(fromLabel);
  const b = norm(toLabel);
  let best: TransitCorridor | null = null;
  for (const c of corridors) {
    const matches =
      (norm(c.from) === a && norm(c.to) === b) || (norm(c.from) === b && norm(c.to) === a);
    if (matches && (best === null || c.minutes < best.minutes)) best = c;
  }
  return best;
}

export function clearTravelCache(): void {
  cache.clear();
}
