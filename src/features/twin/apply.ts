/**
 * Where the twin stops being a simulation and starts changing the product.
 *
 * This is the file that answers the brief's hardest requirement: "demonstrate at
 * least one interactive scenario where changing a weather parameter produces a
 * corresponding change in the team's existing system through the Digital Twin." The
 * only way to satisfy that honestly is to change an input to the **real planner** and
 * let it re-solve. So this module does not compute a plan, describe one, or
 * approximate one — it rewrites the two arguments `planItinerary()` takes and calls
 * it.
 *
 * ```
 *   TwinState ──► twin catalogue  ──┐
 *               twin context   ──┴──► planItinerary()  ──►  Plan   (the engine's)
 * ```
 *
 * Four things change in the catalogue, and each one is a channel the twin already
 * computed, so nothing here is new arithmetic:
 *
 *  1. **Rows the sky closed are removed.** Availability at or below 0.05 means shut,
 *     and the engine's own retriever would rank them anyway because it has no idea
 *     it is raining. This is the largest single effect and the easiest to verify.
 *  2. **Visit durations stretch.** A covered stop in the rain takes longer, and the
 *     engine's own window arithmetic then has to fit fewer of them. This is the
 *     subtle one: nothing is forbidden, the day is just fuller.
 *  3. **Severe weather enters the context**, so the engine's own feasibility gate and
 *     the weather feature's policy both see the same sky the twin did.
 *  4. **`excludedIds` grows** with the shut rows, so even if a row survived the
 *     filter it cannot come back.
 *
 * ## The live plan is never touched
 *
 * `applyTwin` is a pure function of `(context, catalogue, twinState)`. It mutates
 * neither argument, returns a new context and a new catalogue, and the caller keeps
 * the baseline result to diff against. That is the brief's "without affecting the
 * actual system", and it is structural rather than a convention — there is no code
 * path here that can write to a live plan.
 */
import {
  DiscoveryContext,
  type Experience,
  type Fit,
} from "../../contracts";
import { planItinerary, type PlanOptions, type PlanResult } from "../../engine/plan";
import { computeFit } from "../../engine/fit";
import { opennessOf } from "./hazards";
import { type NodeImpact, type TwinState } from "./propagate";
import { scenarioMonth, scenarioWeekday } from "./propagate";
import { weatherNowOf } from "./scenario";

/** At or below this, the twin considers an entity shut and it does not go in. */
export const SHUT_AT = 0.05;

/**
 * The token the traveller's own sensitivity arrives as.
 *
 * `docs/ARCHITECTURE.md` §9 requires the engine to honour the weather tokens the
 * editor writes, and `src/features/weather/model.ts` reads `WEATHER_TOKENS.high` and
 * `INDOOR_TOKEN` out of `ctx.avoid` for exactly this purpose. So the twin writes the
 * same vocabulary rather than inventing a parallel one — which is also why it does
 * not need a frozen-contract change to express "this traveller hates weather".
 */
const WEATHER_AVERSE = "weather_averse";

export type ApplyResult = {
  /** A new context. The input is untouched. */
  context: DiscoveryContext;
  /** A new catalogue. The input is untouched. */
  catalogue: Experience[];
  /** The real engine's answer, for the twin world. */
  result: PlanResult;
  /** Ids the twin removed, with the sentence explaining each. */
  closed: { id: string; name: string; reason: string }[];
  /** Rows whose visit length the twin stretched. */
  stretched: { id: string; from: number; to: number }[];
  /** True when nothing at all changed, which is the honest no-op result. */
  noop: boolean;
};

export type ApplyOptions = {
  context: DiscoveryContext;
  catalogue: readonly Experience[];
  twin: TwinState;
  /** Forwarded to the engine. `weekday`/`month` default to the scenario's own date. */
  planOptions?: PlanOptions;
  /**
   * Whether the twin's simulation is allowed to remove rows at all.
   *
   * On by default. It exists because there is one caller that must not have it: a
   * side-by-side "what would the planner do with no twin at all" baseline, where
   * removing the closed rows would make the comparison circular.
   */
  applyClosures?: boolean;
};

/**
 * Run the real planner over the twin world.
 *
 * `structuredClone` rather than a spread, because a shallow copy would share every
 * nested object — `accessibility`, `provenance`, `perception` — with the live
 * catalogue, and one mutated `durationMin` later would be a data-corruption bug
 * rather than a simulation artefact.
 */
export function applyTwin(options: ApplyOptions): ApplyResult {
  const { context, catalogue, twin } = options;
  const applyClosures = options.applyClosures ?? true;
  const weekday = (options.planOptions?.weekday ?? scenarioWeekday(twin.scenario)) as PlanOptions["weekday"];
  const month = options.planOptions?.month ?? scenarioMonth(twin.scenario);

  const closed: ApplyResult["closed"] = [];
  const stretched: ApplyResult["stretched"] = [];
  const excluded = new Set(context.excludedIds);

  const next: Experience[] = [];
  for (const row of catalogue) {
    const impact: NodeImpact | undefined = twin.nodes.get(row.id);
    if (!impact) {
      // A row the twin never saw — a filter artefact, or a catalogue that grew
      // between the graph build and this call. It passes through unchanged, because
      // "the twin has no opinion" must not become "the twin closed it".
      next.push(row);
      continue;
    }

    if (applyClosures && impact.availability.point <= SHUT_AT) {
      excluded.add(row.id);
      closed.push({
        id: row.id,
        name: row.name,
        reason: impact.reason || `Closed by the simulated conditions: ${impact.severity >= 2 ? "inoperable" : "unavailable"}.`,
      });
      continue;
    }

    const durationMultiplier = impact.channels.duration.multiplier;
    if (durationMultiplier > 1.02) {
      const to = Math.max(1, Math.round(row.durationMin * durationMultiplier));
      if (to !== row.durationMin) {
        stretched.push({ id: row.id, from: row.durationMin, to });
        next.push({ ...row, durationMin: to });
        continue;
      }
    }
    next.push(row);
  }

  const nextContext = buildTwinContext(context, twin, excluded);
  const result = planItinerary(nextContext, next, {
    ...options.planOptions,
    weekday,
    month,
    planId: options.planOptions?.planId ?? `${context.id}-twin`,
  });

  return {
    context: nextContext,
    catalogue: next,
    result,
    closed,
    stretched,
    noop: closed.length === 0 && stretched.length === 0,
  };
}

/**
 * The twin's weather, expressed in the frozen context.
 *
 * Three parts, and the third is the one that matters: the scenario's condition goes
 * in as `WeatherNow`, the *severe* hazards are additionally written into `avoid` as
 * the tokens the engine already honours, and the source is always `simulated`
 * because a counterfactual is not a forecast.
 *
 * `src/features/weather`'s `WeatherProfile` deliberately ignores `source`, so a
 * simulated scenario gates exactly as a live one would — the demo cannot quietly
 * plan differently from production.
 */
export function buildTwinContext(
  context: DiscoveryContext,
  twin: TwinState,
  excluded: ReadonlySet<string>,
): DiscoveryContext {
  const avoid = [...context.avoid];
  const severe = twin.hazards.filter((hazard) => hazard.severity >= 1.8).map((hazard) => hazard.kind);

  if (severe.length > 0 && !avoid.includes(WEATHER_AVERSE)) {
    // Not "the traveller is sensitive" — the *simulated sky* is. But the contract has
    // no other channel for it, so the honest use of the existing token is to lower
    // the gate's thresholds for a sky that has genuinely earned it, and to say so in
    // `provenance` rather than pretend the traveller asked.
    avoid.push(WEATHER_AVERSE);
  }
  // Anything the sky closed is not a preference the traveller stated,
  // so `indoors_only` is *not* added here. Adding it would silently forbid the
  // outdoor thing the traveller might have wanted at 16:00 when the rain stopped, and
  // a twin that changes the traveller's preferences is a twin that has stopped
  // simulating the weather.

  return DiscoveryContext.parse({
    ...context,
    weather: weatherNowOf(twin.scenario, "simulated"),
    avoid,
    excludedIds: [...new Set([...excluded])],
  });
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

export type PlanDelta = {
  /** Stops in the baseline that are not in the twin plan. */
  removed: { id: string; name: string; reason: string }[];
  /** Stops in the twin plan that were not in the baseline. */
  added: { id: string; name: string; reason: string }[];
  kept: number;
  totalMin: { from: number; to: number };
  totalCost: { from: number; to: number };
  totalMetres: { from: number; to: number };
  utilisation: { from: number; to: number };
  stress: { from: number; to: number };
  /** One sentence, because a page needs a headline and two plans need a comparison. */
  headline: string;
};

/**
 * What the weather actually did to the traveller's day.
 *
 * `diffPlans` in `src/features/discovery/diff.ts` is the repo's deterministic plan
 * diff, but it needs a `DiscoverySession` and the twin works below that layer, so
 * this is a small local diff over ids. It is deliberately the *same shape* as
 * `Swap[]` in `src/features/discovery/diff.ts` — one out, one in, with a reason — so
 * a caller can render either with the same component.
 *
 * `nameOf` is injected because `PlanStop` carries only an `experienceId`: the
 * contract deliberately keeps display names out of a plan, because a plan that embeds
 * a name goes stale the moment a listing is renamed. The caller already has the
 * catalogue, so it resolves the name and the diff does not have to carry a second
 * lookup table.
 */
export function diffPlans(
  baseline: PlanResult,
  twinResult: PlanResult,
  closedById: ReadonlyMap<string, string>,
  nameOf: (id: string) => string,
): PlanDelta {
  const baselineIds = baseline.plan.stops.map((stop) => stop.experienceId);
  const twinIds = new Set(twinResult.plan.stops.map((stop) => stop.experienceId));
  const baselineSet = new Set(baselineIds);

  const removed = baselineIds
    .filter((id) => !twinIds.has(id))
    .map((id) => {
      const stop = baseline.plan.stops.find((entry) => entry.experienceId === id);
      return {
        id,
        name: nameOf(id),
        reason: closedById.get(id) ?? stop?.why?.[0] ?? "No longer fits the simulated conditions.",
      };
    });

  const added = twinResult.plan.stops
    .filter((stop) => !baselineSet.has(stop.experienceId))
    .map((stop) => ({
      id: stop.experienceId,
      name: nameOf(stop.experienceId),
      reason: stop.why?.[0] ?? "Fits the simulated conditions better than what it replaced.",
    }));

  const kept = baselineIds.filter((id) => twinIds.has(id)).length;
  const from = baseline.plan;
  const to = twinResult.plan;

  const headline =
    removed.length === 0 && added.length === 0
      ? `The plan is unchanged: ${kept} stop${kept === 1 ? "" : "s"} survive these conditions.`
      : removed.length === 0
        ? `Same ${kept} stops, plus ${added.length} that only fit once the weather changed.`
        : added.length === 0
          ? `${removed.length} stop${removed.length === 1 ? "" : "s"} lost, nothing gained.`
          : `${removed.length} out, ${added.length} in.`;

  return {
    removed,
    added,
    kept,
    totalMin: { from: from.totalMin, to: to.totalMin },
    // `Plan.totalCost` is a `Money`, not a minor-unit integer, so the diff is in
    // paise and the UI divides. Keeping it in the contract's own unit is what stops
    // a float rupee from creeping in at the last step.
    totalCost: { from: from.totalCost.minor, to: to.totalCost.minor },
    totalMetres: { from: from.totalMetres, to: to.totalMetres },
    utilisation: { from: round3(from.utilisation), to: round3(to.utilisation) },
    stress: { from: round3(from.stressScore), to: round3(to.stressScore) },
    headline,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Per-card fit for the twin world, so a results card can show what the weather did
 * to *this* record rather than only to the plan it is in.
 *
 * The engine's own `computeFit`, on the twin's stretched duration. That is the point
 * of calling the engine rather than scaling a number: the fit meter, the plan and the
 * card are then all reading one computation, and a discrepancy is impossible rather
 * than merely unlikely.
 *
 * `weekday` is required rather than defaulted because the engine's own gate treats it
 * as correctness-critical — `planItinerary` is passed the scenario's weekday by
 * `applyTwin`, and a fit computed against a different day is a lie with a number on
 * it. The caller has the scenario; this module does not guess.
 */
export function twinFit(
  context: DiscoveryContext,
  experience: Experience,
  travelMin: number,
  weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6,
): Fit {
  const visitFrom = context.nowMin + travelMin + 10;
  return computeFit(context, experience, {
    travelMin,
    bufferMin: 10,
    visitFrom,
    visitTo: visitFrom + experience.durationMin,
    cost: experience.pricePerPerson ?? { minor: 0, currency: "INR" },
    weekday,
  });
}

/** Openness per class, re-exported so a caller can colour the map without a second import. */
export { opennessOf };
