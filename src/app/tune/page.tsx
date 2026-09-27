import Link from "next/link";

import { DEFAULT_PROFILE } from "@/engine/scoring";
import { computeDiscovery, paramsFromContext, realityAfter } from "../_lib/discovery";
import { placeOptions } from "../_lib/place";
import { SwapDiff } from "../_components/SwapDiff";
import { TunePanel } from "../_components/TunePanel";

export const dynamic = "force-dynamic";

/**
 * Everything that changes the answer, in one place.
 *
 * The situation editor, the accessibility needs, the "what would have to be true"
 * triggers and the learned weights used to occupy three columns of the home page
 * alongside the map and the results. They are all inputs, so they live together
 * and the home page keeps the map and the list.
 *
 * This is also where the swap diff lives, and that is the whole reason the
 * triggers are on this page rather than on the home page: a replan the traveller
 * cannot see the consequences of is a silent rewrite, which is the one thing
 * principle 3 exists to prevent. The diff is computed on the server from the two
 * engine plans, so there is no client state to fall out of step with the plan.
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
  const reality = await realityAfter(params, discovery);
  // Cached per process, so this is a map lookup on every render after the first.
  const places = await placeOptions();
  // `was`, `intent` and `changed` ride along, so a link back to the map does not
  // resurrect a stop that just left or reset the frozen baseline.
  const query = paramsFromContext(discovery.context, params).toString();

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-medium text-ink">Change what you are looking for</h1>
        <Link href={`/?${query}`} className="shrink-0 text-sm text-ink-muted hover:text-ink">
          Back to the map
        </Link>
      </div>

      {reality ? <SwapDiff reality={reality} /> : null}

      <div className="mt-4">
        <TunePanel
          initialContext={discovery.context}
          query={query}
          firstStopId={discovery.plan.stops[0]?.experienceId ?? null}
          places={places}
          rejections={discovery.rejections}
          profile={{
            weights: DEFAULT_PROFILE.weights,
            source: "prior",
            observations: 0,
            version: DEFAULT_PROFILE.version,
          }}
        />
      </div>
    </div>
  );
}
