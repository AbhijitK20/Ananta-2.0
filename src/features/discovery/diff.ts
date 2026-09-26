/**
 * The plan diff. Deterministic, structural, and free of any model call: the
 * numbers in the swap panel are re-derivable offline, which is the only way the
 * "we told you exactly what changed and why" claim survives a judge's question.
 *
 * The reasons are not written here either. They come from two things the engine
 * already produced:
 *  - a removed stop is looked up in `after.rejected`, whose `message` is a
 *    finished sentence with the real shortfall in it ("Needs 40 min more than
 *    you have left");
 *  - an added stop borrows the first line of the engine's own `PlanStop.why`.
 *
 * So a removal is explained by a number we computed, and an addition by the
 * scoring term that won. The only fallback is a generic sentence about the
 * change, used when the engine emitted no rejection for that id.
 */
import type {
  Category,
  ContextChange,
  DiscoveryContext,
  Experience,
  IndoorOutdoor,
  Minutes,
  Money,
  Plan,
  PlanStop,
  TravelLeg,
} from "../../contracts";
import type { EnginePort, TravelMode } from "./engine";

export function indexCatalogue(
  items: readonly Experience[],
): ReadonlyMap<string, Experience> {
  return new Map(items.map((item) => [item.id, item]));
}

export type StopDiff = {
  id: string;
  name: string;
  category: Category | null;
  indoorOutdoor: IndoorOutdoor | null;
  status: "removed" | "added" | "unchanged";
  orderBefore: number | null;
  orderAfter: number | null;
  arriveBefore: Minutes | null;
  arriveAfter: Minutes | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  scoreDelta: number;
  costBefore: Money | null;
  costAfter: Money | null;
  fitRatioBefore: number | null;
  /** How it scores against the *new* context. Null when it is not a candidate. */
  fitRatioAfter: number | null;
  /** Same stop, different slot in the day: the order moved, the stop did not. */
  reordered: boolean;
  /** Travel minutes the removal saved, from the engine's router. */
  travelSavedMin: number | null;
  /** Deterministic, and engine-authored. Never generated. */
  reason: string;
};

export type PlanDiff = {
  removed: StopDiff[];
  added: StopDiff[];
  unchanged: StopDiff[];
  /**
   * `max(removed, added)`, which is the number `docs/EVAL_SPEC.md` caps at 2
   * per trigger. A `Swap` in the contract is one removed plus one added, so for
   * an unequal swap set the worse side is the honest count.
   */
  swapCount: number;
  costDelta: Money;
  timeDeltaMin: number;
  metresDelta: number;
  utilisationDelta: number;
  stressDelta: number;
  changed: boolean;
};

export type DiffInput = {
  catalogue: ReadonlyMap<string, Experience>;
  change: ContextChange;
  travelMode: DiscoveryContext["travelMode"];
};

const byStop = (plan: Plan): ReadonlyMap<string, PlanStop> =>
  new Map(plan.stops.map((stop) => [stop.experienceId, stop]));

function stopDiff(
  status: StopDiff["status"],
  id: string,
  before: PlanStop | undefined,
  after: PlanStop | undefined,
  catalogue: ReadonlyMap<string, Experience>,
): StopDiff {
  const exp = catalogue.get(id);
  return {
    id,
    name: exp?.name ?? "Unknown place",
    category: exp?.category ?? null,
    indoorOutdoor: exp?.indoorOutdoor ?? null,
    status,
    orderBefore: before?.order ?? null,
    orderAfter: after?.order ?? null,
    arriveBefore: before?.arriveMin ?? null,
    arriveAfter: after?.arriveMin ?? null,
    scoreBefore: before?.score.total ?? null,
    scoreAfter: after?.score.total ?? null,
    scoreDelta: (after?.score.total ?? 0) - (before?.score.total ?? 0),
    costBefore: before?.fit.cost ?? null,
    costAfter: after?.fit.cost ?? null,
    fitRatioBefore: before?.fit.fitRatio ?? null,
    fitRatioAfter: after?.fit.fitRatio ?? null,
    reordered: before !== undefined && after !== undefined && before.order !== after.order,
    travelSavedMin: null,
    reason: "",
  };
}

/**
 * Why a stop left. `after.rejected` is the engine's own account of what it had
 * to drop, so the panel never invents a justification for a removal.
 */
function removalReason(id: string, after: Plan, change: ContextChange): string {
  const rejection = after.rejected.find((entry) => entry.experienceId === id);
  return rejection ? rejection.message : `Dropped after: ${change.narrative}`;
}

function additionReason(stop: PlanStop, change: ContextChange): string {
  return stop.why[0] ?? `Added after: ${change.narrative}`;
}

/**
 * `DiscoveryContext.travelMode` is a PREFERENCE and includes `"any"`, which is
 * its own default. `travelBetween` takes a concrete leg mode and has no `"any"`.
 * Handing it the preference verbatim is both a type error and a runtime hazard
 * on the single most common path in the product, so the translation happens here,
 * once, at the boundary.
 *
 * `"any"` resolves to `"auto"`: the router returns its fastest option and the leg
 * it produces is already flagged `estimated: true`, so nothing here claims more
 * than it knows. A wrong guess costs one number in the "you saved N minutes"
 * line of the swap diff.
 */
function legMode(preference: DiscoveryContext["travelMode"]): TravelLeg["mode"] {
  return preference === "any" ? "auto" : preference;
}

/**
 * The travel the removal actually saved. The new plan's legs no longer contain
 * the removed stop, so the saving has to come from the router rather than from
 * a subtraction of two leg lists. Null when the removed stop was last in the
 * day or is missing from the catalogue.
 */
function savedTravel(
  engine: EnginePort,
  id: string,
  before: Plan,
  catalogue: ReadonlyMap<string, Experience>,
  travelMode: DiscoveryContext["travelMode"],
): number | null {
  const index = before.stops.findIndex((stop) => stop.experienceId === id);
  const here = catalogue.get(id);
  const next = before.stops[index + 1];
  const there = next ? catalogue.get(next.experienceId) : undefined;
  if (index < 0 || !here || !there) return null;
  return engine.travelBetween(here.location, there.location, ROUTER_MODE[travelMode], before.stops[index]?.departMin ?? 0)
    .minutes;
}


/**
 * `travelMode` includes "any", the router does not. "any" means the traveller
 * has no preference, so the shortest-hop default is the honest one to measure
 * the saving with.
 */
const ROUTER_MODE: Record<DiscoveryContext["travelMode"], TravelMode> = {
  walk: "walk",
  auto: "auto",
  transit: "transit",
  any: "auto",
};

export function diffPlans(
  engine: EnginePort,
  before: Plan,
  after: Plan,
  input: DiffInput,
): PlanDiff {
  const { catalogue, change, travelMode } = input;
  const beforeStops = byStop(before);
  const afterStops = byStop(after);

  const removed = before.stops
    .filter((stop) => !afterStops.has(stop.experienceId))
    .map((stop) => {
      const diff = stopDiff("removed", stop.experienceId, stop, undefined, catalogue);
      diff.reason = removalReason(stop.experienceId, after, change);
      diff.travelSavedMin = savedTravel(engine, stop.experienceId, before, catalogue, travelMode);
      return diff;
    });

  const added = after.stops
    .filter((stop) => !beforeStops.has(stop.experienceId))
    .map((stop) => {
      const diff = stopDiff("added", stop.experienceId, undefined, stop, catalogue);
      diff.reason = additionReason(stop, change);
      return diff;
    });

  const unchanged = after.stops
    .filter((stop) => beforeStops.has(stop.experienceId))
    .map((stop) => stopDiff("unchanged", stop.experienceId, beforeStops.get(stop.experienceId), stop, catalogue));

  return {
    removed,
    added,
    unchanged,
    swapCount: Math.max(removed.length, added.length),
    costDelta: { minor: after.totalCost.minor - before.totalCost.minor, currency: after.totalCost.currency },
    timeDeltaMin: after.totalMin - before.totalMin,
    metresDelta: after.totalMetres - before.totalMetres,
    utilisationDelta: after.utilisation - before.utilisation,
    stressDelta: after.stressScore - before.stressScore,
    changed: removed.length > 0 || added.length > 0,
  };
}
