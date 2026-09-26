/**
 * The analytics adapter seam.
 *
 * There is no backend API for provider analytics yet, so nothing here imports
 * `fetch` and nothing invents a route. What ships is (a) the interface every
 * backend will eventually satisfy, and (b) a deterministic demo implementation
 * of it. When `src/db` lands a repository for `interactions` and `unmet_demand`,
 * the only change needed is one function that assembles the same object from
 * contract rows — no view, no aggregation, or contract type changes.
 *
 * Validation is not ceremony: input is parsed with the CONTRACT's own schemas,
 * so a malformed row from a future API fails here rather than rendering a NaN
 * percentage on a provider's dashboard.
 */
import { z } from "zod";
import { BookingRequest, Experience, Interaction, Provider, UnmetDemand } from "../../contracts";
import type { AnalyticsDataset, AnalyticsSource } from "./types";
import { createDemoSource } from "./demo-data";

const Dataset = z.object({
  source: z.enum(["demo", "live"]),
  label: z.string(),
  asOf: z.string(),
  notes: z.array(z.string()),
});

const Shape = z.object({
  dataset: Dataset,
  providers: z.array(Provider),
  listings: z.array(Experience),
  interactions: z.array(Interaction),
  bookings: z.array(BookingRequest),
  unmetDemand: z.array(UnmetDemand),
});

/**
 * Parse an untrusted source into a typed one. Throws on a bad row: a dashboard
 * with a silently wrong number is worse than a failed render.
 */
export function parseAnalyticsSource(value: unknown): AnalyticsSource {
  return Shape.parse(value) as AnalyticsSource;
}

/**
 * The one call a page makes. Today it returns the demo source; the day the API
 * lands it returns that instead, and nothing downstream changes.
 */
export function resolveAnalyticsSource(provided?: unknown): AnalyticsSource {
  if (provided !== undefined && provided !== null) return parseAnalyticsSource(provided);
  return createDemoSource();
}

export type { AnalyticsDataset, AnalyticsSource };
