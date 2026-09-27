import Link from "next/link";

import { planForGroup, type GroupMember } from "@/features/group";
import { DEFAULT_PROFILE } from "@/engine";

import { Card } from "@/components/ui/Card";
import { SiteHeader } from "../_components/SiteHeader";
import {
  DEFAULT_ORIGIN,
  contextFromParams,
  paramsFromContext,
} from "../_lib/discovery";
import { loadCatalogue } from "../_lib/catalogue";
import { realEngine } from "@/features/discovery/real-engine";

export const dynamic = "force-dynamic";

/**
 * Several travellers, one plan.
 *
 * `src/features/group` is 1,555 lines whose whole premise is that a group is not
 * a headcount: a child lowers the walking budget, an older adult forces step-free
 * access, a jain and a vegetarian union rather than average, and none of those
 * are outvotable. It had no route, so the tension it resolves was never shown to
 * anyone.
 *
 * The demo party is fixed and stated on the page. It is not pretending to be the
 * traveller's group — it is a worked example of the thing the feature does, and
 * the URL cannot carry per-member interests without turning every link into a
 * form post.
 */
const DEMO_PARTY: readonly GroupMember[] = [
  { id: "a", label: "Ashwin", role: "adult" },
  { id: "b", label: "Bela", role: "adult" },
  { id: "c", label: "Chia", role: "child", age: 4 },
  { id: "d", label: "Dilip", role: "elder" },
];

export default async function GroupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const ctx = contextFromParams(params);
  const query = paramsFromContext(ctx);
  const { experiences } = await loadCatalogue();
  const engine = realEngine();

  const group = planForGroup({
    engine,
    request: {
      id: "group-demo",
      origin: { label: DEFAULT_ORIGIN.label, point: { ...DEFAULT_ORIGIN.point } },
      availableMin: ctx.availableMin,
      nowMin: ctx.nowMin,
      budgetMinor: ctx.budget?.minor ?? null,
      weather: { ...ctx.weather },
    },
    members: DEMO_PARTY,
    catalogue: experiences,
    weights: DEFAULT_PROFILE,
  });

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-[70rem] px-4 py-6">
        <header className="mb-5">
          <p className="text-caps text-ink-muted">Group</p>
          <h1 className="mt-1 font-display text-3xl text-ink">
            Four people who do not want the same thing
          </h1>
          <p className="mt-2 max-w-[70ch] text-sm text-ink-muted">
            A four-year-old and a parent who cannot manage stairs are not a party
            size. The group layer decides what this set can collectively commit to,
            and reports what that cost.
          </p>
        </header>

        <Card className="mb-4">
          <h2 className="text-caps text-ink-muted">The party</h2>
          <ul className="mt-2 flex flex-wrap gap-2 text-sm">
            {DEMO_PARTY.map((member) => (
              <li
                key={member.id}
                className="rounded-pill border border-rule px-3 py-1 text-ink"
              >
                {member.label}
                {member.role === "child" && member.age !== undefined
                  ? `, ${member.age}`
                  : member.role === "elder"
                    ? ", needs step-free"
                    : ""}
              </li>
            ))}
          </ul>
        </Card>

        {group.ok ? (
          <>
            <Card className="mb-4">
              <h2 className="text-caps text-ink-muted">What the group agreed on</h2>
              <dl className="mt-2 space-y-1.5 text-sm">
                {group.aggregate.decisions.map((decision) => (
                  <div key={decision.axis} className="flex gap-2">
                    <dt className="w-28 shrink-0 text-ink-muted">{decision.axis}</dt>
                    <dd className="text-ink">
                      {decision.value}{" "}
                      <span className="text-ink-muted">
                        ({decision.strength === "shared"
                          ? "nobody had to ask"
                          : `asked for by ${decision.by.join(", ")}`})
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card className="mb-4">
              <h2 className="text-caps text-ink-muted">The plan</h2>
              <p className="mt-1 text-sm text-ink-muted">
                {group.outcome.plan.stops.length} stops,{" "}
                {Math.round(group.outcome.plan.totalMin)} minutes.
              </p>
              <ol className="mt-3 space-y-1.5 text-sm">
                {group.outcome.plan.stops.map((stop) => (
                  <li key={stop.experienceId} className="text-ink">
                    {stop.experienceId}
                    {stop.why.length > 0 ? (
                      <span className="text-ink-muted"> — {stop.why[0]}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </Card>

            {group.conflicts.length > 0 ? (
              <Card>
                <h2 className="text-caps text-ink-muted">What that cost</h2>
                <ul className="mt-2 space-y-2 text-sm">
                  {group.conflicts.map((conflict) => (
                    <li key={conflict.axis}>
                      <span className="text-ink">{conflict.reason}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <Card>
                <h2 className="text-caps text-ink-muted">What that cost</h2>
                <p className="mt-2 text-sm text-ink-muted">
                  Nothing. This group happened to agree.
                </p>
              </Card>
            )}
          </>
        ) : (
          <Card>
            <h2 className="text-caps text-ink-muted">No plan for this group</h2>
            <p className="mt-2 text-sm text-ink">{group.reason}</p>
            {group.ask.length > 0 ? (
              <div className="mt-3">
                <h3 className="text-caps text-ink-muted">What would unblock it</h3>
                <ul className="mt-1 space-y-1 text-sm text-ink-muted">
                  {group.ask.map((ask) => (
                    <li key={ask.sentence}>{ask.sentence}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {group.conflicts.length > 0 ? (
              <ul className="mt-3 space-y-2 text-sm">
                {group.conflicts.map((conflict) => (
                  <li key={conflict.axis} className="text-ink">
                    {conflict.reason}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        )}

        <p className="mt-6 text-xs text-ink-muted">
          <Link href={`/?${query}`} className="underline">
            Back to your plan
          </Link>
        </p>
      </main>
    </>
  );
}
