import Link from "next/link";

import { computeDiscovery, paramsFromContext } from "../_lib/discovery";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { WhyLedger } from "@/components/fit";
import type { PlanStop } from "@/contracts";

export const dynamic = "force-dynamic";

/**
 * Why this place, and why not the others.
 *
 * This was an overlay on the old home page, reached from a "Why this, and why
 * not the others" button on every card. Splitting the screen across routes meant
 * it needed somewhere to live, and leaving the button pointing at a route that
 * did not exist would have been worse than removing it — a 404 from a trust
 * feature is exactly the wrong signal.
 *
 * Everything it renders was already computed for the request: the score for
 * this row, the plan stop's ranked sentences, and the rejections with their
 * place names. Nothing is recomputed here.
 */
export default async function WhyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }
  const id = typeof raw.id === "string" ? raw.id : null;

  const discovery = await computeDiscovery(params);
  const query = paramsFromContext(discovery.context).toString();
  const experience = id ? discovery.experiences.find((item) => item.id === id) : undefined;

  if (!id || !experience) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-6">
        <EmptyState
          kind="no_data"
          title="That place is not in the results any more."
          body="It may have been ruled out for this trip, or the link may be old."
          actions={
            <Link href={`/?${query}`} className="text-sm text-ink hover:text-accent">
              Back to the map
            </Link>
          }
        />
      </div>
    );
  }

  const stop = discovery.plan.stops.find((item) => item.experienceId === id);
  const rejection = discovery.rejections.find((item) => item.experienceId === id);
  const rejectionNames: Record<string, string> = {};
  for (const item of discovery.rejections) {
    const name = discovery.experiences.find((e) => e.id === item.experienceId)?.name;
    if (name) rejectionNames[item.experienceId] = name;
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-medium text-ink">{experience.name}</h1>
          <p className="text-sm text-ink-muted">
            {discovery.fits[id]?.verdict === "does_not_fit"
              ? "Ruled out for this trip"
              : stop
                ? "In your plan"
                : "A candidate"}
          </p>
        </div>
        <Link href={`/?${query}`} className="shrink-0 text-sm text-ink-muted hover:text-ink">
          Back to the map
        </Link>
      </div>

      <Card>
        <WhyLedger
          score={discovery.scores[id]}
          why={stop?.why as PlanStop["why"] | undefined}
          rejections={rejection ? [rejection] : []}
          rejectionNames={rejectionNames}
        />
      </Card>
    </div>
  );
}
