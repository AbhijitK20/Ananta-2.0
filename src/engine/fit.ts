/**
 * The feasibility meter. One place computes `Fit`, so the card, the timeline and
 * the validator all read the same numbers.
 *
 * This is the arithmetic the whole product rests on, so it is deliberately dull:
 * no hidden defaults, no Date objects, integers throughout, and every `checks`
 * entry carries the number that produced it. The UI renders the strip; it never
 * recomputes.
 */
import type { DiscoveryContext, Experience, Fit, Money } from "@/contracts";
import { isOpenDuring, describeHours, intervalsForWeekday, type OpenVerdict } from "./hours";
import { toMajor, addMoney, compareMoney, formatMoney } from "@/lib/money";
import { formatDuration, MINUTES_PER_DAY, type Weekday } from "@/lib/time";

/** "09:30" from minutes-from-midnight. */
function clock(minutes: number): string {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Budget comparison that treats an absent ceiling as "not violated". */
function withinBudget(spent: Money, budget: Money | null): boolean {
  if (budget === null) return true;
  return compareMoney(spent, budget) <= 0;
}

export interface FitInput {
  /** Minutes from the previous stop (or the origin) to this one. */
  travelMin: number;
  /** Slack charged on top of travel: parking, queueing, finding the entrance. */
  bufferMin: number;
  /** Wall-clock window the visit actually occupies. */
  visitFrom: number;
  visitTo: number;
  /** Running total including this stop, for the budget row. */
  cost: Money;
  /** Cached answer from the gate, so we do not re-parse hours twice. */
  weekday?: number;
}

export function computeFit(
  ctx: DiscoveryContext,
  exp: Experience,
  input: FitInput,
): Fit {
  // `Weekday` is 0 = Monday. The gate always supplies it; the default is a
  // placeholder so the meter never NaNs, and is never reached in production.
  const weekday = (input.weekday ?? 3) as Weekday;
  const hours = isOpenDuring(exp.hours, weekday, input.visitFrom, input.visitTo);

  const partyMinor = exp.pricePerPerson === null ? 0 : exp.pricePerPerson.minor * ctx.partySize;
  const stopCost: Money =
    exp.pricePerPerson === null
      ? { minor: 0, currency: "INR" }
      : { minor: partyMinor, currency: exp.pricePerPerson.currency };
  const runningCost = addMoney(input.cost, stopCost);

  const totalMin = input.travelMin + input.bufferMin + exp.durationMin;
  const fitRatio = totalMin > 0 ? ctx.availableMin / totalMin : 1;
  const costPerHead = ctx.partySize > 0 ? toMajor(stopCost) / ctx.partySize : 0;

  const checks: Fit["checks"] = [
    {
      label: "Time",
      pass: totalMin <= ctx.availableMin,
      detail:
        totalMin <= ctx.availableMin
          ? `${formatDuration(totalMin)} of your ${formatDuration(ctx.availableMin)}`
          : `needs ${formatDuration(totalMin - ctx.availableMin)} more than you have left`,
    },
    {
      label: "Cost",
      pass: withinBudget(runningCost, ctx.budget),
      detail:
        ctx.budget === null
          ? exp.pricePerPerson === null
            ? "free"
            : `${formatMoney(stopCost)} for the party, no ceiling set`
          : withinBudget(runningCost, ctx.budget)
            ? `${formatMoney(runningCost)} of ${formatMoney(ctx.budget)}`
            : `${formatMoney({ minor: runningCost.minor - ctx.budget.minor, currency: runningCost.currency })} over your budget`,
    },
    {
      label: "Open",
      pass: hours.open,
      detail: hoursDetail(hours, exp.hours, weekday),
    },
    {
      label: "Group",
      pass: exp.capacity === null || exp.capacity >= ctx.partySize,
      detail:
        exp.capacity === null
          ? "no group limit"
          : exp.capacity >= ctx.partySize
            ? `takes up to ${exp.capacity}`
            : `takes only ${exp.capacity}, you are ${ctx.partySize}`,
    },
    {
      label: "Access",
      pass: accessPass(ctx, exp),
      detail: accessDetail(ctx, exp),
    },
  ];

  const verdict: Fit["verdict"] = !checks.every((c) => c.pass)
    ? "does_not_fit"
    : fitRatio < 1.15
      ? "tight"
      : "fits";

  return {
    experienceId: exp.id,
    travelMin: input.travelMin,
    activityMin: exp.durationMin,
    bufferMin: input.bufferMin,
    totalMin,
    availableMin: ctx.availableMin,
    fitRatio: Math.round(fitRatio * 100) / 100,
    cost: runningCost,
    budget: ctx.budget,
    checks,
    verdict,
  };
}

/**
 * `OpenVerdict` separates "confidently shut" from "we cannot tell", and so does
 * this copy. Collapsing the two is how a platform ends up telling a traveller
 * somewhere is closed when nobody ever knew its hours.
 */
function hoursDetail(v: OpenVerdict, hours: Experience["hours"], weekday: Weekday): string {
  if (v.status === "absent") return "hours not listed, so unverified";
  if (v.status === "unparsable") return "hours listed but we could not read them";
  if (v.unknown) return `we could not confirm; listed as ${describeHours(hours, weekday)}`;
  if (v.open) return "open for the whole visit";
  if (v.coveredMin > 0) return `open for only ${v.coveredMin} of those minutes`;
  return "closed at that time";
}

function accessPass(ctx: DiscoveryContext, exp: Experience): boolean {
  const a = exp.accessibility;
  if (ctx.accessNeeds.includes("wheelchair") && a.stepFree === false) return false;
  if (ctx.accessNeeds.includes("stroller") && a.strollerOk === false) return false;
  if (ctx.accessNeeds.includes("lowStairs") && a.lowStairs === false) return false;
  if (ctx.accessNeeds.includes("hearingLoop") && a.hearingLoop === false) return false;
  if (ctx.accessNeeds.includes("restroom") && a.restroomOnSite === false) return false;
  return true;
}

function accessDetail(ctx: DiscoveryContext, exp: Experience): string {
  if (ctx.accessNeeds.length === 0) return "no accessibility needs set";
  const a = exp.accessibility;
  const parts: string[] = [];
  if (ctx.accessNeeds.includes("wheelchair")) parts.push(a.stepFree === false ? "not step-free" : a.stepFree === true ? "step-free" : "step-free unverified");
  if (ctx.accessNeeds.includes("stroller")) parts.push(a.strollerOk === false ? "stroller unfriendly" : a.strollerOk === true ? "stroller ok" : "stroller unverified");
  if (ctx.accessNeeds.includes("restroom")) parts.push(a.restroomOnSite === false ? "no restroom on site" : a.restroomOnSite === true ? "restroom on site" : "restroom unverified");
  return parts.length ? parts.join(", ") : "no accessibility needs set";
}

/**
 * The named relaxation ladder.
 *
 * The reference implementation we rejected had a "relaxation" that was defeated
 * by its own objective ordering, and no code anywhere read the explanation it
 * wrote. A named ladder is duller and honest: we say which rung we are on and
 * what it cost.
 */
export const RELAXATION_LADDER = ["strict", "dropped_minimum", "greedy_fill", "single_best"] as const;
export type RelaxationRung = (typeof RELAXATION_LADDER)[number];

/**
 * Shrink a visit to the hours it is actually open, rather than dropping the stop.
 * The cheapest rung on the relaxation ladder: same place, different hour.
 */
export function tryShrinkToHours(
  exp: Experience,
  weekday: Weekday,
  wantFrom: number,
  wantTo: number,
): { from: number; to: number } | null {
  const { intervals } = intervalsForWeekday(exp.hours, weekday);
  let best: { from: number; to: number } | null = null;
  let bestOverlap = 0;
  for (const w of intervals) {
    const from = Math.max(wantFrom, w.startMin);
    const to = Math.min(wantTo, w.endMin);
    const overlap = to - from;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = { from, to };
    }
  }
  return best;
}
