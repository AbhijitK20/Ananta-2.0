/** @jsxImportSource react */
/**
 * The provider analytics view. A pure renderer over `ProviderDashboard`.
 *
 * It computes nothing. Every number, bar, and badge comes from the dashboard
 * object, and every panel says which tier its number is, because a provider
 * reading "42 travellers wanted X" deserves to know whether 42 is a measurement
 * or a rule we wrote.
 *
 * The one piece of logic here is layout: how many panels fit, and which panels
 * are worth hiding on a narrow screen. Empty states are deliberate — an empty
 * dashboard with no explanation reads as a bug.
 */
import type { ReactNode } from "react";
import { formatCount, formatInr, formatMinutes, formatPercent } from "../format";
import type { DemandDimension, Opportunity, ProviderDashboard, ProviderSuggestion } from "../types";
import { DemandBars, DemandHeatGrid, MetricCard, OpportunityCard, Panel, SuggestionRow, TierBadge, TrendLine } from "./charts";

export interface ProviderDashboardViewProps {
  dashboard: ProviderDashboard;
  /** Wire these to the listing editor at the given field. */
  onOpportunity?: (opportunity: Opportunity) => void;
  onSuggestion?: (suggestion: ProviderSuggestion) => void;
}

export function ProviderDashboardView({
  dashboard,
  onOpportunity,
  onSuggestion,
}: ProviderDashboardViewProps): ReactNode {
  const { demand, opportunities, suggestions, dataset } = dashboard;
  const cards = metricCards(dashboard);

  return (
    <div style={{ display: "grid", gap: 12, fontFamily: "var(--font-ui, system-ui, sans-serif)" }}>
      <div>
        <h2 style={{ margin: 0, fontFamily: "var(--font-display, Georgia, serif)", fontSize: 24, fontWeight: 400 }}>
          {dashboard.provider.name}
        </h2>
        <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--ink-muted)" }}>
          {[...new Set(dashboard.listings.map((l) => l.neighbourhood))].sort().join(", ") || "No listings yet"}
          {" · "}
          {dashboard.listings.length} {dashboard.listings.length === 1 ? "listing" : "listings"}
          {dashboard.provider.verified ? " · verified" : ""}
        </p>
      </div>

      <DatasetBanner dashboard={dashboard} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: 8 }}>
        {cards.map((c) => (
          <MetricCard key={c.label} label={c.label} value={c.value} sub={c.sub} tone={c.tone} />
        ))}
      </div>

      <Panel
        title="Impressions and requests"
        subtitle={`Last ${demand.windowDays} days, ending ${dataset.asOf.slice(0, 10)}`}
        aside={<TierBadge tier="observed" title="counted from the event stream" />}
      >
        <TrendLine points={dashboard.trend} />
      </Panel>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Panel
          title="What travellers near you asked for"
          subtitle={`${demand.total} searches returned nothing, across ${demand.byLocality.bars.length} areas`}
        >
          <div style={{ display: "grid", gap: 14 }}>
            <Dim title="Category" dimension={demand.byCategory} />
            <Dim title="Locality" dimension={demand.byLocality} />
            <Dim title="Time of day" dimension={demand.byTime} />
            <Dim title="Price band" dimension={demand.byPrice} />
          </div>
        </Panel>

        <Panel title="Where and when" subtitle="Unmet searches by area and time of day">
          {dashboard.heat.rows.length === 0 ? (
            <Empty>No unmet searches recorded near your listings yet.</Empty>
          ) : (
            <DemandHeatGrid rows={dashboard.heat.rows} columns={dashboard.heat.columns} cells={dashboard.heat.cells} />
          )}
        </Panel>
      </div>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Panel
          title="What blocked them"
          subtitle="The constraint that eliminated the most candidates"
        >
          <Dim title="Blocking constraint" dimension={demand.byConstraint} />
        </Panel>
        <Panel title="Constraints they named" subtitle="Access needs, party size, weather, window">
          <div style={{ display: "grid", gap: 14 }}>
            <Dim title="Access needs" dimension={demand.byAccessNeed} />
            <Dim title="Party size" dimension={demand.byPartySize} />
            <Dim title="Weather" dimension={demand.byWeather} />
            <Dim title="Time available" dimension={demand.byDuration} />
          </div>
        </Panel>
      </div>

      <Panel
        title="Opportunities"
        subtitle={`${opportunities.length} gaps you are close enough to fill`}
        aside={<TierBadge tier="observed" title="gaps with a well-sampled demand cell" />}
      >
        {opportunities.length === 0 ? (
          <Empty>
            Nothing actionable in this window. That is either good news or a sign nobody is searching near you yet.
          </Empty>
        ) : (
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
            {opportunities.map((o) => (
              <OpportunityCard key={o.id} opportunity={o} onAction={onOpportunity} />
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="Changes worth making"
        subtitle={`${suggestions.length} suggestions, each with a search count behind it`}
        aside={<TierBadge tier="suggested" title="proposals, never measurements" />}
      >
        {suggestions.length === 0 ? (
          <Empty>
            No suggestion clears the sample bar. We would rather show nothing than guess on your listing.
          </Empty>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {suggestions.map((s) => (
              <SuggestionRow
                key={s.id}
                action={s.action}
                cta={s.cta}
                tier={s.tier}
                sampleSize={s.sampleSize}
                onAction={onSuggestion === undefined ? undefined : () => onSuggestion(s)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <Panel title="Why you said no" subtitle="Decline reasons, as written by you">
          {dashboard.declineReasons.length === 0 ? (
            <Empty>No declines in this window.</Empty>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}>
              {dashboard.declineReasons.map((b) => (
                <li key={b.key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", gap: 12 }}>
                  <span>{b.label}</span>
                  <span style={{ fontFamily: "var(--font-data, monospace)" }}>{b.value}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Your listings" subtitle="What travellers saw, per listing">
          <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}>
            {dashboard.listings.map((l) => (
              <li key={l.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--rule)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span>{l.name}</span>
                  <span style={{ fontFamily: "var(--font-data, monospace)", color: "var(--ink-muted)" }}>
                    {l.impressions} / {l.fitViews} / {l.requests}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-faint)" }}>
                  {formatMinutes(l.durationMin)}, {formatInr(l.priceMinor)}, {l.indoorOutdoor}
                  {l.kidFriendly === null ? ", kid-friendly unknown" : l.kidFriendly ? ", kid-friendly" : ""}
                  {l.unconfirmedAccess.length > 0 ? `, ${l.unconfirmedAccess.length} access fields unconfirmed` : ""}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function Dim({ title, dimension }: { title: string; dimension: DemandDimension }): ReactNode {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.04em", color: "var(--ink-muted)" }}>{title}</span>
        <span style={{ fontSize: 11, color: "var(--ink-faint)", fontFamily: "var(--font-data, monospace)" }}>
          {dimension.reliable ? `n=${dimension.n}` : `n=${dimension.n}, thin`}
        </span>
      </div>
      <DemandBars dimension={dimension} />
    </div>
  );
}

function DatasetBanner({ dashboard }: { dashboard: ProviderDashboard }): ReactNode {
  return (
    <div
      style={{
        border: `1px solid ${dashboard.dataset.source === "demo" ? "var(--warn)" : "var(--rule)"}`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 12,
        color: "var(--ink-muted)",
      }}
    >
      <strong style={{ color: "var(--ink)" }}>
        {dashboard.dataset.source === "demo" ? "Demo data" : "Live data"}: {dashboard.dataset.label}
      </strong>
      {dashboard.notes.map((note) => (
        <div key={note}>{note}</div>
      ))}
    </div>
  );
}

function metricCards(dashboard: ProviderDashboard): {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "alarm" | "fit";
}[] {
  const m = dashboard.metrics;
  return [
    { label: "Impressions", value: String(m.impressions), sub: `${formatCount(m.fitViews, "fit-view")}` },
    {
      label: "Requests",
      value: String(m.requests),
      sub: m.requestRate === null ? "no impressions" : `${formatPercent(m.requestRate)} of impressions`,
    },
    {
      label: "Confirmed",
      value: String(m.confirmed),
      sub: `${m.declined} declined`,
      tone: m.confirmed > 0 ? "fit" : "default",
    },
    {
      label: "Acceptance rate",
      value: formatPercent(m.acceptanceRate),
      sub: m.acceptanceRate === null ? "no requests yet" : "confirmed over requests",
    },
    { label: "Unmet demand", value: String(m.unmetNearby), sub: "searches near you" },
    { label: "Opportunities", value: String(m.opportunityCount), sub: `${m.suggestionCount} suggestions` },
  ];
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <p style={{ margin: 0, fontSize: 12, color: "var(--ink-muted)", lineHeight: 1.5 }}>{children}</p>
  );
}
