import type { Metadata } from "next";

import { getPage, PAGES_UPDATED, type StaticPage } from "../lib/pages";
import "../app/globals.css";
import "../app/interior.css";

/**
 * Renders a page from data/pages.json. Every utility/legal route is this
 * component plus a slug, so the three of them cannot drift apart in markup.
 */
export function StaticPageView({ page }: { page: StaticPage }) {
  return (
    <div className="g-edit lal-page">
      <div className="g-edit__inner">
        <h1 className="g-edit__title">{page.title}</h1>
        <p className="g-edit__sub">{page.lede}</p>

        {page.sections.map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.body.map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </section>
        ))}

        <p className="g-edit__aside">Last updated {PAGES_UPDATED}.</p>
      </div>
    </div>
  );
}

/** Metadata derived from the same record the page renders, so they cannot disagree. */
export function staticPageMetadata(slug: string): Metadata {
  const page = getPage(slug);
  return { title: page.title, description: page.description };
}
