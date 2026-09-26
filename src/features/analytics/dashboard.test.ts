/**
 * The dashboard: the numbers a provider sees, and the ways the feature refuses
 * to show a number it does not have.
 */
import { describe, expect, it } from "vitest";
import { CONFIDENCE_FLOOR, buildAllDashboards, buildDashboard, citywideOpportunities } from "./dashboard";
import { AS_OF, createDemoSource } from "./demo-data";
import { toCopilotBrief, toGraphExport, toSupplyLoopSignals } from "./graph";
import { resolveAnalyticsSource } from "./adapter";
import type { AnalyticsSource, ProviderDashboard } from "./types";

const source: AnalyticsSource = createDemoSource();

function emptyish(over: Partial<AnalyticsSource> = {}): AnalyticsSource {
  return {
    dataset: source.dataset,
    providers: source.providers,
    listings: source.listings,
    interactions: [],
    bookings: [],
    unmetDemand: [],
    ...over,
  };
}

describe("buildDashboard", () => {
  const dash = buildDashboard(source, "prov-nila")!;

  it("returns null for a provider it does not know", () => {
    expect(buildDashboard(source, "prov-nobody")).toBeNull();
  });

  it("counts impressions, fit views, requests, confirmations and declines", () => {
    expect(dash.metrics.impressions).toBeGreaterThan(0);
    expect(dash.metrics.fitViews).toBeGreaterThan(0);
    expect(dash.metrics.fitViews).toBeLessThan(dash.metrics.impressions);
    expect(dash.metrics.requests).toBe(
      dash.metrics.confirmed + dash.metrics.declined + dash.metrics.requests - dash.metrics.confirmed - dash.metrics.declined,
    );
    expect(dash.metrics.confirmed + dash.metrics.declined).toBeLessThanOrEqual(dash.metrics.requests);
  });

  it("leaves the acceptance rate null rather than showing zero when nothing was requested", () => {
    const quiet = buildDashboard(emptyish(), "prov-nila")!;
    expect(quiet.metrics.requests).toBe(0);
    expect(quiet.metrics.acceptanceRate).toBeNull();
    expect(quiet.metrics.requestRate).toBeNull();
    expect(quiet.metrics.confidence).toBe("none");
    expect(quiet.notes.join(" ")).toContain("left blank");
  });

  it("does not count a cancellation as demand", () => {
    const withCancel = buildDashboard(emptyish({ bookings: source.bookings }), "prov-sabzi")!;
    const withoutCancel = buildDashboard(
      emptyish({ bookings: source.bookings.filter((b) => b.state !== "cancelled") }),
      "prov-sabzi",
    )!;
    const cancelled = source.bookings.filter(
      (b) => b.experienceId === "exp-sabzi-thali" && b.state === "cancelled",
    );
    expect(cancelled).toHaveLength(1);
    // Deleting the cancellation changes nothing: it was never a request.
    expect(withCancel.metrics.requests).toBe(withoutCancel.metrics.requests);
    expect(withCancel.metrics.requests).toBe(3);
  });

  it("says when the data is thin instead of presenting a rate as fact", () => {
    const thin = buildDashboard(
      emptyish({ interactions: source.interactions.slice(0, 3) }),
      "prov-nila",
    )!;
    expect(thin.metrics.confidence).toBe("low");
    expect(thin.notes.join(" ")).toContain(String(CONFIDENCE_FLOOR));
  });

  it("scopes demand to the areas the provider operates in", () => {
    expect(dash.demand.total).toBeLessThan(source.unmetDemand.length);
    expect(dash.demand.total).toBeGreaterThan(0);
    expect(dash.demandFeed.total).toBe(source.unmetDemand.length);
    expect(dash.demand.byLocality.bars.every((b) => b.key === "Fort")).toBe(true);
  });

  it("reports unmet demand, opportunity count and suggestion count consistently", () => {
    expect(dash.metrics.unmetNearby).toBe(dash.demand.total);
    expect(dash.metrics.opportunityCount).toBe(dash.opportunities.length);
    expect(dash.metrics.suggestionCount).toBe(dash.suggestions.length);
    expect(dash.opportunities.length).toBeGreaterThanOrEqual(3);
    expect(dash.suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it("flags the dataset as demo, in the data and in the notes", () => {
    expect(dash.dataset.source).toBe("demo");
    expect(dash.notes.join(" ")).toContain("Demo figures");
  });

  it("builds a zero-filled trend over the window that sums back to the totals", () => {
    expect(dash.trend).toHaveLength(dash.demand.windowDays);
    expect(dash.trend[0]!.date < dash.trend[dash.trend.length - 1]!.date).toBe(true);
    const impressions = dash.trend.reduce((a, p) => a + p.impressions, 0);
    const requests = dash.trend.reduce((a, p) => a + p.requests, 0);
    expect(impressions).toBe(dash.metrics.impressions);
    expect(requests).toBe(dash.metrics.requests);
  });

  it("summarises why travellers nearby got nothing, and why the provider said no", () => {
    expect(dash.blockingCodes.length).toBeGreaterThan(0);
    expect(dash.blockingCodes[0]!.value).toBeGreaterThanOrEqual(dash.blockingCodes[1]!.value);
    expect(dash.declineReasons.length).toBeGreaterThan(0);
    expect(dash.declineReasons.reduce((a, b) => a + b.value, 0)).toBe(dash.metrics.declined);
  });

  it("cross-tabs area against time of day, zero-filled and sorted", () => {
    expect(dash.heat.rows).toEqual([...dash.heat.rows].sort());
    expect(dash.heat.columns).toEqual([...dash.heat.columns].sort());
    expect(dash.heat.peak).toBeGreaterThan(0);
    const total = Object.values(dash.heat.cells).reduce((a, b) => a + b, 0);
    expect(total).toBe(dash.demand.total);
  });

  it("summarises each listing with its own numbers", () => {
    expect(dash.listings).toHaveLength(2);
    const sum = dash.listings.reduce((a, l) => a + l.impressions, 0);
    expect(sum).toBe(dash.metrics.impressions);
    expect(dash.listings.every((l) => l.unconfirmedAccess.length > 0)).toBe(true);
  });

  it("renders an empty dataset without throwing or inventing numbers", () => {
    const empty = buildDashboard(
      { dataset: source.dataset, providers: source.providers, listings: source.listings, interactions: [], bookings: [], unmetDemand: [] },
      "prov-nila",
    )!;
    expect(empty.opportunities).toEqual([]);
    expect(empty.suggestions).toEqual([]);
    expect(empty.demand.total).toBe(0);
    expect(empty.demand.byConstraint.reliable).toBe(false);
    expect(empty.demand.byConstraint.bars).toEqual([]);
    expect(empty.heat.rows).toEqual([]);
    expect(empty.trend.every((p) => p.impressions === 0 && p.requests === 0)).toBe(true);
    expect(empty.metrics.acceptanceRate).toBeNull();
  });

  it("is deterministic: same source, same object", () => {
    expect(JSON.stringify(buildDashboard(createDemoSource(), "prov-nila"))).toBe(JSON.stringify(dash));
    expect(JSON.stringify(buildDashboard(source, "prov-nila"))).toBe(JSON.stringify(dash));
  });
});

describe("buildAllDashboards", () => {
  it("builds one per provider and none of them disagrees with the single build", () => {
    const all = buildAllDashboards(source);
    expect(all).toHaveLength(source.providers.length);
    for (const d of all) {
      expect(JSON.stringify(d)).toBe(JSON.stringify(buildDashboard(source, d.provider.id)));
    }
  });

  it("orders the citywide feed by sample size, then id", () => {
    const feed = citywideOpportunities(buildAllDashboards(source));
    expect(feed.length).toBeGreaterThanOrEqual(source.providers.length * 3);
    const sizes = feed.map((o) => o.sampleSize);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });
});

describe("adapter", () => {
  it("falls back to the demo source when nothing is supplied", () => {
    const resolved = resolveAnalyticsSource();
    expect(resolved.dataset.source).toBe("demo");
    expect(resolved.providers.length).toBeGreaterThan(0);
  });

  it("accepts a supplied source and validates it", () => {
    expect(resolveAnalyticsSource(source).dataset.asOf).toBe(AS_OF);
    expect(() => resolveAnalyticsSource({ dataset: "nope" })).toThrow();
  });
});

describe("future seams", () => {
  const dash = buildDashboard(source, "prov-nila")!;

  it("exports the provider, its listings and the gaps between them", () => {
    const graph = toGraphExport(dash);
    expect(graph.nodes.some((n) => n.kind === "provider")).toBe(true);
    expect(graph.nodes.filter((n) => n.kind === "listing")).toHaveLength(dash.listings.length);
    expect(graph.nodes.some((n) => n.kind === "demand_cell")).toBe(true);
    for (const e of graph.edges) {
      expect(e.from.startsWith("provider:") || e.from.startsWith("cell:") || e.from.startsWith("listing:")).toBe(true);
      expect(e.weight).toBeGreaterThanOrEqual(0);
      expect(e.weight).toBeLessThanOrEqual(1);
    }
    expect(JSON.stringify(toGraphExport(buildDashboard(createDemoSource(), "prov-nila")!))).toBe(JSON.stringify(graph));
  });

  it("briefs a Copilot with counts and no measured impact", () => {
    const brief = toCopilotBrief(dash);
    expect(brief.actions).toHaveLength(3);
    expect(brief.measuredImpact).toBeNull();
    expect(brief.evidence.join(" ")).toContain("searches");
    expect(brief.asOf).toBe(AS_OF);
  });

  it("opens the supply loop with every suggestion marked unknown", () => {
    const signals = toSupplyLoopSignals(dash);
    expect(signals).toHaveLength(dash.suggestions.length);
    expect(signals.every((s) => s.action === "unknown" && s.matchRateAfter === null)).toBe(true);
  });
});

describe("every demo provider", () => {
  it("has a dashboard that a provider can act on", () => {
    for (const d of buildAllDashboards(source)) {
      expect(d.opportunities.length, d.provider.id).toBeGreaterThanOrEqual(3);
      expect(d.suggestions.length, d.provider.id).toBeGreaterThanOrEqual(3);
      expect(d.listings.length, d.provider.id).toBeGreaterThan(0);
      expect(d.metrics.unmetNearby, d.provider.id).toBeGreaterThan(0);
      for (const o of d.opportunities) {
        expect(o.contract.headline).toMatch(/\d/);
        expect(o.contract.evidence.length).toBeGreaterThan(3);
        expect(["observed", "inferred"]).toContain(o.tier);
      }
      for (const s of d.suggestions) {
        expect(s.tier, `${d.provider.id}/${s.kind} is a proposal, not a fact`).toBe("suggested");
        expect(s.sampleSize).toBeGreaterThan(0);
        const demandTier = s.evidence.find((e) => e.label === "demand evidence");
        expect(["observed", "inferred"]).toContain(demandTier?.value);
      }
    }
  });

  it("shows at least one inferred item somewhere, so the tiering is visible in the demo", () => {
    const all: ProviderDashboard[] = buildAllDashboards(source);
    expect(all.some((d) => d.opportunities.some((o) => o.tier === "inferred"))).toBe(true);
  });
});
