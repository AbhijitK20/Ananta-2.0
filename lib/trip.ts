/**
 * lib/trip.ts — the trip planner's logic, with no React in it.
 *
 * Furkot's planner is a URL, a map and a list of stops, and everything that
 * decides what those three agree on lives here: which stop a loop swap produces,
 * where a stop lands when it is dragged, which places survive the filters, and
 * what the route line looks like. Keeping it out of the component means the
 * awkward parts -- reordering, and the loop/end-point swap -- are checkable
 * without a browser. tools/check-trip.mjs runs them.
 *
 * The clone is reference material with no test runner of its own, so there is no
 * vitest here on purpose. Node strips the types off a .ts on import, so the one
 * check imports this file directly and needs nothing installed.
 *
 * This file deliberately imports nothing. That is what lets tools/check-trip.mjs
 * load it in bare Node with no bundler and no node_modules, so the place
 * catalogue is bound in at the component instead, through the structural
 * MappablePlace below.
 *
 * Values in here that are not obvious come from tools/capture.mjs against
 * https://trips.furkot.com/ui, not from reading the CSS. Furkot injects its
 * stylesheets from JS, so the source rules are not fetchable and the computed
 * style of each element is the only honest source. See app/planner.css.
 */

/**
 * The shape this module needs from a place. Structural rather than an import of
 * Place from data/places, so that lib/trip.ts stays importable on its own;
 * data/places' Place satisfies it as written.
 */
export type MappablePlace = {
  name: string;
  country: string;
  code: string;
  region: string;
  lat?: number;
  lng?: number;
};

/** A place the traveller dropped on the map, in trip order. */
export type Stop = {
  id: string;
  name: string;
  country: string;
  code: string;
  region: string;
  lat: number;
  lng: number;
  /** Minutes the traveller said they would spend here. Furkot calls this a stay. */
  minutes: number;
};

/** The inputs that decide the shape of the route. */
export type Endpoints = {
  start: string;
  /** Mid point, only meaningful when `loop` is true. */
  mid: string;
  /** End point, only meaningful when `loop` is false. */
  end: string;
  loop: boolean;
  name: string;
};

export type Filters = {
  query: string;
  region: string;
  country: string;
  /** Furkot's five side tabs. "none" means the map is showing the trip itself. */
  tab: Tab;
};

export const TABS = ["none", "trips", "plan", "sleep", "eat", "find"] as const;
export type Tab = (typeof TABS)[number];

export const EMPTY_FILTERS: Filters = { query: "", region: "", country: "", tab: "none" };

export const EMPTY_ENDPOINTS: Endpoints = { start: "", mid: "", end: "", loop: false, name: "" };

/* ------------------------------------------------------------------ geography */

/** Great-circle distance in kilometres. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Round to km's precision, which is finer than any scale bar on the map. */
export const roundKm = (km: number): number => Math.round(km);

/** Total route length, and the leg each stop is reached by. */
export function routeLength(stops: readonly Stop[]): {
  totalKm: number;
  legs: { from: number; to: number; km: number }[];
} {
  const legs: { from: number; to: number; km: number }[] = [];
  let totalKm = 0;
  for (let i = 1; i < stops.length; i++) {
    const km = roundKm(haversineKm(stops[i - 1]!, stops[i]!));
    legs.push({ from: i - 1, to: i, km });
    totalKm += km;
  }
  return { totalKm: roundKm(totalKm), legs };
}

/**
 * A loop trip closes back on the start, so the line and the length both gain a
 * final leg that a one-way trip does not have. This is the whole reason `loop`
 * is more than a label on a checkbox.
 */
export function closesOnItself(stops: readonly Stop[], loop: boolean): boolean {
  return loop && stops.length > 2;
}

/** The route as map coordinates, with the closing leg appended for a loop. */
export function routeCoordinates(stops: readonly Stop[], loop: boolean): [number, number][] {
  const line = stops.map((s) => [s.lng, s.lat] as [number, number]);
  if (line.length > 1 && closesOnItself(stops, loop)) {
    const first = line[0]!;
    const last = line[line.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) line.push(first);
  }
  return line;
}

/** The box a trip fits in, as maplibre wants it: [west, south, east, north]. */
export function boundsOf(
  points: readonly { lat: number; lng: number }[],
): [number, number, number, number] | null {
  if (points.length === 0) return null;
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const p of points) {
    if (p.lng < w) w = p.lng;
    if (p.lng > e) e = p.lng;
    if (p.lat < s) s = p.lat;
    if (p.lat > n) n = p.lat;
  }
  // A single stop, or several in one place, has a zero-area box that maplibre
  // refuses to fit to. One degree is roughly the width of a mid-size country.
  if (w === e) {
    w -= 1;
    e += 1;
  }
  if (s === n) {
    s -= 1;
    n += 1;
  }
  return [w, s, e, n];
}

/** Furkot prints coordinates as degrees, minutes and decimal seconds. */
export function formatDms(value: number, axis: "lat" | "lng"): string {
  const hemisphere = axis === "lat" ? (value >= 0 ? "N" : "S") : value >= 0 ? "E" : "W";
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFull = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFull);
  const seconds = (minutesFull - minutes) * 60;
  const d = String(degrees);
  const m = String(minutes).padStart(2, "0");
  const s = seconds.toFixed(1).padStart(4, "0");
  return `${d}°${m}'${s}"${hemisphere}`;
}

/* ------------------------------------------------------------------- filtering */

/**
 * The same three controls the clone's DirectoryFilter already offers -- a text
 * box, a region and a country -- narrowed to places that actually have
 * coordinates, because a place with no lat/lng has nothing to drop on the map.
 */
export function filterPlaces<T extends MappablePlace>(places: readonly T[], filters: Filters): T[] {
  const q = filters.query.trim().toLowerCase();
  return places.filter((p) => {
    if (p.lat == null || p.lng == null) return false;
    if (filters.region && p.region !== filters.region) return false;
    if (filters.country && p.code !== filters.country) return false;
    if (q && !`${p.name} ${p.country}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** The countries present in a region, so the second select is not a global list. */
export function countriesIn(places: readonly MappablePlace[], region: string): string[] {
  const seen = new Map<string, string>();
  for (const p of places) {
    if (region && p.region !== region) continue;
    if (!seen.has(p.code)) seen.set(p.code, p.country);
  }
  return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([, name]) => name);
}

export function codeForCountry(places: readonly MappablePlace[], country: string): string {
  return places.find((p) => p.country === country)?.code ?? "";
}

/**
 * How the finder list is ordered, which is the only thing separating the EAT,
 * SLEEP and FIND tabs -- they read the same 100 places, because this clone has
 * no hotel or restaurant database to narrow them with. Saying so in the copy and
 * then sorting three different ways is honest; claiming "grouped by country" and
 * serving the same list three times is not.
 *
 * `nearest` needs somewhere to measure from, and the first stop is the only
 * sensible origin: it is where the trip begins. With no stops there is nothing
 * to be near, so it falls back to the catalogue order rather than pretending.
 */
export type FinderOrder = "catalogue" | "country" | "nearest";

export function orderPlaces<T extends MappablePlace>(
  places: readonly T[],
  order: FinderOrder,
  origin?: { lat: number; lng: number },
): T[] {
  if (order === "catalogue") return [...places];
  if (order === "country") {
    return [...places].sort(
      (a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name),
    );
  }
  if (!origin) return [...places];
  // Nearest first. filterPlaces has already dropped everything without
  // coordinates, which is what makes the non-null assertions here safe.
  return [...places].sort((a, b) => {
    const da = haversineKm(origin, { lat: a.lat!, lng: a.lng! });
    const db = haversineKm(origin, { lat: b.lat!, lng: b.lng! });
    return da - db;
  });
}

/* ------------------------------------------------------------------- reordering */

/**
 * Move the stop at `from` so it sits at index `to`, and report the two indices
 * the drag actually swapped.
 *
 * An array `splice` is the whole implementation, and returning the swap pair
 * rather than a boolean is deliberate: the itinerary shows a drop indicator
 * between two rows, and the indicator needs to know which gap it landed in.
 * Clamping both ends means a drag past either edge parks the stop at that edge
 * instead of throwing, which is what every native list does and what a user
 * dragging past the last row expects.
 */
export function moveStop<T>(items: readonly T[], from: number, to: number): {
  items: T[];
  from: number;
  to: number;
  moved: boolean;
} {
  const last = items.length - 1;
  const a = Math.min(Math.max(from, 0), last);
  const b = Math.min(Math.max(to, 0), last);
  if (items.length < 2 || a === b) return { items: [...items], from: a, to: a, moved: false };
  const next = [...items];
  const [row] = next.splice(a, 1);
  next.splice(b, 0, row!);
  return { items: next, from: a, to: b, moved: true };
}

/** Nudge a stop one place up or down. The keyboard path beside the drag. */
export function nudgeStop<T>(items: readonly T[], from: number, delta: -1 | 1): T[] {
  return moveStop(items, from, from + delta).items;
}

/* ---------------------------------------------------------------------- stops */

let seq = 0;

/** Ids only have to be unique within one session, so a counter beats a uuid. */
export function stopFrom(place: MappablePlace): Stop {
  seq += 1;
  return {
    id: `stop-${seq}`,
    name: place.name,
    country: place.country,
    code: place.code,
    region: place.region,
    lat: place.lat!,
    lng: place.lng!,
    minutes: 60,
  };
}

/** A stop dropped on bare map coordinates, with no place behind it. */
export function stopAt(name: string, lat: number, lng: number): Stop {
  seq += 1;
  return { id: `stop-${seq}`, name, country: "", code: "", region: "", lat, lng, minutes: 60 };
}

export function addStop(stops: readonly Stop[], stop: Stop): Stop[] {
  // The same place twice is a mistake, not a two-night stay, and a duplicate
  // makes the route line fold back on itself with nothing to show for it.
  if (stops.some((s) => s.name === stop.name)) return [...stops];
  return [...stops, stop];
}

export function removeStop(stops: readonly Stop[], id: string): Stop[] {
  return stops.filter((s) => s.id !== id);
}

export function updateStop(stops: readonly Stop[], id: string, patch: Partial<Stop>): Stop[] {
  return stops.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/* ---------------------------------------------------------------- daily limits */

/**
 * Furkot's PLAN filters are daily caps: how far you will drive and how long you
 * will be in the wheel per day, and it splits your route into days against them.
 *
 * `maxDailyKm` of 0 means "no cap". A leg that would breach the cap is what
 * starts the next day, which is how Furkot behaves and the reason the per-stop
 * day number can be larger than you expected after one long hop.
 */
export type DayPlan = {
  /** 1-based, matching how the sidebar prints it. */
  day: number;
  km: number;
  hours: number;
  /** True when this leg could not fit in the day it started on. */
  breachesKm: boolean;
  breachesHours: boolean;
};

export const NO_LIMIT = 0;

export function planDays(
  stops: readonly Stop[],
  maxDailyKm: number,
  maxDrivingHours: number,
): DayPlan[] {
  const { legs } = routeLength(stops);
  const kmCap = maxDailyKm > 0 ? maxDailyKm : Infinity;
  const hourCap = maxDrivingHours > 0 ? maxDrivingHours : Infinity;
  // A car averages about 60km/h on the kind of road these routes are made of.
  const kmPerHour = 60;

  const plans: DayPlan[] = [];
  let day = 1;
  let km = 0;
  let hours = 0;

  for (const leg of legs) {
    const legHours = leg.km / kmPerHour;
    // Only start a new day if the cap is a real one. With no cap every leg is
    // day 1, which is what "I have not set a limit" should mean.
    const wouldBreach = km > 0 && (km + leg.km > kmCap || hours + legHours > hourCap);
    if (wouldBreach) {
      day += 1;
      km = 0;
      hours = 0;
    }
    km += leg.km;
    hours += legHours;
    plans.push({
      day,
      km: roundKm(km),
      hours: Math.round(hours * 10) / 10,
      breachesKm: km > kmCap,
      breachesHours: hours > hourCap,
    });
  }
  return plans;
}

/** How many days the route needs, which is what a max-days filter compares. */
export function dayCount(plans: readonly DayPlan[]): number {
  return plans.length === 0 ? 0 : plans[plans.length - 1]!.day;
}

/** Keep the first `maxDays` days of the route, cut mid-day at the cap. */
export function trimToDays(
  stops: readonly Stop[],
  plans: readonly DayPlan[],
  maxDays: number,
): Stop[] {
  if (maxDays <= 0) return [...stops];
  let cut = stops.length;
  for (let i = 0; i < plans.length; i++) {
    if (plans[i]!.day > maxDays) {
      cut = i + 1;
      break;
    }
  }
  return stops.slice(0, cut);
}

/* ----------------------------------------------------------------- scale bar */

/** The Earth's circumference in kilometres, used to size the map's scale bar. */
const EARTH_CIRCUMFERENCE_KM = 40075.017;

/**
 * A round number of miles that fits in `maxPx` at this zoom, how many pixels
 * wide it draws, and the label to print under it.
 *
 * The screenshot's bar reads "500mi", so miles are the unit rather than
 * maplibre's default kilometres, and the bar has to move as you zoom or it is a
 * decoration pretending to be a measurement.
 *
 * The ladder is picked DOWNWARDS -- the largest round number that still fits --
 * because picking upwards overshoots: at zoom 1 a 100-mile bar is 103px against
 * a 90px budget, and the 1-2-5 ladder has no value between to catch it. The
 * sub-mile and sub-foot rungs matter for the same reason at street zoom, where a
 * mile is several thousand pixels and the only number that fits is a few feet.
 */
const NICE_MILES = [
  0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200,
  500, 1000, 2000, 5000,
] as const;

/** Below this, feet read better than a mile count with three decimals. */
const FEET_BELOW_MILES = 0.1;

export function scaleBarFor(
  zoom: number,
  maxPx = 90,
): { miles: number; px: number; label: string } {
  const worldPx = 256 * 2 ** Math.max(0, zoom);
  const kmPerPx = EARTH_CIRCUMFERENCE_KM / worldPx;
  const milesPerPx = kmPerPx / 1.609344;
  const budget = milesPerPx * maxPx;

  let miles: number = NICE_MILES[0]!;
  for (const n of NICE_MILES) {
    if (n <= budget) miles = n;
    else break;
  }
  return { miles, px: Math.round(miles / milesPerPx), label: formatMiles(miles) };
}

/** Sub-mile distances print in feet; a mile and up print in miles. */
export function formatMiles(miles: number): string {
  if (miles >= FEET_BELOW_MILES) return `${miles}mi`;
  const feet = miles * 5280;
  // Two significant figures: 2.64ft is a false precision and 2640ft is a lie.
  const rounded = feet < 10 ? Math.round(feet * 10) / 10 : Math.round(feet);
  return `${rounded}ft`;
}

/* -------------------------------------------------------------------- summary */

/**
 * What the dialog's Done button and the sidebar both read: is there enough here
 * to draw a route, and if not, which field is missing.
 *
 * Furkot lets you start with nothing and change it later, so this never blocks.
 * It only decides which of the two buttons is live, and DONE is disabled on an
 * empty start point in the real thing.
 */
export function tripReadiness(endpoints: Endpoints, stops: readonly Stop[]): {
  canDraw: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!endpoints.start.trim()) missing.push("Start point");
  if (!endpoints.loop && !endpoints.end.trim()) missing.push("End point");
  if (endpoints.loop && !endpoints.mid.trim()) missing.push("Mid point");
  if (stops.length < 2) missing.push("at least two stops");
  return { canDraw: missing.length === 0, missing };
}

/**
 * The loop swap, measured.
 *
 * Ticking "Loop back to the starting point" replaces the End point input with a
 * Mid point one in the same 730x28 box and rewrites the sentence above it, so
 * the dialog does not grow. Captured both states with tools/capture-click.mjs;
 * the two inputs never coexist on screen.
 *
 * The returned key is a field of Endpoints. Furkot's own class for the one-way
 * input is `last`, which is why it is spelled differently here: `end` is the
 * word the rest of this file uses, and the mapping is this one function.
 */
export function endpointFieldFor(loop: boolean): "mid" | "end" {
  return loop ? "mid" : "end";
}

export function endpointPlaceholderFor(loop: boolean): string {
  return loop ? "Mid point" : "End point";
}

export function endpointHintFor(loop: boolean): string {
  return loop
    ? "For round trips, enter a name of a city, a landmark or an address half way down the road."
    : "For one way trips, enter a name of a city, a landmark or an address where the trip ends.";
}
