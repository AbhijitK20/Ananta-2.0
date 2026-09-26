import type { Metadata } from "next";

import { DirectoryFilter, EntryCard, HighlightRow } from "../../components/Interior";
import { CATEGORY_LABELS, ENTRIES, categories, highlightsFor } from "../../lib/content";
import "../interior.css";

export const metadata: Metadata = {
  title: "Social Impact",
  description: "Community-first places with a one-filter toggle.",
};

export default function SocialImpactPage() {
  const budgets = [...new Set(ENTRIES.map((e) => e.budget).filter(Boolean))].sort();
  const tagged = ENTRIES.filter((e) => e.cats).length;

  return (
    <div className="g-page">
      <div className="g-wrap">
        <h1 className="g-h1">Social Impact &amp; Sustainable Shopping</h1>
        <p className="g-lede">
          The filter that clears the noise. When it is on, only places that are
          worker-owned, community-run, or genuinely sustainable stay on the list.
        </p>

        {categories.map((c, i) => (
          <HighlightRow
            key={c.tag}
            title={CATEGORY_LABELS[c.tag] ?? c.label}
            more="See all"
            items={highlightsFor(i)}
          />
        ))}

        <hr className="g-divider" />

        <DirectoryFilter categories={categories} budgets={budgets} />

        <p className="g-count">
          Showing all {ENTRIES.length} places &middot; {tagged} carry a category tag
        </p>

        <div className="g-grid">
          {ENTRIES.map((entry) => (
            <EntryCard key={entry.href || entry.name} entry={entry} />
          ))}
        </div>
      </div>
    </div>
  );
}
