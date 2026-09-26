/**
 * Narration: explain the plan the deterministic engine already produced.
 *
 * This is prose, not a decision. The engine has finished, the validator has
 * agreed, and nothing here can change a single stop. What this file is allowed
 * to do is make the result legible: why these stops, how the time and money add
 * up, what the travel looks like, what was traded away, and what the traveller
 * should know before they go.
 *
 * The honesty rule is enforced mechanically rather than asked for in a prompt:
 * every rupee amount, every duration and every percentage in the returned prose
 * must correspond to a figure that exists in the plan. A model that says "a
 * short walk across the bay" is fine; a model that says "25 minutes" when the
 * plan says 32 is not, and the whole narration is thrown away for the
 * deterministic one. Prose that invents a number is worse than no prose, because
 * the traveller budgets from it.
 *
 * The deterministic narration is therefore not a degraded mode bolted on at the
 * end. It is the reference implementation: it is always computed, it is what
 * every figure is checked against, and it is what ships when there is no model.
 */

import type { DiscoveryContext, LLMEnvelope, Plan } from "../contracts";
import { callText, toEnvelope } from "./client";
import { capProse, groundedFigures, guardTrip, unsupportedFigures } from "./guardrails";
import { formatMinutes, formatMoney, sentence } from "./format";
import { log } from "./log";

const MAX_WORDS = 170;

export type NarrateOptions = {
  /**
   * `experienceId -> display name`. The plan carries ids only, so without this the
   * prose says "the first stop" instead of a name. The caller has the catalogue;
   * this is the one optional input, and omitting it never invents a name.
   */
  labels?: Record<string, string>;
  signal?: AbortSignal;
};

export type NarrateResult = {
  text: string;
  degraded: boolean;
  envelope: LLMEnvelope;
  /** Why the model's prose was not used, when it was not. */
  rejected?: string;
};

// ---------------------------------------------------------------------------
// The fact sheet — the only facts prose is allowed to touch
// ---------------------------------------------------------------------------

/** The fact sheet, typed. Prose may state these values and nothing else. */
type PlanFacts = {
  stops: {
    position: number;
    name: string;
    arriveMin: number;
    departMin: number;
    fitRatio: number;
    verdict: string;
    checksFailed: string[];
    why: string[];
  }[];
  totalMin: number;
  availableMin: number;
  utilisationPct: number;
  totalCostMinor: number;
  currency: string;
  budgetMinor: number | null;
  budgetPerPersonMinor: number | null;
  travel: { legs: number; minutes: number; metres: number; byMode: Record<string, number> };
  context: {
    partySize: number;
    accessNeeds: string[];
    weather: string;
    interests: string[];
    avoid: string[];
  };
  tradeoffs: {
    rejected: number;
    topRejections: string[];
    relaxations: string[];
    stressScore: number;
    worstStressFactor: string | null;
    rescue: string | null;
  };
};

type FactSheet = {
  facts: PlanFacts;
  figures: Set<string>;
  label: (id: string) => string;
};

function collectMinutes(plan: Plan, ctx: DiscoveryContext): number[] {
  const out: number[] = [ctx.availableMin, ctx.nowMin, Math.abs(plan.totalMin)];
  for (const s of plan.stops) {
    out.push(s.arriveMin, s.departMin, s.fit.travelMin, s.fit.activityMin, s.fit.bufferMin, s.fit.totalMin, s.fit.availableMin);
  }
  for (const leg of plan.legs) out.push(leg.minutes);
  for (const r of plan.rejected) if (typeof r.shortfall === "number" && r.unit === "minutes") out.push(Math.abs(r.shortfall));
  return out.filter((n) => Number.isFinite(n));
}

/**
 * Everything the narrator may state, and the exact set of figures it may state it
 * with. Built from the plan and the context only.
 */
export function buildFactSheet(plan: Plan, ctx: DiscoveryContext, labels?: Record<string, string>): FactSheet {
  const label = (id: string): string => labels?.[id] ?? "";
  const currency = plan.totalCost.currency || ctx.budget?.currency || "INR";
  const budgetMinor = ctx.budget?.minor;
  const perPerson = ctx.budgetPerPerson?.minor;

  const stops = plan.stops.map((s, i) => ({
    position: i + 1,
    name: label(s.experienceId) || `stop ${i + 1}`,
    arriveMin: s.arriveMin,
    departMin: s.departMin,
    fitRatio: Number(s.fit.fitRatio.toFixed(2)),
    verdict: s.fit.verdict,
    checksFailed: s.fit.checks.filter((c) => !c.pass).map((c) => c.label),
    why: s.why.slice(0, 2),
  }));

  const modes = new Map<string, number>();
  for (const leg of plan.legs) modes.set(leg.mode, (modes.get(leg.mode) ?? 0) + leg.minutes);
  const worstStress = [...plan.stressFactors].sort((a, b) => b.weight * b.value - a.weight * a.value)[0];

  const facts: PlanFacts = {
    stops,
    totalMin: plan.totalMin,
    availableMin: ctx.availableMin,
    utilisationPct: Math.round(plan.utilisation * 100),
    totalCostMinor: plan.totalCost.minor,
    currency,
    budgetMinor: budgetMinor ?? null,
    budgetPerPersonMinor: perPerson ?? null,
    travel: {
      legs: plan.legs.length,
      minutes: plan.legs.reduce((sum, l) => sum + l.minutes, 0),
      metres: plan.totalMetres,
      byMode: Object.fromEntries(modes),
    },
    context: {
      partySize: ctx.partySize,
      accessNeeds: ctx.accessNeeds,
      weather: ctx.weather.condition,
      interests: ctx.interests,
      avoid: ctx.avoid,
    },
    tradeoffs: {
      rejected: plan.rejected.length,
      topRejections: plan.rejected.slice(0, 3).map((r) => r.message),
      relaxations: plan.relaxations.map((r) => `${r.label}: ${r.gaveUp}`),
      stressScore: Math.round(plan.stressScore),
      worstStressFactor: worstStress ? `${worstStress.dimension} ${Math.round(worstStress.weight * worstStress.value)}` : null,
      rescue: worstStress?.rescue ?? null,
    },
  };

  return {
    facts,
    label,
    figures: groundedFigures({
      // The unspent remainder is a fact about this plan, so prose may state it.
      moneyMinor: [
        plan.totalCost.minor,
        budgetMinor,
        perPerson,
        ...(budgetMinor != null ? [Math.abs(budgetMinor - plan.totalCost.minor)] : []),
      ].filter((n): n is number => typeof n === "number"),
      minutes: collectMinutes(plan, ctx),
      percents: [plan.utilisation * 100, plan.stressScore, ...plan.stops.map((s) => s.fit.fitRatio * 100)],
    }),
  };
}

// ---------------------------------------------------------------------------
// Deterministic narration — the reference implementation
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Composed entirely from the fact sheet. Every sentence is checkable against the
 * plan, which is why this doubles as the figure allow-list for the model's prose.
 */
export function deterministicNarration(plan: Plan, ctx: DiscoveryContext, labels?: Record<string, string>): string {
  const sheet = buildFactSheet(plan, ctx, labels);
  const parts: string[] = [];
  const currency = plan.totalCost.currency || "INR";

  // 1. What it is, and how well it uses the window.
  const util = Math.round(plan.utilisation * 100);
  const stopWord = plural(plan.stops.length, "stop");
  parts.push(
    plan.stops.length === 0
      ? `Nothing fits the ${formatMinutes(ctx.availableMin)} you have, so the plan is empty.`
      : `${stopWord[0]?.toUpperCase() ?? ""}${stopWord.slice(1)} over ${formatMinutes(plan.totalMin)}, using ${util}% of the ${formatMinutes(ctx.availableMin)} you have.`,
  );

  // 2. Money, always in the traveller's own currency and against their ceiling.
  const spent = formatMoney(plan.totalCost.minor, currency);
  if (ctx.budget) {
    const ceiling = formatMoney(ctx.budget.minor, ctx.budget.currency);
    const left = ctx.budget.minor - plan.totalCost.minor;
    parts.push(
      left >= 0
        ? `${spent} of the ${ceiling} ceiling, ${formatMoney(left, ctx.budget.currency)} unspent.`
        : `${spent}, which is ${formatMoney(-left, ctx.budget.currency)} over the ${ceiling} ceiling.`,
    );
  } else {
    parts.push(`${spent} in total, with no ceiling set.`);
  }

  // 3. Travel logic.
  if (plan.legs.length > 0) {
    const modeWord = Object.entries(sheet.facts.travel.byMode)
      .sort((a, b) => b[1] - a[1])
      .map(([mode, mins]) => `${mins} min by ${mode}`)
      .join(" and ");
    const distance = plan.totalMetres >= 1000 ? `${(plan.totalMetres / 1000).toFixed(1)} km` : `${plan.totalMetres} m`;
    parts.push(`${plural(plan.legs.length, "leg")} between them: ${modeWord}, ${distance} covered.`);
  }

  // 4. Why these, from the engine's own ledger.
  const reasons = plan.stops
    .map((s, i) => {
      const name = sheet.label(s.experienceId) || `stop ${i + 1}`;
      return s.why[0] ? `${name} (${s.why[0]})` : name;
    })
    .slice(0, 3);
  if (reasons.length > 0) parts.push(`Why these: ${reasons.join("; ")}.`);

  // 5. Tradeoffs, stated as what was given up.
  const tradeoffs: string[] = [];
  if (plan.relaxations.length > 0) {
    tradeoffs.push(plan.relaxations.map((r) => `${r.label}, which gave up ${r.gaveUp}`).join("; "));
  }
  if (plan.rejected.length > 0) {
    tradeoffs.push(`${plural(plan.rejected.length, "candidate")} did not make it`);
  }
  if (tradeoffs.length > 0) parts.push(sentence(tradeoffs.map((t) => t.charAt(0).toUpperCase() + t.slice(1))));

  // 6. Caveats a traveller can act on.
  const caveats: string[] = [];
  const tight = plan.stops.filter((s) => s.fit.verdict !== "fits");
  if (tight.length > 0) caveats.push(`${plural(tight.length, "stop")} is tight against the clock`);
  const stress = sheet.facts.tradeoffs;
  if (typeof stress.worstStressFactor === "string") {
    caveats.push(`the heaviest strain is ${stress.worstStressFactor}${typeof stress.rescue === "string" ? `, and the fix is to ${stress.rescue}` : ""}`);
  }
  if (plan.rejected.some((r) => r.code === "hours_unverified")) caveats.push("some opening hours are unverified");
  if (plan.rejected.some((r) => r.code === "weather_unsafe")) caveats.push(`weather rules out some options right now`);
  // Only the traveller's OWN words go in this sentence. `DiscoveryContext.avoid`
  // also carries the discovery editor's internal preference tokens
  // (`prefers_short_walks`, `indoors_only`, `mood_low_energy`), and printing
  // those at somebody is how "nothing you asked to avoid (prefers_short_walks) is
  // in here" reaches a demo. The filter needs no shared constant, because the
  // invariant is already enforced upstream: `cleanList` (the only path a
  // traveller's or a model's words take into `avoid`) keeps just
  // [a-z0-9 ₹/+&'-], so an underscore can ONLY have come from us.
  const spokenAvoid = ctx.avoid.filter((token) => !token.includes("_"));
  if (spokenAvoid.length > 0) caveats.push(`nothing you asked to avoid (${spokenAvoid.join(", ")}) is in here`);
  if (caveats.length > 0) parts.push(sentence(caveats.map((c) => c.charAt(0).toUpperCase() + c.slice(1))));

  return capProse(parts.join(" "), 1_400);
}

// ---------------------------------------------------------------------------
// Model narration
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  "You are explaining an itinerary that a deterministic engine has already produced and validated.",
  "You have no tools. You cannot add, remove, reorder or re-time anything.",
  "Use only the numbers in the provided data. If a fact is not in it, do not state it.",
  "Cover, in this order: how the plan uses the time window, what it costs against the ceiling, how the travel adds up, why these stops, what was traded away, and one caveat worth knowing.",
  "Quote the engine's own `why` lines rather than inventing a rationale.",
  "Plain prose, two or three short paragraphs. No markdown, no headings, no emoji, no bullet symbols.",
  "Never invent an opening time, a price, a distance or an accessibility claim.",
  "Return only the explanation.",
].join(" ");

/**
 * Deterministic narration, with the model's version substituted when — and only
 * when — every figure in it exists in the plan.
 */
export async function narrateDetailed(plan: Plan, ctx: DiscoveryContext, opts: NarrateOptions = {}): Promise<NarrateResult> {
  const fallback = deterministicNarration(plan, ctx, opts.labels);
  const sheet = buildFactSheet(plan, ctx, opts.labels);

  const result = await callText({
    role: "narrator",
    instructions: INSTRUCTIONS,
    prompt: `<plan data-only="true">\n${JSON.stringify(sheet.facts)}\n</plan>`,
    maxOutputTokens: 700,
    temperature: 0.6,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!result.ok) {
    log.info("narration_degraded", { reason: result.reason });
    return { text: fallback, degraded: true, envelope: toEnvelope(result) };
  }

  const text = capProse(result.value, 1_400);
  const rejected = rejectUnsupported(text, sheet.figures);
  if (rejected) {
    guardTrip("narration.unsupported_claim", rejected);
    return { text: fallback, degraded: true, envelope: toEnvelope(result), rejected };
  }
  if (text.split(/\s+/).length > MAX_WORDS) {
    guardTrip("narration.too_long", `${text.split(/\s+/).length} words`);
    return { text: fallback, degraded: true, envelope: toEnvelope(result), rejected: "too_long" };
  }
  if (!text) {
    return { text: fallback, degraded: true, envelope: toEnvelope(result), rejected: "empty" };
  }

  return { text, degraded: false, envelope: toEnvelope(result) };
}

/** @returns the offending figure, or null when every figure is grounded. */
function rejectUnsupported(text: string, figures: Set<string>): string | null {
  const bad = unsupportedFigures(text, figures);
  return bad[0] ?? null;
}

/** The contract's narration surface. */
export async function narrate(plan: Plan, ctx: DiscoveryContext, opts: NarrateOptions = {}): Promise<string> {
  return (await narrateDetailed(plan, ctx, opts)).text;
}
