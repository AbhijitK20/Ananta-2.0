import Link from "next/link";

import { computeDiscovery, paramsFromContext } from "./_lib/discovery";
import { ContextBar } from "./_components/ContextBar";
import { ResultsSurface } from "./_components/ResultsSurface";

/**
 * The home page is a map and a list.
 *
 * The situation the traveller described lives in the URL, so every route can
 * render from the same computation without a client-side provider to keep in
 * sync. See `_lib/discovery.ts` for why the URL holds it.
 *
 * Always dynamic: the catalogue is read from disk and the plan is computed per
 * request. There is nothing here worth caching across a catalogue change, and a
 * static page would freeze the plan at build time, which is the one thing this
 * product must never do.
 */
export const dynamic = "force-dynamic";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const discovery = await computeDiscovery(params);
  const query = paramsFromContext(discovery.context).toString();

  return (
    <div className="flex min-h-dvh flex-col">
      <ContextBar
        context={discovery.context}
        query={query}
        stopCount={discovery.plan.stops.length}
        rowCount={discovery.rowCount}
        originNote={discovery.originNote}
      />
      <ResultsSurface
        context={discovery.context}
        experiences={discovery.experiences}
        fits={discovery.fits}
        scores={discovery.scores}
        rejections={discovery.rejections}
        plan={discovery.plan}
        query={query}
      />
      {/*
        One line, at the bottom, for the two surfaces a traveller is not on.
        They used to be top-level nav next to the brand, which put "what
        travellers could not find" beside "find me a restaurant" — two different
        audiences sharing a header. Discover, plan and tune are the traveller's
        and they are already reachable from the bar above; these are the
        operator's, so they live down here where they do not compete.
      */}
      <footer className="border-t border-rule px-4 py-3">
        <nav aria-label="Other surfaces" className="mx-auto flex max-w-[100rem] gap-4 text-xs text-ink-muted">
          <Link href={`/plan?${query}`} className="hover:text-ink">
            Plan
          </Link>
          <Link href={`/tune?${query}`} className="hover:text-ink">
            Change what you want
          </Link>
          <Link href="/provider" className="hover:text-ink">
            List a place
          </Link>
          <Link href="/analytics" className="hover:text-ink">
            Demand
          </Link>
        </nav>
      </footer>
    </div>
  );
}
