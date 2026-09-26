/**
 * src/engine/stress.ts
 *
 * The Trip Stress Radar: how hard a plan is to actually live through.
 *
 * WHY THIS IS NOT A FIT SCORE. `computeFit` answers "does this one stop fit in
 * your remaining window". `stress` answers a different question about the whole
 * itinerary: even when every stop individually fits and nothing is rejected,
 * how fragile is the result? A plan can be 100% feasible and still exhausting
 * — six back-to-back stops with no slack, a 40-minute walk in 32°C heat, or a
 * single closed door that collapses half the day. Feasibility is necessary, not
 * sufficient, and the gap between them is what this measures.
 *
 * SEVEN DIMENSIONS, each 0..1 where 1 is worst, each with a weight that sums to
 * 1. Weights are a documented editorial judgement, not a measurement, and they
 * are exported so the UI can show them rather than presenting the total as a
 * fact from nature.
 *
 * The score is the weighted mean of the dimension values, scaled to 0..100.
 * Labels break at 38 and 68: below 38 relaxed, 38-68 workable, above 68
 * relentless. Those thresholds are Karan's (TASKS.md, Day 3) and are exported
 * so the two sides cannot drift.
 *
 * `rescue` is populated for the single highest-impact factor only, because a
 * list of eight suggestions is a list nobody reads. That matches the contract:
 * "The single highest-impact fix. Only for the worst factor."
 *
 * Purity: no I/O, no LLM, no Date. All clock values are integer minutes already
 * carried on the plan.
 */
import type { DiscoveryContext, Plan, WeatherNow } from "@/contracts";

/** The dimension keys. Stable strings: the UI and saved plans key off these. */
export const STRESS_DIMENSIONS = [
  "utilisation",
  "buffer",
  "cost",
  "travel",
  "pacing",
  "fragility",
  "pacing_crowd",
] as const;

export type StressDimension = (typeof STRESS_DIMENSIONS)[number];

/**
 * Weights per dimension, summing to 1.
 *
 * Ordering reflects how often each one actually ruins a day, which is a judgement
 * call from reading the eval scenarios rather than a fitted model. The three
 * "load" dimensions (utilisation, buffer, pacing) carry half the weight between
 * them because being over-committed, having no slack, and being scheduled at the
 * wrong hour are the three that make people abandon an itinerary.
 */
export const STRESS_WEIGHTS: Record<StressDimension, number> = {
  utilisation: 0.26,
  buffer: 0.16,
  cost: 0.14,
  travel: 0.14,
  pacing: 0.12,
  fragility: 0.12,
  pacing_crowd: 0.06,
};

/** Label thresholds, exported so the radar and the copy cannot disagree. */
export const STRESS_LABELS = {
  relaxed: 38,
  relentless: 68,
} as const;

export type StressLabel = "relaxed" | "workable" | "relentless";

export function stressLabel(score: number): StressLabel {
  if (score >= STRESS_LABELS.relentless) return "relentless";
  if (score >= STRESS_LABELS.relaxed) return "workable";
  return "relaxed";
}

interface Factor {
  dimension: StressDimension;
  weight: number;
  value: number;
  rescue: string | null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function moneyMinor(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/** 25..34°C is the band where an outdoor stop starts costing energy. */
function heatLoad(weather: WeatherNow): number {
  if (weather.condition === "heat") return 1;
  if (weather.condition === "heavy_rain" || weather.condition === "storm") return 0.7;
  if (weather.condition === "light_rain") return 0.35;
  return clamp01((weather.tempC - 25) / 10);
}

/**
 * Score a packed plan.
 *
 * Every dimension is clamped to 0..1 before weighting, so one catastrophic
 * dimension cannot push the total above 100 and a comfortable plan cannot hide
 * behind averaging. A plan with three perfect dimensions and one that is
 * off-the-scale is still a bad plan, and clamping is what makes that true.
 */
export function stress(
  plan: Plan,
  ctx: DiscoveryContext,
): { score: number; factors: Plan["stressFactors"] } {
  const factors: Factor[] = [];
  const stops = plan.stops ?? [];
  const legs = plan.legs ?? [];

  // An empty plan is not stressful, it is just empty. Scoring it as 100 would
  // put a bright red radar on a blank state and train people to ignore it.
  if (stops.length === 0) {
    return {
      score: 0,
      factors: STRESS_DIMENSIONS.map((dimension) => ({
        dimension,
        weight: STRESS_WEIGHTS[dimension],
        value: 0,
        rescue: null,
      })),
    };
  }

  // --- 1. utilisation: how much of the window is spoken for -------------------
  // 0 when the plan uses under three-quarters of the time, 1 when it overruns.
  const availableMin = Math.max(1, ctx.availableMin);
  const useRatio = (plan.totalMin ?? 0) / availableMin;
  const utilisation = clamp01(useRatio <= 0.75 ? (useRatio / 0.75) * 0.4 : 0.4 + (useRatio - 0.75));

  // --- 2. buffer: the slack the plan deliberately left ------------------------
  // Aggregate buffer as a share of the plan. A plan with no buffer is knife-edge:
  // one late train and the last stop falls off the end.
  const bufferMin = stops.reduce((sum, s) => sum + (s.fit?.bufferMin ?? 0), 0);
  const bufferShare = bufferMin / Math.max(1, plan.totalMin || 1);
  const buffer = clamp01(1 - bufferShare / 0.15);

  // --- 3. cost: budget burn ---------------------------------------------------
  // Only meaningful when a budget exists. No budget means no cost stress, not
  // an assumed one.
  const budgetMinor = moneyMinor(ctx.budget?.minor);
  const cost = budgetMinor > 0
    ? clamp01(moneyMinor(plan.totalCost?.minor) / budgetMinor)
    : 0;

  // --- 4. travel: how much of the day is spent moving -------------------------
  // Walking-heavy days are the ones people remember as exhausting. The 0.5
  // normaliser means "half the day is travel" reads as maximally stressful.
  const travelMin = legs.reduce((sum, l) => sum + (l.minutes ?? 0), 0);
  const travelShare = travelMin / Math.max(1, plan.totalMin || 1);
  const travel = clamp01(travelShare / 0.5);

  // --- 5. pacing: stops scheduled at a hostile hour of day ---------------------
  // `Experience.bestTimeOfDay` is the real preference signal, but it lives on the
  // catalogue row, not on `PlanStop`, and this function is given the plan and the
  // context only. Inventing a category-to-hour table here would be us guessing at
  // the traveller's behalf, so the dimension is deliberately narrow: it penalises
  // only hours that are hostile regardless of category. A 06:00 start or a
  // 23:30 finish is a scheduling mistake for anything; everything between is the
  // catalogue's business, not this function's.
  let hostileHour = 0;
  for (const stop of stops) {
    const arrive = stop.arriveMin;
    if (arrive < 420 || arrive > 1380) hostileHour += 1;
  }
  const pacing = clamp01(hostileHour / Math.max(1, stops.length));

  // --- 6. fragility: how many stops fail if one goes wrong ---------------------
  // Counted, not weighted: two independent fallback options is genuinely
  // different from one, and three is no better than two. Capped so a long day
  // cannot dominate the other six dimensions.
  const stopsWithAlternative = stops.filter((s) => s.fit?.verdict === "fits").length;
  const fragility = clamp01(1 - Math.min(2, stopsWithAlternative) / 2);

  // --- 7. pacing_crowd: heat and rain pushed onto outdoor stops ---------------
  // The multiplier interaction: a hot day is only stressful if the plan puts you
  // outside during it, so an all-indoor plan on a 40 degC day scores zero here.
  // `Fit.checks` carries a per-constraint pass/fail ledger, and the feasibility
  // stage is the thing that knows indoor versus outdoor, so we read the
  // indoor-outdoor verdict from there rather than re-deriving it from a string
  // on the stop.
  const heat = heatLoad(ctx.weather ?? { condition: "clear", tempC: 30, source: "unknown" });
  const outdoorStops = stops.filter((s) => {
    const indoorCheck = s.fit?.checks?.find((c) => c.label.toLowerCase().includes("indoor"));
    // Absent the check we do not know, and unknown must not become "outdoor":
    // a plan whose indoor status was never evaluated is not an outdoor plan.
    return indoorCheck ? !indoorCheck.pass : false;
  }).length;
  const pacingCrowd = clamp01(heat * (outdoorStops / Math.max(1, stops.length)));

  factors.push(
    { dimension: "utilisation", weight: STRESS_WEIGHTS.utilisation, value: utilisation, rescue: null },
    { dimension: "buffer", weight: STRESS_WEIGHTS.buffer, value: buffer, rescue: null },
    { dimension: "cost", weight: STRESS_WEIGHTS.cost, value: cost, rescue: null },
    { dimension: "travel", weight: STRESS_WEIGHTS.travel, value: travel, rescue: null },
    { dimension: "pacing", weight: STRESS_WEIGHTS.pacing, value: pacing, rescue: null },
    { dimension: "fragility", weight: STRESS_WEIGHTS.fragility, value: fragility, rescue: null },
    { dimension: "pacing_crowd", weight: STRESS_WEIGHTS.pacing_crowd, value: pacingCrowd, rescue: null },
  );

  // --- the single highest-impact fix ------------------------------------------
  // Impact is value x weight, not value alone: the worst-looking dimension is
  // not the one worth fixing if it barely moves the score.
  const worst = factors.reduce((a, b) =>
    b.value * b.weight > a.value * a.weight ? b : a,
  );

  const rescue = (f: Factor): string => {
    switch (f.dimension) {
      case "utilisation":
        return `Drop the lowest-scoring stop to free about ${Math.max(
          0,
          (plan.totalMin ?? 0) - availableMin,
        )} min, or extend the window.`;
      case "buffer":
        return "Trade one stop for a shorter walk so the plan is not knife-edge.";
      case "cost":
        return "Swap the priciest stop for a free alternative nearby.";
      case "travel":
        return "Group stops by neighbourhood to cut the walking.";
      case "pacing":
        return "Move the early or late stop into the middle of the day.";
      case "fragility":
        return "Add a second option you can fall back on if a stop is closed.";
      case "pacing_crowd":
        return "Swap an outdoor stop for an indoor one while the weather holds.";
      default:
        return "";
    }
  };

  // Only the worst factor earns a rescue, and only when it is actually bad.
  // A rescue on a comfortable plan is noise.
  for (const f of factors) {
    f.rescue = f === worst && f.value >= 0.5 ? rescue(f) : null;
  }

  const weighted = factors.reduce((sum, f) => sum + f.value * f.weight, 0);
  const score = Math.round(clamp01(weighted) * 100);

  return {
    score,
    factors: factors.map(({ dimension, weight, value, rescue: r }) => ({
      dimension,
      weight,
      value: Math.round(value * 1000) / 1000,
      rescue: r,
    })),
  };
}
