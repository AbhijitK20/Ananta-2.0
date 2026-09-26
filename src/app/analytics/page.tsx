import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  ProviderDashboardView,
  buildAllDashboards,
  resolveAnalyticsSource,
} from "@/features/analytics";

import { SiteHeader } from "../_components/SiteHeader";

export const metadata: Metadata = {
  title: "Provider analytics",
  description:
    "What travellers wanted near you and could not get, and what to do about it.",
};

/*
  The provider analytics surface. Also had no route: `buildDashboard` and
  `ProviderDashboardView` were built, tested and documented as "typical use from
  a page", but no page existed.

  Pure and synchronous. The analytics module is a pure function of an
  `AnalyticsSource` plus a fixed `asOf`, with no clock and no randomness, so this
  render is deterministic and does not need a loading state.
*/
export const dynamic = "force-static";

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  const source = resolveAnalyticsSource();

  // Which provider to show. Defaults to the first one in the source rather than
  // a hard-coded id, so a different dataset does not silently render nothing.
  const dashboards = buildAllDashboards(source);
  const selected =
    (provider ? dashboards.find((d) => d.provider.id === provider) : undefined) ??
    dashboards[0];

  if (!selected) notFound();

  const others = dashboards.filter((d) => d.provider.id !== selected.provider.id);

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-[90rem] px-4 py-6">
      <header className="mb-5">
        <p className="text-caps text-ink-muted">Provider analytics</p>
        <h1 className="mt-1 font-display text-3xl text-ink">
          What people wanted and could not find
        </h1>
        <p className="mt-2 max-w-[70ch] text-sm text-ink-muted">
          Every number here is a count of something a traveller actually did.
          A search that returned nothing is the most useful row we have, because
          it is a description of demand you could serve.
        </p>
      </header>

      {others.length > 0 && (
        <nav aria-label="Other providers" className="mb-4 flex flex-wrap gap-2">
          {others.map((d) => (
            <a
              key={d.provider.id}
              href={`/analytics?provider=${encodeURIComponent(d.provider.id)}`}
              className="rounded-pill border border-rule px-3 py-1 text-sm text-ink-muted hover:text-ink"
            >
              {d.provider.name}
            </a>
          ))}
        </nav>
      )}

        <ProviderDashboardView dashboard={selected} />
      </main>
    </>
  );
}
