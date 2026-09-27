/**
 * Reading and writing the saved trip.
 *
 * Deliberately the same contract as `lib/game/storage.ts`: `localStorage` throws
 * on the *read* in Safari private browsing, with site data blocked, on a null
 * origin and at quota, so every access is wrapped and an in-memory copy backs it.
 * A traveller who blocks storage still plans their trip; they are told once that
 * it will not survive a reload, and nothing throws.
 *
 * A save from a future version is refused rather than reinterpreted, for the
 * reason documented at length in the game storage module: reading a newer shape
 * as if it were the old one drops the newer build's fields on the next write.
 */

import { emptyTrip, type Stop, type TravelMode, type Trip } from "./types";

const KEY = "lal-planner/trip/v1";
const SAVE_VERSION = 1;

let storageWorks = true;
let memory: Trip = emptyTrip();

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function safeGet(key: string): string | null {
  if (!hasWindow()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    storageWorks = false;
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  if (!hasWindow()) return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    storageWorks = false;
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 * Validation
 * -------------------------------------------------------------------------- */

const MODES: readonly TravelMode[] = ["car", "bike", "foot"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Coerce a parsed stop back into a `Stop`, or return null if it cannot be one.
 *
 * A stop without a usable coordinate is dropped rather than repaired with a
 * default: a marker at [0, 0] in the Gulf of Guinea is worse than a stop the
 * traveller cannot see, because it looks deliberate.
 */
function parseStop(raw: unknown): Stop | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;

  const at = c.at as Record<string, unknown> | undefined;
  if (!at || !isNum(at.lat) || !isNum(at.lon)) return null;
  if (at.lat < -90 || at.lat > 90 || at.lon < -180 || at.lon > 180) return null;

  return {
    id: isStr(c.id) && c.id ? c.id : `pin-${at.lat}-${at.lon}`,
    placeId: isStr(c.placeId) ? c.placeId : undefined,
    name: isStr(c.name) ? c.name : "Dropped pin",
    city: isStr(c.city) ? c.city : "",
    hood: isStr(c.hood) ? c.hood : "",
    at: { lat: at.lat, lon: at.lon },
    dwell: isNum(c.dwell) ? clamp(c.dwell, 0, 24) : 1,
    notes: isStr(c.notes) ? c.notes : "",
    source: c.source === "place" ? "place" : "pin",
    href: isStr(c.href) ? c.href : undefined,
    cats: Array.isArray(c.cats) ? c.cats.filter(isStr) : [],
    budget: isStr(c.budget) ? c.budget : "",
    skipped: c.skipped === true,
  };
}

/**
 * Field-by-field, like the game save: a trip that gained a field in a later
 * version should still load its stops, and throwing away a whole itinerary
 * because one optional field is absent loses the part the traveller cares about.
 */
function parseTrip(raw: string): Trip | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const c = parsed as Record<string, unknown>;
  if (typeof c.version === "number" && c.version > SAVE_VERSION) return null;

  const trip = emptyTrip();

  trip.name = isStr(c.name) && c.name ? c.name : trip.name;
  trip.mode = MODES.includes(c.mode as TravelMode) ? (c.mode as TravelMode) : trip.mode;
  // A cap of 0 would make every leg close a day, and a cap of 24 would make the
  // split a no-op. Both are states a traveller cannot mean.
  trip.dailyDriveHours = isNum(c.dailyDriveHours)
    ? clamp(c.dailyDriveHours, 1, 24)
    : trip.dailyDriveHours;
  trip.nonStop = c.nonStop === true;
  trip.spreadKm = isNum(c.spreadKm) ? clamp(c.spreadKm, 1, 500) : trip.spreadKm;
  trip.startDate = isStr(c.startDate) ? c.startDate : null;
  trip.stops = Array.isArray(c.stops)
    ? c.stops.map(parseStop).filter((s): s is Stop => s !== null)
    : [];

  return trip;
}

/* -------------------------------------------------------------------------- *
 * Public API
 * -------------------------------------------------------------------------- */

export type LoadResult = {
  trip: Trip;
  /** A stored trip was found and thrown away. Surfaced so the shell can say the
   *  plan started fresh rather than showing an empty itinerary as a choice. */
  discarded: boolean;
  reason?: string;
};

export function load(): LoadResult {
  const raw = safeGet(KEY);
  if (raw === null) {
    memory = emptyTrip();
    return { trip: memory, discarded: false };
  }

  const parsed = parseTrip(raw);
  if (!parsed) {
    memory = emptyTrip();
    return { trip: memory, discarded: true, reason: "unreadable or from a newer version" };
  }

  memory = parsed;
  return { trip: memory, discarded: false };
}

export function persist(trip: Trip): boolean {
  memory = trip;
  return safeSet(KEY, JSON.stringify({ version: SAVE_VERSION, ...trip }));
}

export function clear(): Trip {
  memory = emptyTrip();
  if (hasWindow()) {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      storageWorks = false;
    }
  }
  return memory;
}

export function isStorageAvailable(): boolean {
  return storageWorks;
}
