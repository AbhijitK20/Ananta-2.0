/**
 * The render model. Every string a what-if panel shows, resolved here.
 *
 * The rule this file exists to enforce is the repo's own: the engine computes,
 * the UI renders. A panel that receives a `ScenarioResult` and does arithmetic
 * on it will get that arithmetic wrong in at least one place — a percent rendered
 * as a ratio, a delta sign that means nothing without knowing which direction is
 * good — and it will do it silently, because the number still looks like a
 * number. So all of that happens once, here, where it can be tested.
 *
 * Nothing here is generated. Every string is a format applied to a number the
 * engine produced, or a sentence the engine wrote in a `Rejection.message` or a
 * `PlanStop.why`. There is no template that invents a claim.
 *
 * `hypothetical: true` is a literal, not a string, so a component that renders a
 * panel cannot forget to label it: the type will not let it be anything else.
 */
import { hm, money, plural } from "../discovery/format";
import { findingsIn, type GateChange } from "./gates";
import { type AxisComparison, type ScenarioDelta, type ScenarioResult } from "./scenario";

export type PanelDirection = "up" | "down" | "flat";

export type PanelRow = {
  id: string;
  label: string;
  before: string;
  after: string;
  /** Signed and formatted, or "" when nothing changed. */
  delta: string;
  direction: PanelDirection;
  /**
   * Whether going up is good news. The COLOUR decision, kept beside the number
   * that causes it so the two cannot be separated. More stops is good, more
   * spending is not, and a component guessing this is how a plan renders its
   * overspend in the reassuring colour.
   */
  higherIsBetter: boolean;
};

export type PanelStop = {
  id: string;
  name: string;
  /** The engine's sentence, or null when it gave none. Never invented here. */
  reason: string | null;
};

export type WhatIfPanel = {
  question: string | null;
  headline: string;
  verdict: ScenarioDelta;
  rows: PanelRow[];
  /** In the hypothetical day, not in the live one. */
  added: PanelStop[];
  removed: PanelStop[];
  /** Blocked before, possible now. The answer to "what did that buy". */
  unlocked: PanelStop[];
  /** The hypothetical's own limits, broken. */
  breaches: { axis: string; message: string }[];
  /** Engine findings, phrased as findings. */
  findings: string[];
  /** Always true. A what-if is not bookable and the type says so. */
  hypothetical: true;
};

// ---------------------------------------------------------------------------
// Formatting, once
// ---------------------------------------------------------------------------

type Unit = AxisComparison["unit"];

const value = (unit: Unit, n: number): string => {
  switch (unit) {
    case "count":
      return plural(n, "stop", "stops");
    case "minor_units":
      // -1 is this file's "no ceiling" sentinel, and the only value that can
      // reach here, so it renders as the absence of a limit rather than as a
      // negative rupee amount.
      return n < 0 ? "no limit" : money(n);
    case "metres":
      return `${n} m`;
    case "minutes":
      return hm(n);
    case "ratio":
      return `${Math.round(n * 100)}%`;
  }
};

const signed = (unit: Unit, n: number): string => {
  if (n === 0) return "";
  const sign = n > 0 ? "+" : "-";
  const magnitude = Math.abs(n);
  switch (unit) {
    case "count":
      return `${sign}${magnitude}`;
    case "minor_units":
      return n < 0 ? "" : `${sign}${money(magnitude)}`;
    case "metres":
      return `${sign}${magnitude} m`;
    case "minutes":
      return `${sign}${hm(magnitude)}`;
    case "ratio":
      // Percentage POINTS, not a percentage of a percentage. A utilisation that
      // goes 0.62 -> 0.84 is +22 points, and rendering that as +22% is wrong by
      // a factor that grows with the number.
      return `${sign}${Math.round(magnitude * 100)}pp`;
  }
};

function row(
  id: string,
  label: string,
  axis: AxisComparison,
  higherIsBetter: boolean,
): PanelRow {
  return {
    id,
    label,
    before: value(axis.unit, axis.before),
    after: value(axis.unit, axis.after),
    delta: signed(axis.unit, axis.delta),
    direction: axis.delta > 0 ? "up" : axis.delta < 0 ? "down" : "flat",
    higherIsBetter,
  };
}

const stopLine = (id: string, name: string, reason: string | null): PanelStop => ({ id, name, reason });

/**
 * The headline, in this order of precedence:
 *
 *   infeasible  the hypothetical's own limit is broken. Leads with the shortfall
 *               because a plan that cannot be done IS the answer, and burying it
 *               under "we swapped one stop" is how a broken promise ships.
 *   unlocked    something became possible that was not. This is the most
 *               interesting outcome and the easiest to miss.
 *   otherwise   the engine's own reason for the first thing that left.
 */
function headlineOf(result: ScenarioResult): string {
  if (result.breaches.length > 0) {
    const first = result.breaches[0];
    return first ? `${result.change.narrative} ${first.message}` : result.change.narrative;
  }
  const unlocked = result.gates.filter((change) => change.kind === "unlocked");
  if (unlocked.length > 0) {
    return `${result.change.narrative} That makes possible: ${unlocked.map((c) => c.name).join(", ")}.`;
  }
  return result.reality.reason;
}

const findingLine = (change: GateChange): string =>
  `${change.name} left the plan with no reason attached. Every drop should carry one.`;

/**
 * The whole panel, ready to render. `question` is the traveller's own words when
 * the caller has them; the panel never invents a question to go with an answer.
 */
export function present(result: ScenarioResult, question: string | null = null): WhatIfPanel {
  const { compare, reality, gates } = result;
  return {
    question,
    headline: headlineOf(result),
    verdict: result.delta,
    rows: [
      row("stops", "Stops", compare.stops, true),
      row("spend", "Spend", compare.spend, false),
      row("time", "Time used", compare.plannedMin, true),
      row("walking", "Walking", compare.walkingMetres, false),
      row("window", "Your window", compare.windowMin, true),
      row("utilisation", "Window used", compare.utilisation, true),
      row("stress", "Stress", compare.stress, false),
    ],
    added: reality.added.map((entry) => stopLine(entry.id, entry.name, entry.reason)),
    removed: reality.removed.map((entry) => stopLine(entry.id, entry.name, entry.reason)),
    unlocked: gates
      .filter((change) => change.kind === "unlocked")
      .map((change) => stopLine(change.id, change.name, change.reason)),
    breaches: result.breaches.map((breach) => ({ axis: breach.axis, message: breach.message })),
    findings: findingsIn(gates).map(findingLine),
    hypothetical: true,
  };
}
