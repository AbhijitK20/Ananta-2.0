import Link from "next/link";

import { DEFAULT_PROFILE } from "@/engine/scoring";
import { computeDiscovery, paramsFromContext } from "../_lib/discovery";
import { TunePanel } from "../_components/TunePanel";

export const dynamic = "force-dynamic";

/**
 * Everything that changes the answer, in one place.
 *
 * The situation editor, the accessibility needs, the "what would have to be true"
 * triggers and the learned weights used to occupy three columns of the home page
 * alongside the map and the results. They are all inputs, so they live together
 * and the home page keeps the map and the list.
 */
export default async function TunePage({
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
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-medium text-ink">Change what you are looking for</h1>
        <Link href={`/?${query}`} className="shrink-0 text-sm text-ink-muted hover:text-ink">
          Back to the map
        </Link>
      </div>
      <TunePanel
        initialContext={discovery.context}
        query={query}
        rejections={discovery.rejections}
        profile={{
          weights: DEFAULT_PROFILE.weights,
          source: "prior",
          observations: 0,
          version: DEFAULT_PROFILE.version,
        }}
      />
    </div>
  );
}
