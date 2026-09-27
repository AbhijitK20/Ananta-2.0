/**
 * The cascade: how a hazard at one place becomes a change somewhere else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM THE PRIOR
 * ---------------------------------------------------------------------------
 *
 * ./impact answers "what does this weather do to this place". This file answers
 * "and then what happens next". Keeping them apart matters because the two have
 * very different epistemic standing: the prior is a stated engineering judgement
 * with a table behind it, whereas an effect that has travelled three hops is a
 * compounding of three judgements and should be visibly less certain than any of
 * them. Every step here damps both the effect and its confidence, so an effect
 * cannot arrive at the far end of a long chain as confident as the hazard that
 * started it.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR ORDERS, AND WHY EACH EXISTS
 * ---------------------------------------------------------------------------
 *
 *  0. **Direct** — the weather at the entity's own city, scaled by its shelter.
 *     The only order with direct observational evidence behind it.
 *  1. **Access** — the road between you and the place. A flooded road changes a
 *     perfectly dry café, and it is the single most common way weather alters a
 *     plan without touching the destination. This order exists only because of
 *     that, and it is why `access` is a real edge in ./graph rather than a map
 *     convenience.
 *  2. **Workforce** — a venue cannot run at its nominal capacity when the city
 *     has lost the staff to get there, and this is the channel that has to be
 *     reserved rather than derived: it is *not* a direct effect of anything
 *     readable off a directory row, which is why ./impact excludes it and this
 *     file owns it.
 *  3. **Reroute** — the only order that *improves* anything. People whose plans
 *     are broken do not disappear, they go somewhere else, and an indoor venue
 *     next to a closed outdoor one gains demand. Without this the twin would be
 *     incapable of saying a city gets busier in bad weather, which is the most
 *     reliably true thing about hospitality and weather.
 *
 * Each order runs to a fixed depth. A cascade that ran to exhaustion would push a
 * hazard in one city into every other city in the graph and report a continent
 * shutting down, which is not a cascade, it is a spreading failure.
 */

import { directChannels, workforceMultiplier, type HazardInput } from "./impact";
import type { CityEvidence } from "./signals";
import { resolveIntensities } from "./weather";
import {
  CHANNEL_GOOD_WHEN_HIGH,
  CHANNEL_KINDS,
  type ChannelKind,
  type ChannelSet,
  type CityObservation,
  type EffectStep,
  type HazardKind,
  type ImpactSeverity,
  type NodeImpact,
  type Provenance,
  type Scenario,
  type TwinGraph,
  type TwinNode,
  neutralChannels,
  opennessOf,
  round2,
} from "./types";

/** How much of an effect survives each order. Falling, because each hop is another
 *  compounding judgement and the compounding should be visible. */
const DAMP_ACCESS = 0.7;
const DAMP_WORKFORCE = 0.6;
const DAMP_REROUTE = 0.5;

/** Beyond this many legs an effect is assumed to be noise rather than a plan. */
const MAX_ACCESS_HOPS = 2;

/** The channels an effect is allowed to travel over. `availability` and `capacity`
 *  are the ones that actually move other entities; propagating `movement` would
 *  compound a travel-time inflation into a nonsense one. */
const TRAVELLED_CHANNELS: readonly ChannelKind[] = ["availability", "capacity", "workforce"];

export type SimulateInput = {
  graph: TwinGraph;
  /** Live conditions per city slug. A city with no observation is skipped, and
   *  its nodes come back at neutral rather than at a guess. */
  observations: ReadonlyMap<string, CityObservation>;
  scenario: Scenario;
  /** Real reports and alerts, bucketed by the city they name. One bucket per
   *  city, holding both the signals and what they add up to. */
  signalsByCity: ReadonlyMap<string, CityEvidence>;
  /** What the weather service said, for the provenance panel. */
  weatherNote: { source: string; ok: number; failed: number; note: string };
  signalStatus: Provenance["signals"];
  calibration: Provenance["calibration"];
  /** Not used for the cascade; carried so the caller can name the peak stop. */
  isLive: boolean;
};

export type SimulateOutput = {
  nodes: readonly NodeImpact[];
  /**
   * Weather-inflated hours, keyed `"fromId>toId"`.
   *
   * Keyed rather than positional, and the reason is a bug this nearly had. The
   * graph holds one collection of leg edges and the planner holds another, and
   * indexing one by the other's array position is a coupling that holds only
   * while the two happen to be built in the same order — with no type error and
   * no failure anywhere when they stop agreeing, just a driving time that
   * belongs to a different leg. A key is checked on lookup instead of assumed.
   */
  adjustedLegHours: ReadonlyMap<string, number>;
  /** Stop ids the scenario closes outright. */
  closedIds: ReadonlySet<string>;
  degradedIds: ReadonlySet<string>;
};

/* -------------------------------------------------------------------------- *
 * The simulation
 * -------------------------------------------------------------------------- */

export function simulate(input: SimulateInput): SimulateOutput {
  const { graph, observations, scenario } = input;

  /* ---- per-city hazard sets, once ---- */

  const hazardByCity = new Map<string, HazardInput[]>();
  for (const [city, observation] of observations) {
    if (!observation.hazards) continue;
    hazardByCity.set(
      city,
      // The scenario resolves to absolute units in ./weather, because "×2.5 of
      // what" is only answerable by whoever knows what "what" was measured in.
      // Severity is then recomputed from the resolved intensity rather than
      // scaled, because a hazard's steps are absolute physical thresholds.
      resolveIntensities(observation.hazards, scenario).map((r) => ({
        kind: r.kind,
        severity: r.severity,
        evidence: observation.hazards?.find((h) => h.kind === r.kind)?.evidence ?? 0,
      })),
    );
  }

  /* ---- order 0: direct ---- */

  const channels = new Map<string, ChannelSet>();
  const driverOf = new Map<string, HazardKind | null>();
  const worstOf = new Map<string, ImpactSeverity>();

  for (const node of graph.nodes.values()) {
    const hazards = node.city ? hazardByCity.get(node.city) : undefined;
    if (!hazards || node.kind === "city") {
      channels.set(node.id, neutralChannels());
      driverOf.set(node.id, null);
      worstOf.set(node.id, 0);
      continue;
    }

    const openness = opennessOf(node.entityClass);
    const direct = directChannels(hazards, openness);

    const set = {} as Record<ChannelKind, { kind: ChannelKind; multiplier: number; confidence: number }>;
    for (const kind of CHANNEL_KINDS) {
      set[kind] = { kind, multiplier: direct[kind].multiplier, confidence: direct[kind].confidence };
    }
    channels.set(node.id, set);

    const worst = pickWorst(hazards);
    worstOf.set(node.id, worst.severity);
    driverOf.set(node.id, worst.kind);
  }

  /* ---- order 1: access — the road between you and the place ---- */

  const access = new Map<string, { from: string; km: number }[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "access") continue;
    const list = access.get(edge.from);
    if (list) list.push({ from: edge.to, km: edge.km });
    else access.set(edge.from, [{ from: edge.to, km: edge.km }]);
  }

  const chains = new Map<string, EffectStep[]>();
  const seedChain = (node: TwinNode, from: TwinNode | null, damp: number, via: string): EffectStep[] => {
    const previous = from ? (chains.get(from.id) ?? []) : [];
    return [
      ...previous,
      { nodeId: node.id, nodeName: node.name, via: from ? via : "observed", damp: round2(damp) },
    ];
  };

  // Breadth-first over the access graph, because the effect attenuates with
  // distance and a depth-first walk would report a far neighbour's state as if it
  // were the near one.
  for (let hop = 1; hop <= MAX_ACCESS_HOPS; hop++) {
    for (const node of graph.stops) {
      const neighbours = access.get(node.id) ?? [];
      let best: { from: string; km: number; weight: number } | null = null;

      for (const neighbour of neighbours) {
        // Distance attenuation within the hop: 200 m of road matters, 11 km does
        // not, even though both are inside the adjacency cutoff.
        const weight = DAMP_ACCESS ** hop * (1 - Math.min(1, neighbour.km / 12));
        if (!best || weight > best.weight) best = { ...neighbour, weight };
      }

      if (!best) continue;
      const source = channels.get(best.from);
      if (!source) continue;

      const current = channels.get(node.id);
      if (!current) continue;

      for (const kind of TRAVELLED_CHANNELS) {
        if (kind === "workforce") continue; // order 2 owns this one
        const loss = 1 - source[kind].multiplier;
        if (loss <= 0) continue;
        const moved = loss * best.weight;
        current[kind].multiplier = round2(
          kind === "availability" || kind === "capacity"
            ? Math.max(0, current[kind].multiplier - moved)
            : current[kind].multiplier,
        );
        current[kind].confidence = round2(
          Math.min(current[kind].confidence, source[kind].confidence * best.weight),
        );
      }

      chains.set(node.id, seedChain(node, graph.nodes.get(best.from) ?? null, best.weight, "access"));
    }
  }

  /* ---- order 2: workforce — the city, not the venue ---- */

  for (const node of graph.stops) {
    const hazards = node.city ? hazardByCity.get(node.city) : undefined;
    if (!hazards) continue;

    const current = channels.get(node.id);
    if (!current) continue;

    // The city's staff are as exposed as the open air, not as the venue.
    const cityWorkforce = workforceMultiplier(hazards, 3);
    const loss = 1 - cityWorkforce.multiplier;
    if (loss <= 0) continue;

    const damped = loss * DAMP_WORKFORCE;
    const previous = chains.get(node.id) ?? [];
    const cityNode = node.city ? graph.cityNode.get(node.city) : undefined;

    chains.set(node.id, [
      ...previous,
      {
        nodeId: node.id,
        nodeName: node.name,
        via: cityNode ? graph.nodes.get(cityNode)?.name ?? "the city" : "the city",
        damp: DAMP_WORKFORCE,
      },
    ]);

    current.workforce.multiplier = round2(
      Math.max(0.1, current.workforce.multiplier - damped),
    );
    current.workforce.confidence = round2(
      Math.min(current.workforce.confidence, cityWorkforce.confidence * DAMP_WORKFORCE),
    );

    // Staff loss is capacity loss, but a gentler one than a closure: a venue with
    // half its staff takes half the people rather than none.
    current.capacity.multiplier = round2(
      Math.max(0.25, current.capacity.multiplier * (1 - damped * 0.8)),
    );
  }

  /* ---- order 3: reroute — the only order that improves anything ---- */

  for (const node of graph.stops) {
    const neighbours = access.get(node.id) ?? [];
    if (!neighbours.length) continue;

    const own = channels.get(node.id);
    if (!own) continue;

    // Only a genuinely unaffected entity gains. Inheriting demand while being shut
    // is how a twin starts inventing a crowded, closed venue.
    if (own.availability.multiplier < 0.999) continue;
    if (opennessOf(node.entityClass) > 2) continue;

    let spill = 0;
    for (const neighbour of neighbours) {
      const source = channels.get(neighbour.from);
      if (!source) continue;
      const loss = 1 - source.availability.multiplier;
      if (loss <= 0) continue;
      spill += loss * (1 - Math.min(1, neighbour.km / 12));
    }
    if (spill <= 0) continue;

    const gain = Math.min(0.6, spill * DAMP_REROUTE);
    own.demand.multiplier = round2(Math.min(1.6, own.demand.multiplier + gain));
    own.demand.confidence = round2(own.demand.confidence * DAMP_REROUTE);

    const previous = chains.get(node.id) ?? [];
    chains.set(node.id, [
      ...previous,
      { nodeId: node.id, nodeName: node.name, via: "people rerouting", damp: DAMP_REROUTE },
    ]);
  }

  /* ---- order 4: a broken venue reshapes the days around it ----
     A closed stop is not merely closed: the leg that reached it and the leg that
     leaves it now serve a different purpose, and the day split moves. This order
     is read out through the itinerary effect in ./itinerary rather than as
     another channel, because "the trip is a day longer" is a statement about the
     plan and not about any one place. */

  /* ---- assemble ---- */

  const nodes: NodeImpact[] = [];
  const closedIds = new Set<string>();
  const degradedIds = new Set<string>();

  for (const node of graph.stops) {
    const set = channels.get(node.id);
    if (!set) continue;

    const severity = (worstOf.get(node.id) ?? 0) as ImpactSeverity;
    const availability = set.availability.multiplier;
    const chain = chains.get(node.id) ?? [
      { nodeId: node.id, nodeName: node.name, via: "observed", damp: 1 },
    ];

    // Depth is the number of *extra* links the effect travelled, which is what
    // makes an access-borne effect less certain than a direct one.
    const depth = Math.max(0, chain.length - 1);
    const evidence = averageConfidence(set);

    const headline = availability;
    nodes.push({
      node,
      channels: set,
      severity,
      driver: driverOf.get(node.id) ?? null,
      chain,
      p50: headline,
      spread: spreadFor(headline, evidence, depth),
      confidence: evidence,
      signals: (node.city ? input.signalsByCity.get(node.city)?.signals : undefined) ?? [],
    });

    if (availability <= 0.001) closedIds.add(node.id.slice(5));
    else if (availability < 0.85) degradedIds.add(node.id.slice(5));
  }

  /* ---- itinerary: the movement channel, in leg order ---- */

  const legHours = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind !== "leg") continue;
    // The worst of the two ends governs the road between them, because a leg is
    // only as usable as its worse approach.
    const from = channels.get(edge.from);
    const to = channels.get(edge.to);
    const inflation = Math.max(
      from?.movement.multiplier ?? 1,
      to?.movement.multiplier ?? 1,
      // The access order already moved `movement` on the endpoints, and a road
      // between two wet cities is worse than either of them alone.
      from && to ? extraLegInflation(from, to) : 1,
    );
    legHours.set(`${edge.from.slice(5)}>${edge.to.slice(5)}`, round2(edge.hours * inflation));
  }

  return {
    nodes,
    adjustedLegHours: legHours,
    closedIds,
    degradedIds,
  };
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

function pickWorst(hazards: readonly HazardInput[]): { kind: HazardKind; severity: ImpactSeverity } {
  let best: { kind: HazardKind; severity: ImpactSeverity } = { kind: "rain", severity: 0 };
  for (const h of hazards) {
    if (h.severity > best.severity) best = { kind: h.kind, severity: h.severity };
  }
  return best;
}

function averageConfidence(set: ChannelSet): number {
  let sum = 0;
  for (const kind of CHANNEL_KINDS) sum += set[kind].confidence;
  return round2(sum / CHANNEL_KINDS.length);
}

/**
 * How far a headline estimate could plausibly be wrong.
 *
 * This is a *confidence-derived* interval, not a fitted distribution, and it is
 * labelled as such wherever it appears. Two things widen it: low confidence in
 * the channels behind the number, and a long chain — because an effect that has
 * travelled three links is a compounding of three judgements, each of which could
 * be wrong in the same direction.
 *
 * The floor of 0.02 is not a confidence interval on nothing. It is the honest
 * answer to "how sure are we about a completely unperturbed stop", which is not
 * zero: the prior is a judgement, and a judgement is not a proof.
 */
function spreadFor(multiplier: number, evidence: number, depth: number): number {
  const distance = Math.abs(multiplier - 1);
  const width = (1 - evidence) * (1 + 0.35 * depth) * distance;
  return round2(Math.max(0.02, width * 0.5 + 0.02));
}

/**
 * A leg between two entities is worse than either end alone, because both ends
 * have to be reached. Reported as a small extra inflation rather than a
 * composition, since composing two full movement channels would double-count the
 * access order.
 */
function extraLegInflation(from: ChannelSet, to: ChannelSet): number {
  const both = (from.movement.multiplier + to.movement.multiplier) / 2;
  return 1 + (both - 1) * 0.25;
}

/** Channels where a number below 1 is bad. Exported for the UI. */
export { CHANNEL_GOOD_WHEN_HIGH };
