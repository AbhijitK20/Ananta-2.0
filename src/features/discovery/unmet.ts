/**
 * Unmet demand: the traveller-side half of the provider flywheel.
 *
 * `src/contracts` already defines `UnmetDemand` — "a search that returned nothing
 * usable ... literally a list of what travellers want and cannot get". Nothing
 * produced one. This file is the producer, and it has exactly one job: decide
 * honestly whether a discovery run that returned nothing to the traveller is
 * evidence about the market, and if it is, write it down in a shape that
 * aggregates.
 *
 * Four rules, all load-bearing:
 *
 *  1. **Zero results is not automatically unmet demand.** It only is when the
 *     engine eliminated candidates on hard constraints. A thrown engine, a plan
 *     that failed `admit()`, and a catalogue that was never searched are three
 *     different things, and none of them is a provider opportunity. One of them
 *     is our bug.
 *  2. **Nothing is invented.** There are no seeded rows, no sampled traveller, no
 *     clock. Every number in a `DemandSignal` is either read out of the context
 *     the traveller gave us or counted out of the `Rejection`s the engine
 *     returned for that same request.
 *  3. **The row id IS the aggregation key.** Equivalent requests produce the same
 *     fingerprint, therefore the same `UnmetDemand.id`, so persisting is an
 *     upsert and a duplicate is structurally impossible without a second,
 *     deliberate dedupe pass. No hashing: the key is short enough to read, and
 *     this module must stay importable from a client bundle.
 *  4. **The contract row is one real request; the ledger is the aggregate.**
 *     `signal.demand` is the first occurrence, verbatim, so every field in it is
 *     a fact about something a traveller actually asked for. The counts, the
 *     spread and the last-seen time live beside it in the `DemandSignal`, where
 *     nobody mistakes them for a single event.
 *
 * Typical wiring, in one place in `src/app`:
 *
 * ```ts
 * const outcome = discover(engine, session, { travellerId, at: new Date().toISOString() });
 * if (outcome.ok && outcome.demand.status === "unmet" && outcome.demand.signal) {
 *   ledger = recordDemand(ledger, outcome.demand.signal);   // then persist signal.demand
 * }
 * ```
 */
import {
  Category,
  UnmetDemand,
  type AccessNeed,
  type DiscoveryContext,
  type Experience,
  type Plan,
  type Rejection,
  type RejectionCode,
} from "../../contracts";
import {
  MUMBAI_TZ_OFFSET_MIN,
  categoryIntent,
  durationBandOf,
  localMinutesOfDay,
  partyBandOf,
  priceBandOf,
} from "../analytics/aggregate";
import { timeBucketOf } from "../analytics/format";
import type { ClaimTier } from "../analytics/types";
import { INDOOR_TOKEN, slug } from "./context";

/** The contract's own time-of-day vocabulary, not a second one. */
export type TimeBucket = Experience["bestTimeOfDay"][number];

export interface Range {
  min: number;
  max: number;
}

// ---------------------------------------------------------------------------
// What the traveller asked for
// ---------------------------------------------------------------------------

/**
 * The supply-side constraints the traveller stated. The `UnmetDemand.constraints`
 * block holds the six the contract could name; these are the rest, kept beside it
 * rather than squeezed into it. Composed, never a widened contract type.
 */
export interface DemandAsks {
  /** Free-text interests, deduped and sorted. Open vocabulary by design. */
  interests: string[];
  category: Category | null;
  /** `observed` only when the traveller's own words contained the category tag. */
  categoryTier: ClaimTier;
  /** The interest string the category came from. null when nothing matched. */
  categoryMatchedOn: string | null;
  /** The `indoors_only` token lowered by the context editor. */
  indoorOnly: boolean;
  diets: string[];
  accessNeeds: AccessNeed[];
  childAges: number[];
  /** True when children are in the group. A family gap is a different supply gap. */
  kidGroup: boolean;
}

function dedupeSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();
}

/**
 * `categoryIntent` returns the traveller's own wording — "craft workshop" — where
 * the contract's value is `craft_workshop`. Left alone, the two spellings become
 * two aggregation keys for one gap, so the tag is normalised here against the
 * contract's own enum rather than at the call site.
 */
function contractCategory(tag: string | null): Category | null {
  if (tag === null) return null;
  const normalised = tag.trim().replace(/\s+/g, "_");
  return Category.safeParse(normalised).success ? (normalised as Category) : null;
}

export function asksOf(ctx: DiscoveryContext): DemandAsks {
  const intent = categoryIntent(ctx.interests);
  return {
    interests: dedupeSorted(ctx.interests),
    category: contractCategory(intent.category),
    categoryTier: intent.tier,
    categoryMatchedOn: intent.matchedOn,
    indoorOnly: ctx.avoid.includes(INDOOR_TOKEN),
    diets: dedupeSorted(ctx.diets),
    accessNeeds: [...new Set(ctx.accessNeeds)].sort(),
    childAges: [...ctx.childAges].sort((a, b) => a - b),
    kidGroup: ctx.childAges.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Which constraint killed the candidates
// ---------------------------------------------------------------------------

export interface BlockingCodeCount {
  code: RejectionCode;
  count: number;
}

/** The constraint that eliminated the most candidates. The actionable bit. */
export interface BlockedOn extends BlockingCodeCount {
  /** The engine's own finished sentence, reused verbatim. We never rewrite it. */
  message: string;
  /** Every code that fired: count desc, then code asc. */
  all: BlockingCodeCount[];
}

/**
 * Rank the engine's rejections. A candidate can die on several constraints, so
 * every row counts; the tie-break is the code name, so the winner is a function
 * of the data and never of the order the engine happened to emit.
 */
export function rankBlockers(rejected: readonly Rejection[]): BlockedOn | null {
  const counts = new Map<RejectionCode, number>();
  const messages = new Map<RejectionCode, string>();
  for (const row of rejected) {
    counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
    if (!messages.has(row.code)) messages.set(row.code, row.message);
  }
  const all: BlockingCodeCount[] = [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const top = all[0];
  if (!top) return null;
  return { code: top.code, count: top.count, message: messages.get(top.code) ?? top.code, all };
}

/**
 * One candidate, one reason per row. The engine may report a rejection in
 * `FeasibleResult.rejected`, in `Plan.rejected`, or in both, so any consumer that
 * adds the two has to be idempotent or the counts inflate.
 */
export function mergeRejections(...groups: readonly (readonly Rejection[])[]): Rejection[] {
  const seen = new Map<string, Rejection>();
  for (const group of groups) {
    for (const row of group) {
      const key = `${row.experienceId}|${row.code}`;
      if (!seen.has(key)) seen.set(key, row);
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.experienceId.localeCompare(b.experienceId) || a.code.localeCompare(b.code),
  );
}

// ---------------------------------------------------------------------------
// The signal
// ---------------------------------------------------------------------------

/** Who asked, and when. Supplied by the caller — this file never reads a clock. */
export interface DemandMeta {
  /** The contract row requires it, so an unattributable request is not persisted. */
  travellerId: string;
  /** ISO datetime, `Z`-suffixed. An unparseable one is not persisted either. */
  at: string;
  /** Overrides the origin label. Pass `null` to keep the neighbourhood off the row. */
  neighbourhood?: string | null;
  /** Local offset for the time bucket. Every `Experience.city` defaults to Mumbai. */
  tzOffsetMin?: number;
}

/**
 * One unmet gap plus everything needed to fold the next equivalent request into
 * it. `demand` is the contract row to persist; the rest is the aggregate state
 * that has nowhere to live in the frozen contract.
 */
export interface DemandSignal {
  /** Deterministic aggregation key. Equivalent requests share it. */
  fingerprint: string;
  /** The contract row. `id === signalId(fingerprint)`. */
  demand: UnmetDemand;
  /** Real failed requests folded in. Starts at 1. Never seeded, never estimated. */
  count: number;
  firstAt: string;
  lastAt: string;
  blocking: BlockedOn;
  asks: DemandAsks;
  timeBucket: TimeBucket;
  /** Stated ceilings across the folded requests. null when none stated one. */
  budget: Range | null;
  availableMin: Range;
  partySize: Range;
}

/** The row id is the aggregation key. Readable, stable, and dependency-free. */
export function signalId(fingerprint: string): string {
  return `ud-${fingerprint.replace(/\|/g, ".")}`;
}

interface FingerprintParts {
  neighbourhood: string;
  asks: DemandAsks;
  budgetBand: string;
  availableBand: string;
  partyBand: string;
  timeBucket: TimeBucket;
  blocking: RejectionCode;
}

/**
 * The key. Two requests that agree on everything a provider would have to change
 * to serve them are the same gap; anything else is a different one.
 *
 * Bands rather than exact values, so "₹950" and "₹520" land together, and mood
 * tokens are left out, because how tired someone is does not change what supply
 * is missing. Time of day is in, because a craft workshop wanted at 07:00 and the
 * same one wanted at 19:00 are two different slots to open.
 *
 * Bump `v1` if a component is ever added or removed: old keys must not silently
 * merge with new ones.
 */
function fingerprintOf(parts: FingerprintParts): string {
  const { asks } = parts;
  return [
    "v1",
    parts.neighbourhood,
    asks.category ?? "any_category",
    parts.budgetBand,
    parts.availableBand,
    parts.partyBand,
    parts.timeBucket,
    parts.blocking,
    asks.accessNeeds.length > 0 ? asks.accessNeeds.join("+") : "no_access_need",
    asks.diets.length > 0 ? asks.diets.join("+") : "no_diet",
    asks.indoorOnly ? "indoor_only" : "any_venue",
  ].join("|");
}

function usableAt(at: string): boolean {
  return typeof at === "string" && at.endsWith("Z") && !Number.isNaN(Date.parse(at));
}

/**
 * Build the signal for one real unsatisfied request, or `null` when no honest
 * `UnmetDemand` row can be written.
 *
 * `null` means "we know the traveller got nothing and we are not writing a row":
 * no constraint survived to be blamed, the origin never resolved to a point, or
 * the request cannot be attributed to a traveller at a time. Every one of those
 * is a real state the caller is told about by `assessDemand`; none of them is
 * papered over with a made-up code, and this function never throws.
 */
export function captureUnmet(
  ctx: DiscoveryContext,
  rejected: readonly Rejection[],
  meta: DemandMeta,
): DemandSignal | null {
  const blocked = rankBlockers(rejected);
  const point = ctx.origin.point;
  if (!blocked || !point || meta.travellerId.trim() === "" || !usableAt(meta.at)) return null;

  const asks = asksOf(ctx);
  const budgetMinor = ctx.budget?.minor ?? null;
  const neighbourhood = slug(meta.neighbourhood ?? ctx.origin.label) || "unspecified";
  const timeBucket = timeBucketOf(localMinutesOfDay(meta.at, meta.tzOffsetMin ?? MUMBAI_TZ_OFFSET_MIN));
  const fingerprint = fingerprintOf({
    neighbourhood,
    asks,
    budgetBand: priceBandOf(budgetMinor).key,
    availableBand: durationBandOf(ctx.availableMin).key,
    partyBand: partyBandOf(ctx.partySize).key,
    timeBucket,
    blocking: blocked.code,
  });

  const row = UnmetDemand.safeParse({
    id: signalId(fingerprint),
    travellerId: meta.travellerId,
    point,
    neighbourhood,
    at: meta.at,
    constraints: {
      availableMin: ctx.availableMin,
      budgetMinor,
      partySize: ctx.partySize,
      accessNeeds: asks.accessNeeds,
      interests: asks.interests,
      weather: ctx.weather.condition,
    },
    // Zero results is what makes it unmet. Not an estimate.
    shortfallCount: 0,
    topBlockingCode: blocked.code,
    topBlockingCount: blocked.count,
  });
  if (!row.success) return null;

  return {
    fingerprint,
    demand: row.data,
    count: 1,
    firstAt: meta.at,
    lastAt: meta.at,
    blocking: blocked,
    asks,
    timeBucket,
    budget: budgetMinor === null ? null : { min: budgetMinor, max: budgetMinor },
    availableMin: { min: ctx.availableMin, max: ctx.availableMin },
    partySize: { min: ctx.partySize, max: ctx.partySize },
  };
}

// ---------------------------------------------------------------------------
// Telling unmet demand apart from everything else
// ---------------------------------------------------------------------------

/** One discovery run, as the detector needs to see it. */
export interface DiscoveryReport {
  ctx: DiscoveryContext;
  /** The admitted plan, or null when the run failed before one existed. */
  plan: Plan | null;
  /** Every rejection this run produced, from wherever the engine put them. */
  rejected: readonly Rejection[];
  /** How many candidates the engine actually looked at. */
  considered: number;
}

export type DemandStatus = "satisfied" | "unmet" | "unserved" | "error";

export type DemandAssessment =
  | { status: "satisfied"; stops: number }
  | { status: "unmet"; signal: DemandSignal | null; blocked: BlockedOn; asks: DemandAsks }
  /**
   * Nothing was planned and no constraint is on record, so there is nothing to
   * write down. `considered` separates "we hold nothing there" (0) from "the
   * packer gave up despite having candidates" (> 0, and our bug to look at).
   */
  | { status: "unserved"; considered: number }
  /** The run failed. Our problem, not the market's, so never a demand signal. */
  | { status: "error" };

/**
 * The whole policy in one function.
 *
 * `satisfied`   the traveller got at least one stop. Never a demand signal.
 * `unmet`       candidates were retrieved and every one was eliminated on a hard
 *               constraint. `signal` is null only when the row could not be
 *               attributed honestly, which the caller is still told about.
 * `unserved`    nothing planned, nothing to blame.
 * `error`       no plan at all.
 */
export function assessDemand(report: DiscoveryReport, meta?: DemandMeta): DemandAssessment {
  const { ctx, plan, rejected, considered } = report;
  if (!plan) return { status: "error" };
  if (plan.stops.length > 0) return { status: "satisfied", stops: plan.stops.length };

  const blocked = rankBlockers(rejected);
  if (!blocked) return { status: "unserved", considered };

  return {
    status: "unmet",
    signal: meta ? captureUnmet(ctx, rejected, meta) : null,
    blocked,
    asks: asksOf(ctx),
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface DemandLedger {
  /** Sorted by count desc, blocked candidates desc, fingerprint asc. */
  signals: readonly DemandSignal[];
}

export function createLedger(): DemandLedger {
  return { signals: [] };
}

function widen(current: Range, next: Range): Range {
  return { min: Math.min(current.min, next.min), max: Math.max(current.max, next.max) };
}

/** A null budget stays null: "nobody said" must not become a zero ceiling. */
function widenBudget(current: Range | null, next: Range | null): Range | null {
  if (!current) return next ? { ...next } : null;
  if (!next) return { ...current };
  return widen(current, next);
}

function bySignalRank(a: DemandSignal, b: DemandSignal): number {
  if (b.count !== a.count) return b.count - a.count;
  if (b.blocking.count !== a.blocking.count) return b.blocking.count - a.blocking.count;
  return a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0;
}

/**
 * Fold a signal into the ledger. Pure, so the same requests in the same order
 * always produce the same bytes and a test can assert on it.
 *
 * On a match the aggregate grows — `count`, the spread, the blocked-candidate
 * total — and the row is refreshed in exactly two places: `at`, so a
 * time-windowed query sees the freshest signal, and `topBlockingCount`, so the
 * number on the persisted row is the real running total rather than one request's
 * share of it. `travellerId`, `point`, `neighbourhood` and `constraints` are left
 * alone: they describe the same gap either way, and rewriting them would mean
 * inventing a request nobody made.
 */
export function recordDemand(ledger: DemandLedger, signal: DemandSignal): DemandLedger {
  const existing = ledger.signals.find((row) => row.fingerprint === signal.fingerprint);
  if (!existing) {
    return { signals: [...ledger.signals, signal].sort(bySignalRank) };
  }

  const blockingCount = existing.blocking.count + signal.blocking.count;
  const merged: DemandSignal = {
    ...existing,
    demand: {
      ...existing.demand,
      at: signal.lastAt,
      topBlockingCount: blockingCount,
    },
    count: existing.count + signal.count,
    lastAt: existing.lastAt < signal.lastAt ? signal.lastAt : existing.lastAt,
    blocking: { ...existing.blocking, count: blockingCount },
    budget: widenBudget(existing.budget, signal.budget),
    availableMin: widen(existing.availableMin, signal.availableMin),
    partySize: widen(existing.partySize, signal.partySize),
  };
  const signals = ledger.signals.map((row) => (row.fingerprint === signal.fingerprint ? merged : row));
  return { signals: [...signals].sort(bySignalRank) };
}

/** The signals a provider feed would lead with: the same ranking, capped. */
export function topSignals(ledger: DemandLedger, limit: number): DemandSignal[] {
  return ledger.signals.slice(0, Math.max(0, limit));
}
