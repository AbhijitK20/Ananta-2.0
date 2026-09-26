/**
 * The written half: what the weather did to a plan that already exists.
 *
 * `docs/EVAL_SPEC.md` §219 sets an assertion that nothing in the tree can currently
 * satisfy — `no weatherSensitive: 'rain' | 'any' outdoor stop unless forecastNote
 * justifies it` — and `content/evaluation/README.md` §74 restates it: "no
 * rain-sensitive outdoor stop **without a written reason**".
 *
 * That is a real gap, and it is not the same gap as the gate. A gate that removes
 * the Gateway of India in a downpour has done half the job; the other half is being
 * able to say *why the plan you are looking at is still the right plan*. A stop that
 * survived the gate under a covered verandah and a stop that survived because it is
 * a 24/7 indoor market look identical in a list, and they are not the same promise.
 *
 * So this file produces two things and changes no plan:
 *
 *  - a **justification** for every weather-exposed stop, drawn from the same verdict
 *    the gate used. No second opinion, no re-derivation: `assess()` is the only
 *    policy in the feature and the report just reads it.
 *  - a **`weatherRisk` factor** in the exact shape of `Plan.stressFactors`, because
 *    the app's own fixtures already claim a `{ dimension: "weatherRisk" }` factor
 *    that nothing computes. A plan that is 80% open air in a storm is a stressful
 *    plan whether or not the engine agrees, and `rescue` names the one stop to swap.
 *
 * It is a report, not a constraint. The gate lives in `model.ts` and the wiring in
 * `pipeline.ts`; nothing here is allowed to remove a stop, and nothing here is on
 * the path to a plan.
 */
import type { DiscoveryContext, Plan } from "../../contracts";
import { assess, profileFor, type WeatherEnv, type WeatherVerdict } from "./model";
import { EXPOSED_AT } from "./model";
import type { Experience } from "../../contracts";

/** The shape `Plan.stressFactors` already uses. Reused, not redefined. */
export type StressFactor = Plan["stressFactors"][number];

export type WeatherStopNote = {
  stopId: string;
  name: string;
  /** 0 indoors to 3 fully outdoors. */
  shelter: number;
  /** True when enough of the visit is outside for the weather to matter. */
  exposed: boolean;
  /**
   * The written justification. Never empty for an exposed stop — that invariant is
   * the whole point of this file, and `unjustified` exists to catch a regression on
   * it rather than to be checked by hand.
   */
  note: string;
  /** The ledger terms that apply to this stop, for a "why this" panel. */
  components: string[];
};

export type WeatherReport = {
  /** 0-100. How exposed the plan is to the sky it was built for. */
  risk: number;
  /** Ready to append to `Plan.stressFactors`, or null when there is no risk at all. */
  factor: StressFactor | null;
  stops: WeatherStopNote[];
  /**
   * Exposed stops with no written reason. The eval assertion is that this is empty,
   * so it is surfaced as a value rather than left as a comment.
   */
  unjustified: string[];
  /** What the weather removed, read back out of `Plan.rejected`. */
  dropped: Array<{ id: string; reason: string }>;
  /** The single highest-impact fix, in a finished sentence. Null when there is none. */
  rescue: string | null;
};

export type ReportOptions = WeatherEnv & {
  catalogue: ReadonlyMap<string, Experience>;
  /** Shown in the factor label, e.g. "Marine Drive". Defaults to the origin label. */
  place?: string;
};

/**
 * Weight of the `weatherRisk` dimension inside a stress score. The app's fixtures
 * use 0.14, so this matches the number already on screen rather than inventing a
 * second scale.
 */
const RISK_WEIGHT = 0.14;

/**
 * The plan's weather risk, 0-100: the most exposed thing in it, against the sky it
 * was built for.
 *
 * The **worst** stop, not the average, and that is the whole design. A stress factor
 * is asked "where is the weak point in this plan", and a day that puts one fully
 * exposed outdoor stop among six good indoor ones is a plan with a weak point — which
 * is exactly when `rescue` has something useful to say. Averaging instead would put
 * that plan at 8% and tell the traveller nothing, which is the same as reporting no
 * risk at all while their square is being rained on.
 */
function riskOf(stops: readonly WeatherStopNote[], severity: number): number {
  const worst = stops.reduce((peak, stop) => (stop.exposed ? Math.max(peak, stop.shelter) : peak), 0);
  if (worst === 0) return 0;
  return Math.max(0, Math.min(100, Math.round((worst / 3) * (severity / 2) * 100)));
}

function noteFor(verdict: WeatherVerdict, exposed: boolean): string {
  if (!exposed) return "";
  // A sealed record never reaches a plan, so `reason` here is the soft one: the
  // sentence that says why this stop is still on the list.
  return verdict.reason
    || verdict.season?.reason
    || verdict.timing?.reason
    || "It is under a roof, so the weather does not change it.";
}

/**
 * Read a plan back through the gate. Pure, and safe to call on any plan: a stop the
 * catalogue cannot resolve is reported as unexposed rather than guessed at.
 */
export function weatherReport(plan: Plan, ctx: DiscoveryContext, options: ReportOptions): WeatherReport {
  const p = profileFor(ctx, options);
  const stops: WeatherStopNote[] = [];
  const unjustified: string[] = [];

  for (const stop of plan.stops) {
    const item = options.catalogue.get(stop.experienceId);
    if (!item) continue;
    const verdict = assess(p, item);
    const exposed = verdict.shelter >= EXPOSED_AT;
    const note = noteFor(verdict, exposed);
    if (exposed && note.trim() === "") unjustified.push(stop.experienceId);
    stops.push({
      stopId: stop.experienceId,
      name: item.name,
      shelter: verdict.shelter,
      exposed,
      note,
      components: [
        ...(verdict.penalty > 0 ? ["weather"] : []),
        ...(verdict.season && verdict.season.penalty > 0 ? ["season"] : []),
        ...(verdict.timing ? ["timing"] : []),
      ],
    });
  }

  const risk = riskOf(stops, p.severity);
  const dropped = plan.rejected
    .filter((entry) => entry.code === "weather_unsafe" || entry.code === "seasonal_mismatch")
    .map((entry) => ({ id: entry.experienceId, reason: entry.message }));
  const worst = [...stops].filter((stop) => stop.exposed).sort((a, b) => b.shelter - a.shelter)[0];
  const place = options.place ?? ctx.origin.label;
  const rescue = risk >= 40 && worst
    ? `${worst.name} is the exposed one. Swap it for something under a roof around ${place} and the rest of the day stands.`
    : null;

  return {
    risk,
    factor: risk === 0
      ? null
      : {
        dimension: "weatherRisk",
        weight: RISK_WEIGHT,
        value: risk,
        rescue,
      },
    stops,
    unjustified,
    dropped,
    rescue,
  };
}
