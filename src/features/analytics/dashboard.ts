/**
 * The provider dashboard. Pure assembly over contract rows.
 *
 * Rules that matter more than the fields:
 *   - A rate is `null` when its denominator is zero. Never `0%`, never `100%`.
 *   - Every count comes from a row. Nothing is modelled, smoothed, or guessed.
 *   - The dataset badge is data, not decoration: a demo source says so.
 */
import type { BookingRequest, Experience, Interaction, UnmetDemand } from "../../contracts";
import {
  MIN_SAMPLE,
  WINDOW_DAYS,
  aggregateDemand,
  buildCells,
  localDate,
  localMinutesOfDay,
  rowsInWindow,
} from "./aggregate";
import { timeBucketOf, timeBucketShort } from "./format";
import { buildOpportunities, buildProviderSuggestions } from "./opportunities";
import type {
  AnalyticsSource,
  DashboardMetrics,
  DemandBar,
  DemandHeat,
  ListingSummary,
  Opportunity,
  ProviderDashboard,
  ProviderSuggestion,
  TrendPoint,
} from "./types";

/** Below this many impressions or requests, the dashboard says the data is thin. */
export const CONFIDENCE_FLOOR = 20;

export interface DashboardOptions {
  minSample?: number;
  windowDays?: number;
}

export function buildDashboard(
  source: AnalyticsSource,
  providerId: string,
  opts: DashboardOptions = {},
): ProviderDashboard | null {
  const provider = source.providers.find((p) => p.id === providerId);
  if (provider === undefined) return null;

  const minSample = opts.minSample ?? MIN_SAMPLE;
  const windowDays = opts.windowDays ?? WINDOW_DAYS;
  const buildOpts = { minSample, windowDays, datasetLabel: source.dataset.label };

  const listings = source.listings.filter((l) => l.providerId === providerId);
  const listingIds = new Set(listings.map((l) => l.id));
  const interactions = source.interactions.filter((i) => listingIds.has(i.experienceId));
  const bookings = source.bookings.filter((b) => listingIds.has(b.experienceId));

  const cells = buildCells(source.unmetDemand, { asOf: source.dataset.asOf, minSample, windowDays });
  const all = buildOpportunities(cells, source.listings, source.providers, buildOpts);
  const opportunities = all.filter((o) => o.providerId === providerId);
  const suggestions = buildProviderSuggestions(provider, source.listings, cells, buildOpts);

  // Demand "near you" is demand in the neighbourhoods the provider actually
  // operates in, not demand everywhere. Claiming city-wide numbers for a Fort
  // studio would be the kind of overreach this whole layer is trying to avoid.
  // The window filter is not optional: `aggregateDemand` applies it, so skipping
  // it here made `metrics.unmetNearby` disagree with `demand.total` and put
  // out-of-window searches on the heat grid.
  const hoods = new Set(listings.map((l) => l.neighbourhood).filter((h): h is string => h !== null));
  const windowed = rowsInWindow(source.unmetDemand, source.dataset.asOf, windowDays);
  const nearby = hoods.size === 0 ? [] : windowed.filter((d) => hoods.has(d.neighbourhood ?? ""));

  const metrics = buildMetrics(interactions, bookings, nearby, opportunities, suggestions);
  const notes = buildNotes(source, metrics, nearby, minSample);

  return {
    provider,
    listings: listings.map((l) => summarise(l, interactions, bookings)),
    metrics,
    trend: buildTrend(interactions, bookings, source.dataset.asOf, windowDays),
    demand: aggregateDemand(nearby, { asOf: source.dataset.asOf, minSample, windowDays }),
    demandFeed: aggregateDemand(source.unmetDemand, { asOf: source.dataset.asOf, minSample, windowDays }),
    heat: buildHeat(nearby),
    opportunities,
    suggestions,
    blockingCodes: blockingCodes(nearby, windowDays),
    declineReasons: declineReasons(bookings),
    dataset: source.dataset,
    notes,
  };
}

/** Every provider's dashboard, for a cross-provider feed. */
export function buildAllDashboards(
  source: AnalyticsSource,
  opts: DashboardOptions = {},
): ProviderDashboard[] {
  return source.providers
    .map((p) => buildDashboard(source, p.id, opts))
    .filter((d): d is ProviderDashboard => d !== null);
}

/** City-wide opportunity feed, ordered exactly like the per-provider one. */
export function citywideOpportunities(dashboards: readonly ProviderDashboard[]): Opportunity[] {
  const all = dashboards.flatMap((d) => d.opportunities);
  return all.sort((a, b) =>
    b.sampleSize !== a.sampleSize ? b.sampleSize - a.sampleSize : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

// --- metrics --------------------------------------------------------------

function buildMetrics(
  interactions: readonly Interaction[],
  bookings: readonly BookingRequest[],
  nearby: readonly UnmetDemand[],
  opportunities: readonly Opportunity[],
  suggestions: readonly ProviderSuggestion[],
): DashboardMetrics {
  const impressions = interactions.filter((i) => i.type === "impression").length;
  const fitViews = interactions.filter((i) => i.type === "click").length;
  // Cancelled is not a demand signal: the traveller asked, then changed their mind.
  const requests = bookings.filter((b) => b.state !== "cancelled").length;
  const confirmed = bookings.filter((b) => b.state === "confirmed" || b.state === "completed").length;
  const declined = bookings.filter((b) => b.state === "declined").length;
  const volume = impressions + requests;

  return {
    impressions,
    fitViews,
    requests,
    confirmed,
    declined,
    acceptanceRate: requests === 0 ? null : Math.round((confirmed / requests) * 1000) / 1000,
    requestRate: impressions === 0 ? null : Math.round((requests / impressions) * 1000) / 1000,
    confidence: volume === 0 ? "none" : volume < CONFIDENCE_FLOOR ? "low" : "high",
    unmetNearby: nearby.length,
    opportunityCount: opportunities.length,
    suggestionCount: suggestions.length,
  };
}

function summarise(
  listing: Experience,
  interactions: readonly Interaction[],
  bookings: readonly BookingRequest[],
): ListingSummary {
  const mine = interactions.filter((i) => i.experienceId === listing.id);
  const myBookings = bookings.filter((b) => b.experienceId === listing.id);
  const unconfirmed = (Object.entries(listing.accessibility) as [string, boolean | null][])
    .filter(([, v]) => v === null)
    .map(([k]) => k as ListingSummary["unconfirmedAccess"][number]);

  return {
    id: listing.id,
    name: listing.name,
    category: listing.category,
    neighbourhood: listing.neighbourhood ?? "Unknown",
    durationMin: listing.durationMin,
    priceMinor: listing.pricePerPerson?.minor ?? null,
    indoorOutdoor: listing.indoorOutdoor,
    kidFriendly: listing.kidFriendly,
    unconfirmedAccess: unconfirmed,
    bestTimeOfDay: listing.bestTimeOfDay,
    capacity: listing.capacity,
    impressions: mine.filter((i) => i.type === "impression").length,
    fitViews: mine.filter((i) => i.type === "click").length,
    requests: myBookings.filter((b) => b.state !== "cancelled").length,
  };
}

/** Daily impressions and requests across the window, zero-filled, oldest first. */
function buildTrend(
  interactions: readonly Interaction[],
  bookings: readonly BookingRequest[],
  asOf: string,
  windowDays: number,
): TrendPoint[] {
  const days: string[] = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    days.push(localDate(new Date(Date.parse(asOf) - i * 86_400_000).toISOString()));
  }
  const impressions = tally(interactions.filter((i) => i.type === "impression"), days);
  const requests = tally(
    bookings.filter((b) => b.state !== "cancelled").map((b) => ({ at: b.createdAt })),
    days,
  );
  return days.map((date) => ({ date, impressions: impressions[date] ?? 0, requests: requests[date] ?? 0 }));
}

function tally(rows: readonly { at: string }[], days: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const day = localDate(row.at);
    if (!days.includes(day)) continue;
    out[day] = (out[day] ?? 0) + 1;
  }
  return out;
}

/** Why travellers near this provider got nothing, by blocking code. */
function blockingCodes(demand: readonly UnmetDemand[], windowDays: number): DemandBar[] {
  const counts = new Map<string, number>();
  for (const d of demand) {
    counts.set(d.topBlockingCode, (counts.get(d.topBlockingCode) ?? 0) + d.topBlockingCount);
  }
  return barsFromCounts(
    [...counts.entries()].map(([key, value]) => [key, `${key} (${windowDays}d)`, value] as const),
    demand.length,
  );
}

/** Why this provider said no. Counts, grouped by the reason text itself. */
function declineReasons(bookings: readonly BookingRequest[]): DemandBar[] {
  const declined = bookings.filter((b) => b.state === "declined");
  const counts = new Map<string, number>();
  for (const b of declined) {
    const reason = b.declineReason?.trim() || "No reason given";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return barsFromCounts(
    [...counts.entries()].map(([key, value]) => [key, key, value] as const),
    declined.length,
  );
}

/**
 * Area by time-of-day, zero-filled. Rows and columns are both sorted so the grid
 * does not reshuffle between renders; a missing key is zero, never unknown.
 */
function buildHeat(demand: readonly UnmetDemand[]): DemandHeat {
  const cells: Record<string, number> = {};
  const rows = new Set<string>();
  const columns = new Set<string>();
  let peak = 0;
  for (const d of demand) {
    const row = d.neighbourhood?.trim() || "Unspecified";
    const col = timeBucketShort(timeBucketOf(localMinutesOfDay(d.at)));
    const key = `${row}|${col}`;
    const next = (cells[key] ?? 0) + 1;
    cells[key] = next;
    if (next > peak) peak = next;
    rows.add(row);
    columns.add(col);
  }
  return { rows: [...rows].sort(), columns: [...columns].sort(), cells, peak };
}

/** Counts -> bars, sorted by count then key, share against the total. */function barsFromCounts(
  entries: ReadonlyArray<readonly [string, string, number]>,
  total: number,
): DemandBar[] {
  return entries
    .map(([key, label, value]) => ({
      key,
      label,
      value,
      share: total === 0 ? 0 : Math.round((value / total) * 1000) / 1000,
      tier: "observed" as const,
      sampleSize: total,
    }))
    .sort((a, b) => (b.value !== a.value ? b.value - a.value : a.key < b.key ? -1 : 1));
}

function buildNotes(
  source: AnalyticsSource,
  metrics: DashboardMetrics,
  nearby: readonly UnmetDemand[],
  minSample: number,
): string[] {
  const notes: string[] = [...source.dataset.notes];
  if (source.dataset.source === "demo") {
    notes.push("Demo figures. Do not quote these as performance.");
  }
  if (metrics.confidence === "none") {
    notes.push("No impressions and no requests in this window, so rates are left blank rather than shown as zero.");
  } else if (metrics.confidence === "low") {
    notes.push(`Fewer than ${CONFIDENCE_FLOOR} events in the window. Treat every rate here as provisional.`);
  }
  if (nearby.length > 0 && nearby.length < minSample) {
    notes.push(`Only ${nearby.length} unmet searches near you, below the ${minSample} we require before calling a pattern.`);
  }
  return notes;
}
