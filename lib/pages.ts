/**
 * The utility and legal pages, and the accessors the routes read them through.
 *
 * Separate from lib/content.ts on purpose: everything in there is a dataset
 * scraped off the live site by tools/extract-content.mjs, where a missing field
 * means the scrape drifted and someone should go and look. The copy in
 * data/pages.json is ours — it is written, reviewed and translated by hand — so
 * treating the two the same would invite the wrong response when they break.
 *
 * Pages are keyed by slug and the slug is the route, so PAGES is the list of
 * routes this module can serve. Adding a key to data/pages.json is not enough on
 * its own: a route folder has to exist to render it, because app/[slug] is a
 * catch-all for cities and would answer /privacy with notFound().
 */
import pageData from "../data/pages.json";

export type PageSection = {
  heading: string;
  body: string[];
};

export type StaticPage = {
  title: string;
  description: string;
  lede: string;
  sections: PageSection[];
};

type PageFile = {
  updated: string;
  pages: Record<string, StaticPage>;
};

const file = pageData as PageFile;

/** Last edited date shown at the foot of every page below. */
export const PAGES_UPDATED = file.updated;

/** Slug -> copy. A missing slug is a bug in the route folder, not a 404. */
export const PAGES = file.pages;

/**
 * Copy for one page. Throws rather than returning undefined so a typo'd slug
 * fails the build instead of rendering a blank shell in production.
 */
export function getPage(slug: string): StaticPage {
  const page = PAGES[slug];
  if (!page) {
    throw new Error(
      `No copy in data/pages.json for "${slug}". Known pages: ${Object.keys(PAGES).join(", ")}`,
    );
  }
  return page;
}
