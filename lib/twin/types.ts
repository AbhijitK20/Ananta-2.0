/**
 * The twin's vocabulary, in one file.
 *
 * This is the planner's weather layer, not a second application. Everything here
 * is derived on read from the trip the traveller has already built — the stops,
 * the routed legs, the directory entries behind them — and nothing here is stored
 * alongside it, for the reason `lib/plan/store.tsx` gives: several
 * representations of one fact that can disagree is a bug factory.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A BADGE
 * ---------------------------------------------------------------------------
 *
 * A weather widget wants a condition enum: `rain`, `clear`, `snow`. A simulation
 * layer cannot use one, because the entire point of a what-if control is to ask
 * "what if it were 40 mm/h instead of 20", and a seven-value enum has no way to
 * hold 40. So the twin's native representation is *continuous and in real units*
 * — mm/h, °C, km/h, cm of standing water, hours of storm — and the familiar
 * condition word is derived from it at the display boundary, in
 * `lib/twin/weather.ts`. That is the only place the two meet.
 *
 * The hazard set is five rather than the three a condition enum can express,
 * because two of the brief's named scenarios cannot be a condition at all. Flood
 * is driven by *accumulated* depth, not by the rate falling right now: an
 * underpass with 40 cm of standing water in a lull strands more people than a
 * heavier shower that never pooled. `flood` and `storm` therefore carry their own
 * drivers.
 */

/** What can go wrong. */
export type HazardKind = "rain" | "heat" | "wind" | "flood" | "storm";

export const HAZARD_KINDS: readonly HazardKind[] = ["rain", "heat", "wind", "flood", "storm"] as const;

/**
 * The operational quantity a hazard moves. Six, because "impact" is not one
 * number, and collapsing six quantities with different signs into a single score
 * produces a number nobody can check.
 *
 *  - `availability`  is the entity usable at all. 0 = shut.
 *  - `capacity`      is how much of it still sells. Falls slower than
 *                    availability: a venue open with half its staff takes half
 *                    the people, and pretending it is either fully trading or
 *                    fully shut is false precision.
 *  - `movement`      is a travel-time multiplier. Above 1 is slower.
 *  - `demand`        is how many people want to come. The only channel allowed to
 *                    rise, and only from a hazard-free entity — that is the
 *                    reroute effect, and it is real.
 *  - `duration`      is a visit-length multiplier. Rain stretches a covered stop.
 *  - `workforce`     is a staffing multiplier, and the channel that cascades
 *                    hardest: staff cannot cross a flooded road either.
 *
 * Every one is a multiplier on 1.0 and every one is reported separately, so a
 * reader who disbelieves the heat response can throw it away without discarding
 * the flood response.
 */
export type ChannelKind =
  | "availability"
  | "capacity"
  | "movement"
  | "demand"
  | "duration"
  | "workforce";

export const CHANNEL_KINDS: readonly ChannelKind[] = [
  "availability",
  "capacity",
  "movement",
  "demand",
  "duration",
  "workforce",
] as const;

export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  availability: "Open at all",
  capacity: "Capacity",
  movement: "Travel time",
  demand: "Demand",
  duration: "Time spent",
  workforce: "Staffing",
};

/** Above 1 on `movement` and `duration` is worse; on `demand` it is better. The
 *  one channel whose sign flips is the reason the UI never colours a multiplier
 *  without also printing which way is bad. */
export const CHANNEL_GOOD_WHEN_HIGH: Record<ChannelKind, boolean> = {
  availability: true,
  capacity: true,
  movement: false,
  demand: true,
  duration: false,
  workforce: true,
};

/**
 * How a place is exposed, which decides which hazards can reach it at all.
 *
 * Derived from fields the directory already carries — the category tag, the name,
 * the snippet — rather than a new taxonomy 892 rows would have to be backfilled
 * into. Every row classifies, including the 578 that carry no tag at all, because
 * those are exactly the ones a curation pass would miss.
 */
export type EntityClass =
  | "indoor_shelter"
  | "covered_veranda"
  | "mixed_shelter"
  | "open_air"
  | "water_dependent"
  | "terrain_exposed"
  | "unknown";

export const ENTITY_CLASS_LABELS: Record<EntityClass, string> = {
  indoor_shelter: "Indoors",
  covered_veranda: "Covered",
  mixed_shelter: "Partly sheltered",
  open_air: "Outdoors",
  water_dependent: "Depends on the water",
  terrain_exposed: "Exposed terrain",
  unknown: "Shelter not recorded",
};

/**
 * Openness: how much of a visit happens outside. 0 is fully sheltered, and it is
 * the only level at which the flood and storm paths are skipped outright.
 *
 * A pin dropped on open map is `unknown`, not `open_air`. The planner cannot know
 * whether a coordinate is a cathedral or a car park, and asserting the worst case
 * would invent a flood closure for a building; asserting the best case would
 * invent safety. `unknown` sits between the two and is labelled as such wherever
 * it appears.
 */
export function opennessOf(entityClass: EntityClass): number {
  switch (entityClass) {
    case "indoor_shelter":
      return 0;
    case "covered_veranda":
      return 1;
    case "unknown":
      return 2;
    case "mixed_shelter":
      return 2;
    case "open_air":
    case "terrain_exposed":
    case "water_dependent":
      return 3;
  }
}

/**
 * 0 nothing to avoid · 1 degraded · 2 closed · 3 beyond the directory.
 *
 * A badge stops at 2 because a card has nowhere to put a 3. The twin needs it:
 * "heavy rain" and "the road is under 40 cm" look the same to a traveller and
 * nothing like the same to a venue, and that difference is precisely what a
 * what-if slider has to express.
 */
export type ImpactSeverity = 0 | 1 | 2 | 3;

export const SEVERITY_WORDS: Record<ImpactSeverity, string> = {
  0: "unaffected",
  1: "degraded",
  2: "closed",
  3: "inoperable",
};

/** One channel's state on one entity. */
export type ChannelState = {
  kind: ChannelKind;
  /** Multiplier on 1.0. */
  multiplier: number;
  /** 0-1. Falls with cascade depth, rises with corroborating real-world signal. */
  confidence: number;
};

export type ChannelSet = Readonly<Record<ChannelKind, ChannelState>>;

/** An all-clear. Every simulation is measured against this. */
export function neutralChannels(): ChannelSet {
  const out = {} as Record<ChannelKind, ChannelState>;
  for (const kind of CHANNEL_KINDS) out[kind] = { kind, multiplier: 1, confidence: 1 };
  return out;
}

/**
 * Multipliers compose by multiplication, never by averaging.
 *
 * A 0.8 and a 0.5 in series is 0.4, and that is the right answer for a chain of
 * independent degradations. An average reports 0.65, which makes a venue that has
 * lost half its capacity twice look like it has lost a third of it once — and the
 * planner's day split then quietly plans around a number that is too generous.
 */
export function composeChannels(a: ChannelSet, b: ChannelSet): ChannelSet {
  const out = {} as Record<ChannelKind, ChannelState>;
  for (const kind of CHANNEL_KINDS) {
    const left = a[kind];
    const right = b[kind];
    out[kind] = {
      kind,
      multiplier: round2(left.multiplier * right.multiplier),
      // Two weak signals agreeing is not one strong signal, so confidence
      // compounds sub-linearly and never reaches certainty from evidence alone.
      confidence: round2(Math.min(1, left.confidence * 0.5 + right.confidence * 0.5 + 0.15)),
    };
  }
  return out;
}

/** Scale a channel set toward 1.0, used for cascade damping. */
export function dampChannels(set: ChannelSet, by: number): ChannelSet {
  const out = {} as Record<ChannelKind, ChannelState>;
  for (const kind of CHANNEL_KINDS) {
    const s = set[kind];
    out[kind] = {
      kind,
      multiplier: round2(1 + (s.multiplier - 1) * by),
      confidence: round2(s.confidence * by),
    };
  }
  return out;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* -------------------------------------------------------------------------- *
 * The graph
 * -------------------------------------------------------------------------- */

export type TwinNodeKind = "stop" | "city" | "leg";

/** One real-world thing the planner already addresses. */
export type TwinNode = {
  id: string;
  kind: TwinNodeKind;
  name: string;
  city: string;
  at: { lat: number; lon: number };
  entityClass: EntityClass;
  /** Why the class was chosen, in the traveller's language. Always shown. */
  classReason: string;
  /** True when the node is a coordinate the traveller dropped by hand. */
  isPin: boolean;
  /** Hours the traveller means to spend here. Drives the duration channel. */
  dwell: number;
  /** Day index in the current split, or -1 when the node is not in one. */
  day: number;
  href?: string;
};

/**
 * The two edge kinds, and both are inspectable.
 *
 * `leg` comes from the planner's own routed itinerary and is authoritative: it is
 * real road geometry, or a stated estimate the planner already labels. `proximity`
 * is derived from coordinates and is a heuristic. There is no third kind, because
 * a cascade that can route an effect along an edge nobody can look at is a
 * cascade nobody can argue with.
 */
export type TwinEdgeKind = "leg" | "access" | "contains";

export type TwinEdge = {
  from: string;
  to: string;
  kind: TwinEdgeKind;
  km: number;
  /** Hours at the planner's own speed for this edge, pre-weather. */
  hours: number;
};

export type TwinGraph = {
  nodes: ReadonlyMap<string, TwinNode>;
  edges: readonly TwinEdge[];
  /** Node id -> the ids it depends on, for the cascade to walk. */
  inbound: ReadonlyMap<string, readonly string[]>;
  /** City slug -> its node, for city-level aggregation. */
  cityNode: ReadonlyMap<string, string>;
  stops: readonly TwinNode[];
  cities: readonly TwinNode[];
};

/* -------------------------------------------------------------------------- *
 * Observation
 * -------------------------------------------------------------------------- */

/**
 * One hazard at one place, in real units.
 *
 * `intensity` is the unit the driver is measured in — mm/h for rain, °C above the
 * comfort ceiling for heat, km/h for wind, cm of standing water for flood, hours
 * of remaining storm for storm — and `severity` is 0-3, the discretisation the
 * prior table is written in. Both are carried because the slider moves the former
 * and the prior reads the latter, and a bridge that only kept one of them would
 * force one of the two to be the loser's problem.
 */
export type HazardReading = {
  kind: HazardKind;
  /** 0-3, after the calibration in ./impact has had its say. */
  severity: ImpactSeverity;
  /** The raw reading in the hazard's own unit. 0 means "not present". */
  intensity: number;
  unit: string;
  /** 0-1: how much of `severity` is evidence rather than prior. */
  evidence: number;
};

export const HAZARD_UNITS: Record<HazardKind, string> = {
  rain: "mm/h",
  heat: "°C over 30",
  wind: "km/h gust",
  flood: "cm standing",
  storm: "h remaining",
};

export const HAZARD_LABELS: Record<HazardKind, string> = {
  rain: "Rainfall",
  heat: "Heat",
  wind: "Wind",
  flood: "Flooding",
  storm: "Storm",
};

/** Live conditions at one city, plus the forecast it came with. */
export type CityObservation = {
  city: string;
  cityLabel: string;
  at: { lat: number; lon: number };
  /** Null when the weather service did not answer. Never a guess. */
  hazards: readonly HazardReading[] | null;
  /** The familiar word, derived from the hazards at the boundary. */
  condition: string | null;
  conditionIcon: string | null;
  tempC: number | null;
  feelsLikeC: number | null;
  humidity: number | null;
  windKph: number | null;
  /** mm/h implied by the forecast over the next 12 hours, when one was returned. */
  forecastRainMmH: number | null;
  /** Hours of forecast available. Zero means current conditions only. */
  forecastHours: number;
  /** When the service says this observation is from, ISO. */
  observedAt: string | null;
  /** Set when the request for this city failed. Rendered, never swallowed. */
  error: string | null;
};

/* -------------------------------------------------------------------------- *
 * Social and public signals
 * -------------------------------------------------------------------------- */

export type SignalSource = "gdacs" | "reddit" | "hackernews";

export const SIGNAL_SOURCE_LABELS: Record<SignalSource, string> = {
  gdacs: "GDACS alerts",
  reddit: "Reddit",
  hackernews: "Hacker News",
};

export type SocialSignal = {
  id: string;
  source: SignalSource;
  title: string;
  /** Public URL to the original. Null when the source gave none. */
  url: string | null;
  /** Where it happened, when the source says. Not invented. */
  city: string | null;
  at: { lat: number; lon: number } | null;
  /** ISO timestamp from the source, when it carried one. */
  publishedAt: string | null;
  /**
   * -1 to 1, a crude polarity from the source's own words. Null when the source
   * carried no text to read. Never presented as a sentiment model — see
   * lib/twin/signals.ts.
   */
  polarity: number | null;
  /**
   * The issuing body's own alert level, 0-3, when the source is one that issues
   * alerts. Null for everything else.
   *
   * It is a field rather than something derived from `weight` because it is the
   * only one of the two that may move a severity: a Reddit post can be as unhappy
   * as it likes and it is still not an official warning.
   */
  alertLevel: number | null;
  /** Engagement count, or the alert's severity figure. Evidence mass, never truth. */
  weight: number;
  /**
   * People the source says are affected, when it says. GDACS publishes this for
   * floods and cyclones and it is the strongest single piece of evidence in the
   * whole signal layer: a red alert over a million people outranks a thousand
   * upvotes. Null everywhere else, and never inferred.
   */
  population: number | null;
};

export type SignalBatch = {
  signals: readonly SocialSignal[];
  /** Per-source outcome, including the ones that failed. */
  status: readonly { source: SignalSource; ok: boolean; count: number; note: string }[];
};

/* -------------------------------------------------------------------------- *
 * Scenario
 * -------------------------------------------------------------------------- */

/**
 * A counterfactual, expressed as multipliers on the *observed* reading rather
 * than as absolute weather.
 *
 * This is the important decision in the whole file. A slider that sets "rainfall
 * to 40 mm/h" is only meaningful if 40 mm/h means something at the traveller's
 * current conditions; a slider that scales the live reading by 2.5× works at any
 * baseline, is meaningful in a downpour as well as in clear air, and still lands
 * on a real unit. So the controls are ratios, and the absolute value they resolve
 * to is printed next to every one of them.
 */
export type Scenario = {
  /** Multiplier on observed rainfall rate. 1 = leave it alone. */
  rain: number;
  /** Additive °C on top of the observed temperature. */
  heatDeltaC: number;
  /** Multiplier on observed wind speed. */
  wind: number;
  /** Centimetres of extra standing water. Not a ratio: depth has a floor of zero
   *  and an origin that is not "clear skies". */
  floodCm: number;
  /** Hours of storm still to come. Zero ends the storm. */
  stormHours: number;
  /**
   * When true, the scenario is *not* applied: the twin reports what is observed.
   * Every panel reads this rather than comparing against an implicit baseline, so
   * "what the weather is doing" and "what I am imagining" are never confused.
   */
  live: boolean;
};

export const LIVE_SCENARIO: Scenario = {
  rain: 1,
  heatDeltaC: 0,
  wind: 1,
  floodCm: 0,
  stormHours: 0,
  live: true,
};

export function isLive(scenario: Scenario): boolean {
  return (
    scenario.live ||
    (scenario.rain === 1 &&
      scenario.heatDeltaC === 0 &&
      scenario.wind === 1 &&
      scenario.floodCm === 0 &&
      scenario.stormHours === 0)
  );
}

/* -------------------------------------------------------------------------- *
 * Result
 * -------------------------------------------------------------------------- */

/** One step in a causal chain, so the UI can name the path and not just the score. */
export type EffectStep = {
  nodeId: string;
  nodeName: string;
  /** The edge that carried the effect here, null for the direct pass. */
  via: string;
  /** How far the effect has been damped by the time it arrived. */
  damp: number;
};

export type NodeImpact = {
  node: TwinNode;
  channels: ChannelSet;
  /** The worst severity anywhere in this node's hazard set. */
  severity: ImpactSeverity;
  /** The hazard responsible for `severity`. */
  driver: HazardKind | null;
  /** Direct, then each cascade step outward. Always length ≥ 1. */
  chain: readonly EffectStep[];
  /**
   * A prediction with its spread, not a point estimate. `p50` is the central
   * estimate of the headline channel and `spread` is the interval half-width
   * implied by the cascade depth and the evidence mass behind it — a
   * confidence-derived width, not a fitted distribution.
   */
  p50: number;
  spread: number;
  /** Mean confidence across the six channels. The number behind `spread`. */
  confidence: number;
  /** Real reports and alerts that bear on this node. */
  signals: readonly SocialSignal[];
};

export type TwinResult = {
  /** True when this is the observed state rather than a counterfactual. */
  live: boolean;
  nodes: readonly NodeImpact[];
  /** Worst node, for the headline. */
  peak: NodeImpact | null;
  /** The itinerary consequences, which is what the planner actually reads. */
  itinerary: ItineraryEffect;
  /** How the prediction was arrived at, for the provenance panel. */
  provenance: Provenance;
};

export type ItineraryEffect = {
  /** Days the split would produce under these conditions. */
  days: number;
  /** Nights inserted by the trip's own driving limit. */
  nights: number;
  /** Total driving time after the movement channel is applied. */
  driveHours: number;
  /** Stops the scenario would close, by name. */
  closed: readonly string[];
  /** Stops it would degrade, by name. */
  degraded: readonly string[];
  /** A one-line statement of what changed, or null when nothing did. */
  headline: string | null;
};

export type Provenance = {
  /** Weather service that answered, and for how many cities. */
  weather: { source: string; ok: number; failed: number; note: string };
  /** Signal sources, including the ones that failed. */
  signals: readonly { source: string; ok: boolean; count: number; note: string }[];
  /** How many real reports fed the calibration, and the prior weight against them. */
  calibration: { observations: number; priorWeight: number; cells: number };
  /** The hazard that dominated, and how much of the answer it carries. */
  driver: { hazard: HazardKind | null; share: number };
};
