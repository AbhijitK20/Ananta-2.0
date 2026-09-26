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
 * Six rules, all load-bearing:
 *
 *  1. **Zero results is not automatically unmet demand.** It only is when the
 *     engine eliminated candidates on hard constraints. A thrown engine, a plan
 *     that failed `admit()`, and a catalogue that was never searched are three
 *     different things, and none of them is a provider opportunity. One of them
 *     is our bug.
 *  2. **A re-solve counts.** Most unsatisfied discovery in this product is not a
 *     first search, it is rain starting or the clock running out. `replan()`
 *     feeds this same policy, because a plan that used to work and now returns
 *     nothing is the strongest demand signal the product produces.
 *  3. **Nothing is invented.** There are no seeded rows, no sampled traveller, no
 *     clock. Every number in a `DemandSignal` is either read out of the context the
 *     traveller gave us or counted out of the `Rejection`s the engine returned for
 *     that same request. Where the contract cannot hold the fact — a blocking code
 *     for a catalogue that was never searched — no row is written at all.
 *  4. **The row id IS the aggregation key.** Equivalent requests produce the same
 *     fingerprint, therefore the same `UnmetDemand.id`, so persisting is an upsert
 *     and a duplicate is structurally impossible without a second, deliberate
 *     dedupe pass. No hashing: the key is short enough to read, and this module must
 *     stay importable from a client bundle.
 *  5. **Counts are derived from evidence.** `observations` lists the
 *     `(traveller, time)` pairs actually folded in, and `count` is always
 *     `observations.length`. Re-recording the same request — a double submit, a
 *     retry, a replayed event — therefore cannot inflate a number a provider will
 *     be shown. Nothing in this file increments a count; they are recomputed.
 *  6. **The contract row is one real request; the ledger is the aggregate.**
 *     `signal.demand` is the first occurrence, verbatim, so every field in it is a
 *     fact about something a traveller actually asked for. Counts, spread and
 *     last-seen time live beside it, where nobody mistakes them for one event.
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
  humanise,
  localMinutesOfDay,
  partyBandOf,
  priceBandOf,
  rejectionLabel,
} from "../analytics/aggregate";
import { formatCount, formatInr, timeBucketOf } from "../analytics/format";
import type { ClaimTier } from "../analytics/types";
import { INDOOR_TOKEN, slug } from "./context";

/** The contract's own time-of-day vocabulary, not a second one. */
export type TimeBucket = Experience["bestTimeOfDay"][number];

export interface Range {
  min: number;
  max: number;
}

/** One real request, as the proof that a count is not a projection. */
export interface DemandObservation {
  travellerId: string;
  at: string;
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

/** A shortfall, in the unit the engine reported it in. */
export interface BlockingShortfall {
  amount: number;
  unit: NonNullable<Rejection["unit"]>;
}

export interface BlockingCodeCount {
  code: RejectionCode;
  count: number;
  /**
   * The SMALLEST shortfall reported for this code — the nearest miss, and so the
   * cheapest change that would have served this traveller. A provider can act on
   * "the closest option was ₹500 over" and cannot act on "blocked on price"; the
   * largest shortfall is the one that reads as a problem and fixes nothing. A
   * structural constraint gets `null` rather than a made-up number.
   */
  shortfall: BlockingShortfall | null;
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
  const shortfalls = new Map<RejectionCode, BlockingShortfall>();
  for (const row of rejected) {
    counts.set(row.code, (counts.get(row.code) ?? 0) + 1);
    if (!messages.has(row.code)) messages.set(row.code, row.message);
    if (row.shortfall !== null && row.unit !== null) {
      const seen = shortfalls.get(row.code);
      if (!seen || row.shortfall < seen.amount) {
        shortfalls.set(row.code, { amount: row.shortfall, unit: row.unit });
      }
    }
  }
  const all: BlockingCodeCount[] = [...counts.entries()]
    .map(([code, count]) => ({ code, count, shortfall: shortfalls.get(code) ?? null }))
    .sort((a, b) => b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const top = all[0];
  if (!top) return null;
  return { ...top, message: messages.get(top.code) ?? top.code, all };
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
  /** Always `observations.length`. Derived, never incremented. See rule 5. */
  count: number;
  /**
   * The real requests folded in, and the only thing `count` is allowed to come
   * from. Re-observing a pair already listed here is the same request seen twice,
   * so the ledger ignores it instead of inventing a second traveller.
   */
  observations: readonly DemandObservation[];
  firstAt: string;
  lastAt: string;
  blocking: BlockedOn;
  asks: DemandAsks;
  timeBucket: TimeBucket;
  /** The area as the traveller named it, for copy. The row carries the slug. */
  locality: string;
  /** Stated ceilings across the folded requests. null when none stated one. */
  budget: Range | null;
  availableMin: Range;
  partySize: Range;
}

function observationKey(observation: DemandObservation): string {
  return `${observation.travellerId}|${observation.at}`;
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
  const locality = (meta.neighbourhood ?? ctx.origin.label).trim();
  const neighbourhood = slug(locality) || "unspecified";
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

  const observations: DemandObservation[] = [{ travellerId: meta.travellerId, at: meta.at }];
  return {
    fingerprint,
    demand: row.data,
    count: observations.length,
    observations,
    firstAt: meta.at,
    lastAt: meta.at,
    blocking: blocked,
    asks,
    timeBucket,
    locality: locality || "the area",
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
  /**
   * What the engine had in hand for this traveller: the retrieved shortlist on a
   * first run, the previous plan's stops on a re-solve. It is what makes an empty
   * result legible — zero of three candidates is a market, zero of nothing is not.
   */
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
// Copy — the provider feed needs a sentence, not a row
// ---------------------------------------------------------------------------

function unitText(shortfall: BlockingShortfall): string {
  switch (shortfall.unit) {
    case "minutes":
      return `${shortfall.amount} min`;
    case "minor_units":
      return formatInr(shortfall.amount);
    case "metres":
      return `${shortfall.amount} m`;
    case "people":
      return `${shortfall.amount} people`;
  }
}

/**
 * One finished sentence, no placeholders, every number interpolated. This is the
 * line a provider reads, so it says what was wanted, where, when, how often, and
 * the one number that would have made it possible.
 *
 * Deliberately one blocker. `signal.blocking.all` carries the rest for a
 * drill-down; a sentence with four reasons is a sentence nobody finishes reading.
 */
export function describeSignal(signal: DemandSignal): string {
  const wants: string[] = [signal.asks.category === null ? "an experience" : humanise(signal.asks.category)];
  if (signal.asks.indoorOnly) wants.push("indoors");
  if (signal.asks.kidGroup) wants.push("with children");
  if (signal.asks.diets.length > 0) wants.push(signal.asks.diets.join("/"));
  const where = ` in ${signal.locality}`;
  const money = signal.budget === null ? "" : ` at ${priceBandOf(signal.budget.max).label}`;
  const gap = signal.blocking.shortfall === null ? "" : `, short by ${unitText(signal.blocking.shortfall)}`;
  return (
    `${formatCount(signal.count, "traveller")} wanted ${wants.join(", ")}${where}${money}, this ${signal.timeBucket}. ` +
    `Every candidate was ruled out by ${rejectionLabel(signal.blocking.code)}${gap}.`
  );
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
 * Idempotent by construction. A signal whose `(traveller, time)` pair is already
 * folded in is the same request seen twice — a double submit, a retry, a replayed
 * event — and returns the ledger untouched rather than a second traveller. Every
 * count is then recomputed from `observations`, so no number in here can drift
 * away from the requests that justify it.
 *
 * On a real match the aggregate grows — the spread, the blocked-candidate total —
 * and the row is refreshed in exactly two places: `at`, so a time-windowed query
 * sees the freshest signal, and `topBlockingCount`, so the number on the persisted
 * row is the real running total rather than one request's share of it.
 * `travellerId`, `point`, `neighbourhood` and `constraints` are left alone: they
 * describe the same gap either way, and rewriting them would mean inventing a
 * request nobody made.
 */
export function recordDemand(ledger: DemandLedger, signal: DemandSignal): DemandLedger {
  const existing = ledger.signals.find((row) => row.fingerprint === signal.fingerprint);
  if (!existing) {
    return { signals: [...ledger.signals, signal].sort(bySignalRank) };
  }

  const seen = new Set(existing.observations.map(observationKey));
  const fresh = signal.observations.filter((entry) => !seen.has(observationKey(entry)));
  if (fresh.length === 0) return ledger;

  const observations = [...existing.observations, ...signal.observations].sort((a, b) =>
    observationKey(a).localeCompare(observationKey(b)),
  );
  const blockingCount = existing.blocking.count + signal.blocking.count;
  const merged: DemandSignal = {
    ...existing,
    demand: {
      ...existing.demand,
      at: signal.lastAt,
      topBlockingCount: blockingCount,
    },
    count: observations.length,
    observations,
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
