import Link from "next/link";

import { computeDiscovery, paramsFromContext } from "../_lib/discovery";
import { Card } from "@/components/ui/Card";
import { PlanTimelineLink } from "../_components/PlanTimelineLink";

export const dynamic = "force-dynamic";

/**
 * The plan, on its own page.
 *
 * It used to sit under the results list on a screen that also held a situation
 * editor, a map, and four tuning panels. It is a summary of a computation, so it
 * reads better as the destination of "Your plan" than as another block on a
 * screen where everything competes.
 */
export default async function PlanPage({
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
  const experienceById = new Map(discovery.experiences.map((item) => [item.id, item]));

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-medium text-ink">Your plan</h1>
        <Link href={`/?${query}`} className="text-sm text-ink-muted hover:text-ink">
          Back to the map
        </Link>
      </div>

      <Card>
        {discovery.plan.stops.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing fits in the time you have from {discovery.context.origin.label}. Widen the
            window or loosen a need and the plan will fill in.
          </p>
        ) : (
          <PlanTimelineLink
            plan={discovery.plan}
            experiences={experienceById}
            query={query}
          />
        )}
      </Card>

      <p className="mt-4 text-xs text-ink-muted">
        {discovery.counts.retrieved.toLocaleString("en-IN")} places considered ·{" "}
        {discovery.counts.passed.toLocaleString("en-IN")} fit ·{" "}
        {discovery.counts.rejected.toLocaleString("en-IN")} ruled out with a reason
      </p>
    </div>
  );
}
