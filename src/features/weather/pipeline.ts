/**
 * Where the weather model meets the real pipeline.
 *
 * `withWeather(engine, catalogue)` returns an `EnginePort` — the same interface
 * `discover()` and `replan()` in `../discovery` already call — with the weather
 * gate hung off three of its stages:
 *
 *   filterFeasible  outdoor records the sky has closed leave `passed` and come
 *                   back in `rejected` as `weather_unsafe` with a written reason.
 *   score           a signed `weather` term on every record the sky has degraded,
 *                   so the order the packer receives is a different order.
 *   replan          if the engine's new plan still holds a stop the sky has
 *                   closed, that stop is excluded and the engine re-solves.
 *
 * Three deliberate decisions:
 *
 *  1. **A decorator, not a fork.** Nothing here re-implements retrieval, a fit, a
 *     pack or an objective, and it never edits a `Plan` the engine produced except
 *     to append rejections to `rejected`. When `src/engine/**` lands, the only
 *     thing that changes is the one wiring line in the app:
 *     `withWeather(engine, session.catalogue)`.
 *  2. **Fine weather is a no-op.** `profileFor(ctx).severity === 0` short-circuits
 *     every stage and returns the engine's own objects, untouched and un-copied.
 *     "The weather did not change anything" is then a fact a test can assert.
 *  3. **No hidden state.** A decorator that stashed rejections between calls would
 *     make the call order load-bearing and the result unexplainable. Everything
 *     here is a function of `(ctx, catalogue)`, which is why the catalogue is a
 *     required argument: `replan()` is handed a plan and a context, not the records
 *     behind the stops, and the catalogue belongs to the engine.
 *
 * If the engine grows its own weather gate this composes rather than conflicts: the
 * gate only ever *removes* ids the engine passed and *lowers* scores, so an engine
 * that already did the work leaves nothing here to do.
 *
 * One honest limit, stated rather than papered over: the soft penalty reaches the
 * packer on the `discover` path, where `score()` is the packer's input, but on the
 * `replan` path the engine re-solves and re-ranks from its own catalogue, so what
 * this file guarantees there is *feasibility* — nothing the sky closed survives, and
 * the plan is handed back to be re-solved without it. If the engine routes its
 * re-solve through its own exported `score()`, the ordering follows automatically;
 * if it does not, the hard gate still holds and only the preference ordering is
 * left to the engine. Re-ranking a re-solved plan here would mean re-packing it
 * here, and re-packing is the one thing this file must never do.
 */
import {
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type FeasibleResult,
  type GeoPoint,
  type Plan,
  type PlanStop,
  type Rejection,
  type ReplanResult,
  type RetrieveInput,
  type ScoreBreakdown,
  type Swap,
  type ValidationResult,
  type WeightProfile,
} from "../../contracts";
import type { EnginePort, TravelMode } from "../discovery/engine";
import {
  WEATHER_POLICY_VERSION,
  assess,
  profileFor,
  weatherComponent,
  type WeatherProfile,
} from "./model";

/**
 * Re-solve budget for one replan. A real engine should already have re-solved for
 * the new sky, so one round is the expected case; three covers an engine that
 * honours the first exclusion list lazily. Bounded because an unbounded loop over
 * a planner is a hang, and a plan the weather has closed is the engine's to own,
 * not ours to forge.
 */
export const MAX_WEATHER_REPAIRS = 3;

export type WeatherOptions = {
  /**
   * Record lookup for the stages that are handed ids rather than records.
   * `DiscoverySession.catalogue` is already exactly this type.
   */
  catalogue: ReadonlyMap<string, Experience>;
};

/** `experienceId + code`, so an engine that already wrote the same reason wins. */
const rejectionKey = (entry: Rejection): string => `${entry.experienceId}:${entry.code}`;

function mergeRejections(plan: Plan, extra: readonly Rejection[]): Rejection[] {
  if (extra.length === 0) return plan.rejected;
  const seen = new Set(plan.rejected.map(rejectionKey));
  return [...plan.rejected, ...extra.filter((entry) => !seen.has(rejectionKey(entry)))];
}

/** The weather's own account of every stop that left the plan, in plan order. */
function weatherRejectionsFor(
  p: WeatherProfile,
  prev: Plan,
  next: Plan,
  catalogue: ReadonlyMap<string, Experience>,
): Rejection[] {
  const survived = new Set(next.stops.map((stop) => stop.experienceId));
  const out: Rejection[] = [];
  for (const stop of prev.stops) {
    if (survived.has(stop.experienceId)) continue;
    const item = catalogue.get(stop.experienceId);
    if (!item) continue;
    const verdict = assess(p, item);
    if (verdict.rejection) out.push(verdict.rejection);
  }
  return out;
}

/**
 * A `Swap` is one stop out and one stop in, per `../discovery/diff.ts`. When the
 * two sides are unequal the leftover gets a null partner rather than being
 * dropped, so the count stays the honest worse side of the two.
 */
function swapsFor(prev: Plan, next: Plan, reason: (id: string) => string, narrative: string): Swap[] {
  const kept = new Set(next.stops.map((stop) => stop.experienceId));
  const wasThere = new Set(prev.stops.map((stop) => stop.experienceId));
  const removed = prev.stops.filter((stop) => !kept.has(stop.experienceId));
  const added = next.stops.filter((stop) => !wasThere.has(stop.experienceId));
  const swaps: Swap[] = [];
  for (let i = 0; i < Math.max(removed.length, added.length); i += 1) {
    const out: PlanStop | undefined = removed[i];
    const incoming: PlanStop | undefined = added[i];
    if (!out && !incoming) continue;
    swaps.push({
      removedId: out?.experienceId ?? null,
      addedId: incoming?.experienceId ?? null,
      reason: out ? reason(out.experienceId) : (incoming?.why[0] ?? `Added after: ${narrative}`),
      scoreDelta: (incoming?.score.total ?? 0) - (out?.score.total ?? 0),
    });
  }
  return swaps;
}

/**
 * The wiring. One line in the app, three real stages, no UI conditionals.
 *
 * ```ts
 * const engine = withWeather(realEngine, session.catalogue);
 * const first = discover(engine, session);
 * applyOpsAndReplan(engine, session, [{ kind: "set_weather", condition: "heavy_rain" }]);
 * ```
 */
export function withWeather(base: EnginePort, options: WeatherOptions): EnginePort {
  const { catalogue } = options;

  return {
    retrieve(input: RetrieveInput): Experience[] {
      return base.retrieve(input);
    },

    filterFeasible(ctx: DiscoveryContext, items: Experience[]): FeasibleResult {
      const engineResult = base.filterFeasible(ctx, items);
      const p = profileFor(ctx);
      if (p.severity === 0) return engineResult;
      const byId = new Map(items.map((item) => [item.id, item]));
      const passed: string[] = [];
      const rejected: Rejection[] = [...engineResult.rejected];
      for (const id of engineResult.passed) {
        const item = byId.get(id);
        // An id we cannot resolve is the engine knowing something we do not. Pass
        // it through rather than second-guessing it with a shrug.
        if (!item) {
          passed.push(id);
          continue;
        }
        const verdict = assess(p, item);
        if (verdict.rejection) rejected.push(verdict.rejection);
        else passed.push(id);
      }
      return { passed, rejected };
    },

    score(ctx: DiscoveryContext, items: Experience[], weights: WeightProfile): ScoreBreakdown[] {
      const engineScores = base.score(ctx, items, weights);
      const p = profileFor(ctx);
      if (p.severity === 0) return engineScores;
      const byId = new Map(items.map((item) => [item.id, item]));
      return engineScores.map((entry) => {
        const item = byId.get(entry.experienceId);
        if (!item) return entry;
        const component = weatherComponent(assess(p, item));
        if (!component) return entry;
        return {
          ...entry,
          total: entry.total + component.value,
          components: [...entry.components, component],
          // The engine's own version stays in the string, so a score that moved
          // can be traced to the weather policy that moved it.
          profileVersion: `${entry.profileVersion}+${WEATHER_POLICY_VERSION}`,
        };
      });
    },

    pack(ctx: DiscoveryContext, items: Experience[]): Plan {
      return base.pack(ctx, items);
    },

    validate(plan: Plan): ValidationResult {
      return base.validate(plan);
    },

    replan(prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult {
      const p = profileFor(ctx);
      let result = base.replan(prev, ctx, change);
      if (p.severity === 0) return result;

      // The engine may or may not have re-solved hard enough for the new sky. We
      // do not re-pack anything here: the sealed stops go into `excludedIds` and
      // the engine re-solves from `prev` again, so every stop, leg and fit in the
      // result is still the engine's and `validate()` keeps meaning what it meant.
      let excluded = new Set<string>();
      for (let round = 0; round < MAX_WEATHER_REPAIRS; round += 1) {
        const sealed = result.plan.stops
          .map((stop) => stop.experienceId)
          .filter((id) => {
            const item = catalogue.get(id);
            return item ? assess(p, item).sealed : false;
          });
        if (sealed.length === 0) break;
        excluded = new Set([...excluded, ...sealed]);
        result = base.replan(prev, { ...ctx, excludedIds: [...new Set([...ctx.excludedIds, ...excluded])] }, change);
      }
      // Nothing was ever sealed, so the engine's own answer stands un-copied. And if
      // the rounds ran out with a stop still sealed — an engine that ignores
      // `excludedIds` entirely — its plan is returned as it is, because forging a
      // weather-safe plan here would mean re-packing it here.
      if (excluded.size === 0) return result;

      // `Plan.rejected` is what `../discovery/diff.ts` reads to explain a removal,
      // so a stop the weather closed leaves with the weather's own sentence rather
      // than a generic "dropped after: Rain started". Appended, never prepended, so
      // a reason the engine already wrote keeps priority.
      const reason = (id: string): string => {
        const item = catalogue.get(id);
        const rejection = item ? assess(p, item).rejection : null;
        return rejection ? rejection.message : `Dropped after: ${change.narrative}`;
      };
      return {
        ...result,
        plan: {
          ...result.plan,
          rejected: mergeRejections(result.plan, weatherRejectionsFor(p, prev, result.plan, catalogue)),
        },
        swaps: swapsFor(prev, result.plan, reason, change.narrative),
      };
    },

    computeFit(ctx: DiscoveryContext, exp: Experience) {
      return base.computeFit(ctx, exp);
    },

    stress(plan: Plan, ctx: DiscoveryContext) {
      return base.stress(plan, ctx);
    },

    travelBetween(from: GeoPoint, to: GeoPoint, mode: TravelMode, atMin: number) {
      return base.travelBetween(from, to, mode, atMin);
    },
  };
}
