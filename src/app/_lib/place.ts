/**
 * "I am at ..." — free text to a real coordinate.
 *
 * WHY THIS EXISTS. `DiscoveryContext.origin.point` has been hardcoded to Bandra
 * West since the first commit, so every "too far" rejection in the product was
 * measured from one fixed spot in the city, and F1 ("resolve a location by pin,
 * free text, or I am at <hotel/landmark>") was unimplemented. The component that
 * looked like it did the job, `DiscoverySearch`, sent a `where` parameter that
 * nothing read.
 *
 * HOW IT RESOLVES, AND WHY WITHOUT A GEOCODER. Both data sources are already in
 * the repository and both are honest:
 *
 *  - the city manifest names 26 neighbourhoods, and
 *  - the catalogue is 4,596 real places, each tagged with its neighbourhood and
 *    its own coordinates.
 *
 * So a neighbourhood is placed at the mean of the coordinates of the rows that
 * claim it. That is a derived centroid, not a surveyed one, and it is only ever
 * used to seed a walking-distance estimate that already calls itself an
 * estimate. It needs no key, no network, and no new data file, which matters
 * because the demo has to run with the wifi off.
 *
 * HONEST FAILURE. Text that does not resolve returns a `point` of `null` rather
 * than silently falling back to Bandra West. A null point means the distance
 * gate is off, which is a materially different plan, so the caller has to say so
 * — see `originNote`. Snapping an unknown location onto a real one would produce
 * confident, wrong travel times, which is the single worst thing this product
 * can do.
 */
import type { GeoPoint } from "@/contracts";

import { loadCatalogue } from "./catalogue";

/** Phrases a traveller prefixes to a place without meaning them. */
const LEAD_IN = /^(i\s*(?:'m|’m| am)\s+(?:at|near|in)|we\s*(?:'re|’re| are)\s+(?:at|near|in)|at|near|in|around)\s+/i;

export interface ResolvedPlace {
  /** What the traveller typed, cleaned. Shown back so they can see what we read. */
  label: string;
  /** Null when the text did not resolve. See the note at the top of this file. */
  point: GeoPoint | null;
  /** Which of the two sources answered. Null when nothing did. */
  source: "place" | "neighbourhood" | null;
}

/** A place the traveller can pick instead of typing. */
export interface PlaceOption {
  label: string;
  point: GeoPoint;
  /**
   * `place` is a named venue resolved to its own door. `neighbourhood` is a
   * centroid over the rows that claim it, so it is coarser and the UI says so
   * rather than pretending a neighbourhood is a door.
   */
  source: "place" | "neighbourhood";
  /** Rows behind the centroid, so the UI can be honest about how precise it is. */
  rows: number;
}

let cache: { key: string; options: PlaceOption[] } | null = null;

/**
 * Every resolvable place, most precise first.
 *
 * Cached per process for the same reason the catalogue is: the file is immutable
 * and re-reducing 4,596 rows on every keystroke is the kind of thing that makes
 * a text box feel broken.
 */
export async function placeOptions(): Promise<PlaceOption[]> {
  if (cache) return cache.options;
  const { experiences } = await loadCatalogue();

  const byName = new Map<string, { lat: number; lon: number; n: number }>();
  const bump = (key: string, point: GeoPoint) => {
    const hit = byName.get(key);
    if (hit) {
      hit.lat += point.lat;
      hit.lon += point.lon;
      hit.n += 1;
    } else {
      byName.set(key, { lat: point.lat, lon: point.lon, n: 1 });
    }
  };

  for (const item of experiences) {
    if (item.neighbourhood) bump(`neighbourhood:${normalise(item.neighbourhood)}`, item.location);
    // A named venue resolves to its own door, not to a centroid, so it is a
    // separate bucket: "Taj Mahal Palace Hotel" should mean that building.
    bump(`place:${normalise(item.name)}`, item.location);
  }

  const options: PlaceOption[] = [];
  for (const [key, sum] of byName) {
    options.push({
      label: titleCase(key.slice(key.indexOf(":") + 1)),
      point: { lat: round6(sum.lat / sum.n), lon: round6(sum.lon / sum.n) },
      source: key.startsWith("place:") ? "place" : "neighbourhood",
      rows: sum.n,
    });
  }

  options.sort((a, b) => a.label.localeCompare(b.label));
  cache = { key: "v1", options };
  return options;
}

function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCase(raw: string): string {
  return raw.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Resolve one piece of free text.
 *
 * Exact match first, then a prefix match, then a substring match. The order
 * matters: "colaba cafe" must not silently become "Colaba" because a substring
 * rule ran before the prefix one. Ambiguity is resolved by the shorter label,
 * which is the more specific of the two, and an empty result is returned rather
 * than a guess.
 */
export async function resolvePlace(raw: string): Promise<ResolvedPlace> {
  const label = raw.replace(LEAD_IN, "").replace(/\s+/g, " ").trim();
  if (!label) return { label: "", point: null, source: null };

  const needle = normalise(label);
  if (!needle) return { label, point: null, source: null };

  const options = await placeOptions();
  const hit =
    options.find((option) => normalise(option.label) === needle) ??
    options.find((option) => normalise(option.label).startsWith(needle)) ??
    options
      .filter((option) => normalise(option.label).includes(needle))
      .sort((a, b) => a.label.length - b.label.length)[0];

  if (!hit) return { label, point: null, source: null };
  return { label: hit.label, point: hit.point, source: hit.source };
}

/**
 * What to tell the traveller about an origin, if anything.
 *
 * Null when the origin resolved, because there is nothing to warn about. A
 * non-null return is a sentence the UI must render — an unplaced origin means
 * every distance in the plan is unmeasured, and saying so is the difference
 * between degraded and wrong.
 */
export function originNote(place: ResolvedPlace): string | null {
  if (place.point) return null;
  if (!place.label) return null;
  return `We could not place ${place.label}, so nothing has been ruled out for being too far away.`;
}
