import Link from "next/link";

import {
  DIMENSION_LABELS,
  assessTripHealth,
  recoveryMoves,
} from "@/features/health";
import { weatherReport } from "@/features/weather";
import { discover } from "@/features/discovery/replanner";

import { Card } from "@/components/ui/Card";
import { SiteHeader } from "../_components/SiteHeader";
import { computeFeatureSession, paramsFromContext } from "../_lib/discovery";

export const dynamic = "force-dynamic";

/**
 * How hard is this plan, and what would make it easier.
 *
 * Two orphaned features on one page, because they answer the same question from
 * two directions and splitting them would make the traveller do the joining:
 *
 *   `features/health` (1,828 lines) scores the plan on eight dimensions and
 *   proposes recovery moves, each one MEASURED by re-running the read rather
 *   than asserted. `features/weather` (2,136 lines) writes the justification
 *   for every exposed stop and the `weatherRisk` factor, read back off the
 *   finished plan.
 *
 * Neither had a caller. `assessTripHealth` needs a `Plan` and a catalogue,
 * which is exactly what one planner run produces, so this page is also the
 * cheapest honest proof that the `EnginePort` wiring works.
 */
export default async function HealthPage({
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

  const outcome = discover(engine, session);
  if (!outcome.ok) {
    return (
      <>
        <SiteHeader />
        <main id="main" className="mx-auto max-w-[70rem] px-4 py-6">
          <Card>
            <h1 className="font-display text-2xl text-ink">No plan to assess</h1>
            <p className="mt-2 text-sm text-ink-muted">{outcome.reason}</p>
          </Card>
        </main>
      </>
    );
  }

  const plan = outcome.plan;
  const ctx = outcome.session.state.ctx;
  const health = assessTripHealth(plan, ctx, catalogue);
  const moves = recoveryMoves(plan, ctx, catalogue);
  // `WeatherEnv.catalogue` is a Map, not an array. Passing the array is the
  // kind of near-miss that typechecks on a looser type and 500s on a stricter one.
  const byId = new Map(catalogue.map((row) => [row.id, row]));
  const weather = weatherReport(plan, ctx, { catalogue: byId, month: new Date().getMonth() + 1 });

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-[70rem] px-4 py-6">
        <header className="mb-5">
          <p className="text-caps text-ink-muted">Trip health</p>
          <h1 className="mt-1 font-display text-3xl text-ink">
            How hard is this, honestly
          </h1>
          <p className="mt-2 max-w-[70ch] text-sm text-ink-muted">
            Seven weighted dimensions, scored from the plan you actually have.
            Anything the catalogue cannot answer is reported as unmeasured rather
            than guessed.
          </p>
        </header>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="text-caps text-ink-muted">The read</h2>
            <p className="mt-1 font-display text-2xl text-ink">
              {health.labelSentence}
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              Score {health.score} of 100, worst factor: {health.worst.label} at{" "}
              {health.worst.value}.
            </p>

            {health.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1 text-sm text-alarm">
                {health.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            {health.unmeasured.length > 0 ? (
              <div className="mt-3">
                <h3 className="text-caps text-ink-muted">Not measured</h3>
                <ul className="mt-1 space-y-1 text-sm text-ink-muted">
                  {health.unmeasured.map((entry) => (
                    <li key={entry.dimension}>
                      {DIMENSION_LABELS[entry.dimension]} — {entry.why}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-ink-muted">
                  Coverage {Math.round(health.coverage * 100)}% of the weighted
                  dimensions.
                </p>
              </div>
            ) : null}

            <dl className="mt-4 space-y-2">
              {health.dimensions.map((dimension) => (
                <div key={dimension.dimension} className="text-sm">
                  <dt className="flex items-baseline justify-between">
                    <span className="text-ink">{dimension.label}</span>
                    <span className="text-ink-muted">
                      {dimension.value} · {dimension.band}
                    </span>
                  </dt>
                  <dd className="text-xs text-ink-muted">{dimension.explanation}</dd>
                  {dimension.rescue ? (
                    <dd className="text-xs text-fit">{dimension.rescue}</dd>
                  ) : null}
                </div>
              ))}
            </dl>
          </Card>

          <div className="space-y-4">
            <Card>
              <h2 className="text-caps text-ink-muted">Weather, per stop</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Exposure risk {weather.risk} of 100
                {weather.rescue ? `. ${weather.rescue}` : "."}
              </p>
              {weather.dropped.length > 0 ? (
                <p className="mt-1 text-sm text-ink-muted">
                  The weather removed {weather.dropped.length} option
                  {weather.dropped.length === 1 ? "" : "s"}:{" "}
                  {weather.dropped.map((entry) => entry.reason).join("; ")}
                </p>
              ) : null}
              {weather.stops.length > 0 ? (
                <ul className="mt-3 space-y-2 text-sm">
                  {weather.stops.map((stop) => (
                    <li key={stop.stopId}>
                      <span className="text-ink">{stop.name}</span>{" "}
                      <span className="text-ink-muted">{stop.note}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>

            <Card>
              <h2 className="text-caps text-ink-muted">What would make it easier</h2>
              {moves.length === 0 ? (
                <p className="mt-2 text-sm text-ink-muted">
                  Nothing to change. The plan is not straining on any dimension we
                  can measure.
                </p>
              ) : (
                <ul className="mt-3 space-y-3 text-sm">
                  {moves.slice(0, 6).map((move) => (
                    <li key={move.id}>
                      <p className="text-ink">{move.instruction}</p>
                      <p className="text-xs text-ink-muted">
                        Aimed at {DIMENSION_LABELS[move.targets]}; measured change{" "}
                        {Math.round(move.gain)}.
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        <p className="mt-6 text-xs text-ink-muted">
          <Link href={`/?${query}`} className="underline">
            Back to your plan
          </Link>
        </p>
      </main>
    </>
  );
}
