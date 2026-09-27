/**
 * The place index this game is played on.
 *
 * 890 unique places across 202 cities, seven category tags, four budget bands.
 * The numbers come from `data/social-impact.json`, which is a copy of the dataset
 * `research/lal-clone` extracted from likealocalguide.com with
 * `tools/extract-content.mjs`. It is copied rather than imported because that
 * project is reference material and nothing in product surface is meant to
 * depend on it — see the note at the top of its README.
 *
 * Everything in this file is derived once at module load and then frozen. The
 * alternative, filtering 890 records inside every render, is the sort of thing
 * that is invisible in a prototype and obvious on a phone.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DATA DOES NOT KNOW — read before trusting a count
 * ---------------------------------------------------------------------------
 *
 * Four gaps in the source shape this file rather than papering over it:
 *
 *   1. `cats` is empty on 576 of the 890 records kept (578 of the 892
 *      extracted). The extractor reads category from
 *      a DOM node the site only renders for some cards, so most records carry
 *      no tag at all. Those places are kept and given the `unfiled` tag, and the
 *      stamp book shows that bucket as its own row. Dropping them would make
 *      the collection look 65% emptier than it is; guessing a category for them
 *      would be inventing data.
 *
 *   2. Two records collide on `city/slug` — `vienna/magdas-hotel` and
 *      `parnu/uuskasutuskeskus-parnu` each appear twice, differing only by case
 *      or by a dropped diacritic. An id has to be unique or a stamp written
 *      against one record would silently apply to its twin. The first
 *      occurrence in source order wins; `COLLISIONS` records the losers so the
 *      loss is stated in the UI instead of being a silent 2-record shortfall.
 *
 *   3. `hood` (the neighbourhood) is missing on 202 records. Rendered as
 *      nothing rather than as the city name, because a neighbourhood line that
 *      repeats the title above it is worse than no line.
 *
 *   4. `budget` is empty on 282 records. `unknown` is a first-class band
 *      alongside budget / mid-range / high-end.
 *
 * City names are prettified from the slug for the 189 cities absent from
 * `cities.json`. `data/place-coords.json` carries Wikipedia article titles for
 * 31 of them, but that file describes *destinations* and gets it wrong in
 * places — `krakow` resolves to "Kraków John Paul II International Airport",
 * which is not the city a player is collecting a stamp in. Thirteen slugs have
 * an authoritative name in `cities.json` and those are used verbatim.
 */

import cityData from "../../data/cities.json";
import impactData from "../../data/social-impact.json";

/* -------------------------------------------------------------------------- *
 * Shapes
 * -------------------------------------------------------------------------- */

export type Category =
  | "restaurants"
  | "hotels"
  | "tours"
  | "sightseeing"
  | "attractions"
  | "shopping"
  | "nightlife"
  /** Records the extractor could not tag. A real bucket, not a null. */
  | "unfiled";

export type Budget = "budget" | "mid-range" | "high-end" | "unknown";

export type Place = {
  /** `${city}/${slug}`. Stable, URL-safe, and the key every stamp is stored under. */
  id: string;
  name: string;
  /** City slug, as it appears in the source data. */
  city: string;
  /** Place slug, as it appears in the source data. Route segments use these. */
  slug: string;
  /** Display name — authoritative where known, prettified from the slug otherwise. */
  cityLabel: string;
  /** Neighbourhood, or null. Never substituted with the city name; see note 3. */
  hood: string | null;
  snippet: string;
  budget: Budget;
  categories: Category[];
  href: string;
};

export type City = {
  slug: string;
  label: string;
  /** True when `label` came from cities.json rather than from the slug. */
  named: boolean;
  places: readonly Place[];
  /** Places per category, `unfiled` included, so a city reads at a glance. */
  byCategory: Readonly<Record<Category, number>>;
};

/* -------------------------------------------------------------------------- *
 * Lookup tables
 * -------------------------------------------------------------------------- */

export const CATEGORY_LABELS: Record<Category, string> = {
  restaurants: "Restaurants",
  hotels: "Hotels",
  tours: "Tours",
  sightseeing: "Sightseeing",
  attractions: "Ticketed Attractions",
  shopping: "Shops & Markets",
  nightlife: "Nightlife",
  unfiled: "Unfiled",
};

export const CATEGORY_ORDER: readonly Category[] = [
  "restaurants",
  "shopping",
  "sightseeing",
  "tours",
  "attractions",
  "nightlife",
  "hotels",
  "unfiled",
];

export const CATEGORIES: readonly Category[] = CATEGORY_ORDER;

export const BUDGET_LABELS: Record<Budget, string> = {
  budget: "Budget",
  "mid-range": "Mid-range",
  "high-end": "High-end",
  unknown: "Price unknown",
};

/**
 * Every source record that lost its id to an earlier twin. Surfaced, not hidden.
 *
 * Mutable during the build pass and frozen on export — a `readonly` array type
 * would forbid the very `push` that records the collision, and exporting it
 * before `buildPlaces()` runs would freeze an empty list permanently.
 */
const collisions: { id: string; name: string }[] = [];

/* -------------------------------------------------------------------------- *
 * Derivation
 * -------------------------------------------------------------------------- */

const SOURCE = impactData.entries as {
  name: string;
  slug: string;
  city: string;
  hood: string;
  snippet: string;
  budget: string;
  cats: string;
  href: string;
}[];

const EMPTY_CATEGORY_COUNTS = (): Record<Category, number> => ({
  restaurants: 0,
  hotels: 0,
  tours: 0,
  sightseeing: 0,
  attractions: 0,
  shopping: 0,
  nightlife: 0,
  unfiled: 0,
});

/**
 * `ui-cities` over `cities.json` is safe even though that file's slugs do not
 * line up with the entry slugs — `new-york-city` in the file, `nyc` in the
 * entries. A Map keyed by slug simply misses, and the miss falls through to the
 * prettifier, which is the correct outcome for a name we do not have.
 */
const AUTHORITATIVE_CITY_NAMES = new Map(
  (cityData as { slug: string; name: string }[]).map((c) => [c.slug, c.name]),
);

/**
 * Slug to display name, for the 189 cities with no authoritative name.
 *
 * Deliberately not a title-case of a split on hyphens alone: `st-johns` and
 * `wadi-rum` are both single words, and naively splitting them produces "St
 * Johns" and "Wadi Rum". What this does not do is guess harder than the data
 * supports — "Sao Paulo" rather than "São Paulo" is the honest reading of the
 * ASCII slug it was given, and the game never claims otherwise.
 */
function prettifySlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) =>
      // Leave short all-consonant tokens alone: "st", "de", "el" are not words
      // that want a capital in running text, and "The" reads better lowercased.
      word.length <= 2 || /^(st|el|de|del|la|le|du|da|di|do|dos|das)$/i.test(word)
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

function toBudget(raw: string): Budget {
  if (raw === "budget" || raw === "mid-range" || raw === "high-end") return raw;
  return "unknown";
}

function toCategories(raw: string): Category[] {
  const tags = raw.split(" ").filter(Boolean);
  const known = tags.filter((t): t is Category => t in CATEGORY_LABELS);
  // A record with no recognised tag is `unfiled` rather than untagged. Same
  // reasoning as note 1: the stamp book counts what exists.
  return known.length ? known : ["unfiled"];
}

function buildPlaces(): Place[] {
  const byId = new Map<string, Place>();

  for (const row of SOURCE) {
    const id = `${row.city}/${row.slug}`;

    const existing = byId.get(id);
    if (existing) {
      collisions.push({ id, name: row.name });
      continue;
    }

    byId.set(id, {
      id,
      name: row.name,
      city: row.city,
      slug: row.slug,
      cityLabel: AUTHORITATIVE_CITY_NAMES.get(row.city) ?? prettifySlug(row.city),
      // Empty string is the source's way of saying "not captured", and a hood of
      // "" would render as an empty line under the name.
      hood: row.hood ? row.hood : null,
      snippet: row.snippet,
      budget: toBudget(row.budget),
      categories: toCategories(row.cats),
      href: row.href,
    });
  }

  return [...byId.values()];
}

export const PLACES: readonly Place[] = Object.freeze(buildPlaces());

/** Frozen after the build pass above, so it is non-empty by the time it is read. */
export const COLLISIONS: readonly { id: string; name: string }[] = Object.freeze(
  collisions,
);

export const PLACE_BY_ID: ReadonlyMap<string, Place> = new Map(
  PLACES.map((p) => [p.id, p]),
);

function buildCities(): City[] {
  const grouped = new Map<string, Place[]>();

  for (const place of PLACES) {
    const bucket = grouped.get(place.city);
    if (bucket) bucket.push(place);
    else grouped.set(place.city, [place]);
  }

  return [...grouped.entries()]
    .map(([slug, places]) => {
      const byCategory = EMPTY_CATEGORY_COUNTS();
      for (const place of places) {
        // A place can hold two tags (a bar that is also a music venue), so it
        // counts once per tag. The union across tags therefore exceeds
        // `places.length`, and the UI must not present it as a total.
        for (const category of place.categories) byCategory[category] += 1;
      }
      return {
        slug,
        label: places[0].cityLabel,
        named: AUTHORITATIVE_CITY_NAMES.has(slug),
        places: Object.freeze([...places].sort((a, b) => a.name.localeCompare(b.name))),
        byCategory,
      };
    })
    .sort((a, b) => b.places.length - a.places.length || a.label.localeCompare(b.label));
}

export const CITIES: readonly City[] = Object.freeze(buildCities());

export const CITY_BY_SLUG: ReadonlyMap<string, City> = new Map(
  CITIES.map((c) => [c.slug, c]),
);

/* -------------------------------------------------------------------------- *
 * Derived counts
 * -------------------------------------------------------------------------- */

export const TOTALS = Object.freeze({
  places: PLACES.length,
  cities: CITIES.length,
  categories: CATEGORY_ORDER.length,
});

/** Places carrying each tag, across every city. */
export const CATEGORY_TOTALS: Readonly<Record<Category, number>> = Object.freeze(
  CATEGORY_ORDER.reduce((acc, category) => {
    acc[category] = PLACES.reduce(
      (sum, p) => sum + (p.categories.includes(category) ? 1 : 0),
      0,
    );
    return acc;
  }, EMPTY_CATEGORY_COUNTS()),
);

/* -------------------------------------------------------------------------- *
 * Accessors
 * -------------------------------------------------------------------------- */

export function cityOf(slug: string): City | undefined {
  return CITY_BY_SLUG.get(slug);
}

export function placeOf(id: string): Place | undefined {
  return PLACE_BY_ID.get(id);
}

