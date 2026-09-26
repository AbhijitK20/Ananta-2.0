import Link from "next/link";

import {
  SCENARIO_PRESETS,
  ladder,
  present,
  simulate,
  type LadderAxis,
  type WhatIfPanel,
} from "@/features/whatif";
import { discover } from "@/features/discovery/replanner";

import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteHeader } from "../_components/SiteHeader";
import { computeFeatureSession, paramsFromContext } from "../_lib/discovery";

export const dynamic = "force-dynamic";

/**
 * What if: the counterfactual, run through the real planner.
 *
 * This route exists because `src/features/whatif` — 1,752 lines with its own
 * tests — had no caller. Every one of its scenarios is a real re-solve rather
 * than a narrated one, which is why this page is slow to first paint and honest
 * about it: six scenarios is six planner runs over the 4,596-row catalogue.
 *
 * The maths is the feature's, not this file's. `present()` resolves every string
 * and every delta, so the component below renders numbers and computes none, and
 * `hypothetical: true` travels with the panel because a what-if is not bookable
 * and the type says so.
 */
export default async function WhatIfPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const { session, engine, catalogue } = await computeFeatureSession(params);
  const query = paramsFromContext(session.state.ctx);

  // `simulate` compares against `session.plan`, so the live trip has to exist
  // first. This is the one planner run the page cannot avoid.
  const first = discover(engine, session);
  if (!first.ok) {
    return (
      <>
        <SiteHeader />
        <main id="main" className="mx-auto max-w-[70rem] px-4 py-6">
          <EmptyState
            kind="constraints"
            title="No plan to compare against"
            body={first.reason}
          />
        </main>
      </>
    );
  }

  const live = first.session;
  const wanted = typeof raw.s === "string" ? raw.s : null;
  const panels: { id: string; question: string; panel: WhatIfPanel | null; reason: string | null }[] =
    [];

  for (const preset of SCENARIO_PRESETS) {
    // Only the selected scenario is simulated, plus the one in the URL. Six
    // planner runs on every request would be six times the latency to show
    // something the traveller did not ask about.
    if (wanted !== null && preset.id !== wanted) continue;

    const outcome = simulate(engine, live, preset.edits);
    panels.push({
      id: preset.id,
      question: preset.question,
      panel: outcome.ok ? present(outcome.scenario, preset.question) : null,
      reason: outcome.ok ? null : outcome.reason,
    });
  }

  // The ladder is the question a single scenario cannot answer: "is more worth
  // it", not "what would this do". Budget rungs in rupees, from the current
  // budget upward, which is the direction that could plausibly help.
  const budgetNow = live.state.ctx.budget?.minor ?? 0;
  const rungs = [0, 50_000, 100_000, 150_000, 200_000, 300_000]
    .map((minor) => budgetNow + minor)
    .filter((minor, index, all) => all.indexOf(minor) === index);

  const budgetLadder = ladder(engine, live, "budget" as LadderAxis, rungs);

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-[70rem] px-4 py-6">
        <header className="mb-5">
          <p className="text-caps text-ink-muted">What if</p>
          <h1 className="mt-1 font-display text-3xl text-ink">
            Ask the planner a different question
          </h1>
          <p className="mt-2 max-w-[70ch] text-sm text-ink-muted">
            Every answer below is a real plan the real planner built for a changed
            situation, not a sentence describing one. None of it is bookable.
          </p>
        </header>

        {/* The situation as the planner sees it, and the entry point for each. */}
        <Card className="mb-5">
          <h2 className="text-caps text-ink-muted">Pick a different situation</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Current plan: {live.plan?.stops.length ?? 0} stops,{" "}
            {Math.round((live.plan?.totalMin ?? 0) / 60 * 10) / 10} hours.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {SCENARIO_PRESETS.map((preset) => (
              <li key={preset.id}>
                <Link
                  href={`/what-if?s=${preset.id}&${query}`}
                  className="inline-block rounded-pill border border-rule px-3 py-1.5 text-sm text-ink hover:border-ink"
                >
                  {preset.label}
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {panels.length === 0 ? (
          <EmptyState
            kind="area"
            title="Pick one above"
            body="Each one re-solves the whole plan against a changed situation."
          />
        ) : null}

        {panels.map(({ id, question, panel, reason }) => (
          <section key={id} className="mb-5" aria-label={question}>
            <Card>
              <h2 className="font-display text-xl text-ink">{question}</h2>

              {reason ? (
                <p className="mt-2 text-sm text-ink-muted">{reason}</p>
              ) : panel ? (
                <>
                  <p className="mt-2 text-sm text-ink-muted">{panel.headline}</p>

                  <dl className="mt-4 grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {panel.rows.map((row) => (
                      <div
                        key={row.id}
                        className="flex items-baseline justify-between border-b border-rule py-1.5 text-sm"
                      >
                        <dt className="text-ink-muted">{row.label}</dt>
                        <dd className="text-ink">
                          {row.after}
                          {row.delta ? (
                            <span
                              className={
                                row.direction === "flat"
                                  ? "ml-2 text-ink-muted"
                                  : row.higherIsBetter === (row.direction === "up")
                                    ? "ml-2 text-fit"
                                    : "ml-2 text-alarm"
                              }
                            >
                              {row.delta}
                            </span>
                          ) : null}
                        </dd>
                      </div>
                    ))}
                  </dl>

                  {panel.added.length > 0 ? (
                    <div className="mt-4">
                      <h3 className="text-caps text-ink-muted">Newly possible</h3>
                      <ul className="mt-1 space-y-1 text-sm">
                        {panel.added.map((stop) => (
                          <li key={stop.id} className="text-ink">
                            {stop.name}
                            {stop.reason ? (
                              <span className="text-ink-muted"> — {stop.reason}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {panel.removed.length > 0 ? (
                    <div className="mt-3">
                      <h3 className="text-caps text-ink-muted">No longer fits</h3>
                      <ul className="mt-1 space-y-1 text-sm">
                        {panel.removed.map((stop) => (
                          <li key={stop.id} className="text-ink-muted">
                            {stop.name}
                            {stop.reason ? <span> — {stop.reason}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {panel.unlocked.length > 0 ? (
                    <div className="mt-3">
                      <h3 className="text-caps text-ink-muted">
                        Blocked before, possible now
                      </h3>
                      <ul className="mt-1 space-y-1 text-sm">
                        {panel.unlocked.map((stop) => (
                          <li key={stop.id} className="text-fit">
                            {stop.name}
                            {stop.reason ? (
                              <span className="text-ink-muted"> — {stop.reason}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {panel.breaches.length > 0 ? (
                    <div className="mt-3">
                      <h3 className="text-caps text-ink-muted">What that would break</h3>
                      <ul className="mt-1 space-y-1 text-sm text-alarm">
                        {panel.breaches.map((breach) => (
                          <li key={breach.axis}>
                            {breach.axis}: {breach.message}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {panel.findings.length > 0 ? (
                    <ul className="mt-3 space-y-1 text-sm text-ink-muted">
                      {panel.findings.map((finding) => (
                        <li key={finding}>{finding}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </Card>
          </section>
        ))}

        {/* The ladder: the question one scenario cannot answer. */}
        {budgetLadder.rungs.length > 0 ? (
          <Card>
            <h2 className="font-display text-xl text-ink">Is more worth it?</h2>
            <p className="mt-1 text-sm text-ink-muted">
              One axis, several rungs, and the point where it stops paying.{" "}
              {budgetLadder.plannerCalls} planner run{budgetLadder.plannerCalls === 1 ? "" : "s"}.
            </p>

            <table className="mt-4 w-full text-sm">
              <caption className="sr-only">Plan quality at each budget</caption>
              <thead>
                <tr className="border-b border-rule text-left text-ink-muted">
                  <th scope="col" className="py-1.5 font-normal">Budget</th>
                  <th scope="col" className="py-1.5 font-normal">Stops</th>
                  <th scope="col" className="py-1.5 font-normal">Time used</th>
                  <th scope="col" className="py-1.5 font-normal">What it bought</th>
                </tr>
              </thead>
              <tbody>
                {budgetLadder.rungs.map((rung) => (
                  <tr key={rung.value} className="border-b border-rule">
                    <th scope="row" className="py-1.5 text-left font-normal text-ink">
                      {rung.label}
                      {rung.isCurrent ? (
                        <span className="ml-2 text-ink-muted">(now)</span>
                      ) : null}
                    </th>
                    <td className="py-1.5 text-ink">{rung.plan?.stops.length ?? "—"}</td>
                    <td className="py-1.5 text-ink">
                      {rung.plan ? Math.round(rung.plan.totalMin) : "—"}
                    </td>
                    <td className="py-1.5 text-ink-muted">{rung.reason ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {budgetLadder.saturatesAt !== null ? (
              <p className="mt-3 text-sm text-ink">
                You have enough at {budgetLadder.rungs.find((r) => r.value === budgetLadder.saturatesAt)?.label ?? ""}.
                Spending past that changes nothing in this plan.
              </p>
            ) : null}
          </Card>
        ) : null}

        <p className="mt-6 text-xs text-ink-muted">
          Catalogue: {catalogue.length.toLocaleString("en-IN")} places.{" "}
          <Link href={`/?${query}`} className="underline">
            Back to your plan
          </Link>
        </p>
      </main>
    </>
  );
}
