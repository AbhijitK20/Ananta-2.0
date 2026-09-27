/**
 * The shapes the trip planner is built from.
 *
 * Modelled on Furkot's planner, whose help centre documents the behaviour of
 * every one of these: stops and the routes between them, per-day splitting, the
 * Find/Sleep/Eat drawers, skipped stops, overnight suggestions, and the
 * navigation hand-off. The naming follows Furkot's so the two are comparable
 * when reading its docs against this code.
 *
 * ---------------------------------------------------------------------------
 * WHY STOPS CARRY COORDINATES RATHER THAN A PLACE ID
 * ---------------------------------------------------------------------------
 *
 * A stop is a coordinate with a name attached, not a reference into a dataset.
 * Furkot's stops are exactly that — a pin you drop anywhere on the map, or a
 * place you pick out of a drawer, and the two are indistinguishable afterwards.
 * Modelling it as a union of "dataset row" and "loose pin" would put a null
 * check on every read for no gain, because the planner never needs to know
 * where a stop came from in order to route it.
 *
 * `source` and `href` are kept anyway, and only for honesty: the drawer has to
 * be able to say "this came from the directory" and link back to the entry, and
 * a pin has to be able to say it has no such link.
 */

/** `[lon, lat]` everywhere a GeoJSON-shaped value is expected, `[lat, lon]` in
 *  our own types. MapLibre and OSRM both speak lon-first; mixing the two up is
 *  the single easiest way to put a marker in the ocean, so the conversion is
 *  confined to `toLngLat` / `fromLngLat` in ./geo and nowhere else. */
export type LngLat = { lat: number; lon: number };

/** Furkot's three drawers. */
export type Drawer = "find" | "sleep" | "eat";

export const DRAWERS: readonly Drawer[] = ["find", "sleep", "eat"] as const;

export const DRAWER_LABELS: Record<Drawer, string> = {
  find: "Find",
  sleep: "Sleep",
  eat: "Eat",
};

export const DRAWER_BLURB: Record<Drawer, string> = {
  find: "Attractions, sights, tours, shops and nightlife.",
  sleep: "Hotels and other lodging from the directory.",
  eat: "Restaurants and places to refuel.",
};

export type Stop = {
  /** Unique per stop, and stable across reorders. The route cache, the day
   *  split and the DOM all key off this, so it must not be the array index.
   *
   *  Deliberately NOT the directory entry's own id. A traveller can put the same
   *  hotel on two nights, and two stops sharing an id means a React key
   *  collision, an ambiguous `byId` lookup, a leg whose two ends are the same
   *  stop, and a remove that takes out both. */
  id: string;
  /** The directory entry this came from, when it came from one. Used to tell the
   *  drawer a place is already in the trip, which is why it is separate. */
  placeId?: string;
  name: string;
  /** City slug, or "" for a pin dropped on open map. */
  city: string;
  /** Neighbourhood, carried over from the directory entry. Empty for a pin. */
  hood: string;
  at: LngLat;
  /** Hours the traveller means to spend here. Feeds the day split, so a museum
   *  and a viewpoint do not cost the same. */
  dwell: number;
  notes: string;
  /** "place" came out of a drawer, "pin" was dropped on the map by hand. */
  source: "place" | "pin";
  /** The directory entry this stop came from, when there was one. */
  href?: string;
  /** The category tag that filed it, or null when the source carried none. */
  cats: string[];
  budget: string;
  /**
   * Furkot's "Maybe": stays on the map in grey, is not a leg of the route and
   * does not consume a day. Held on the stop rather than in a parallel list so
   * that flipping it cannot desynchronise the two.
   */
  skipped: boolean;
};

export type TravelMode = "car" | "bike" | "foot";

export const TRAVEL_MODES: readonly TravelMode[] = ["car", "bike", "foot"] as const;

export const TRAVEL_MODE_LABELS: Record<TravelMode, string> = {
  car: "Car",
  bike: "Bicycle",
  foot: "On foot",
};

/**
 * How a leg's distance and duration were arrived at.
 *
 * Rendered in the UI. A planner that quietly shows a straight-line estimate as
 * though it were a routed road distance is lying about the one number a traveller
 * plans around, so the distinction is part of the type rather than a log line.
 */
export type LegBasis = "routed" | "estimated";

export type Leg = {
  fromId: string;
  toId: string;
  km: number;
  hours: number;
  basis: LegBasis;
  /** `[lon, lat]` pairs, when a real route was available. */
  geometry?: [number, number][];
};

/** One day of the split itinerary. */
export type Day = {
  index: number;
  stopIds: string[];
  /** Hours spent driving on this day. */
  driveHours: number;
  km: number;
  /**
   * A city whose lodging the planner wants to suggest for the night, and whether
   * the directory actually holds a hotel there. `null` city means no suggestion.
   * `available: false` is a real state, not an error: see ./schedule.
   */
  overnight: { city: string; available: boolean } | null;
};

export type Trip = {
  name: string;
  stops: Stop[];
  mode: TravelMode;
  /** Hours of driving the traveller will accept in a day, before a night is
   *  inserted. Furkot's "set daily limits on the travel time". */
  dailyDriveHours: number;
  /** Furkot's non-stop toggle: never split, however long the day gets. */
  nonStop: boolean;
  /** Furkot's Spread: how far off the route a drawer result may sit and still
   *  be offered. */
  spreadKm: number;
  startDate: string | null;
};

export const SPREAD_STEPS = [5, 10, 25, 50, 100, 250] as const;

/** A filter set over the directory. Empty array means "no constraint". */
export type Filters = {
  categories: string[];
  budgets: string[];
  /** City slugs to keep. Empty means every city. */
  cities: string[];
  query: string;
};

export const emptyFilters: Filters = { categories: [], budgets: [], cities: [], query: "" };

export function emptyTrip(): Trip {
  return {
    name: "My trip",
    stops: [],
    mode: "car",
    dailyDriveHours: 6,
    nonStop: false,
    spreadKm: 25,
    startDate: null,
  };
}
