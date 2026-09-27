/**
 * The impact model: weather → a stated prior, and real reports → a correction to
 * it.
 *
 * ---------------------------------------------------------------------------
 * WHY A PRIOR PLUS A CORRECTION, AND NOT A TRAINED REGRESSOR
 * ---------------------------------------------------------------------------
 *
 * The brief asks the model to "learn the relationship between environmental
 * conditions and the behaviour of the target ecosystem". Taken literally that
 * invites a regression, and a regression over what this project actually has —
 * a 5-hazard × 6-channel surface and a handful of real alert and report records —
 * would memorise noise and print a number nobody can interrogate.
 *
 * So the physical structure is *stated*: a table of what each hazard does to each
 * channel at each level of shelter, written down with its reasoning. And the
 * observations are used for the one thing a handful of observations is actually
 * good for: **calibrating how bad it is, per city, for these particular places.**
 *
 * That is a 5 × 4 table, estimated from records that genuinely name a hazard and
 * carry an alert level or an engagement count. The fit is a weighted mean and a
 * clamp. There is no gradient descent, no matrix, and no dependency, and the
 * model's own output says how many observations any given number rests on so a
 * reader can discount it accordingly.
 */

import { SEVERITY_THRESHOLDS, severityFromIntensity } from "./hazard-scale";

export { SEVERITY_THRESHOLDS, severityFromIntensity };

/* -------------------------------------------------------------------------- *
 * The prior
 * -------------------------------------------------------------------------- */

type PriorRow = {
  /** Multiplier change on this channel per severity step, at full exposure. */
  perSeverity: number;
  /** The multiplier at which the channel bottoms out. Beyond it, nothing. */
  floorsAt: number;
};

/** Openness level 3: fully exposed. Everything scales off this. */
const OPEN = 3;

/**
 * The channels the *direct* pass is allowed to move.
 *
 * Five, not six, and `workforce` is the exclusion that matters: **staff impact is
 * not a direct effect of anything you can read off a directory row.** No row
 * tells you whether its staff can get to work, whereas every channel the direct
 * pass does touch has fields that are genuinely sufficient evidence. Leaving
 * `workforce` in meant the direct pass applied the whole effect from severity
 * alone, the order-2 city pass then found nothing left to add, and the
 * highest-order cascade silently never ran. Its magnitudes stay here because a
 * prior documents what a hazard costs whether or not the direct pass uses it;
 * `applyWorkforce` in ./propagate reads them.
 */
const DIRECT_CHANNELS = [
  "availability",
  "capacity",
  "movement",
  "demand",
  "duration",
] as const satisfies readonly import("./types").ChannelKind[];

/**
 * The prior table. Six channels × five hazards, each row carrying its own floor.
 *
 * The floors are the interesting part.
 *
 *  - `availability` floors at 0. Nothing is more unavailable than shut.
 *  - `capacity` floors above 0, because a venue open with half its staff takes
 *    half the people, and a model that reports that as either fully trading or
 *    fully shut is the kind of false precision that makes a twin untrustworthy.
 *  - `movement` floors at 1. Rain makes a journey slower, never faster, and a
 *    model that can produce a sub-1.0 movement multiplier under a hazard is
 *    broken.
 *  - `demand` is the only channel allowed to go *up*, and only via the reroute
 *    effect in ./propagate, never from a hazard acting on the entity itself.
 *  - `heat` does not move `movement` at all. Heat does not slow a road, and a
 *    model that reports that it does is measuring nothing.
 */
const PRIOR: Record<import("./types").HazardKind, Record<import("./types").ChannelKind, PriorRow>> = {
  rain: {
    availability: { perSeverity: -0.45, floorsAt: 0 },
    capacity: { perSeverity: -0.25, floorsAt: 0.25 },
    movement: { perSeverity: 0.18, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: 0.12, floorsAt: 0 },
    workforce: { perSeverity: -0.1, floorsAt: 0.3 },
  },
  heat: {
    availability: { perSeverity: -0.35, floorsAt: 0 },
    capacity: { perSeverity: -0.3, floorsAt: 0.3 },
    movement: { perSeverity: 0, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: -0.1, floorsAt: 0 },
    workforce: { perSeverity: -0.35, floorsAt: 0.2 },
  },
  wind: {
    availability: { perSeverity: -0.5, floorsAt: 0 },
    capacity: { perSeverity: -0.2, floorsAt: 0.3 },
    movement: { perSeverity: 0.08, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: 0, floorsAt: 0 },
    workforce: { perSeverity: -0.1, floorsAt: 0.4 },
  },
  flood: {
    // Flood is the only hazard that closes a *sheltered* venue, because it closes
    // the road to it rather than the venue. Shelter scaling is what stops it
    // closing a rooftop café indoors.
    availability: { perSeverity: -0.5, floorsAt: 0 },
    capacity: { perSeverity: -0.3, floorsAt: 0.2 },
    // The largest movement effect of any hazard, and the reason the access
    // cascade exists as a separate order rather than being folded into the
    // direct one.
    movement: { perSeverity: 0.55, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: -0.15, floorsAt: 0 },
    workforce: { perSeverity: -0.4, floorsAt: 0.1 },
  },
  storm: {
    // A storm is the compound of the others plus a duration, so its profile sits
    // between wind and flood on every channel rather than exceeding both.
    availability: { perSeverity: -0.4, floorsAt: 0 },
    capacity: { perSeverity: -0.22, floorsAt: 0.25 },
    movement: { perSeverity: 0.22, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: 0.1, floorsAt: 0 },
    workforce: { perSeverity: -0.18, floorsAt: 0.25 },
  },
};

/**
 * How much of a hazard a shelter level lets through. 0 at `indoor_shelter` for
 * everything except flood, which is why this is a per-hazard function and not a
 * single scalar.
 *
 * The flood column is the interesting one: full exposure at 0 shelter. A flooded
 * *road* closes an indoor venue, and shelter describes the venue, not the way in.
 * That is exactly the asymmetry the access cascade exists to express, and
 * collapsing it into one number is how a twin ends up reporting a dry museum as
 * shut.
 */
const EXPOSURE: Record<import("./types").HazardKind, readonly number[]> = {
  //          indoor  covered  mixed  open
  rain: [0.1, 0.35, 0.6, 1],
  heat: [0.35, 0.45, 0.6, 1],
  wind: [0.05, 0.25, 0.5, 1],
  flood: [1, 1, 1, 1],
  storm: [0.15, 0.4, 0.6, 1],
};

/** The prior's own multiplier for one channel under one hazard at one exposure. */
export function priorMultiplier(
  hazard: import("./types").HazardKind,
  channel: import("./types").ChannelKind,
  severity: import("./types").ImpactSeverity,
  openness: number,
): number {
  const row = PRIOR[hazard][channel];
  const raw = 1 + row.perSeverity * severity * EXPOSURE[hazard][openness];
  if (row.perSeverity < 0) return round2(Math.max(row.floorsAt, raw));
  if (row.perSeverity > 0) return round2(Math.min(row.floorsAt || Number.POSITIVE_INFINITY, raw));
  return 1;
}

/* -------------------------------------------------------------------------- *
 * Calibration — the part that is learned
 * -------------------------------------------------------------------------- */

/**
 * How many observations it takes to outweigh the prior.
 *
 * Laplace smoothing in the useful direction: confidence is `n / (n + K)`, so a
 * cell with one report is overwhelmingly prior and a cell with forty is mostly
 * evidence. A cell with nothing at all is *exactly* the prior, at evidence 0, and
 * that is reported rather than hidden.
 *
 * Four is chosen against the volume this project can actually reach: a
 * multi-city trip generates on the order of tens of records over a session, not
 * thousands. Setting it lower would let a single viral thread move a channel
 * more than the physics does.
 */
export const PRIOR_WEIGHT = 4;

/** How far a correction may move a severity, in severity steps. */
const MAX_ADJUST = 1;

/** How much a single unit of corroborating evidence may move a severity. */
const K = 0.34;

export type CalibrationInput = {
  /** Official alert level 0-3 at this city, or null when nothing was issued. */
  alertLevel: number | null;
  /** How many public reports name this city and a weather event. */
  reports: number;
  /** Whether the reports read negative, neutral or positive. Null when unreadable. */
  reportPolarity: number | null;
};

/**
 * Correct one severity by what the real world said.
 *
 * The sign is worth reading twice, because it is easy to get backwards.
 *
 * An **official alert** means reality is at least as bad as the prior thought. So
 * it can only push severity *up*, and it pushes hardest when the prior said
 * nothing was wrong — that is the case where a real warning contradicts the
 * forecast, and it is the case worth catching.
 *
 * **Public reports** cut the other way. A city whose conditions are holding up
 * gets a lot of "we're fine, went anyway" posts, and that is evidence the prior
 * is being pessimistic there. So negative reports raise severity and *positive*
 * reports lower it.
 *
 * Both are clamped, and both are scaled by `n / (n + PRIOR_WEIGHT)`, so nothing
 * here can run away with the answer.
 */
export function calibrate(
  severity: import("./types").ImpactSeverity,
  input: CalibrationInput,
): { severity: import("./types").ImpactSeverity; evidence: number; delta: number } {
  const mass = input.alertLevel !== null ? 1 : 0;
  const n = mass + Math.min(4, Math.floor(input.reports / 3));
  const confidence = n / (n + PRIOR_WEIGHT);

  if (confidence === 0) return { severity, evidence: 0, delta: 0 };

  let delta = 0;

  // An alert above the severity already assumed is the only evidence that can
  // raise it. `alertLevel` is 1-based (Green/Orange/Red) in the source; 0 means
  // "green, i.e. nothing to speak of", which is deliberately not evidence.
  if (input.alertLevel !== null && input.alertLevel > severity) {
    delta += K * (input.alertLevel - severity);
  }

  // Reports. polarity is -1..1; negative means unhappy, which means worse.
  if (input.reportPolarity !== null && input.reports > 0) {
    delta += K * -input.reportPolarity * Math.min(2, input.reports / 4);
  }

  const clamped = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, delta)) * confidence;
  const adjusted = Math.max(0, Math.min(3, severity + clamped));

  return {
    severity: (Math.round(adjusted * 2) / 2) as import("./types").ImpactSeverity,
    evidence: Math.round(confidence * 100) / 100,
    delta: Math.round(clamped * 100) / 100,
  };
}

/* -------------------------------------------------------------------------- *
 * Applying a hazard set to one entity
 * -------------------------------------------------------------------------- */

export type HazardInput = {
  kind: import("./types").HazardKind;
  severity: import("./types").ImpactSeverity;
  evidence: number;
};

/**
 * The direct pass: the entity's own channels, from the weather at its own city.
 *
 * Returns a partial set — `workforce` is left at neutral on purpose, because it
 * is not a direct effect and ./propagate owns it. The caller composes it onto the
 * rest.
 */
export function directChannels(
  hazards: readonly HazardInput[],
  openness: number,
): Record<import("./types").ChannelKind, { multiplier: number; confidence: number }> {
  const out = {} as Record<import("./types").ChannelKind, { multiplier: number; confidence: number }>;
  for (const kind of ["availability", "capacity", "movement", "demand", "duration", "workforce"] as const) {
    out[kind] = { multiplier: 1, confidence: 1 };
  }

  // The evidence of the worst hazard governs confidence, not an average of all
  // five. A forecast nobody can corroborate is weak whatever else is true.
  let worstEvidence = 0;
  for (const h of hazards) {
    if (h.severity > 0) worstEvidence = Math.max(worstEvidence, h.evidence);
  }

  for (const hazard of hazards) {
    if (hazard.severity === 0) continue;
    for (const channel of DIRECT_CHANNELS) {
      const step = priorMultiplier(hazard.kind, channel, hazard.severity, openness);
      if (step === 1) continue;
      out[channel].multiplier = round2(out[channel].multiplier * step);
      out[channel].confidence = round2(Math.min(out[channel].confidence, 0.35 + 0.65 * worstEvidence));
    }
  }

  // Floors are applied after composition rather than per-hazard, because a
  // composed 0.09 that gets floored to 0.25 twice is 0.25, and flooring each step
  // on the way in would give a different answer for the same pair of hazards.
  out.availability.multiplier = round2(Math.max(0, out.availability.multiplier));
  out.capacity.multiplier = round2(Math.max(0.25, out.capacity.multiplier));
  out.movement.multiplier = round2(Math.max(1, out.movement.multiplier));
  out.demand.multiplier = round2(Math.max(0, out.demand.multiplier));
  out.duration.multiplier = round2(Math.max(0.4, out.duration.multiplier));

  return out;
}

/** The workforce response at a given city, read from the same prior. */
export function workforceMultiplier(
  hazards: readonly HazardInput[],
  openness: number,
): { multiplier: number; confidence: number } {
  let multiplier = 1;
  let evidence = 0;
  for (const hazard of hazards) {
    if (hazard.severity === 0) continue;
    multiplier *= priorMultiplier(hazard.kind, "workforce", hazard.severity, openness);
    evidence = Math.max(evidence, hazard.evidence);
  }
  return {
    multiplier: round2(Math.max(0.1, multiplier)),
    confidence: round2(0.3 + 0.7 * evidence),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
