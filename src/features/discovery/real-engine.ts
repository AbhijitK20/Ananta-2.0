/**
 * The wiring line `src/features/discovery/engine.ts` promised and nobody wrote.
 *
 * `EnginePort` is the traveller-side features' view of the engine, and its own
 * header says: "So: one wiring line in `src/app`, zero engine logic under
 * `src/features/**`." That line did not exist. Nothing imported
 * `@/features/discovery`, so `EnginePort` was never satisfied by anything, and
 * 20,828 lines of finished feature code across `discovery`, `whatif`, `group`,
 * `weather`, `health`, `explain` and `opportunity` sat in the repo with no route
 * that could reach them. Merging the branches that built them changed the source
 * tree and nothing a user could see.
 *
 * WHY AN ADAPTER AND NOT A SIGNATURE CHANGE. `EnginePort` is narrower than the
 * landed engine on three methods, and the features are tested against the port:
 *
 *   port  filterFeasible(ctx, items)             engine (ctx, candidates, opts)
 *   port  pack(ctx, items): Plan                  engine (ctx, feasible, opts): PackResult
 *   port  score(ctx, items, weights): Breakdown[] engine (ctx, one, weights, opts): Breakdown
 *
 * So the engine cannot be handed over directly, and the port must not be edited
 * to match it — that would mean touching the tests of seven feature folders to
 * re-plumb one caller. The gap is bridged here, once:
 *
 *   - `Candidate` decoration (the engine's gate and packer want travel times)
 *   - `FilterOptions` / `PackOptions`, including the weekday and month that must
 *     reach BOTH the gate and the packer or the plan is internally consistent
 *     and wrong
 *   - `PackResult` -> `Plan` assembly, which is the job `engine/plan.ts` exists
 *     to do and which the port's return type silently requires
 *   - per-item `score`, and `computeFit`'s third argument
 *
 * `travelBetween` is the one method that cannot be bridged: the port declares it
 * synchronous and returning a `TravelLeg`, and the real one is `async` and
 * returns a richer `TravelResult`. It throws with a message that says so rather
 * than resolving a promise nobody awaits, because a silently wrong leg is worse
 * than a loud one. `discover()` in the discovery feature never calls it — the
 * packer charges straight-line estimates — so this is a contract mismatch
 * waiting for a caller, not a live bug.
 */
import {
  computeFit as realComputeFit,
  filterFeasible as realFilterFeasible,
  pack as realPack,
  retrieve as realRetrieve,
  score as realScore,
  stress as realStress,
  validate as realValidate,
  replan as realReplan,
  DEFAULT_PROFILE,
  ENGINE_VERSION,
} from "@/engine";
import type {
  Candidate,
  FilterOptions,
  PackOptions,
  PackResult,
  TravelMode as EngineTravelMode,
} from "@/engine";
import type {
  ContextChange,
  DiscoveryContext,
  Experience,
  FeasibleResult,
  Fit,
  GeoPoint,
  Plan,
  ReplanResult,
  RetrieveInput,
  ScoreBreakdown,
  TravelLeg,
  ValidationResult,
  WeightProfile,
} from "@/contracts";
import { EPOCH_ISO, weekdayOf } from "@/lib/time";
import { haversineMetres } from "@/engine/geo";

import type { EnginePort, TravelMode } from "./engine";

/** Options the port's narrower signatures have nowhere to accept. */
export interface RealEngineOptions {
  /**
   * Day of week, 0 = Monday, matching `lib/time` and OSM's `Mo..Su`. Defaults to
   * the real current day, because the alternative — a hard-coded literal — is
   * the bug that made the old `page.tsx` evaluate Sunday's hours for a plan
   * whose comment claimed Saturday.
   */
  weekday?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** 1-12. Omit to disable the season gate rather than guess a month. */
  month?: number | null;
  /** Never lets the packer touch the network. The eval harness depends on this. */
  allowNetwork?: boolean;
}

/**
 * Origin -> venue walking estimate, the same pessimistic straight-line
 * approximation `engine/plan.ts` uses, so a card's travel time and the plan's
 * travel time are the same number rather than two similar ones.
 */
function estimateTravelMinutes(
  ctx: DiscoveryContext,
  experience: Experience,
  mode: EngineTravelMode,
): number {
  const from = ctx.origin.point;
  if (!from) return 0;
  const metres = haversineMetres(from, experience.location);
  const metresPerMinute =
    mode === "auto" ? 400 : mode === "transit" ? 250 : mode === "ferry" ? 300 : 80;
  return Math.max(1, Math.round((metres * 1.3) / metresPerMinute));
}

function modeOf(ctx: DiscoveryContext): EngineTravelMode {
  return ctx.travelMode === "any" ? "walk" : ctx.travelMode;
}

/** `Experience[]` -> the `Candidate[]` the gate and the packer both require. */
function toCandidates(
  ctx: DiscoveryContext,
  items: ReadonlyArray<Experience>,
  mode: EngineTravelMode,
): Candidate[] {
  const from = ctx.origin.point;
  return items.map((experience) => ({
    experience,
    travelMin: estimateTravelMinutes(ctx, experience, mode),
    distanceM: from ? haversineMetres(from, experience.location) : null,
    slot: null,
  }));
}

/**
 * The adapter. A plain object rather than a class: nothing here holds state, and
 * the features only ever pass it around.
 *
 * `weekday` and `month` are read from the closure on every call rather than
 * captured once, so a caller that crosses midnight mid-request gets the same
 * answer as one that did not.
 */
export function realEngine(options: RealEngineOptions = {}): EnginePort {
  const clock = (): { weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; month: number } => {
    const now = new Date();
    return {
      weekday: options.weekday ?? weekdayOf(now),
      month: options.month ?? now.getMonth() + 1,
    };
  };

  return {
    retrieve(input: RetrieveInput): Experience[] {
      return realRetrieve({ ...input, catalogue: [...input.catalogue] });
    },

    filterFeasible(ctx: DiscoveryContext, items: Experience[]): FeasibleResult {
      const { weekday, month } = clock();
      const mode = modeOf(ctx);
      const gateOpts: FilterOptions = { weekday, month };
      return realFilterFeasible(ctx, toCandidates(ctx, items, mode), gateOpts);
    },

    score(
      ctx: DiscoveryContext,
      items: Experience[],
      weights: WeightProfile,
    ): ScoreBreakdown[] {
      const mode = modeOf(ctx);
      return items.map((experience) =>
        realScore(ctx, experience, weights ?? DEFAULT_PROFILE, {
          travelMin: estimateTravelMinutes(ctx, experience, mode),
        }),
      );
    },

    /**
     * `PackResult` -> `Plan`.
     *
     * The port promises a `Plan` and the engine returns something that is
     * deliberately not one: no `utilisation`, no stress, no `createdAt`, no
     * `rejected`. `engine/plan.ts` does this assembly for the app's own call
     * path; this is the same ten lines for the features, and `validate` below is
     * what would catch it if the two ever drifted.
     */
    pack(ctx: DiscoveryContext, items: Experience[]): Plan {
      const { weekday, month } = clock();
      const mode = modeOf(ctx);
      const candidates = toCandidates(ctx, items, mode);

      // The gate runs here as well, because `PackOptions extends FilterOptions`
      // and the packer gates internally. A packer that gated on Sunday hours and
      // packed against Monday would produce a plan that is internally consistent
      // and wrong, so both get the same pair.
      const gateOpts: FilterOptions = { weekday, month };
      const gate = realFilterFeasible(ctx, candidates, gateOpts);
      const allowed = new Set(gate.passed);

      const packOpts: PackOptions = {
        ...gateOpts,
        travelContext: {
          atMin: ctx.nowMin,
          mode,
          allowNetwork: options.allowNetwork ?? false,
        },
      };
      const packed: PackResult = realPack(
        ctx,
        candidates.filter((candidate) => allowed.has(candidate.experience.id)),
        packOpts,
      );

      const assembled: Plan = {
        id: `plan-${ctx.id}`,
        contextId: ctx.id,
        stops: packed.stops,
        legs: packed.legs,
        totalMin: packed.totalMin,
        totalCost: packed.totalCost,
        utilisation: ctx.availableMin > 0 ? packed.totalMin / ctx.availableMin : 0,
        totalMetres: packed.totalMetres,
        rejected: gate.rejected,
        relaxations: [],
        stressScore: 0,
        stressFactors: [],
        createdAt: EPOCH_ISO,
        engineVersion: ENGINE_VERSION,
      };

      const measured = realStress(assembled, ctx);
      assembled.stressScore = measured.score;
      assembled.stressFactors = measured.factors;
      return assembled;
    },

    validate(plan: Plan): ValidationResult {
      return realValidate(plan);
    },

    replan(prev: Plan, ctx: DiscoveryContext, change: ContextChange): ReplanResult {
      return realReplan(prev, ctx, change);
    },

    /**
     * `FitInput` has no defaults for the fields that matter, so the visit window
     * is placed as early as the traveller could reach the place — the same
     * per-card estimate `app/_lib/discovery.ts` uses. The only thing this has to
     * be right about is the hours: a card whose window falls outside its opening
     * hours has to read closed.
     */
    computeFit(ctx: DiscoveryContext, exp: Experience): Fit {
      const { weekday } = clock();
      const travelMin = estimateTravelMinutes(ctx, exp, modeOf(ctx));
      const visitFrom = ctx.nowMin + travelMin + 10;
      return realComputeFit(ctx, exp, {
        travelMin,
        bufferMin: 10,
        visitFrom,
        visitTo: visitFrom + exp.durationMin,
        cost: exp.pricePerPerson ?? { minor: 0, currency: "INR" },
        weekday,
      });
    },

    stress(plan: Plan, ctx: DiscoveryContext) {
      return realStress(plan, ctx);
    },

    /**
     * NOT BRIDGED, ON PURPOSE.
     *
     * The port declares this synchronous and returning a `TravelLeg`; the real
     * one is `async` and returns a `TravelResult` with fields the port's callers
     * are not typed for. Inventing a synchronous leg here would mean either a
     * blocking network call on the server or a fabricated straight-line estimate
     * dressed up as a routed one, and the second is precisely the kind of quiet
     * lie this product is built not to tell — a leg that claims a mode and a
     * duration it never computed.
     *
     * Throwing is the honest failure: the message names the mismatch, and the
     * caller sees it in development rather than getting a plausible wrong number
     * in a demo. `discover()` in this folder charges straight-line estimates
     * instead, so nothing in the shipped path calls this.
     */
    travelBetween(
      _from: GeoPoint,
      _to: GeoPoint,
      _mode: TravelMode,
      _atMin: number,
    ): TravelLeg {
      throw new Error(
        "EnginePort.travelBetween is not bridged: the landed engine's travelBetween is " +
          "async and returns TravelResult, not a synchronous TravelLeg. Callers must use " +
          "the packer's travel estimates, or this port's method needs its signature changed " +
          "to Promise<TravelResult> and its callers with it.",
      );
    },
  };
}
