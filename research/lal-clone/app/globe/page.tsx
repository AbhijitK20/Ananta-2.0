import type { Metadata } from "next";

import { GlobeExplorer } from "../../components/GlobeExplorer";

export const metadata: Metadata = {
  title: "Around the world — 100 places",
  description:
    "A globe of 100 famous places, from the Taj Mahal to the Salar de Uyuni. Search by name, filter by region, and the planet turns to wherever you pick.",
};

/**
 * /globe — the globe on a page of its own.
 *
 * `?place=<slug>` seeds the selection so any card on the home filmstrip can deep
 * link straight to its pin. Unrecognised slugs are ignored rather than
 * erroring: the list still renders, which is the useful failure mode for a
 * link that may be stale.
 */
export default async function GlobePage({
  searchParams,
}: {
  searchParams: Promise<{ place?: string | string[] }>;
}) {
  const params = await searchParams;
  const raw = params.place;
  const initialSlug = Array.isArray(raw) ? raw[0] : raw;

  return (
    <div className="lal-globepage">
      <header className="lal-globepage__head">
        <h1>Around the world</h1>
        <p>
          100 famous places on one planet. Pick a pin, or search below — the
          globe turns to wherever you land.
        </p>
      </header>

      <GlobeExplorer initialSlug={initialSlug} />
    </div>
  );
}
