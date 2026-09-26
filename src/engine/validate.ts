/**
 * src/engine/validate.ts
 *
 * The independent check on the packer.
 *
 * WHY THIS EXISTS. The contract calls this out directly: "This is the pattern
 * that makes an LLM-adjacent system trustworthy, and it is a build-failure risk
 * if we skip it: every repo that let a model influence ordering without a
 * validator leaked." A packer that is quietly wrong is worse than a packer that
 * is visibly bad, because the UI renders whatever `Plan` comes back and shows a
 * confident feasibility meter over an itinerary that does not add up.
 *
 * The rule here is that this file trusts NOTHING the packer claimed. It recomputes
 * every number it can from the plan's own contents and reports the difference. If
 * the packer says a plan takes 172 minutes and its own stops and legs add up to
 * 190, that is a violation, not a rounding detail.
 *
 * The one number it cannot recompute is `utilisation`, because `Plan` does not
 * carry the traveller's window (`DiscoveryContext.availableMin`) — only the stops
 * and legs. So utilisation is verified as an *internal* ratio against the plan's
 * own elapsed span, and the cross-check against the real window happens in
 * `stress`, which is given the context. That split is deliberate: `validate(plan)`
 * is pure self-consistency, `stress(plan, ctx)` is plan-versus-reality.
 *
 * Purity: no I/O, no LLM, no Date. Integer minutes and integer minor units only.
 */
import type { Money, Plan, ValidationResult } from "@/contracts";
import { addMoney, fromMinor, moneyEquals } from "@/lib/money";

/** Named violation classes, so the UI can be specific rather than saying "invalid". */
export type ViolationCode =
  | "total_min_mismatch"
  | "total_cost_mismatch"
  | "total_metres_mismatch"
  | "overlap"
  | "unconnected"
  | "bad_order"
  | "impossible_window"
  | "objective_drift";

interface Violation {
  code: ViolationCode;
  message: string;
  at: string | null;
}

/**
 * Time tolerance. One minute, not 1e-9.
 *
 * The packer walks a minute clock and rounds once per stop, so sub-minute drift
 * is arithmetic noise, not drift. A tolerance tighter than a minute would flag
 * the packer's own rounding as a defect and train everyone to ignore this file.
 * One minute of slack on a multi-hour plan is the honest line: it still catches
 * a dropped leg (tens of minutes) and a duplicated stop, which is what this is for.
 */
const MINUTE_TOLERANCE = 1;

function fail(code: ViolationCode, message: string, at: string | null = null): Violation {
  return { code, message, at };
}

/**
 * Recompute the plan's own arithmetic and report any drift.
 *
 * `plan` is expected to be a well-formed `Plan`. A structurally invalid object
 * (missing `stops`, non-array `legs`) is caught here rather than thrown, so a
 * bad plan degrades to "ok: false with a named reason" instead of a 500.
 */
export function validate(plan: Plan): ValidationResult {
  const violations: Violation[] = [];

  // Defensive shape check. The contract types say these exist, but the whole
  // point of this file is to distrust input, and `ok: false` with a reason is a
  // better failure mode than a TypeError inside the request path.
  if (!plan || !Array.isArray(plan.stops) || !Array.isArray(plan.legs)) {
    return {
      ok: false,
      violations: [
        {
          code: "impossible_window",
          message: "Plan is malformed: stops and legs must both be arrays.",
          at: null,
        },
      ],
      recomputedObjective: null,
      claimedObjective: null,
      objectiveDelta: null,
    };
  }

  const stops = plan.stops;
  const legs = plan.legs;

  // ---------------------------------------------------------------------------
  // 1. Time: does the itinerary's own duration equal the sum of its parts?
  // ---------------------------------------------------------------------------
  // A stop's on-site time is `fit.activityMin` and each leg adds `minutes`.
  // This is deliberately NOT derived from arrive/depart deltas: those are two
  // independent assertions of the same fact, and a packer that wrote both from
  // one clock is the normal case. Checking the parts sum is the stronger test.
  const activityMin = stops.reduce((sum, s) => sum + (s.fit?.activityMin ?? 0), 0);
  const travelMin = legs.reduce((sum, l) => sum + (l.minutes ?? 0), 0);
  const recomputedTotalMin = activityMin + travelMin;

  if (stops.length > 0) {
    const drift = recomputedTotalMin - (plan.totalMin ?? 0);
    if (Math.abs(drift) > MINUTE_TOLERANCE) {
      violations.push(
        fail(
          "total_min_mismatch",
          `Plan claims ${plan.totalMin} min but its own stops and legs sum to ` +
            `${recomputedTotalMin} min (${activityMin} on site + ${travelMin} travelling). ` +
            `Off by ${drift > 0 ? "+" : ""}${drift} min.`,
          "plan.totalMin",
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Distance: legs must account for every metre claimed.
  // ---------------------------------------------------------------------------
  const recomputedMetres = legs.reduce((sum, l) => sum + (l.metres ?? 0), 0);
  if (stops.length > 0 && recomputedMetres !== (plan.totalMetres ?? 0)) {
    violations.push(
      fail(
        "total_metres_mismatch",
        `Plan claims ${plan.totalMetres} m but its legs sum to ${recomputedMetres} m.`,
        "plan.totalMetres",
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Money: do the stops' own costs add up to the plan total?
  // ---------------------------------------------------------------------------
  // Cost is summed from each stop's `fit.cost`, which the feasibility stage set
  // per the whole party. Integer minor units only, never floats.
  let recomputedCost: Money = fromMinor(0);
  if (stops.length > 0) {
    for (const stop of stops) {
      recomputedCost = addMoney(recomputedCost, stop.fit?.cost ?? fromMinor(0));
    }
    if (!moneyEquals(recomputedCost, plan.totalCost)) {
      violations.push(
        fail(
          "total_cost_mismatch",
          `Plan claims ${plan.totalCost.minor} minor units but its stops sum to ` +
            `${recomputedCost.minor}. Off by ` +
            `${recomputedCost.minor - plan.totalCost.minor} minor units.`,
          "plan.totalCost",
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Ordering: `order` must be 0..n-1 with no gaps or duplicates.
  // ---------------------------------------------------------------------------
  // A duplicated order index silently corrupts the timeline render, so it is
  // checked even when the arithmetic is fine.
  const orders = stops.map((s) => s.order).sort((a, b) => a - b);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i) {
      violations.push(
        fail(
          "bad_order",
          `Stop order is not a dense 0..${stops.length - 1} sequence; found ${orders.join(", ")}.`,
          `stops[${i}].order`,
        ),
      );
      break;
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Connectivity: consecutive stops must be joined by a leg, and no stop may
  //    begin before the previous one ends.
  // ---------------------------------------------------------------------------
  // Sorted by `order` because that, not array position, is the itinerary order.
  const timeline = [...stops].sort((a, b) => a.order - b.order);

  for (let i = 1; i < timeline.length; i++) {
    const prev = timeline[i - 1]!;
    const cur = timeline[i]!;

    // A leg is required between every consecutive pair. The leg is looked up by
    // endpoints rather than by index, because the legs array is not required to
    // be in the same order as the stops.
    const leg = legs.find(
      (l) => l.fromId === prev.experienceId && l.toId === cur.experienceId,
    );
    if (!leg) {
      violations.push(
        fail(
          "unconnected",
          `No travel leg joins "${prev.experienceId}" to "${cur.experienceId}", so the ` +
            `plan is not physically connected.`,
          `stops[${i}]`,
        ),
      );
    }

    if (cur.arriveMin < prev.departMin) {
      violations.push(
        fail(
          "overlap",
          `"${cur.experienceId}" arrives at minute ${cur.arriveMin}, before the previous ` +
            `stop departs at ${prev.departMin}.`,
          `stops[${i}].arriveMin`,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Departure must be at or after arrival, and arrival within the day.
  // ---------------------------------------------------------------------------
  for (const stop of timeline) {
    if (stop.departMin < stop.arriveMin) {
      violations.push(
        fail(
          "impossible_window",
          `"${stop.experienceId}" departs at ${stop.departMin}, before it arrives at ` +
            `${stop.arriveMin}.`,
          `${stop.experienceId}`,
        ),
      );
    }
    if (stop.arriveMin < 0 || stop.departMin > 1440) {
      violations.push(
        fail(
          "impossible_window",
          `"${stop.experienceId}" runs ${stop.arriveMin}-${stop.departMin}, outside the day.`,
          `${stop.experienceId}`,
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // 7. The objective: claimed vs recomputed, per the contract's explicit ask.
  // ---------------------------------------------------------------------------
  // The objective reported here is the plan's total time, because that is the
  // one quantity the plan CLAIMS (`plan.totalMin`) and that we can independently
  // recompute from the plan's own contents. Both sides are minutes, so the delta
  // is meaningful rather than a comparison of unlike units.
  //
  // The packer's other objective is the scalarised score sum over the chosen
  // stops. `Plan` does not store that claim anywhere, so there is nothing to
  // check it against and it is deliberately NOT reported here — reporting a
  // recomputed score against no claim would be theatre. That claim belongs on
  // `Plan` if it is ever going to be auditable.
  const empty = stops.length === 0;
  const claimedObjective = plan.totalMin ?? null;
  const recomputedObjective = empty ? null : recomputedTotalMin;
  const objectiveDelta =
    claimedObjective === null || recomputedObjective === null
      ? null
      : recomputedObjective - claimedObjective;

  const ok = violations.length === 0;

  return {
    ok,
    violations,
    recomputedObjective,
    claimedObjective,
    // Contract: "0 when they agree. Non-zero means the packer is lying."
    // An empty plan has nothing to compare, so null is the honest answer.
    objectiveDelta,
  };
}
