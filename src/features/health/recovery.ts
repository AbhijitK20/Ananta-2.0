/**
 * What to do about a bad read, measured instead of asserted.
 *
 * WHY THIS EXISTS. `docs/DESIGN_SYSTEM.md` asks for "one concrete Rescue move"
 * and `Plan.stressFactors` carries a `rescue` string, which is a sentence someone
 * wrote. A sentence is a claim. This file turns the claim into an arithmetic
 * result: every move here is applied to a real clone of the plan, the whole
 * seven-dimension read is re-run on the result, and the number reported is the
 * score that actually came out. "Drop the last stop and you go from 94 to 71" is
 * either true or it is not offered.
 *
 * WHY NOT `whatif`. `src/features/whatif` answers a different and larger
 * question: "what would the planner do if I changed my constraints", and it
 * answers it by running the real planner. That needs an `EnginePort` and a
 * session. This needs neither, because it only ever removes or re-times what is
 * already in the plan, so it works on a plan alone and cannot invent a stop.
 *
 * THE ONE HONEST LIMITATION, STATED UP FRONT. We have no router. When a stop
 * between two others is removed, the leg that replaces the two is costed as
 * those two legs ADDED TOGETHER, which is longer than any real re-route. So the
 * gain reported for dropping a middle stop is a FLOOR, never a fantasy. A direct
 * leg between the survivors is used as-is, so dropping a first or last stop is
 * exact.
 *
 * A move is only returned if it makes the score STRICTLY better, and by enough
 * to act on. If nothing helps, the answer is an empty list and the caller shows
 * the dimension's own rescue sentence, which is the honest thing to do when
 * there is no fix to sell.
 */
import {
  Plan as PlanSchema,
  PlanStop as StopSchema,
  type DiscoveryContext,
  type Experience,
  type Plan,
  type PlanStop,
  type TravelLeg,
} from "../../contracts";
import { hm, plural } from "../discovery/format";
import {
  THRESHOLDS,
  assessTripHealth,
  bandOf,
  dimensionLabel,
  indexCatalogue,
  type Catalogue,
  type Dimension,
  type HealthBand,
  type Thresholds,
  type TripHealth,
} from "./health";

export type RecoveryKind = "drop_stop" | "unbook" | "ride_instead" | "add_buffer";

/** What a move costs the traveller, in the units the contract already uses. */
export type RecoveryCost = {
  /** Stops no longer in the plan. */
  stops: number;
  /** Minutes no longer planned. Negative means the plan got longer. */
  minutes: number;
  /** Metres no longer travelled. */
  metres: number;
  /** Minor units no longer spent. */
  minorUnits: number;
};

export type RecoveryMove = {
  kind: RecoveryKind;
  /** Stable key, e.g. `drop_stop:exp-fort`. Two runs produce the same ids. */
  id: string;
  /** Finished sentence with the real numbers, including the measured outcome. */
  instruction: string;
  /** The dimension this move is aimed at. The read says which one is worst. */
  targets: Dimension;
  /** The score after taking the move. MEASURED, by re-running the read. */
  projectedScore: number;
  /** projectedScore - current score. Always negative for a move worth showing. */
  gain: number;
  cost: RecoveryCost;
  /** The plan as it would be, so a caller can preview or adopt it. */
  after: Plan;
  /** The full re-read, so the panel can show the radar moving and not just claim it. */
  projected: TripHealth;
};

const nameOf = (id: string, order: number, byId: Map<string, Experience>): string =>
  byId.get(id)?.name ?? `stop ${order + 1}`;

const sortedStops = (plan: Plan): PlanStop[] => [...plan.stops].sort((a, b) => a.order - b.order);

/**
 * The leg joining two positions in the ORIGINAL order, as a single leg. When
 * stops have been dropped from between them, the legs they spanned are added
 * together — see the honesty note in the file header. Returns null when the
 * plan's legs do not actually join its stops, because then we cannot rebuild it
 * without inventing a route.
 */
function chainLeg(order: PlanStop[], legs: TravelLeg[], fromPos: number, toPos: number): TravelLeg | null {
  if (toPos <= fromPos) return null;
  const from = order[fromPos];
  const to = order[toPos];
  if (!from || !to) return null;
  let minutes = 0;
  let metres = 0;
  let estimated = false;
  let detail: string | null = null;
  const modes = new Set<TravelLeg["mode"]>();
  for (let i = fromPos; i < toPos; i += 1) {
    const leg = legs[i];
    const anchor = order[i];
    if (!leg || !anchor || leg.fromId !== anchor.experienceId) return null;
    minutes += leg.minutes;
    metres += leg.metres;
    estimated = estimated || leg.estimated;
    detail = detail ?? leg.detail;
    modes.add(leg.mode);
  }
  return {
    fromId: from.experienceId,
    toId: to.experienceId,
    // A chain of mixed modes is not a walk; calling it one would charge the
    // traveller walking minutes they will not walk.
    mode: modes.size === 1 ? [...modes][0]! : "auto",
    minutes,
    metres,
    detail,
    estimated,
  };
}

/**
 * Rebuild a coherent plan from the stops we are keeping, on a real clock.
 *
 * Every stop keeps its own on-site duration, its own buffer and its own cost;
 * only the timing and the legs are recomputed, because those are the things the
 * edit actually changes. `totalMin` is the wall-clock span from the first
 * arrival to the moment the last stop's buffer runs out, which is the same
 * quantity the read measures as `plannedMin`.
 */
function rebuild(
  plan: Plan,
  ctx: DiscoveryContext,
  keep: ReadonlySet<string>,
  bufferBonus: number,
  legsIn: TravelLeg[],
  label: string,
): Plan | null {
  const order = sortedStops(plan);
  const survivors = order.filter((stop) => keep.has(stop.experienceId));
  if (survivors.length === 0) return null;
  const posOf = new Map(order.map((stop, i) => [stop.experienceId, i]));

  const links: TravelLeg[] = [];
  for (let i = 1; i < survivors.length; i += 1) {
    const a = survivors[i - 1];
    const b = survivors[i];
    if (!a || !b) return null;
    const link = chainLeg(order, legsIn, posOf.get(a.experienceId) ?? 0, posOf.get(b.experienceId) ?? 0);
    if (!link) return null;
    links.push(link);
  }

  const stops: PlanStop[] = [];
  let cursor = survivors[0]!.arriveMin;
  for (let i = 0; i < survivors.length; i += 1) {
    const source = survivors[i]!;
    const activityMin = Math.max(0, source.departMin - source.arriveMin);
    const bufferMin = Math.max(0, source.fit.bufferMin + bufferBonus);
    const travelMin = links[i - 1]?.minutes ?? 0;
    const totalMin = travelMin + activityMin + bufferMin;
    const verdict = totalMin <= ctx.availableMin ? "fits" : "does_not_fit";
    stops.push(
      StopSchema.parse({
        experienceId: source.experienceId,
        arriveMin: cursor,
        departMin: cursor + activityMin,
        order: i,
        why: source.why,
        score: source.score,
        fit: {
          ...source.fit,
          travelMin,
          activityMin,
          bufferMin,
          totalMin,
          availableMin: ctx.availableMin,
          fitRatio: totalMin / Math.max(1, ctx.availableMin),
          verdict,
          // The time-dependent check is recomputed; the rest came from the
          // engine about the place, which the edit did not change. Keeping a
          // stale "fits the window: 65 of 240" would be a lie in a plan that
          // no longer has those numbers.
          checks: source.fit.checks
            .filter((check) => !/window|minute|\bmin\b/i.test(check.label))
            .concat([
              {
                label: "Fits the window",
                pass: verdict !== "does_not_fit",
                detail: `${totalMin} of ${ctx.availableMin} min`,
              },
            ]),
        },
      }),
    );
    cursor += activityMin + bufferMin + (links[i]?.minutes ?? 0);
  }

  const totalMin = Math.max(0, cursor - survivors[0]!.arriveMin);
  const minor = stops.reduce((sum, stop) => sum + stop.fit.cost.minor, 0);
  return PlanSchema.parse({
    ...plan,
    // A projection is NOT the plan the engine packed, and two plans sharing an
    // id is how a preview gets mistaken for the live trip. Both facts the
    // contract already provides a field for are used, rather than a comment
    // nobody reads.
    id: `${plan.id}~${label}`,
    engineVersion: `${plan.engineVersion}+recovery-projection`,
    stops,
    legs: links,
    totalMin,
    totalCost: { minor, currency: plan.totalCost.currency },
    utilisation: totalMin / Math.max(1, ctx.availableMin),
    totalMetres: links.reduce((sum, leg) => sum + leg.metres, 0),
    // Filled by the caller from the re-read, so a projected plan never carries
    // the score of the plan it was derived from.
    stressScore: 0,
    stressFactors: [],
  });
}

const costBetween = (before: Plan, after: Plan): RecoveryCost => ({
  stops: before.stops.length - after.stops.length,
  minutes: before.totalMin - after.totalMin,
  metres: before.totalMetres - after.totalMetres,
  minorUnits: before.totalCost.minor - after.totalCost.minor,
});

/**
 * Every move worth taking, best first. Empty when nothing helps, which is a real
 * answer and not a failure.
 */
export function recoveryMoves(
  plan: Plan,
  ctx: DiscoveryContext,
  catalogue: Catalogue = [],
  overrides: Partial<Thresholds> = {},
): RecoveryMove[] {
  const t: Thresholds = { ...THRESHOLDS, ...overrides };
  const byId = indexCatalogue(catalogue);
  const before = assessTripHealth(plan, ctx, catalogue, overrides);
  if (!before.trustworthy) return [];

  const order = sortedStops(plan);
  const all = new Set(order.map((stop) => stop.experienceId));
  const candidates: {
    kind: RecoveryKind;
    id: string;
    targets: Dimension;
    after: Plan;
    instruction: (p: TripHealth) => string;
  }[] = [];

  for (const stop of order) {
    const keep = new Set(all);
    keep.delete(stop.experienceId);
    if (keep.size === 0) continue;
    const after = rebuild(plan, ctx, keep, 0, plan.legs, `drop_${stop.experienceId}`);
    if (!after) continue;
    const name = nameOf(stop.experienceId, stop.order, byId);
    const saved = stop.fit.totalMin;
    candidates.push({
      kind: "drop_stop",
      id: `drop_stop:${stop.experienceId}`,
      targets: "overload",
      after,
      instruction: (p) =>
        `Leave out ${name}, the stop that takes ${hm(saved)}. That takes the plan from ${before.score} to ${p.score}.`,
    });
  }

  const booked = order.filter((stop) => byId.get(stop.experienceId)?.booking.required);
  if (booked.length > 0 && order.length - booked.length > 0) {
    const keep = new Set(
      order.filter((stop) => !byId.get(stop.experienceId)?.booking.required).map((s) => s.experienceId),
    );
    const after = rebuild(plan, ctx, keep, 0, plan.legs, "unbook");
    if (after) {
      const names = booked.map((stop) => nameOf(stop.experienceId, stop.order, byId)).join(" and ");
      candidates.push({
        kind: "unbook",
        id: "unbook:all",
        targets: "reservationRisk",
        after,
        instruction: (p) =>
          `Swap out ${names}, the ${plural(booked.length, "stop", "stops")} behind a reservation. That takes the plan from ${before.score} to ${p.score}.`,
      });
    }
  }

  for (let i = 0; i < plan.legs.length; i += 1) {
    const leg = plan.legs[i];
    if (!leg || leg.mode !== "walk" || leg.minutes <= 1) continue;
    const target = order[i + 1];
    if (!target) continue;
    const ridden = plan.legs.map((l, j) =>
      j === i ? { ...l, mode: "auto" as const, minutes: Math.max(1, Math.round(l.minutes / t.rideSpeedup)) } : l,
    );
    const after = rebuild(plan, ctx, all, 0, ridden, `ride_${leg.toId}`);
    if (!after) continue;
    const name = nameOf(target.experienceId, target.order, byId);
    const beforeMin = leg.minutes;
    const afterMin = ridden[i]!.minutes;
    candidates.push({
      kind: "ride_instead",
      id: `ride_instead:${leg.toId}`,
      targets: "transitComplexity",
      after,
      instruction: (p) =>
        `Ride the ${hm(beforeMin)} walk to ${name} instead of walking it, ${hm(beforeMin - afterMin)} quicker. That takes the plan from ${before.score} to ${p.score}.`,
    });
  }

  if (order.length > 0) {
    const after = rebuild(plan, ctx, all, t.breatherFullMin, plan.legs, "buffer");
    if (after) {
      candidates.push({
        kind: "add_buffer",
        id: "add_buffer:all",
        targets: "pinDebt",
        after,
        instruction: (p) =>
          `Give every stop ${hm(t.breatherFullMin)} more slack. That takes the plan from ${before.score} to ${p.score}, and it costs ${hm(Math.max(0, after.totalMin - plan.totalMin))} more.`,
      });
    }
  }

  const moves: RecoveryMove[] = [];
  for (const candidate of candidates) {
    const projected = assessTripHealth(candidate.after, ctx, catalogue, overrides);
    // Strictly better, or it is not a move. A tie is not worth a traveller's
    // time, and offering it would train them to ignore the list.
    if (projected.score >= before.score) continue;
    // And big enough to act on. See `THRESHOLDS.minRecoveryGain`: a gain that
    // crosses no band and no label is a rescue nobody can do anything with.
    const gain = before.score - projected.score;
    const crossesBand = bandOf(projected.score, t) !== bandOf(before.score, t);
    if (gain < t.minRecoveryGain && !crossesBand) continue;
    moves.push({
      kind: candidate.kind,
      id: candidate.id,
      instruction: candidate.instruction(projected),
      targets: candidate.targets,
      projectedScore: projected.score,
      gain: projected.score - before.score,
      cost: costBetween(plan, candidate.after),
      after: { ...candidate.after, stressScore: projected.score, stressFactors: [] },
      projected,
    });
  }

  return moves.sort(
    (a, b) => a.projectedScore - b.projectedScore || a.cost.stops - b.cost.stops || a.cost.minutes - b.cost.minutes,
  );
}

// ---------------------------------------------------------------------------
// Comparing two reads, which is what a replan needs and a subtraction cannot do.
// ---------------------------------------------------------------------------

export type DimensionMove = {
  dimension: Dimension;
  before: number;
  after: number;
  /** after - before. Negative is better, because every dimension is a strain. */
  delta: number;
  improved: boolean;
  bandBefore: HealthBand;
  bandAfter: HealthBand;
};

export type HealthDelta = {
  before: number;
  after: number;
  /** after - before. Negative is an improvement. */
  delta: number;
  direction: "better" | "worse" | "unchanged";
  labelBefore: TripHealth["label"];
  labelAfter: TripHealth["label"];
  /** Only the dimensions that actually moved, biggest movement first. */
  moved: DimensionMove[];
  /** The moves that made it worse, worst first. Empty when the swap was clean. */
  regressions: DimensionMove[];
  /** The single dimension that moved most, or null when nothing did. */
  biggest: DimensionMove | null;
  /**
   * Whether the swap was worth taking. `null` when it cannot be judged: either
   * read is untrustworthy, or nothing moved. A panel must not render a verdict
   * it does not have.
   */
  worthIt: boolean | null;
  /** One finished sentence naming the numbers and the cause. */
  summary: string;
};

/**
 * Why a plan got harder or easier. `PlanDiff.stressDelta` is a subtraction of two
 * numbers, so it can say "stress went up 12" and nothing about which dimension
 * did it — which is the only part a traveller can act on.
 */
export function compareHealth(before: TripHealth, after: TripHealth): HealthDelta {
  const moves: DimensionMove[] = [];
  for (const dim of before.dimensions) {
    const other = after.dimensions.find((d) => d.dimension === dim.dimension);
    if (!other || dim.value === other.value) continue;
    moves.push({
      dimension: dim.dimension,
      before: dim.value,
      after: other.value,
      delta: round1(other.value - dim.value),
      improved: other.value < dim.value,
      bandBefore: dim.band,
      bandAfter: other.band,
    });
  }
  const byMagnitude = [...moves].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const regressions = moves.filter((m) => !m.improved).sort((a, b) => a.delta - b.delta);
  const delta = after.score - before.score;
  const direction = delta < 0 ? "better" : delta > 0 ? "worse" : "unchanged";
  const judgeable = before.trustworthy && after.trustworthy;
  const biggest = byMagnitude[0] ?? null;

  const summary =
    moves.length === 0
      ? `Nothing about the strain changed: ${before.score} before, ${after.score} after.`
      : direction === "unchanged"
        ? `The two plans read the same at ${after.score}, but ${moves.length} ${plural(moves.length, "dimension", "dimensions")} moved underneath it.`
        : `${direction === "better" ? "Easier" : "Harder"}: ${before.score} to ${after.score}` +
          (biggest
            ? `, mostly ${dimensionLabel(biggest.dimension).toLowerCase()} ${biggest.improved ? "down" : "up"} ${Math.abs(biggest.delta)}.`
            : ".");

  return {
    before: before.score,
    after: after.score,
    delta,
    direction,
    labelBefore: before.label,
    labelAfter: after.label,
    moved: byMagnitude,
    regressions,
    biggest,
    worthIt: judgeable && moves.length > 0 ? delta < 0 : null,
    summary,
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
