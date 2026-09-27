/**
 * The directory, read as something a trip planner can offer.
 *
 * 892 entries, 202 cities, seven category tags. Same source as every other page
 * on the site, reached through `lib/content` rather than re-read from the JSON,
 * so there is one definition of what an entry is.
 *
 * ---------------------------------------------------------------------------
 * WHICH DRAWER A PLACE LANDS IN, AND WHAT THE DATA DOES NOT SUPPORT
 * ---------------------------------------------------------------------------
 *
 * Furkot files points of interest into three drawers. The mapping here is:
 *
 *   Sleep  hotels                                  26 places
 *   Eat    restaurants                              86
 *   Find   tours, sightseeing, attractions,
 *          shopping, nightlife, and anything
 *          the source left uncategorised           780
 *
 * Those three numbers are the honest shape of this dataset and they are worth
 * stating plainly, because a planner that hid them would look far fuller than it
 * is. **There are 26 hotels in the whole directory, and they sit in 12 of its
 * 202 cities.** So for 190 cities the Sleep drawer is empty and the overnight
 * suggestion has nothing to offer. Both are surfaced in the UI rather than
 * papered over with invented lodging.
 *
 * The 578 uncategorised entries are the awkward part. The extractor reads a
 * category from a node the site only renders on some cards, so most entries
 * carry no tag at all — the same gap `lib/game/content.ts` documents. Filing
 * them under "Find" is a choice, and it is the only defensible one: a place with
 * no category cannot be known to be a hotel or a restaurant, and putting it in
 * Sleep or Eat would be inventing the one fact a traveller would act on. They
 * are listed in Find and marked, and the drawers show the untagged count.
 *
 * `drawerFor` files each place exactly once, on its first matching tag, so the
 * three counts sum to exactly 892 and can be presented as a partition. Four
 * entries carry two tags; a bar that is also a music venue lands in Eat, because
 * that is where a traveller would look for it.
 */

import { CATEGORY_LABELS, ENTRIES, type Entry } from "../content";
import { CITY_COORDS, coordsFor, distanceToLineKm } from "./geo";
import type { Drawer, Filters, LngLat } from "./types";

/** The seven tags, in the order the site lists them. */
export const TAGS = [
  "restaurants",
  "hotels",
  "tours",
  "sightseeing",
  "attractions",
  "shopping",
  "nightlife",
] as const;

export type Tag = (typeof TAGS)[number];

export const tagLabel = (tag: string) => CATEGORY_LABELS[tag] ?? tag;

/** A directory entry with a point attached and a drawer assigned. */
export type Place = {
  /** `city/slug`, the same id the rest of the site uses for a place. */
  id: string;
  name: string;
  city: string;
  cityLabel: string;
  /** Null when the city is missing from data/city-coords.json. */
  at: LngLat | null;
  hood: string;
  snippet: string;
  budget: string;
  tags: string[];
  href: string;
  drawer: Drawer;
  /** True when the source carried no category at all. See the file note. */
  untagged: boolean;
};

const tagSet = (entry: Entry) => entry.cats.split(" ").filter(Boolean);

function drawerFor(tags: string[]): Drawer {
  if (tags.includes("hotels")) return "sleep";
  if (tags.includes("restaurants")) return "eat";
  return "find";
}

/** `meta` is "Lisbon · Mid-range"; the part before the separator is the city's
 *  own display name, which beats prettifying the slug (`nyc` -> "New York City"). */
const cityLabelFrom = (entry: Entry) => entry.meta.split(" · ")[0].trim();

function toPlace(entry: Entry): Place | null {
  const coord = coordsFor(entry.city);
  // A place in a city with no centroid cannot be drawn, filtered by distance, or
  // routed to. Dropping it silently would understate the directory, so the count
  // of these is asserted in scripts/check.ts and reported in the UI.
  if (!coord) return null;

  const tags = tagSet(entry);
  return {
    id: `${entry.city}/${entry.slug}`,
    name: entry.name,
    city: entry.city,
    cityLabel: cityLabelFrom(entry),
    at: { lat: coord.lat, lon: coord.lon },
    hood: entry.hood || "",
    snippet: entry.snippet,
    budget: entry.budget || "",
    tags,
    href: entry.href,
    drawer: drawerFor(tags),
    untagged: tags.length === 0,
  };
}

/**
 * Every drawable place, derived once.
 *
 * Frozen for the same reason `lib/content` freezes: filtering 892 records inside
 * a render is invisible in a prototype and obvious on a phone.
 */
export const PLACES: readonly Place[] = Object.freeze(
  ENTRIES.map(toPlace).filter((p): p is Place => p !== null),
);

/** Entries the directory holds that have no centroid, so cannot be placed.
 *  Surfaced rather than dropped in silence — see the note on `toPlace`. */
export const UNPLACED_COUNT = ENTRIES.length - PLACES.length;

export const PLACES_BY_DRAWER: Readonly<Record<Drawer, readonly Place[]>> = Object.freeze({
  find: Object.freeze(PLACES.filter((p) => p.drawer === "find")),
  sleep: Object.freeze(PLACES.filter((p) => p.drawer === "sleep")),
  eat: Object.freeze(PLACES.filter((p) => p.drawer === "eat")),
});

export const PLACE_TOTALS = Object.freeze({
  all: PLACES.length,
  find: PLACES_BY_DRAWER.find.length,
  sleep: PLACES_BY_DRAWER.sleep.length,
  eat: PLACES_BY_DRAWER.eat.length,
  untagged: PLACES.filter((p) => p.untagged).length,
  unplaced: UNPLACED_COUNT,
  cities: Object.keys(CITY_COORDS).length,
  /** How many distinct cities hold at least one hotel. */
  citiesWithHotels: new Set(PLACES_BY_DRAWER.sleep.map((p) => p.city)).size,
  /** Cities holding at least one entry in the drawer asked about. */
  citiesWithEat: new Set(PLACES_BY_DRAWER.eat.map((p) => p.city)).size,
});

/** Every budget band the directory actually uses, sorted. */
export const BUDGETS: readonly string[] = Object.freeze(
  [...new Set(PLACES.map((p) => p.budget).filter(Boolean))].sort(),
);

/* -------------------------------------------------------------------------- *
 * Filtering
 * -------------------------------------------------------------------------- */

export type Route = readonly [number, number][];

/**
 * Apply the drawer, the filters and Furkot's Spread.
 *
 * `route` is the line the spread is measured against, as `[lon, lat]` pairs. With
 * no route yet the spread has nothing to measure from, so it does not filter:
 * the first stop has to be addable from a drawer before a route exists, and a
 * spread that silently returned nothing until then would read as a broken drawer.
 */
export function filterPlaces(
  drawer: Drawer,
  filters: Filters,
  spreadKm: number,
  route: Route | null,
): Place[] {
  const q = filters.query.trim().toLowerCase();

  return PLACES_BY_DRAWER[drawer].filter((place) => {
    if (filters.categories.length && !place.tags.some((t) => filters.categories.includes(t))) {
      return false;
    }
    if (filters.budgets.length && !filters.budgets.includes(place.budget)) return false;
    if (filters.cities.length && !filters.cities.includes(place.city)) return false;

    if (q) {
      const hay = `${place.name} ${place.cityLabel} ${place.hood} ${place.snippet}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }

    if (route && spreadKm > 0 && place.at) {
      if (distanceToLineKm(place.at, route) > spreadKm) return false;
    }

    return true;
  });
}

/** Cities that hold at least one place in a drawer, for the city filter. */
export function citiesInDrawer(drawer: Drawer): { slug: string; label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const place of PLACES_BY_DRAWER[drawer]) {
    const held = counts.get(place.city);
    if (held) held.count += 1;
    else counts.set(place.city, { label: place.cityLabel, count: 1 });
  }
  return [...counts.entries()]
    .map(([slug, v]) => ({ slug, ...v }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** A hotel in a given city, for the overnight suggestion. Null when the
 *  directory has none — which, for most cities, it does not. */
export function hotelIn(city: string): Place | null {
  return PLACES_BY_DRAWER.sleep.find((p) => p.city === city) ?? null;
}
