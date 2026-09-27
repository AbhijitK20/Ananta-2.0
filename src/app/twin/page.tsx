/**
 * `/twin` — the Weather-Driven Digital Twin.
 *
 * An enhancement to the existing solution, on a route beside it. Nothing the planner
 * already does is re-implemented here; the page reads the real catalogue, runs the
 * real `planItinerary()` twice — once for the baseline, once for the simulated
 * weather — and shows the difference. The twin's job is to change the planner's
 * *inputs* and let the planner do the rest.
 *
 * ## Reading order, and why
 *
 * The page is ordered by the order the reader has to trust things in:
 *
 *  1. **Provenance.** What the sky is, where it came from, which model classified it,
 *     and how many reports are behind it. Above everything, because a simulation
 *     whose inputs are invisible is indistinguishable from a guess.
 *  2. **The consequence.** The plan diff, in one sentence, then the stops.
 *  3. **The map.** Where it happened, over the existing MapLibre canvas.
 *  4. **The cascade.** Direct → access → reroute → workforce, as four sentences.
 *  5. **The controls.** So the next question is one drag away.
 *
 * Provenance first is a deliberate choice against the more attractive layout, which
 * would lead with the map. The map is the picture; the provenance is the claim.
 * `docs/FEATURES.md` §125 already established that a simulated forecast must never be
 * silently presented as a live one, and this page is that rule applied to a whole
 * simulation layer.
 *
 * ## Live versus simulated
 *
 * `?live=1` reads Open-Meteo instead of the URL. The default is the URL, because a
 * what-if slider that gets overwritten by an API response is a slider that does
 * nothing, and because a shareable scenario is worth more than a live reading nobody
 * can reproduce. Both paths are labelled in the header.
 */
import { Suspense } from "react";
import type { Metadata } from "next";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteHeader } from "@/app/_components/SiteHeader";

import { TwinControls } from "@/app/_components/TwinControls";
import { TwinMap } from "@/app/_components/TwinMap";
import { computeTwin, mapCorridors, twinFoundation } from "@/app/_lib/twin";
import { CASCADE_ORDERS, type CascadeOrder, type HazardState } from "@/features/twin";

export const metadata: Metadata = {
  title: "Digital Twin — TravelBuddy",
  description:
    "A weather-driven digital twin of the Mumbai experience catalogue: direct and cascading effects, uncertainty, and what-if simulation over the real planner.",
};

export const dynamic = "force-dynamic";

export default async function TwinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }
  const live = params.get("live") === "1";
  return (
    <>
      <SiteHeader />
      <main className="mx-auto w-full max-w-[88rem] px-4 py-6 lg:px-8">
        <Suspense fallback={<TwinSkeleton />}>
          <TwinBody params={params} live={live} />
        </Suspense>
      </main>
    </>
  );
}

function TwinSkeleton() {
  return (
    <div className="space-y-4" aria-busy>
      <div className="h-8 w-64 rounded-sm bg-accent-soft" />
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="h-[32rem] rounded-md bg-accent-soft" />
        <div className="h-[32rem] rounded-md bg-accent-soft" />
      </div>
      <p className="text-meta text-ink-muted">Reading the catalogue and running the simulation.</p>
    </div>
  );
}

async function TwinBody({ params, live }: { params: URLSearchParams; live: boolean }) {
  const report = await computeTwin({ params, live });
  const { experiences } = await twinFoundation();
  const corridors = mapCorridors(report.twin, experiences);
  const centre = { lat: report.context.origin.point?.lat ?? 19.0596, lon: report.context.origin.point?.lon ?? 72.8295 };
  const focus = report.twin.cascades.flatMap((step) => step.highlights);
  const { twin, delta } = report;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-title text-ink">Weather-driven digital twin</h1>
          <Badge tone={report.observation.weatherSource === "live" ? "accent" : "neutral"}>
            {report.observation.weatherSource === "live" ? "Live weather" : "Simulated scenario"}
          </Badge>
          <Badge tone={twin.provenance.modelSource === "aligned" ? "accent" : "neutral"}>
            {twin.provenance.modelSource === "aligned" ? "Nugen aligned model" : "Deterministic classifier"}
          </Badge>
        </div>
        <p className="max-w-[60ch] text-body text-ink-muted">
          The same {report.mapTotal.toLocaleString()} experiences the planner already searches, under a
          weather scenario you choose. {delta.headline}
        </p>
      </header>

      <Provenance report={report} />

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-4">
          <TwinControls
            scenario={report.scenario}
            baseParams={params}
            headline={delta.headline}
            closedCount={report.closedCount}
            stretchedCount={report.stretchedCount}
          />
          <Hazards hazards={twin.hazards} />
        </div>

        <div className="space-y-4">
          <TwinMap
            nodes={report.mapNodes}
            corridors={corridors}
            planIds={report.planIds}
            centre={centre}
            focusIds={focus}
            className="h-[26rem] lg:h-[32rem]"
          />
          <PlanDeltaCard report={report} />
        </div>
      </div>

      <CascadeCard report={report} />

      <EntityList report={report} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Provenance
// ---------------------------------------------------------------------------

function Provenance({ report }: { report: Awaited<ReturnType<typeof computeTwin>> }) {
  const { twin, observation } = report;
  const provenance = twin.provenance;
  return (
    <Card>
      <h2 className="text-body text-ink">What this is based on</h2>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-meta sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Weather">
          {observation.weatherNote}
          {observation.weatherSource === "unknown" ? " — the scenario below is a default, not a forecast." : ""}
        </Fact>
        <Fact label="Hazard classification">
          {provenance.modelSource === "aligned" ? (
            <>
              Nugen aligned model <code className="text-ink">{provenance.model}</code>
            </>
          ) : (
            <>
              Deterministic classifier{provenance.note ? ` (${provenance.note})` : ""}
            </>
          )}
        </Fact>
        <Fact label="Social signals">
          {provenance.socialUsed} hazards corroborated from {provenance.socialObserved} reports
          {provenance.socialFailed.length > 0 ? `, ${provenance.socialFailed.join(", ")} unavailable` : ""}
        </Fact>
        <Fact label="Model">
          {provenance.modelVersion} · {provenance.observations} observations behind the cells
        </Fact>
      </dl>
      {provenance.modelSource !== "aligned" ? (
        <p className="mt-3 text-meta-sm text-ink-faint">
          Run <code>npm run nugen:align</code> to align a base model on this project&rsquo;s own corpus, then{" "}
          <code>npm run nugen:probe</code> to confirm the platform can serve it. The twin is fully functional
          without it — the deterministic classifier reads the same 331 signals.
        </p>
      ) : null}
    </Card>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-meta-sm text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-meta text-ink">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Hazards
// ---------------------------------------------------------------------------

const HAZARD_LABEL: Record<string, string> = {
  rain: "Rain",
  heat: "Heat",
  wind: "Wind",
  flood: "Flood",
  storm: "Storm",
};

function Hazards({ hazards }: { hazards: HazardState[] }) {
  const active = hazards.filter((hazard) => hazard.severity > 0);
  return (
    <Card>
      <h2 className="text-body text-ink">Hazards</h2>
      {active.length === 0 ? (
        <p className="mt-2 text-meta text-ink-muted">
          Nothing above threshold. Every channel is at 1.0 and the plan is identical to the baseline.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {active.map((hazard) => (
            <li key={hazard.kind} className="text-meta">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-ink">{HAZARD_LABEL[hazard.kind] ?? hazard.kind}</span>
                <span className="text-num text-ink-muted">
                  {hazard.severity.toFixed(1)} / 3 · {Math.round(hazard.confidence * 100)}% confident
                </span>
              </div>
              {/* A bar rather than a number alone: severity is an ordinal and a
                  reader should feel 2.4 differently from 1.1 without doing
                  arithmetic. */}
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-rule">
                <div
                  className="h-full rounded-full bg-alarm"
                  style={{ width: `${Math.min(100, (hazard.severity / 3) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-meta-sm text-ink-faint">
                {hazard.trigger}
                {hazard.physical !== hazard.severity
                  ? ` · physical ${hazard.physical.toFixed(1)} before the model corrected it`
                  : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. The plan diff
// ---------------------------------------------------------------------------

function PlanDeltaCard({ report }: { report: Awaited<ReturnType<typeof computeTwin>> }) {
  const { delta, simulated, baseline } = report;

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-body text-ink">What it did to the plan</h2>
        <p className="text-meta text-ink-muted">{delta.headline}</p>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-meta sm:grid-cols-4">
        <Metric label="Stops" from={`${baseline.plan.stops.length}`} to={`${simulated.plan.stops.length}`} />
        <Metric
          label="Time"
          from={`${delta.totalMin.from}m`}
          to={`${delta.totalMin.to}m`}
          emphasis={delta.totalMin.to !== delta.totalMin.from}
        />
        <Metric
          label="Distance"
          from={`${(delta.totalMetres.from / 1000).toFixed(1)}km`}
          to={`${(delta.totalMetres.to / 1000).toFixed(1)}km`}
          emphasis={delta.totalMetres.to !== delta.totalMetres.from}
        />
        <Metric
          label="Utilisation"
          from={`${Math.round(delta.utilisation.from * 100)}%`}
          to={`${Math.round(delta.utilisation.to * 100)}%`}
          emphasis
        />
      </dl>

      {delta.removed.length > 0 || delta.added.length > 0 ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {delta.removed.length > 0 ? (
            <div>
              <h3 className="text-meta-sm text-ink-faint">Lost ({delta.removed.length})</h3>
              <ul className="mt-1.5 space-y-2">
                {delta.removed.map((entry) => (
                  <li key={entry.id} className="text-meta">
                    <span className="text-ink line-through decoration-alarm">{entry.name}</span>
                    <span className="mt-0.5 block text-meta-sm text-ink-muted">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {delta.added.length > 0 ? (
            <div>
              <h3 className="text-meta-sm text-ink-faint">Gained ({delta.added.length})</h3>
              <ul className="mt-1.5 space-y-2">
                {delta.added.map((entry) => (
                  <li key={entry.id} className="text-meta">
                    <span className="text-ink">{entry.name}</span>
                    <span className="mt-0.5 block text-meta-sm text-ink-muted">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="mt-3 text-meta text-ink-muted">
          The same stops, in the same order. These conditions do not change what fits.
        </p>
      )}
    </Card>
  );
}

function Metric({ label, from, to, emphasis }: { label: string; from: string; to: string; emphasis?: boolean }) {
  return (
    <div>
      <dt className="text-meta-sm text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-num text-ink">
        {emphasis && from !== to ? (
          <>
            <span className="text-ink-faint line-through">{from}</span>{" "}
            <span className="text-alarm">{to}</span>
          </>
        ) : (
          to
        )}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. The cascade
// ---------------------------------------------------------------------------

const ORDER_COPY: Record<CascadeOrder, string> = {
  direct: "The weather acts on the entity itself. Read straight off the record's own fields.",
  access: "The route to it degraded. Nothing about the place changed, and the journey still does.",
  reroute: "Demand moved off what closed and onto what stayed open. Signed, not just lost.",
  workforce: "Staff cannot cross the water either, so a sheltered place trades at reduced capacity.",
};

function CascadeCard({ report }: { report: Awaited<ReturnType<typeof computeTwin>> }) {
  const { cascades, summary } = report.twin;
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-body text-ink">How the effect spread</h2>
        <p className="text-meta text-ink-muted">
          {summary.open} open · {summary.degraded} degraded · {summary.closed} shut of{" "}
          {summary.total.toLocaleString()}
        </p>
      </div>

      <ol className="mt-4 space-y-4">
        {CASCADE_ORDERS.map((order, index) => {
          const step = cascades.find((entry) => entry.order === order);
          return (
            <li key={order} className="grid gap-2 sm:grid-cols-[8rem_1fr]">
              <div>
                <p className="text-meta-sm text-ink-faint">Order {index + 1}</p>
                <p className="text-meta font-medium text-ink">{order}</p>
                <p className="mt-1 text-num text-ink-muted">
                  {step ? `${step.touched} touched` : "—"}
                </p>
              </div>
              <div>
                <p className="text-meta text-ink">{step?.summary ?? "Not reached."}</p>
                <p className="mt-1 text-meta-sm text-ink-faint">{ORDER_COPY[order]}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 border-t border-rule pt-3 text-meta text-ink-muted">
        Mean availability across the catalogue:{" "}
        <span className="text-num text-ink">
          {Math.round(summary.availability.point * 100)}%
        </span>{" "}
        with a 90% interval of{" "}
        <span className="text-num text-ink">
          {Math.round(summary.availability.low * 100)}–{Math.round(summary.availability.high * 100)}%
        </span>
        . The interval widens with cascade order and narrows with corroboration, which is why a
        third-order figure is never quoted to one decimal place of confidence.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 5. The accessible list
// ---------------------------------------------------------------------------

function EntityList({ report }: { report: Awaited<ReturnType<typeof computeTwin>> }) {
  const rows = report.mapNodes.filter((node) => node.severity > 0).slice(0, 25);
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          kind="no_data"
          title="Nothing in the catalogue registers any impact at these conditions"
          body="Every channel is at 1.0, so the plan is identical to the baseline. That is the honest result rather than a failure: raise the rainfall or the standing water to watch the propagation run."
        />
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="text-body text-ink">Most affected, in the list</h2>
      <p className="mt-1 text-meta text-ink-muted">
        The map is decorative for assistive tech. This is the same information, and it is the
        accessible path to it.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-meta">
          <caption className="sr-only">
            Entities most affected by the simulated weather, with availability, its 90% interval, and the
            cascade order that reached them.
          </caption>
          <thead>
            <tr className="border-b border-rule text-left text-meta-sm text-ink-faint">
              <th scope="col" className="py-1.5 pr-3 font-medium">Place</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Class</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Available</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Demand</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Journey</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">Reached at</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((node) => (
              <tr key={node.id} className="border-b border-rule/60 align-top">
                <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                  {node.name}
                  {node.inPlan ? <span className="ml-1.5 text-meta-sm text-accent">in plan</span> : null}
                </th>
                <td className="py-2 pr-3 text-ink-muted">{node.entityClass.replace(/_/g, " ")}</td>
                <td className="py-2 pr-3 text-num text-ink">
                  {Math.round(node.availability * 100)}%
                  <span className="ml-1 text-ink-faint">
                    ({Math.round(node.low * 100)}–{Math.round(node.high * 100)})
                  </span>
                </td>
                <td className="py-2 pr-3 text-num text-ink">
                  {node.demand >= 1.02 ? `+${Math.round((node.demand - 1) * 100)}%` : `${Math.round((node.demand - 1) * 100)}%`}
                </td>
                <td className="py-2 pr-3 text-num text-ink">
                  {node.movement > 1.02 ? `+${Math.round((node.movement - 1) * 100)}%` : "—"}
                </td>
                <td className="py-2 pr-3 text-ink-muted">{node.deepestOrder}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
