/**
 * The learned impact model: weather -> a prior, and observation -> a correction to it.
 *
 * ## Why a prior plus a correction, and not a trained regressor
 *
 * The brief asks the model to "learn the relationship between environmental
 * conditions and the behavior of the target ecosystem". Taken literally that invites
 * a regression over 291 reviews, and a regression over 291 rows of a 7-class ×
 * 5-hazard × 6-channel space would memorise noise and print a number nobody can
 * interrogate — which is precisely the failure this repository has already
 * catalogued 27 times in `research/findings/02-engine-internals.md`.
 *
 * So the physical structure is *stated* — a table of what each hazard does to each
 * channel at each level of shelter, written down with its reasoning — and the
 * observations are used for the one thing they are actually good for: **calibrating
 * how bad it is, per hazard, per shelter level, for these particular entities.**
 *
 * That is a 5 × 4 table, and it is estimated from real reports that name a hazard
 * and carry a sentiment and an engagement count. Every one of those three is
 * something the corpus actually has, and none of them is a proxy for the others.
 *
 * ## The fit, in full
 *
 * For each `(hazard, shelterBin)` cell:
 *
 *   observed = weighted mean sentiment of reports naming that hazard at that shelter
 *   expected = the prior's own implied sentiment for that cell
 *   adjustment = clamp(k · (expected - observed), -MAX_ADJUST, +MAX_ADJUST)
 *
 * Read the sign carefully, because it is the part that is easy to get backwards.
 * `observed` is *negative* when people are unhappy. So `expected - observed` is
 * positive when reality is **worse** than the prior assumed, and the adjustment is
 * positive, and the impact gets bigger. The prior is pessimistic when reports are
 * bad and *optimistic* when people are reporting that a place held up — which is the
 * behaviour you want from a model that has read "dry in heavy rain" eleven times.
 *
 * Confidence in a cell is `observations / (observations + PRIOR_WEIGHT)`, Laplace
 * smoothing, so a cell with one report is mostly prior and a cell with forty is
 * mostly evidence. A cell with no reports is *exactly* prior at confidence 0, and
 * that is reported rather than hidden.
 *
 * `ponytail:` no gradient descent, no matrix, no dependency. This is a weighted
 * mean and a clamp. If the corpus ever reaches the thousands, revisit — and say so
 * in the PR, the way `TASKS.md` asks for every other claim we have had to walk back.
 */
import {
  type ChannelKind,
  type ChannelSet,
  type EntityClass,
  type HazardKind,
  HAZARD_KINDS,
  neutralChannels,
  round2,
} from "./hazards";
import type { SocialSignal } from "./social";

// ---------------------------------------------------------------------------
// The prior
// ---------------------------------------------------------------------------

/**
 * What a hazard at severity `s` does to a channel, per unit of shelter exposure.
 *
 * These are the numbers, and they are the whole honest answer to "where does that
 * come from". They are a stated engineering judgement calibrated to the operating
 * experience of running outdoor hospitality in a monsoon city, not a measurement,
 * and the model's own output says so. `observations` in the output is the number
 * that tells a reader how much of any given prediction is evidence.
 */
type PriorRow = {
  /** Multiplier on this channel per severity step, at full exposure (openness 3). */
  perSeverity: number;
  /** Severity at which the channel bottoms out. Beyond this it stops getting worse. */
  floorsAt: number;
};

const OPEN = 3;

/**
 * The channels this function is allowed to move.
 *
 * Five, not six. `workforce` is excluded on purpose and it is the most important
 * exclusion in the file: **staff impact is not a direct effect of anything you can
 * read off a record.** A row cannot tell you whether its staff can get to work, and
 * every channel the direct pass touches is one where the entity's own fields are
 * genuinely sufficient evidence. Leaving `workforce` in meant the direct pass
 * applied the full effect from the severity alone, the order-4 neighbourhood pass
 * then found nothing left to add, and the highest-order cascade silently never ran —
 * which a test caught.
 *
 * The magnitudes still live in `PRIOR`, because a prior is documentation of how much
 * each hazard costs each channel whether or not the direct pass uses it.
 * `applyWorkforce` in `propagate.ts` reads them.
 */
const DIRECT_CHANNELS: readonly ChannelKind[] = [
  "availability",
  "capacity",
  "movement",
  "demand",
  "duration",
] as const;

/**
 * The prior table. Six channels × five hazards, each row carrying its own floor.
 *
 * The floors are the interesting part. `availability` floors at 0 — nothing is more
 * unavailable than shut. `capacity` floors at 0.25 rather than 0, because a venue
 * that is open with half its staff takes half the people and pretending it is either
 * fully trading or fully shut is the kind of false precision that makes a twin
 * untrustworthy. `movement` floors at 1.0 — rain makes travel slower, never faster,
 * and a model that can produce a sub-1.0 movement multiplier under a hazard is
 * broken. `demand` is the only channel allowed to go *up*, and only from a
 * hazard-free entity, which is the reroute effect. `workforce` floors at its lowest
 * per hazard because staff loss is real but total is not.
 */
const PRIOR: Record<HazardKind, Record<ChannelKind, PriorRow>> = {
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
    // Heat does not slow a road. A model that reports it does is measuring nothing.
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
    // Flood is the only hazard that closes a *sheltered* venue, because it closes the
    // road to it rather than the venue. `floorsAt: 0` at full severity is correct; the
    // shelter scaling below is what stops it closing a rooftop café indoors.
    availability: { perSeverity: -0.5, floorsAt: 0 },
    capacity: { perSeverity: -0.3, floorsAt: 0.2 },
    // The biggest movement effect of any hazard, and the reason the access cascade
    // exists as a separate order rather than being folded into the direct one.
    movement: { perSeverity: 0.55, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: 0.1, floorsAt: 0 },
    workforce: { perSeverity: -0.4, floorsAt: 0.15 },
  },
  storm: {
    availability: { perSeverity: -0.6, floorsAt: 0 },
    capacity: { perSeverity: -0.35, floorsAt: 0.15 },
    movement: { perSeverity: 0.4, floorsAt: 0 },
    demand: { perSeverity: 0, floorsAt: 0 },
    duration: { perSeverity: 0.05, floorsAt: 0 },
    workforce: { perSeverity: -0.5, floorsAt: 0.1 },
  },
};

/** A shelter level of 0-3, bucketed so the corpus can fill four cells. */
export type ShelterBin = "sheltered" | "partial" | "open" | "exposed";

export function shelterBinOf(openness: number): ShelterBin {
  if (openness <= 0) return "sheltered";
  if (openness === 1) return "partial";
  if (openness === 2) return "open";
  return "exposed";
}

export const SHELTER_BINS: readonly ShelterBin[] = ["sheltered", "partial", "open", "exposed"] as const;

/** How much shelter scales a hazard's reach. 0 means the hazard cannot touch it. */
const REACH: Record<ShelterBin, number> = {
  sheltered: 0,
  partial: 0.45,
  open: 0.8,
  exposed: 1,
};

/**
 * `water_dependent` inverts the shelter scaling for rain.
 *
 * A beach's value *is* the weather, so rain does not degrade it — it removes it, at a
 * far lower threshold than anything else in the catalogue. Without this one clause a
 * rainstorm would leave Marine Drive's best attribute open at reduced capacity, which
 * is exactly the kind of plausible-looking wrong answer that destroys trust in a
 * simulation layer.
 */
function reachFor(entityClass: EntityClass, hazard: HazardKind, bin: ShelterBin): number {
  if (entityClass === "water_dependent" && hazard === "rain") return 1.6;
  // A terrain-exposed entity is not more sheltered because it is indoors-looking; it
  // is a fort or a viewpoint and it is outdoors regardless of the row's own field.
  if (entityClass === "terrain_exposed") return Math.max(REACH[bin], 0.9);
  return REACH[bin];
}
// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/** Laplace smoothing weight. Roughly "how many reports do we pretend the prior is worth". */
const PRIOR_WEIGHT = 8;
/** How hard one unit of sentiment disagreement moves a cell. */
const GAIN = 0.5;
/** The correction can never more than double or halve a channel. Bounded on purpose. */
const MAX_ADJUST = 0.6;

export type Cell = {
  /** Signed sentiment the reports imply: -1 bad, +1 good. Null when there are none. */
  observed: number | null;
  /** Sum of `helpfulCount` over the reports in this cell. */
  weight: number;
  /** Report count, not weight. This is the number the UI prints. */
  observations: number;
  /** -MAX_ADJUST..+MAX_ADJUST, the multiplier on `PER_SEVERITY` this cell earned. */
  adjustment: number;
  /** Laplace confidence. 0 with no reports, asymptote 1. */
  confidence: number;
};

export type ImpactModel = {
  /** 5 hazards × 4 shelter bins. */
  cells: Record<HazardKind, Record<ShelterBin, Cell>>;
  observations: number;
  /** Bumped when the prior changes, so a stored prediction stays auditable. */
  version: string;
};

export const IMPACT_MODEL_VERSION = "impact-1";

function emptyCell(): Cell {
  return { observed: null, weight: 0, observations: 0, adjustment: 0, confidence: 0 };
}

function emptyModel(): ImpactModel {
  const cells = {} as Record<HazardKind, Record<ShelterBin, Cell>>;
  for (const hazard of HAZARD_KINDS) {
    const row = {} as Record<ShelterBin, Cell>;
    for (const bin of SHELTER_BINS) row[bin] = emptyCell();
    cells[hazard] = row;
  }
  return { cells, observations: 0, version: IMPACT_MODEL_VERSION };
}

/**
 * The prior's implied sentiment for a cell, which is what the observations are
 * compared against.
 *
 * This is the step that makes "the prior was wrong" a computable claim. If the prior
 * says a shelter level is fine in rain, its implied sentiment is mildly positive; a
 * flood of negative reports there means the prior was wrong, and the adjustment says
 * by how much.
 */
function expectedSentiment(hazard: HazardKind, bin: ShelterBin): number {
  const reach = REACH[bin];
  if (reach === 0) return 0.4; // Untouchable by the hazard, and people say so positively.
  const worst = Math.max(
    ...(["availability", "capacity", "workforce"] as const).map((channel) => PRIOR[hazard][channel].perSeverity),
  );
  // Worst channel at full severity, scaled by reach, mapped onto a sentiment scale.
  return clamp(-worst * 2 * reach, -1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fit the model from the social corpus.
 *
 * `opennessOf` is injected rather than imported so the fit is testable against a
 * hand-built signal list with a known shelter level per report, and so this module
 * has no dependency on the graph. In the app it is `opennessOf` from `hazards.ts`.
 */
export function fitImpactModel(
  signals: readonly SocialSignal[],
  opennessOf: (entityClass: EntityClass) => number,
  entityClassOf: (signal: SocialSignal) => EntityClass,
): ImpactModel {
  const model = emptyModel();
  const sums = new Map<string, { sentiment: number; weight: number; count: number }>();

  for (const signal of signals) {
    if (signal.conditions.length === 0) continue;
    // Exposure comes from the corpus when the reporter judged it, and from the
    // entity's own shelter when they did not. A report of "no shade" at an indoor
    // gallery is a report about something else, so the reporter's own judgement
    // wins where we have one.
    const openness =
      signal.exposure >= 0 ? Math.round(signal.exposure * OPEN) : opennessOf(entityClassOf(signal));
    const bin = shelterBinOf(openness);
    for (const hazard of signal.conditions) {
      const key = `${hazard}:${bin}`;
      const current = sums.get(key) ?? { sentiment: 0, weight: 0, count: 0 };
      // Engagement-weighted: a report 86 people found helpful is better evidence of
      // how a place behaves than one nobody upvoted.
      const weight = Math.max(1, signal.weight);
      current.sentiment += signal.sentiment * weight;
      current.weight += weight;
      current.count += 1;
      sums.set(key, current);
    }
  }

  for (const [key, agg] of sums) {
    const [hazard, bin] = key.split(":") as [HazardKind, ShelterBin];
    const observed = agg.weight === 0 ? 0 : agg.sentiment / agg.weight;
    const expected = expectedSentiment(hazard, bin);
    model.cells[hazard][bin] = {
      observed: round2(observed),
      weight: agg.weight,
      observations: agg.count,
      // Positive when reality is worse than the prior assumed. See the header.
      adjustment: round2(clamp(GAIN * (expected - observed), -MAX_ADJUST, MAX_ADJUST)),
      confidence: round2(agg.count / (agg.count + PRIOR_WEIGHT)),
    };
    model.observations += agg.count;
  }

  return model;
}

/** The cell for a hazard at a shelter level. Never null; an unfitted cell is the prior. */
export function cellFor(model: ImpactModel, hazard: HazardKind, bin: ShelterBin): Cell {
  return model.cells[hazard][bin];
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export type DirectImpact = {
  channels: ChannelSet;
  /** 0-3, the worst hazard reaching this entity. */
  severity: ImpactSeverityLike;
  /** Which hazards are responsible, worst first. */
  hazards: { kind: HazardKind; severity: number; confidence: number }[];
  /** A finished sentence with the real numbers. Empty in fine weather. */
  reason: string;
};

type ImpactSeverityLike = 0 | 1 | 2 | 3;

/**
 * The direct effect of a set of hazard severities on one entity.
 *
 * `severityByKind` is the already-resolved severity per hazard: the drivers give the
 * physical severity, the model gives the correction, and this function is only
 * responsible for turning a severity into a channel set. Keeping that split is what
 * lets the same function serve the live observation and a what-if slider, and what
 * makes "clear sky changes nothing" a structural property rather than a hope.
 */
export function directImpact(
  model: ImpactModel,
  entityClass: EntityClass,
  openness: number,
  severityByKind: Readonly<Partial<Record<HazardKind, number>>>,
  socialConfidence = 0,
): DirectImpact {
  const bin = shelterBinOf(openness);
  const channels = { ...neutralChannels() } as ChannelSet & Record<ChannelKind, { kind: ChannelKind; multiplier: number; confidence: number }>;

  const hazards: DirectImpact["hazards"] = [];
  let worst = 0;

  for (const hazard of HAZARD_KINDS) {
    const raw = severityByKind[hazard] ?? 0;
    if (raw <= 0) continue;
    const reach = reachFor(entityClass, hazard, bin);
    if (reach === 0) continue;

    const cell = cellFor(model, hazard, bin);
    const severity = clamp(raw, 0, 3);
    /**
     * `reach` scales the *rate*, not the severity.
     *
     * The first version of this multiplied the severity by `reach` and clamped it to
     * 3, which quietly deleted the entire `water_dependent` clause: a beach at rain
     * 2.0 became 3.2 -> 3, and open air at rain 2.0 became 2.0, and after enough
     * severity steps both floored at zero availability and the two became
     * indistinguishable. Reach is a statement about how *fast* a channel degrades, so
     * it belongs on the rate. `ponytail:` the assertion that caught this is the
     * "a beach closes sooner than a promenade" case in the test suite.
     */
    const gain = (1 + cell.adjustment) * reach;

    for (const channel of DIRECT_CHANNELS) {
      const rule = PRIOR[hazard][channel];
      if (rule.perSeverity === 0) continue;
      const step = rule.perSeverity * gain;
      const steps = Math.min(severity, 3);
      const delta = step * steps;
      const current = channels[channel].multiplier;
      let next: number;
      if (rule.perSeverity < 0) {
        const floor = rule.floorsAt === 0 ? 0 : 1 - rule.floorsAt;
        next = Math.max(floor, current + delta);
      } else {
        // A positive channel never goes below 1.0: weather cannot make travel faster.
        next = Math.max(1, current + delta);
      }
      channels[channel] = {
        kind: channel,
        multiplier: round2(next),
        // Confidence is the model's own cell confidence, lifted by corroboration
        // from live social signal and never above the certainty of a direct read.
        confidence: round2(Math.min(1, 0.35 + cell.confidence * 0.5 + socialConfidence * 0.15)),
      };
    }

    worst = Math.max(worst, Math.round(severity * Math.min(1, reach)));
    hazards.push({ kind: hazard, severity: round2(severity * Math.min(1, reach)), confidence: cell.confidence });
  }

  hazards.sort((a, b) => b.severity - a.severity);

  return {
    channels,
    severity: worst as ImpactSeverityLike,
    hazards,
    reason: reasonFor(hazards, channels),
  };
}

const CHANNEL_PHRASE: Record<ChannelKind, (m: number) => string> = {
  availability: (m) => (m <= 0.05 ? "shut" : `availability down to ${Math.round(m * 100)}%`),
  capacity: (m) => `capacity down to ${Math.round(m * 100)}%`,
  movement: (m) => `journeys ${Math.round((m - 1) * 100)}% longer`,
  demand: (m) => (m > 1.02 ? `demand up ${Math.round((m - 1) * 100)}%` : ""),
  duration: (m) => (m > 1.02 ? `visits ${Math.round((m - 1) * 100)}% longer` : ""),
  workforce: (m) => `staffing down to ${Math.round(m * 100)}%`,
};

/**
 * The sentence. Every number in it is a multiplier that came out of the prior plus a
 * correction, and the string names the hazard and the channel so a reader can go and
 * disagree with exactly one of them.
 */
function reasonFor(hazards: DirectImpact["hazards"], channels: ChannelSet): string {
  if (hazards.length === 0) return "";
  const hazard = hazards[0]!;
  const parts: string[] = [];
  for (const channel of Object.keys(CHANNEL_PHRASE) as ChannelKind[]) {
    const phrase = CHANNEL_PHRASE[channel](channels[channel].multiplier);
    if (phrase) parts.push(phrase);
  }
  if (parts.length === 0) return `${capitalise(hazard.kind)} at severity ${hazard.severity}, no operational effect at this shelter level.`;
  return `${capitalise(hazard.kind)} at severity ${hazard.severity}: ${parts.slice(0, 3).join(", ")}.`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
