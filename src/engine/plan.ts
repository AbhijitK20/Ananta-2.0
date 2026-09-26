/**
 * src/engine/plan.ts
 *
 * The orchestrator: the one function that runs the whole pipeline end to end.
 *
 * WHY THIS EXISTS. Every stage was a pure function and every stage had a unit
 * test, but nothing ran them in sequence, which meant two real bugs could hide:
 * a stage whose output did not satisfy the next stage's input type, and a Plan
 * whose own totals did not add up. `pack()` returns a `PackResult`, which is
 * deliberately not a `Plan` (it has no utilisation, no stress, no createdAt), so
 * SOMETHING has to assemble the final contract shape — and until this file
 * existed, nothing did. The seam advertised `pack(): Plan` but the implementation
 * returned a different type, which is exactly the kind of drift a contract is
 * supposed to prevent.
 *
 * This is also the natural home for the "one number that says the plan is
 * trustworthy": it validates its own output before returning, and a plan that
 * fails validation is still returned (flagged) rather than thrown, because a
 * slightly-wrong plan the UI can render with a warning beats a 500. The caller
 * decides what to do with `validation`; this function does not hide it.
 *
 * Order matters and is the whole point:
 *   retrieve (narrow) -> filterFeasible (hard gate) -> pack (arrange)
 *   -> assemble Plan -> validate (independent check) -> stress (fragility)
 *
 * Purity: no I/O, no LLM, no Date. The catalogue and the context are inputs.
 */
import type {
  DiscoveryContext,
  Experience,
  FeasibleResult,
  Plan,
  Rejection,
  ValidationResult,
} from "@/contracts";
import { EPOCH_ISO } from "@/lib/time";
import { filterFeasible, type Candidate } from "./feasibility";
import { pack, ENGINE_VERSION, type PackResult } from "./packer";
import { retrieve } from "./retrieve";
import { stress } from "./stress";
import { validate } from "./validate";
import { haversineMetres } from "./geo";

/** Options for the orchestrator. All optional; the defaults are the demo path. */
export interface PlanOptions {
  /** Cap on returned candidates before the gate. Defaults to the retriever's 120. */
  limit?: number;
  /** Day of week for the visit, 0 = Monday. Gates that cannot read a date. */
  weekday?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Calendar month 1-12. Omit to disable the season gate rather than guess. */
  month?: number | null;
  /** Fixed RNG seed, so an eval run is reproducible. */
  seed?: number;
  /** Travel mode. Defaults to the context's preference, falling back to walk. */
  mode?: "walk" | "auto" | "transit" | "ferry";
  /** Allow the packer to use cached travel times. Network is never touched here. */
  allowNetwork?: boolean;
  /** Id for the assembled plan. Defaults to a function of the context id. */
  planId?: string;
}

/** Everything the UI and the eval harness need, in one honest envelope. */
export interface PlanResult {
  plan: Plan;
  /** The independent check. Surfaced, never swallowed. */
  validation: ValidationResult;
  /** How many rows survived retrieval, and how many the gate kept. */
  counts: {
    retrieved: number;
    candidates: number;
    passed: number;
    rejected: number;
    stops: number;
  };
  /** The hard-gate rejections, hoisted so "why not that" works without the plan. */
  rejected: Rejection[];
}

/**
 * Travel minutes from the traveller's origin to each candidate.
 *
 * A straight-line haversine at a walking pace, with a detour factor. This is an
 * UPPER-BOUND-ish estimate, deliberately pessimistic: the feasibility gate uses
 * it to reject things that are too far, so erring long rejects a few borderline
 * rows rather than admitting ones the traveller cannot reach. Live routing
 * belongs in `travel.ts` and is wired in by the caller when a provider is
 * available; the eval harness runs with this so it never touches the network.
 */
function estimateTravelMinutes(
  ctx: DiscoveryContext,
  e: Experience,
  mode: PlanOptions["mode"],
): number {
  const from = ctx.origin.point;
  if (!from) return 0;
  const metres = haversineMetres(from, e.location);
  // 1.3 detour factor: straight lines understate real street distance.
  const withDetour = metres * 1.3;
  const metresPerMinute =
    mode === "auto" ? 400 : mode === "transit" ? 250 : mode === "ferry" ? 300 : 80;
  return Math.max(1, Math.round(withDetour / metresPerMinute));
}

/**
 * Run the full pipeline and return a Plan plus its own verification.
 *
 * Never throws on a bad plan. If retrieval finds nothing, or the gate rejects
 * everything, the returned `Plan` is a valid empty plan with a populated
 * `rejected` list — which is the honest answer for "there is nothing here that
 * fits what you asked for", and is exactly the case the unmet-demand feed is
 * built to capture.
 */
export function planItinerary(
  ctx: DiscoveryContext,
  catalogue: readonly Experience[],
  opts: PlanOptions = {},
): PlanResult {
  const mode = opts.mode ?? (ctx.travelMode === "any" ? "walk" : ctx.travelMode);

  // 1. Retrieve: narrow the catalogue. Pure BM25, no LLM.
  // `retrieve` takes a mutable array (the contract's `RetrieveInput` predates
  // readonly collections), so we hand it a shallow copy rather than cast away
  // the caller's readonly.
  const experiences = retrieve({
    context: ctx,
    catalogue: [...catalogue],
    limit: opts.limit ?? 120,
  });

  // 2. Decorate with a travel estimate, which the gate and packer both need.
  const candidates: Candidate[] = experiences.map((e) => ({
    experience: e,
    travelMin: estimateTravelMinutes(ctx, e, mode),
    distanceM: ctx.origin.point ? haversineMetres(ctx.origin.point, e.location) : null,
    slot: null,
  }));

  // 3. The hard gate. Every drop emits a Rejection.
  const gate: FeasibleResult = filterFeasible(ctx, candidates, {
    weekday: opts.weekday ?? 1,
    month: opts.month ?? null,
  });

  // 4. Pack: cluster, order, and stay inside the window. `PackOptions` extends
  // the feasibility `FilterOptions`, so the same weekday/month the gate used has
  // to be forwarded here too — a packer that gated on Sunday hours and packed
  // against Monday would produce a plan that is internally consistent and wrong.
  const filterOpts = { weekday: opts.weekday ?? 1, month: opts.month ?? null } as const;
  const packed: PackResult = pack(
    ctx,
    candidates.filter((c) => gate.passed.includes(c.experience.id)),
    {
      ...filterOpts,
      travelContext: { atMin: ctx.nowMin, mode, allowNetwork: opts.allowNetwork ?? false },
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    },
  );

  // 5. Assemble the contract shape. `stressScore`/`stressFactors` are filled in
  // below by stress(), which needs the assembled plan's own totals.
  const assembled: Plan = {
    id: opts.planId ?? `plan-${ctx.id}`,
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

  // 6. The independent check, on the assembled plan.
  const validation = validate(assembled);

  // 7. Fragility, on the assembled plan. Assigned onto the plan (the contract
  // carries both fields) and returned.
  const s = stress(assembled, ctx);
  assembled.stressScore = s.score;
  assembled.stressFactors = s.factors;

  return {
    plan: assembled,
    validation,
    counts: {
      retrieved: experiences.length,
      candidates: candidates.length,
      passed: gate.passed.length,
      rejected: gate.rejected.length,
      stops: packed.stops.length,
    },
    rejected: gate.rejected,
  };
}
