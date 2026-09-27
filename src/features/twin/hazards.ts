/**
 * The twin's vocabulary: what can go wrong, to what, and through which channel.
 *
 * Three decisions here, and everything downstream inherits them.
 *
 * 1. **Hazards are continuous, conditions are not.** `WeatherNow.condition` is a
 *    seven-value enum, which is the right shape for a *badge* and the wrong shape
 *    for a simulation: a twin that can only say "heavy_rain" cannot answer "what
 *    if it were 40 mm/h instead of 20", and that question is the whole of a
 *    what-if slider. So the twin carries a `WeatherScenario` in real units —
 *    mm/h, °C, km/h, flood depth in cm — and *derives* the contract's enum from it
 *    at the boundary. `conditionOf()` is the only place the two meet, which is why
 *    the existing `src/features/weather` policy, the engine's own gate and the UI
 *    can all keep reading the enum they already read.
 *
 * 2. **Five hazards, not three.** `src/features/weather` models `rain`, `heat` and
 *    `wind` because those are what a `WeatherNow` can express. The brief names
 *    flooding and storm duration, and neither is expressible as a condition: a
 *    flooded underpass at 5 mm/h of *ongoing* rain is the failure mode that
 *    actually strands people in Mumbai, and it is driven by *accumulated* depth
 *    rather than instantaneous rate. So `flood` is a hazard with its own driver.
 *
 * 3. **Six channels, because "impact" is not one number.** The brief asks for
 *    effects on demand, capacity, movement, availability, operations and user
 *    behaviour. Those are six different quantities with six different signs, and
 *    collapsing them into a single "impact score" is the step that makes a twin
 *    unfalsifiable — a number nobody can check. Each channel is separately
 *    computed, separately reported, and separately fed to the planner.
 */
import type { IndoorOutdoor } from "../../contracts";

/** What can go wrong. `flood` and `storm` are the twin's addition to the badge enum. */
export type HazardKind = "rain" | "heat" | "wind" | "flood" | "storm";

export const HAZARD_KINDS: readonly HazardKind[] = ["rain", "heat", "wind", "flood", "storm"] as const;

/**
 * The operational quantity a hazard moves. Each is a multiplier on 1.0, and each
 * is reported on its own so a reader can disagree with one of them without
 * discarding the rest.
 *
 *  - `availability`  fraction of the entity still usable at all. 0 = shut.
 *  - `capacity`      seats/slots still sellable. Falls slower than availability:
 *                    a venue that is open with half its staff takes half the people.
 *  - `movement`      travel-time multiplier. Above 1 means the journey is slower.
 *  - `demand`        how many people want to come. Can go *up* — an indoor mall
 *                    gains demand exactly as the beach loses it.
 *  - `duration`      visit-length multiplier. Rain stretches a covered stop.
 *  - `workforce`     staffing multiplier, which is the channel that cascades worst:
 *                    staff cannot cross a flooded road either.
 */
export type ChannelKind = "availability" | "capacity" | "movement" | "demand" | "duration" | "workforce";

export const CHANNEL_KINDS: readonly ChannelKind[] = [
  "availability",
  "capacity",
  "movement",
  "demand",
  "duration",
  "workforce",
] as const;

/**
 * How an entity is exposed, which decides which hazards reach it at all.
 *
 * Derived from two contract fields the catalogue already carries on every row —
 * `indoorOutdoor` and `category` — rather than a new curated taxonomy the data
 * would have to be backfilled into. An OSM node with no curation at all still
 * classifies, which matters because 4,596 of the rows are exactly that.
 */
export type EntityClass =
  | "indoor_shelter"
  | "covered_veranda"
  | "open_air"
  | "mixed_shelter"
  | "water_dependent"
  | "terrain_exposed"
  | "transit_node";

/**
 * Categories whose value is the weather itself. A beach in a downpour is not a
 * degraded beach, and neither is a boat: `water_dependent` is the one class where
 * `rain` above a low threshold takes availability to zero outright.
 *
 * Matched as substrings against the contract's open `category` string, because the
 * catalogue uses OSM's uncontrolled vocabulary (`heritage_site`, `attraction`,
 * `cafe`, …) and a strict enum would silently drop the long tail.
 */
const WATER_WORDS = ["beach", "garden", "park", "boat", "ferry", "waterfront", "marine", "island", "wetland"] as const;
const TERRAIN_WORDS = ["viewpoint", "fort", "hill", "peak", "trail", "hike", "garden_park", "monument"] as const;

/** The one classifier. Pure, total, and never returns null. */
export function classify(experience: {
  category: string;
  indoorOutdoor: IndoorOutdoor;
}): EntityClass {
  if (TERRAIN_WORDS.some((word) => experience.category.includes(word))) return "terrain_exposed";
  if (WATER_WORDS.some((word) => experience.category.includes(word))) return "water_dependent";
  switch (experience.indoorOutdoor) {
    case "indoor":
      return "indoor_shelter";
    case "covered":
      return "covered_veranda";
    case "mixed":
      return "mixed_shelter";
    case "outdoor":
      return "open_air";
  }
}

/**
 * Openness: how much of a visit happens outside. 0 is fully sheltered and is the
 * only level the flood and storm paths skip entirely.
 *
 * This is the same ladder `src/features/weather/model.ts` uses as `SHELTER` and
 * for the same reason — it is the single most predictive attribute in the
 * catalogue — but it is redeclared here because the twin runs when that module is
 * not loaded and a cross-feature import of a private constant is worse than seven
 * integers. `ponytail:` the two must agree; if `SHELTER` moves, move this.
 */
export function opennessOf(entityClass: EntityClass): number {
  switch (entityClass) {
    case "indoor_shelter":
      return 0;
    case "covered_veranda":
      return 1;
    case "mixed_shelter":
      return 2;
    case "open_air":
    case "terrain_exposed":
    case "water_dependent":
      return 3;
    case "transit_node":
      return 0;
  }
}

/**
 * 0 nothing to avoid · 1 degraded · 2 closes the entity · 3 beyond the catalogue.
 *
 * The badge enum stops at 2 because a card has nowhere to put a 3. The twin needs
 * it: "heavy rain" and "the street is under 40 cm of water" are the same
 * condition to a traveller's eye and nothing like the same to a venue, and the
 * difference is exactly what a what-if slider has to be able to express.
 */
export type ImpactSeverity = 0 | 1 | 2 | 3;

export const SEVERITY_WORDS: Record<ImpactSeverity, string> = {
  0: "unaffected",
  1: "degraded",
  2: "closed",
  3: "inoperable",
};

export type ChannelState = {
  kind: ChannelKind;
  /** Multiplier on 1.0. `movement` above 1 is slower; `availability` below 1 is worse. */
  multiplier: number;
  /** 0-1. Falls with cascade depth; rises with corroborating social signal. */
  confidence: number;
};

export type ChannelSet = Readonly<Record<ChannelKind, ChannelState>>;

/** An all-clear. The baseline every simulation is measured against. */
export function neutralChannels(): ChannelSet {
  const out = {} as Record<ChannelKind, ChannelState>;
  for (const kind of CHANNEL_KINDS) out[kind] = { kind, multiplier: 1, confidence: 1 };
  return out;
}

/**
 * Multipliers compose, not average. A 0.8 and a 0.5 in series is 0.4, and that
 * is the physically right answer for a chain of independent degradations; an
 * average would report 0.65 and let a venue that has lost half its capacity
 * twice look like it has lost a third of it once.
 */
export function composeChannels(a: ChannelSet, b: ChannelSet): ChannelSet {
  const out = {} as Record<ChannelKind, ChannelState>;
  for (const kind of CHANNEL_KINDS) {
    const left = a[kind];
    const right = b[kind];
    out[kind] = {
      kind,
      multiplier: round2(left.multiplier * right.multiplier),
      // Independent evidence compounds confidence too, but never past certainty:
      // two weak signals agreeing is not a strong signal.
      confidence: round2(Math.min(1, left.confidence * 0.5 + right.confidence * 0.5 + 0.15)),
    };
  }
  return out;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
