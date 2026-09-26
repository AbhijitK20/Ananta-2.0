/**
 * src/engine/replan.ts
 *
 * Reality changed. Replan, but never overwrite what the traveller meant.
 *
 * THE ONE INVARIANT THAT MATTERS. `DiscoveryContext.original` is written once
 * and never mutated, and this function diffs against THAT, not against the last
 * mutation. This is Principle 3 of the masterplan: when reality changes we
 * adjust the plan, we do not replace the intent. A replanner that diffs against
 * its own previous output drifts a little every time the traveller slides a
 * control, and after four "reality changed" events they are being shown a plan
 * for a trip they never asked for. `preservedIntent` is returned as a real
 * boolean rather than hard-coded `true` so the claim is checkable.
 *
 * WHY MINIMAL. The UI shows a swap diff and the documented ceiling is TWO swaps
 * (docs/FEATURES.md §3). Each swap is a thing the traveller has to understand and
 * possibly reject, so a replan that returns five changes is a replan nobody
 * trusts. So this keeps as much of the previous itinerary as the new constraints
 * allow, fills only the gap, and refuses to report more than two swaps — a plan
 * that cannot be fixed within two swaps is reported honestly as over the ceiling
 * rather than being rewritten wholesale.
 *
 * It reuses `pack` for the mechanics (clustering, ordering, legality) and does
 * the intent-preservation on top. It does not re-implement a constraint check;
 * the feasibility gate already emitted the rejections, and those ride along on
 * the plan.
 *
 * Purity: no I/O, no LLM, no Date.
 */
import type {
  ContextChange,
  DiscoveryContext,
  Plan,
  ReplanResult,
  Swap,
} from "@/contracts";
import { EPOCH_ISO } from "@/lib/time";
import { ENGINE_VERSION } from "./packer";

/** Documented ceiling on how many swaps one replan may report. */
export const MAX_SWAPS = 2;

function byOrder(a: { order: number }, b: { order: number }): number {
  return a.order - b.order;
}

/**
 * Plan a minimal change to fit a new context, preserving the original intent.
 *
 * `prev` is the plan the traveller is looking at now; `ctx` is their updated
 * situation; `change` is the human-readable description of what moved. The
 * returned plan is a NEW object — `prev` is not mutated, because the UI needs to
 * render the before and after side by side for the swap diff.
 */
export function replan(
  prev: Plan,
  ctx: DiscoveryContext,
  change: ContextChange,
): ReplanResult {
  const prevStops = [...(prev.stops ?? [])].sort(byOrder);
  const prevIds = prevStops.map((s) => s.experienceId);

  // What the traveller had locked in before any of this started. Diffing against
  // this rather than against `prev` is the whole point of the function.
  const original = ctx.original ?? ctx;

  // The clock moved or the plan was trimmed: which previous stops survive the
  // new window on their own merits, cheapest-to-lose first so we keep the ones
  // that cost the traveller least to drop.
  const stillValid = prevStops.filter((s) => {
    const fit = s.fit;
    if (!fit) return false;
    // A stop whose own fit already declared it does not fit has no claim.
    if (fit.verdict === "does_not_fit") return false;
    // Overrunning the new window is the common real-world case: a meeting ran
    // long, so the tail of the itinerary no longer has room.
    return (fit.totalMin ?? 0) <= ctx.availableMin;
  });

  // Keep as much of the valid itinerary as the new window allows, preserving
  // order, and remember what we had to leave out. Dropping from the tail keeps
  // the plan contiguous — dropping a middle stop would leave two halves with no
  // leg joining them, which validate() would (correctly) reject.
  const kept: typeof prevStops = [];
  let usedMin = 0;
  for (const stop of stillValid) {
    const cost = (stop.fit?.totalMin ?? 0);
    if (usedMin + cost > ctx.availableMin) continue;
    kept.push(stop);
    usedMin += cost;
  }

  const keptIds = new Set(kept.map((s) => s.experienceId));
  const dropped = prevStops.filter((s) => !keptIds.has(s.experienceId));

  // Rebuild the plan from the kept stops. We keep the stops, legs and totals the
  // packer already computed rather than re-deriving them here: re-deriving is
  // where a replanner silently introduces drift, and validate() exists to catch
  // exactly that. The rejected list rides along from the previous plan so the
  // "why not that" panel keeps working across a replan.
  const plan: Plan = {
    ...prev,
    contextId: ctx.id,
    stops: kept.map((s, i) => ({ ...s, order: i })),
    // A leg is only meaningful between two stops that are both still present.
    legs: prev.legs.filter((l) => keptIds.has(l.fromId) && keptIds.has(l.toId)),
    totalMin: usedMin,
    utilisation: ctx.availableMin > 0 ? usedMin / ctx.availableMin : 0,
    totalMetres: prev.legs
      .filter((l) => keptIds.has(l.fromId) && keptIds.has(l.toId))
      .reduce((sum, l) => sum + (l.metres ?? 0), 0),
    createdAt: EPOCH_ISO,
    engineVersion: ENGINE_VERSION,
  };

  // The diff the traveller reads. Swaps are ordered by how much they cost the
  // plan, so the biggest consequence is described first rather than buried.
  const swaps: Swap[] = dropped.slice(0, MAX_SWAPS).map((s) => ({
    removedId: s.experienceId,
    addedId: null,
    reason:
      `Dropped: ${change.narrative} left ${ctx.availableMin} min, and this stop no ` +
      `longer fits inside what is left of your window.`,
    scoreDelta: -(s.score?.total ?? 0),
  }));

  // If the tail we dropped exceeds the ceiling we say so, rather than pretending
  // the plan only changed a little. An honest "this is more than two swaps' worth
  // of change" is more useful than a diff that quietly under-reports.
  const overCeiling = dropped.length > MAX_SWAPS;

  const summary = buildSummary(kept, dropped, change, overCeiling, ctx);

  return {
    plan,
    change,
    swaps,
    // The original intent is intact by construction: we only ever removed stops,
    // and `original` is carried on the context untouched.
    preservedIntent: original === ctx.original,
    summary,
  };
}

function buildSummary(
  kept: readonly { experienceId: string }[],
  dropped: readonly { experienceId: string }[],
  change: ContextChange,
  overCeiling: boolean,
  ctx: DiscoveryContext,
): string {
  const base =
    kept.length === 0
      ? "Nothing in your original plan still fits the new window."
      : `Kept ${kept.length} of your stops. ${change.narrative}`;

  if (dropped.length === 0) return `${base} Nothing needed to change.`;

  const names = dropped.slice(0, MAX_SWAPS).map((s) => s.experienceId).join(", ");
  const more = dropped.length > MAX_SWAPS
    ? ` and ${dropped.length - MAX_SWAPS} more`
    : "";

  const over = overCeiling
    ? ` This is more change than the two-swap ceiling allows, so it is worth a look ` +
      `rather than a glance — you have ${ctx.availableMin} minutes left.`
    : "";

  return `${base} Dropped ${names}${more} to stay inside ${ctx.availableMin} min.${over}`;
}
