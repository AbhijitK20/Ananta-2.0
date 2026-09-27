/**
 * The captured datasets, and the accessors the pages read them through.
 *
 * These files under data/ are not fixtures. They are the real contents of the
 * live site, extracted by tools/extract-content.mjs: 14 cities with their pick
 * counts, 160 blog cards, and 892 directory entries across seven category tags.
 * See that file for how each one is read out of the DOM, and for the three
 * approaches that look right and are not.
 *
 * Images are local. The extractor rewrites every CDN URL to /content/*, so the
 * clone makes no third-party request at runtime and does not depend on someone
 * else's uptime.
 */
import blogData from "../data/blog.json";
import cityData from "../data/cities.json";
import impactData from "../data/social-impact.json";

export type City = {
  name: string;
  slug: string;
  picks: number | null;
  href: string;
};

export type Post = {
  title: string;
  slug: string;
  category: string;
  excerpt: string;
  date: string;
  src: string;
  href: string;
};

export type Entry = {
  name: string;
  slug: string;
  category: string;
  cats: string;
  city: string;
  budget: string;
  meta: string;
  hood: string;
  snippet: string;
  link: string;
  href: string;
};

export type Highlight = {
  title: string;
  city: string;
  why: string;
  src: string;
  href: string;
};

export const CITIES = cityData as City[];
export const POSTS = blogData as Post[];
export const ENTRIES = impactData.entries as Entry[];
export const HIGHLIGHTS = impactData.highlights as Highlight[];
export const CATEGORY_TAGS = impactData.categories as string[];

/** Display names for the data-cats values, in the order the site lists them. */
export const CATEGORY_LABELS: Record<string, string> = {
  restaurants: "Restaurants",
  hotels: "Hotels",
  tours: "Tours",
  sightseeing: "Sightseeing",
  attractions: "Ticketed Attractions",
  shopping: "Shops & Markets",
  nightlife: "Nightlife",
};

export const CATEGORY_ORDER = [
  "restaurants",
  "hotels",
  "tours",
  "sightseeing",
  "attractions",
  "shopping",
  "nightlife",
];

export const categories = CATEGORY_ORDER.map((tag) => ({
  tag,
  label: CATEGORY_LABELS[tag] ?? tag,
}));

export const entriesByCategory = (tag: string) =>
  ENTRIES.filter((e) => e.cats.split(" ").includes(tag));

/** A business can sit in two categories, so these overlap by design. */
export const multiCategory = ENTRIES.filter((e) => e.cats.split(" ").length > 1).length;

export const cities = [...CITIES].sort((a, b) => (b.picks ?? 0) - (a.picks ?? 0));

export const postsByCategory = (category: string) =>
  category === "All" ? POSTS : POSTS.filter((p) => p.category === category);

export const postCategories = ["All", ...new Set(POSTS.map((p) => p.category))];

/** The first four cities are the featured strip; the rest fill the grid. */
export const FEATURED_COUNT = 4;

/**
 * The 42 highlight cards are grouped into the seven category rows the page
 * shows, six per row, in the order the rows are declared.
 *
 * The highlight cards carry no category of their own — only a title, a city and
 * a blurb — so the grouping is positional. That is an inference from the page's
 * own structure rather than a read-off: the seven rows declare their headings
 * in the order below, and 42 divides exactly by 7. If the source ever changes
 * either of those facts this silently mis-files, so it is stated here rather
 * than buried in the component.
 */
export const HIGHLIGHTS_PER_CATEGORY = HIGHLIGHTS.length / (CATEGORY_ORDER.length || 1);

export const highlightsFor = (index: number) => {
  const start = Math.round(index * HIGHLIGHTS_PER_CATEGORY);
  return HIGHLIGHTS.slice(start, start + HIGHLIGHTS_PER_CATEGORY);
};
