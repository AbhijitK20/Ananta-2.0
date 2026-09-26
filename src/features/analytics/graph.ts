/**
 * Seams for the three things that come after this feature. Deliberately small.
 *
 * The Experience Graph wants nodes and edges, not a dashboard. The Provider
 * Copilot wants a short, quotable brief, not 130 rows. The Demand to Supply loop
 * wants to know whether a suggestion was taken and whether match rate moved.
 *
 * All three are projections of what already exists, so they are one function
 * each over a `ProviderDashboard`, with no new state and no new storage. When the
 * owning sessions build those systems, they consume these and nothing here
 * changes. If a future consumer needs something these cannot express, that is the
 * moment to widen — not before.
 */
import type { Opportunity, ProviderDashboard } from "./types";

export type GraphNodeKind = "provider" | "listing" | "demand_cell" | "constraint";
export type GraphEdgeKind = "blocked_by" | "competes_with" | "served_by";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** The evidence tier, carried so the graph can badge it too. */
  tier: Opportunity["tier"];
  /** n behind the node. Zero is allowed; null means "not a count". */
  sampleSize: number | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  /** 0..1, relative. Not a probability. */
  weight: number;
  sampleSize: number;
}

export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Unmet demand as a graph fragment: the provider, each of its listings, the gap
 * cells it sits next to, and the constraint standing between them.
 */
export function toGraphExport(dashboard: ProviderDashboard): GraphExport {
  const nodes: GraphNode[] = [
    {
      id: `provider:${dashboard.provider.id}`,
      kind: "provider",
      label: dashboard.provider.name,
      tier: "observed",
      sampleSize: null,
    },
  ];
  const edges: GraphEdge[] = [];

  for (const listing of dashboard.listings) {
    nodes.push({
      id: `listing:${listing.id}`,
      kind: "listing",
      label: listing.name,
      tier: "observed",
      sampleSize: null,
    });
    edges.push({
      from: `provider:${dashboard.provider.id}`,
      to: `listing:${listing.id}`,
      kind: "served_by",
      weight: 1,
      sampleSize: 0,
    });
  }

  for (const opp of dashboard.opportunities) {
    // One node per OPPORTUNITY, not per (neighbourhood, blocking code). Two gaps in
    // the same hood blocked by the same code are still different demand cells —
    // different category, budget band, time band and access constraints — and a
    // shared key collapsed them into one node whose evidence was then duplicated
    // across its edges.
    const cellId = `cell:${opp.id}`;
    nodes.push({
      id: cellId,
      kind: "demand_cell",
      label: `${opp.demand.neighbourhood} ${opp.missingSupply.code}`,
      tier: opp.tier,
      sampleSize: opp.sampleSize,
    });
    edges.push({
      from: cellId,
      to: `provider:${dashboard.provider.id}`,
      kind: "blocked_by",
      weight: Math.min(1, opp.sampleSize / Math.max(1, dashboard.demand.total)),
      sampleSize: opp.sampleSize,
    });
    // `nearbyMatches` is a COUNT, not a set of ids. There is no competitor to name
    // yet, so an edge to `listing:competitor:...` would dangle — a consumer
    // resolving endpoints gets nothing. The count stays on the cell's
    // `sampleSize`; the edge waits until the ids exist.
  }

  return { nodes, edges };
}

export interface CopilotBrief {
  providerId: string;
  providerName: string;
  /** One sentence a provider can read out loud in a standup. */
  summary: string;
  /** The three things we would do first, in our order. */
  actions: string[];
  /** Every number quoted, so the Copilot can cite rather than paraphrase. */
  evidence: string[];
  asOf: string;
  /** Always null until we can measure. The Copilot must not invent impact. */
  measuredImpact: string | null;
}

/** The short brief an assistant can quote. Everything here is already counted. */
export function toCopilotBrief(dashboard: ProviderDashboard, limit = 3): CopilotBrief {
  const top = dashboard.suggestions.slice(0, limit);
  return {
    providerId: dashboard.provider.id,
    providerName: dashboard.provider.name,
    summary:
      `${dashboard.provider.name}: ${dashboard.metrics.unmetNearby} searches near ` +
      `${hoodOf(dashboard)} returned nothing in the last ${dashboard.demand.windowDays} days, ` +
      `and ${dashboard.metrics.opportunityCount} of them are gaps this provider sits inside.`,
    actions: top.map((s) => s.action),
    evidence: [
      `impressions ${dashboard.metrics.impressions}`,
      `requests ${dashboard.metrics.requests}`,
      `acceptance ${dashboard.metrics.acceptanceRate === null ? "no data" : formatRate(dashboard.metrics.acceptanceRate)}`,
      ...top.map((s) => `${s.kind} on ${s.targetField}: ${s.sampleSize} searches`),
    ],
    asOf: dashboard.dataset.asOf,
    measuredImpact: null,
  };
}

export interface SupplyLoopSignal {
  providerId: string;
  suggestionId: string;
  field: string;
  /** Searches behind the suggestion when it was made. */
  sampleSizeAtSuggestion: number;
  /** The provider's action. "unknown" until someone reports one. */
  action: "taken" | "declined" | "unknown";
  /** Match rate after the change. null until measured. */
  matchRateAfter: number | null;
}

/** What a suggestion looked like when we made it. Closed loop comes later. */
export function toSupplyLoopSignals(dashboard: ProviderDashboard): SupplyLoopSignal[] {
  return dashboard.suggestions.map((s) => ({
    providerId: s.providerId,
    suggestionId: s.id,
    field: s.targetField,
    sampleSizeAtSuggestion: s.sampleSize,
    action: "unknown",
    matchRateAfter: null,
  }));
}

function hoodOf(dashboard: ProviderDashboard): string {
  const hoods = [...new Set(dashboard.listings.map((l) => l.neighbourhood))].sort();
  return hoods.length === 0 ? "your listings" : hoods.join(", ");
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}
