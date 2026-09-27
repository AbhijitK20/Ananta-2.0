/**
 * The one place the 100 filmstrip/globe places are read through.
 *
 * Before this there were three copies of the slug rule -- CountryFilmstrip,
 * GlobeExplorer and data/places.ts each spelled it out -- and no reader that
 * joined a place to its photograph, its coordinates and its copy. That is what
 * "tap a card and find out about it" needs, so the rule now lives here once
 * and the two components import it rather than repeating it.
 *
 * Nothing here is fetched. Everything is already in the bundle: the list from
 * data/places.ts, the images from data/place-images.json, the coordinates from
 * data/place-coords.json (attached to PLACES at import time), and the prose
 * from data/place-blurbs.json.
 */
import { PLACES, REGION_ORDER, type Place } from "../data/places";
import blurbs from "../data/place-blurbs.json";
import imageMeta from "../data/place-images.json";

export type ImageMeta = {
  id: string;
  name: string;
  country: string;
  code: string;
  region: string;
  image: string;
  licence: string;
  author: string;
  commonsPage: string;
};

export type Blurb = {
  /** One or two sentences on why the place is worth the trip. */
  blurb: string;
  /** Four short tags for the card and the detail page. */
  bestFor: string[];
  /** When to actually go, which is the question people ask first. */
  goWhen: string;
};

export type PlaceDetail = Place & {
  /** The id every route, pin and image file is keyed by. */
  id: string;
  image: string;
  meta?: ImageMeta;
  blurb: string;
  bestFor: string[];
  goWhen: string;
  /** Every other place in the same country, for "also nearby in <country>". */
  siblings: PlaceDetailSummary[];
};

export type PlaceDetailSummary = {
  id: string;
  name: string;
  country: string;
  image: string;
};

const META = imageMeta as unknown as Record<string, ImageMeta>;
const BLURBS = blurbs as unknown as Record<string, Blurb>;

/**
 * The slug rule, in one place.
 *
 * The combining-mark class is written \u0300-\u036f rather than the literal
 * range the two components used, because the literal form renders as an
 * invisible cluster in most editors and gets silently corrupted. Same range,
 * same behaviour, and it survives a copy-paste.
 */
export const placeSlug = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const PLACE_REGIONS = REGION_ORDER;

const summaries: PlaceDetailSummary[] = PLACES.map((place) => ({
  id: placeSlug(place.name),
  name: place.name,
  country: place.country,
  image: META[placeSlug(place.name)]?.image ?? "/places/placeholder.jpg",
}));

const byCountry = new Map<string, PlaceDetailSummary[]>();
for (const s of summaries) {
  const list = byCountry.get(s.country);
  if (list) list.push(s);
  else byCountry.set(s.country, [s]);
}

/**
 * A missing blurb would render an empty section, which reads as broken. So a
 * place with no entry in place-blurbs.json still resolves -- it just gets a
 * stated, honest fallback rather than a silent hole.
 */
const FALLBACK: Blurb = {
  blurb: "",
  bestFor: [],
  goWhen: "",
};

export const PLACES_DETAILED: PlaceDetail[] = PLACES.map((place) => {
  const id = placeSlug(place.name);
  const copy = BLURBS[id] ?? FALLBACK;
  return {
    ...place,
    id,
    image: META[id]?.image ?? "/places/placeholder.jpg",
    meta: META[id],
    blurb: copy.blurb,
    bestFor: copy.bestFor,
    goWhen: copy.goWhen,
    siblings: (byCountry.get(place.country) ?? []).filter((s) => s.id !== id),
  };
});

export const placeBySlug = (id: string): PlaceDetail | undefined =>
  PLACES_DETAILED.find((place) => place.id === id);

/** Index into PLACES_DETAILED, which is the same order the strip renders in. */
export const placeIndexBySlug = (id: string): number =>
  PLACES_DETAILED.findIndex((place) => place.id === id);

/** Counts per region, in REGION_ORDER, skipping regions with nothing in them. */
export const regionCounts = (() => {
  const counts = new Map<string, number>();
  for (const place of PLACES_DETAILED) {
    counts.set(place.region, (counts.get(place.region) ?? 0) + 1);
  }
  return PLACE_REGIONS.filter((region) => counts.get(region)).map((region) => ({
    region,
    count: counts.get(region) ?? 0,
  }));
})();

/** The distinct countries represented, alphabetical, for the filter rail. */
export const placeCountries = [...new Set(PLACES_DETAILED.map((p) => p.country))].sort();
