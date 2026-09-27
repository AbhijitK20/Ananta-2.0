/**
 * Propagation: from a weather scenario to a state for every entity, with the
 * reasoning left in the order it happened.
 *
 * The brief's hard part is "identify direct and cascading effects" and "secondary
 * and higher-order effects", and the honest way to deliver that is to name the
 * orders, run them in a fixed sequence, and keep each one's contribution separable.
 * A single blended "impact score" cannot do that, which is why `ChannelSet` is six
 * numbers rather than one, and why `TwinState.cascades` is a list rather than a
 * paragraph.
 *
 * ## The four orders
 *
 * | # | Order        | What moves                                        | Where it comes from            |
 * |---|--------------|--------------------------------------------------|--------------------------------|
 * | 1 | `direct`     | the entity's own channels                         | `impact.ts` + the record's own fields |
 * | 2 | `access`     | `movement` on everything one hop away             | degraded transit corridors + proximity edges |
 * | 3 | `reroute`    | `demand` moves from closed to open                | the distance-decayed transfer  |
 * | 4 | `workforce`  | `capacity` on sheltered venues in a bad neighbourhood | neighbourhood aggregation  |
 *
 * Order 2 is the one that makes this a twin rather than a per-record filter. A
 * perfectly sheltered café 400 m from a flooded underpass has not changed at all,
 * and the traveller's experience of it has changed completely. Nothing that looks
 * only at the destination can see that, and it is the most common real way weather
 * alters a plan in a monsoon city.
 *
 * Order 3 is the one that makes the twin report *gains*, not only losses. Weather
 * that removes demand from a promenade adds it to a covered market two streets away,
 * and a demand multiplier above 1 is a real operational fact — it is how a covered
 * venue ends up sold out on a day the beach is empty.
 *
 * Order 4 is the highest-order effect and the one that is most often left out. Staff
 * live somewhere. When a low-lying neighbourhood floods, its staff cannot cross the
 * water, so a venue that is *open* and *dry* still operates at half strength. This
 * is why `capacity` floors above zero in the prior: "open with no staff" is a state
 * the twin has to be able to express.
 *
 * ## Uncertainty
 *
 * Every node carries an interval on its availability, and the interval is built from
 * three things that are all knowable: the cascade order that last touched it, how
 * many observations back the model's cell, and whether live social signal
 * corroborated it. A first-order effect read off a row's own fields is tight; a
 * third-order effect that no report mentions is wide. Reporting a point estimate for
 * the second of those is the thing that makes a simulation unfalsifiable, so the
 * interval is the primary output and the point estimate is derived from it.
 */
import {
  type ChannelKind,
  type ChannelSet,
  type EntityClass,
  type HazardKind,
  HAZARD_KINDS,
  composeChannels,
  neutralChannels,
  opennessOf,
  round2,
} from "./hazards";
import { type EntityGraph, type GraphNode, adjacencyOf, haversineMetres } from "./graph";
import { type ImpactModel, cellFor, directImpact, shelterBinOf } from "./impact";
import {
  type HazardDrivers,
  type WeatherScenario,
  conditionOf,
  driversOf,
  weekdayOf,
  monthOf,
} from "./scenario";
import type { SocialSignal } from "./social";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CascadeOrder = "direct" | "access" | "reroute" | "workforce";

export const CASCADE_ORDERS: readonly CascadeOrder[] = ["direct", "access", "reroute", "workforce"] as const;

/**
 * How much an order moved a node, as a fraction of its baseline.
 *
 * Relative rather than absolute, because a 0.05 change to a channel sitting at 1.0
 * and a 0.05 change to one sitting at 0.2 are not the same event, and the map needs
 * to rank them the way a reader would.
 */
export function orderWeight(before: ChannelSet, after: ChannelSet): number {
  let worst = 0;
  for (const kind of Object.keys(after) as ChannelKind[]) {
    const was = before[kind]?.multiplier ?? 1;
    const now = after[kind]?.multiplier ?? 1;
    worst = Math.max(worst, Math.abs(now - was) / Math.max(0.1, was));
  }
  return worst;
}

/**
 * Which order did the most to each node.
 *
 * An argmax over *measured* effects, resolved once at the end of `simulate` rather
 * than as each order runs. The alternative — last-writer-wins — reports `workforce`
 * for every node in the catalogue, because that pass reaches every neighbourhood,
 * and the map's cascade legend then carries no information. Resolving the argmax at
 * the end means a node whose journey doubled because of a flooded underpass and
 * which lost 6% of its staff says `access`, which is the true and useful answer.
 */
class DeepestOrder {
  private readonly weights = new Map<string, { order: CascadeOrder; weight: number }>();

  record(id: string, order: CascadeOrder, before: ChannelSet, after: ChannelSet): void {
    const weight = orderWeight(before, after);
    const current = this.weights.get(id);
    if (current && current.weight >= weight) return;
    this.weights.set(id, { order, weight });
  }

  /** Force an order, for the direct pass where the baseline is 1.0 by definition. */
  seed(id: string, order: CascadeOrder, weight: number): void {
    this.weights.set(id, { order, weight });
  }

  of(id: string, fallback: CascadeOrder): CascadeOrder {
    return this.weights.get(id)?.order ?? fallback;
  }
}

/** How much confidence one order of magnitude costs. Cumulative, not per-hop. */
const ORDER_COST: Record<CascadeOrder, number> = {
  direct: 0,
  access: 0.18,
  reroute: 0.32,
  workforce: 0.45,
};

/**
 * The workforce magnitudes, lifted out of the prior table.
 *
 * Re-declared rather than imported from `impact.ts` because the prior's `PriorRow`
 * type is private to that module and exporting a type solely so a sibling can index
 * it is worse than nine integers. `ponytail:` these must stay in step with the
 * `workforce` rows in `PRIOR`; the assertion that catches a drift is the "staff
 * cannot cross the water" case in the cascade test.
 */
const WORKFORCE_PRIOR: Record<HazardKind, { perSeverity: number }> = {
  rain: { perSeverity: -0.1 },
  heat: { perSeverity: -0.35 },
  wind: { perSeverity: -0.1 },
  flood: { perSeverity: -0.4 },
  storm: { perSeverity: -0.5 },
};

/** Nobody loses every member of staff. A floor, and an honest one. */
const WORKFORCE_FLOOR = 0.15;

/**
 * The saturating response.
 *
 * `1 - cost` is wrong at both ends: a 70 cm flood is not 100% staff loss, and the
 * curve has to be monotone without a cliff. `1 - cost / (1 + cost)` gives a smooth
 * asymptote at 0, so the worst realistic day lands around 40% staffing rather than
 * at zero, and a mild shower moves the number by a few percent. The claim a twin can
 * defend is the *ordering* of scenarios, and a saturating curve preserves that
 * without ever producing an absurd endpoint.
 */
function staffingRatio(cost: number, extra: number): number {
  const effective = cost * (1 + extra);
  return Math.max(WORKFORCE_FLOOR, 1 / (1 + effective));
}

export type NodeImpact = {
  id: string;
  name: string;
  entityClass: EntityClass;
  neighbourhood: string | null;
  /**
   * Where it is. Carried on the impact rather than looked up from the graph because
   * three separate consumers need it — the map layer, the reroute distance kernel and
   * the viewport filter — and each of them re-deriving it is three chances to pick a
   * different point for the same entity.
   */
  point: { lat: number; lon: number };
  /**
   * The last order that moved this node, which is what the interval width keys off.
   *
   * Read it as "the order that did the most damage", not "the order that ran last".
   * The workforce pass reaches *every* neighbourhood, so a last-writer-wins field
   * would report `workforce` for all 4,596 nodes and the map's cascade legend would
   * carry no information at all. Each order therefore records how much it actually
   * moved the node and the largest wins — a node whose journey doubled because of a
   * flooded underpass and which lost 6% of its staff reports `access`, which is the
   * true and useful answer.
   */
  deepestOrder: CascadeOrder;
  channels: ChannelSet;
  /** The direct half on its own, so the UI can show what the cascade added. */
  direct: ChannelSet;
  severity: number;
  reason: string;
  /** 90% interval on availability, from the cascade depth and the model's own confidence. */
  availability: { point: number; low: number; high: number };
  /** 0-1, and the single number to sort a list by. */
  confidence: number;
  hazards: { kind: HazardKind; severity: number }[];
};

export type CorridorImpact = {
  line: string;
  from: string;
  to: string;
  /** Multiplier on the published journey time. 1.0 is normal service. */
  multiplier: number;
  degraded: boolean;
  reason: string;
};

export type CascadeStep = {
  order: CascadeOrder;
  /** A finished sentence, because a number without a sentence is not auditable. */
  summary: string;
  /** How many nodes this order touched. */
  touched: number;
  /** The nodes it touched most, for the map to highlight. */
  highlights: string[];
};

export type HazardState = {
  kind: HazardKind;
  /** 0-3 before the model's correction. */
  physical: number;
  /** After the correction, and this is what reaches the planner. */
  severity: number;
  confidence: number;
  /** Which threshold set it, so the UI can say "41°C" and not "heat". */
  trigger: string;
};

export type TwinProvenance = {
  /** The aligned model, or `null` when the deterministic classifier is in use. */
  model: string | null;
  modelSource: "aligned" | "deterministic";
  /** Why the aligned model was not used, when it was not. */
  note: string;
  /** Reports that fed the assessment and the fit. */
  socialObserved: number;
  socialUsed: number;
  socialFailed: string[];
  /** Total reports behind the model's cells. Printed, because 4 and 400 are not the same claim. */
  observations: number;
  modelVersion: string;
  weatherSource: "live" | "simulated" | "unknown";
};

export type TwinState = {
  scenario: WeatherScenario;
  drivers: HazardDrivers;
  condition: ReturnType<typeof conditionOf>;
  hazards: HazardState[];
  nodes: ReadonlyMap<string, NodeImpact>;
  corridors: CorridorImpact[];
  cascades: CascadeStep[];
  provenance: TwinProvenance;
  /** The single headline number, so a card has something to show. */
  summary: {
    open: number;
    degraded: number;
    closed: number;
    total: number;
    /** Mean availability across every node, and its interval. */
    availability: { point: number; low: number; high: number };
    /** Net demand movement, signed. Positive is people moving towards shelter. */
    demandShift: number;
  };
};

export type SimulateOptions = {
  scenario: WeatherScenario;
  graph: EntityGraph;
  model: ImpactModel;
  signals: readonly SocialSignal[];
  /** Severities from the aligned model or the deterministic classifier, keyed by hazard. */
  severities: Readonly<Partial<Record<HazardKind, number>>>;
  /** Live weather provenance. `simulated` for a what-if slider. */
  weatherSource: "live" | "simulated" | "unknown";
  provenance: TwinProvenance;
  /** Corridor travel-time multiplier per flood/rain severity. Overridable for a test. */
  corridorSensitivity?: { rain: number; flood: number };
};

// ---------------------------------------------------------------------------
// Physical severity: the drivers, before any learning
// ---------------------------------------------------------------------------

/**
 * Physical severity per hazard, from the scenario's real units.
 *
 * Thresholds are ordered and each records the number that set it, so the UI can
 * print "60 mm/h" rather than "heavy rain" and a reader can check the boundary. The
 * `ponytail:` ceiling is that these are stated heuristics calibrated for coastal
 * Indian monsoon conditions, not a hydrological model; the model's job is to
 * calibrate their *severity*, not to dispute where they sit.
 */
function physicalSeverities(d: HazardDrivers): { state: HazardState; trigger: string }[] {
  const out: { state: HazardState; trigger: string }[] = [];
  const push = (kind: HazardKind, value: number, trigger: string, confidence: number): void => {
    out.push({ state: { kind, physical: round2(value), severity: round2(value), confidence, trigger }, trigger });
  };

  if (d.rainMmH >= 1) {
    const severity = d.rainMmH >= 25 ? 2.4 : d.rainMmH >= 10 ? 1.8 : d.rainMmH >= 4 ? 1.1 : 0.6;
    push("rain", severity, `${d.rainMmH} mm/h for ${d.durationH}h`, 0.9);
  } else {
    push("rain", 0, "no rainfall", 1);
  }

  // Flood is accumulated depth, and it is *also* inferred from total rainfall when
  // the scenario did not state a depth. That inference is the single least reliable
  // number in the twin and it says so: 0.45 confidence, against 0.9 for a stated
  // depth, because a depth that came from a slider is a measurement and one that came
  // from a multiplication is a guess.
  if (d.floodCm > 0) {
    push("flood", Math.min(3, d.floodCm / 20), `${d.floodCm} cm standing water`, 0.9);
  } else if (d.rainTotalMm >= 80) {
    push("flood", Math.min(2.2, d.rainTotalMm / 70), `${d.rainTotalMm} mm accumulated, no depth stated`, 0.45);
  } else {
    push("flood", 0, "no standing water", 1);
  }

  if (d.windKmh >= 25) {
    push("wind", d.windKmh >= 90 ? 2.6 : d.windKmh >= 55 ? 1.7 : 0.9, `${d.windKmh} km/h`, 0.85);
  } else {
    push("wind", 0, `wind ${d.windKmh} km/h`, 1);
  }

  // Heat needs the sun, and only the sun. This is the same distinction
  // `src/features/weather` established for the badge, and the twin inherits it rather
  // than re-deriving it: 41°C at 19:00 is a warm evening, not a closure.
  if (d.feelsLikeC >= 33) {
    const base = d.feelsLikeC >= 40 ? 2.4 : d.feelsLikeC >= 36 ? 1.5 : 0.8;
    const severity = d.sunUp ? base : base * 0.35;
    push("heat", severity, `${d.feelsLikeC}°C apparent${d.sunUp ? " in the sun" : " after sunset"}`, d.sunUp ? 0.85 : 0.7);
  } else {
    push("heat", 0, `${d.feelsLikeC}°C apparent`, 1);
  }

  // Storm is a *conjunction*, not a fifth independent hazard: rain and wind together,
  // or lightning risk. It gets its own prior row because the conjunction is worse
  // than either part, which is a fact about lightning and about wind loading a wet
  // structure, not an arithmetic sum of the two rows.
  const conjunction = d.rainMmH >= 25 && d.windKmh >= 45;
  if (conjunction) push("storm", Math.min(3, 1.6 + d.rainMmH / 60 + d.windKmh / 200), `${d.rainMmH} mm/h with ${d.windKmh} km/h gusts`, 0.8);
  else push("storm", 0, "no rain-wind conjunction", 1);

  return out;
}

// ---------------------------------------------------------------------------
// Corroboration from the social corpus
// ---------------------------------------------------------------------------

/**
 * How much the reports agree with the physical severity.
 *
 * This is the "real-world social signal" doing work rather than decorating a panel.
 * A scenario that says 45 mm/h and a corpus that says nothing about rain is a weaker
 * claim than the same scenario alongside twenty reports of flooding, and the
 * difference is a number the twin reports as confidence rather than as prose.
 *
 * Bounded to ±0.25 on purpose: social signal refines a physical reading, it does not
 * overrule it. A hundred tweets cannot make 5 mm/h a flood, and a model that let
 * them would be one bad bot away from closing a city.
 */
function corroboration(
  signals: readonly SocialSignal[],
  hazards: readonly HazardState[],
): { shift: number; used: number } {
  const counts = new Map<HazardKind, { weight: number; worst: number }>();
  for (const signal of signals) {
    for (const kind of signal.conditions) {
      const current = counts.get(kind) ?? { weight: 0, worst: 0 };
      const weight = Math.max(1, signal.weight);
      current.weight += weight;
      // An exposed report of a hazard is stronger evidence of that hazard than a
      // sheltered one, because a sheltered place surviving is not evidence the sky
      // was worse — only that the place was good.
      if (signal.exposure >= 0.5) current.worst += signal.exposure * weight;
      counts.set(kind, current);
    }
  }
  let shift = 0;
  let used = 0;
  for (const hazard of hazards) {
    if (hazard.physical <= 0) continue;
    const evidence = counts.get(hazard.kind);
    if (!evidence) continue;
    used += 1;
    const normalised = evidence.worst / Math.max(1, evidence.weight);
    shift += (normalised - 0.5) * 0.5;
  }
  return { shift: round2(Math.max(-0.25, Math.min(0.25, shift))), used };
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

/**
 * Run the twin. Pure, total, and non-mutating: it reads the graph and the model and
 * returns a new state, so two what-ifs can be compared and the live plan can never be
 * damaged by a simulation. That is the same guarantee `whatif/scenario.ts` gives for a
 * counterfactual trip, and the brief's "without affecting the actual system" is
 * literally this property.
 */
export function simulate(options: SimulateOptions): TwinState {
  const { scenario, graph, model, signals, provenance } = options;
  const drivers = driversOf(scenario);
  const condition = conditionOf(drivers);

  // 1. Physical severity, then the model's correction, then social corroboration.
  const physical = physicalSeverities(drivers);
  const social = corroboration(signals, physical.map((entry) => entry.state));
  const aligned = options.severities;

  const hazards: HazardState[] = physical.map(({ state }) => {
    // The aligned model / supplied assessment can only *raise* a severity, and only
    // when it reports the same hazard at or above what the physics already said. The
    // asymmetry is deliberate: a classifier is good at spotting a hazard the
    // threshold table missed and bad at dismissing one the measurements caught.
    const suggested = aligned?.[state.kind];
    const raised = typeof suggested === "number" ? Math.max(state.physical, Math.min(3, suggested)) : state.physical;
    const corrected = Math.min(3, raised * (1 + social.shift) * (1 + modelAdjustment(model, state.kind, raised)));
    const cellConfidence = raised > 0 ? averageConfidence(model, state.kind) : 1;
    return {
      kind: state.kind,
      physical: state.physical,
      severity: round2(corrected),
      confidence: round2(Math.min(1, state.confidence * 0.5 + cellConfidence * 0.35 + (social.used > 0 ? 0.15 : 0))),
      trigger: state.trigger,
    };
  });
  const severityByKind: Partial<Record<HazardKind, number>> = {};
  for (const hazard of hazards) severityByKind[hazard.kind] = hazard.severity;

  const activeSeverity = hazards.filter((hazard) => hazard.severity > 0);
  const socialConfidence = signals.length === 0 ? 0 : Math.min(0.5, signals.length / 40);

  // 2. Direct. One pass over every node, and a fast path that returns the neutral set
  //    for all of them when nothing is active — so a clear-sky what-if is O(n) with a
  //    very small constant and returns a plan identical to the baseline.
  const nodes = new Map<string, NodeImpact>();
  const directById = new Map<string, ChannelSet>();
  const deepest = new DeepestOrder();
  for (const node of graph.nodes.values()) {
    const impact = directImpact(model, node.entityClass, opennessOf(node.entityClass), severityByKind, socialConfidence);
    directById.set(node.id, impact.channels);
    nodes.set(node.id, toNodeImpact(node, impact, "direct", impact.channels));
    deepest.seed(node.id, "direct", orderWeight(neutralChannels(), impact.channels));
  }

  const cascades: CascadeStep[] = [];
  cascades.push({
    order: "direct",
    summary: activeSeverity.length === 0
      ? "No hazard is active. Every channel is at 1.0 and the plan is unchanged."
      : `${activeSeverity.map((hazard) => `${hazard.kind} ${hazard.severity} (${hazard.trigger})`).join("; ")}.`,
    touched: activeSeverity.length === 0 ? 0 : [...nodes.values()].filter((node) => node.severity > 0).length,
    highlights: topNodes(nodes, (node) => node.severity, 6),
  });

  // 3. Access. Degrade the corridors, then push the movement effect one hop.
  const corridorSensitivity = options.corridorSensitivity ?? { rain: 0.35, flood: 0.8 };
  const corridors = corridorImpacts(graph, severityByKind, corridorSensitivity);
  const degradedCorridors = corridors.filter((corridor) => corridor.degraded);
  const accessTouched = applyAccess(graph, nodes, directById, degradedCorridors, deepest);
  cascades.push({
    order: "access",
    summary: degradedCorridors.length === 0
      ? "No corridor is degraded, so no journey got longer."
      : `${degradedCorridors.length} of ${corridors.length} corridors degraded; ${accessTouched} entities inherit a longer journey.`,
    touched: accessTouched.size,
    highlights: [...accessTouched.values()].slice(0, 6),
  });

  // 4. Reroute. Move demand from what closed to what stayed open, by distance.
  const reroute = applyReroute(graph, nodes, directById, deepest);
  cascades.push({
    order: "reroute",
    summary: reroute.lostFrom === 0
      ? "Nothing closed, so demand did not move."
      : `Demand moved off ${reroute.lostFrom} entities and onto ${reroute.gainedBy} that stayed open, out to ${Math.round(reroute.radiusM / 100) * 100} m.`,
    touched: reroute.touched.length,
    highlights: reroute.touched.slice(0, 6),
  });

  // 5. Workforce. The highest order, aggregated per neighbourhood.
  const workforce = applyWorkforce(graph, nodes, directById, severityByKind, deepest);
  cascades.push({
    order: "workforce",
    summary: workforce.worstNeighbourhood === null
      ? "No neighbourhood lost staff."
      : `Staff cannot cross the water: ${workforce.worstNeighbourhood} is down to ${Math.round(workforce.worstRatio * 100)}% staffing, and ${workforce.touched} sheltered entities there are open at reduced capacity.`,
    touched: workforce.touched,
    highlights: workforce.highlights,
  });

  // 6. Resolve which order did the most to each node, now that all four have run.
  //    Done last so the answer is a comparison rather than a last-writer-wins.
  for (const [id, node] of nodes) {
    const order = deepest.of(id, "direct");
    if (order === node.deepestOrder) continue;
    nodes.set(id, {
      ...node,
      deepestOrder: order,
      // The interval belongs to the order that actually hurt, so it is recomputed
      // here rather than left at whatever the last pass happened to write.
      availability: {
        point: node.availability.point,
        low: round2(Math.max(0, node.availability.point - ORDER_COST[order] - (1 - node.confidence) * 0.2)),
        high: node.availability.high,
      },
    });
  }

  return {
    scenario,
    drivers,
    condition,
    hazards,
    nodes,
    corridors,
    cascades,
    provenance: { ...provenance, socialUsed: social.used },
    summary: summarise(nodes, reroute.netShift),
  };
}

// ---------------------------------------------------------------------------
// Cascade steps
// ---------------------------------------------------------------------------

function toNodeImpact(
  node: GraphNode,
  impact: { channels: ChannelSet; severity: number; reason: string; hazards: { kind: HazardKind; severity: number }[] },
  order: CascadeOrder,
  channels: ChannelSet,
): NodeImpact {
  const availability = channels.availability;
  // Width grows with cascade order and with how little the model's own cell is
  // backed by observations. A direct effect on a well-reported cell is tight; a
  // workforce effect on an unreported neighbourhood is not, and the interval is how
  // that says so.
  const spread = ORDER_COST[order] + (1 - availability.confidence) * 0.2;
  const point = availability.multiplier;
  return {
    id: node.id,
    name: node.name,
    entityClass: node.entityClass,
    neighbourhood: node.neighbourhood,
    point: node.point,
    deepestOrder: order,
    channels,
    direct: channels,
    severity: impact.severity,
    reason: impact.reason,
    availability: {
      point,
      low: round2(Math.max(0, point - spread)),
      high: round2(Math.min(1, point + spread * 0.5)),
    },
    confidence: availability.confidence,
    hazards: impact.hazards,
  };
}

function corridorImpacts(
  graph: EntityGraph,
  severity: Readonly<Partial<Record<HazardKind, number>>>,
  sensitivity: { rain: number; flood: number },
): CorridorImpact[] {
  const out: CorridorImpact[] = [];
  for (const corridor of graph.corridors) {
    const rain = severity.rain ?? 0;
    const flood = severity.flood ?? 0;
    // Rain slows a line; flood stops it. They are not the same failure and averaging
    // them would produce a corridor that is "slightly slow" in a flood, which is the
    // answer that gets a stranded traveller.
    const multiplier = round2(1 + rain * sensitivity.rain + flood * sensitivity.flood);
    const degraded = multiplier > 1.05;
    out.push({
      line: corridor.line,
      from: corridor.from,
      to: corridor.to,
      multiplier,
      degraded,
      reason: degraded
        ? `${corridor.line} ${corridor.from} to ${corridor.to}: journeys ${Math.round((multiplier - 1) * 100)}% longer than the published ${corridor.minutes} min.`
        : "",
    });
  }
  return out;
}

/**
 * Order 2. Push the movement penalty one hop from every degraded corridor.
 *
 * The hop goes over `proximity` edges, so "one hop" is a real 2 km walk and not an
 * arbitrary adjacency. Entities already hit by a *worse* movement penalty keep it —
 * the cascade composes downward, never upward, so a node cannot end up more
 * comfortable than the direct reading said.
 */
function applyAccess(
  graph: EntityGraph,
  nodes: Map<string, NodeImpact>,
  directById: Map<string, ChannelSet>,
  degraded: readonly CorridorImpact[],
  deepest: DeepestOrder,
): Map<string, string> {
  const touched = new Map<string, string>();
  if (degraded.length === 0) return touched;
  const adjacency = adjacencyOf(graph);

  for (const corridor of degraded) {
    // Find the node nearest each end of the corridor, then flood outward one hop.
    for (const seed of [corridor.from, corridor.to]) {
      const seedIds = graph.byNeighbourhood.get(seed) ?? [];
      const seeds = seedIds.length > 0 ? seedIds : [...graph.nodes.values()].filter((node) => node.neighbourhood === seed).map((node) => node.id);
      for (const id of seeds.slice(0, 40)) {
        for (const edge of adjacency.get(id) ?? []) {
          if (edge.kind !== "proximity") continue;
          const other = edge.from === id ? edge.to : edge.from;
          const node = graph.nodes.get(other);
          const current = directById.get(other);
          if (!node || !current) continue;
          // Distance-decayed: the full penalty at the corridor, half at 2 km.
          const decay = 1 - Math.min(1, edge.metres / 2_000) * 0.5;
          const penalty = round2((corridor.multiplier - 1) * decay);
          if (penalty < 0.03) continue;

          const alreadyWorse = nodes.get(other)!.channels.movement.multiplier;
          const proposed = round2(Math.max(1, alreadyWorse * (1 + penalty)));
          if (proposed <= alreadyWorse + 0.01) continue;

          const channels: ChannelSet = {
            ...current,
            movement: {
              kind: "movement",
              multiplier: proposed,
              confidence: round2(Math.max(0.1, current.movement.confidence - ORDER_COST.access)),
            },
          };
          const merged = composeChannels(channels, neutralChannels());
          deepest.record(other, "access", current, channels);
          directById.set(other, channels);
          nodes.set(other, {
            ...nodes.get(other)!,
            channels: merged,
            availability: {
              point: merged.availability.multiplier,
              low: round2(Math.max(0, merged.availability.multiplier - ORDER_COST.access - 0.1)),
              high: round2(Math.min(1, merged.availability.multiplier + 0.08)),
            },
            reason: `Reachable only through a degraded route: journeys ${Math.round((proposed - 1) * 100)}% longer, and nothing about this place itself has changed.`,
          });
          touched.set(other, nodes.get(other)!.reason);
        }
      }
    }
  }
  return touched;
}

/**
 * Order 3. Move demand from what closed to what stayed open.
 *
 * The transfer is distance-decayed and capped, because "everyone who wanted the
 * beach now wants this one cafe" is not a real thing and a model that reports it is
 * reporting a rounding error. The cap is on the *gain* side: demand can rise by at
 * most half, which is generous for a 2 km radius in a city with this much supply.
 */
function applyReroute(
  graph: EntityGraph,
  nodes: Map<string, NodeImpact>,
  directById: Map<string, ChannelSet>,
  deepest: DeepestOrder,
): { touched: string[]; lostFrom: number; gainedBy: number; netShift: number; radiusM: number } {
  const RADIUS_M = 2_000;
  const MAX_GAIN = 0.5;
  const closed = [...nodes.values()].filter((node) => node.availability.point < 0.35);
  const result = { touched: [] as string[], lostFrom: 0, gainedBy: 0, netShift: 0, radiusM: RADIUS_M };
  if (closed.length === 0) return result;

  const losers = new Set(closed.map((node) => node.id));
  const lostTotal = closed.reduce((sum, node) => sum + (1 - node.availability.point), 0);
  result.lostFrom = losers.size;

  // A grid over the open nodes, so the neighbourhood search is a cell scan rather
  // than a scan of all 4,596. Same trick as the graph build, same reason.
  const CELL = 0.02;
  const open = new Map<string, GraphNode[]>();
  for (const node of graph.nodes.values()) {
    if (losers.has(node.id)) continue;
    if ((nodes.get(node.id)?.availability.point ?? 1) < 0.6) continue;
    const key = `${Math.floor(node.point.lon / CELL)}:${Math.floor(node.point.lat / CELL)}`;
    const bucket = open.get(key);
    if (bucket) bucket.push(node);
    else open.set(key, [node]);
  }

  const gains = new Map<string, number>();
  for (const closedNode of closed) {
    const cx = Math.floor(closedNode.point.lon / CELL);
    const cy = Math.floor(closedNode.point.lat / CELL);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const candidate of open.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const metres = haversineMetres(closedNode.point, candidate.point);
          if (metres > RADIUS_M) continue;
          // Triangular kernel: full transfer at the doorstep, nothing at the radius.
          const share = (1 - metres / RADIUS_M) * (1 - closedNode.availability.point);
          gains.set(candidate.id, (gains.get(candidate.id) ?? 0) + share);
        }
      }
    }
  }

  for (const [id, rawGain] of gains) {
    const node = graph.nodes.get(id);
    const current = directById.get(id);
    if (!node || !current) continue;
    // Normalise against the demand that actually left, so the total transferred is a
    // fraction of the total lost rather than an unbounded accumulation.
    const share = lostTotal > 0 ? Math.min(MAX_GAIN, rawGain / lostTotal) : 0;
    if (share < 0.02) continue;
    const channels: ChannelSet = {
      ...current,
      demand: {
        kind: "demand",
        multiplier: round2(current.demand.multiplier * (1 + share)),
        confidence: round2(Math.max(0.1, current.demand.confidence - ORDER_COST.reroute)),
      },
    };
    deepest.record(id, "reroute", current, channels);
    directById.set(id, channels);
    const previous = nodes.get(id)!;
    nodes.set(id, {
      ...previous,
      channels,
      reason:
        previous.reason && previous.severity > 0
          ? `${previous.reason} Demand also up ${Math.round(share * 100)}% from what closed nearby.`
          : `Untouched by the weather itself, and ${Math.round(share * 100)}% more people than usual are looking for somewhere to go.`,
    });
    result.gainedBy += 1;
    result.touched.push(id);
  }
  result.netShift = round2([...gains.values()].reduce((sum, value) => sum + value, 0));
  return result;
}

/**
 * Order 4. Workforce, aggregated per neighbourhood.
 *
 * This order owns the `workforce` channel outright — `directImpact` never touches
 * it, because a single record cannot tell you whether its staff can get to work. The
 * magnitudes come from the same `PRIOR` table the direct pass reads, so there is one
 * statement of what each hazard costs a channel and not two.
 *
 * The neighbourhood's ratio is its own flood exposure, and a name that says
 * "waterlogging" is the one place the corpus states it rather than the twin guessing
 * it. `capacity` then follows staffing at half strength, because half the staff can
 * still run half the rooms — which is why a sheltered venue can be open and still be
 * the wrong answer on a flood day.
 */
function applyWorkforce(
  graph: EntityGraph,
  nodes: Map<string, NodeImpact>,
  directById: Map<string, ChannelSet>,
  severity: Readonly<Partial<Record<HazardKind, number>>>,
  deepest: DeepestOrder,
): { touched: number; worstNeighbourhood: string | null; worstRatio: number; highlights: string[] } {
  /**
   * The staffing cost, as a **positive** magnitude.
   *
   * Two sign errors lived here and both made order 4 silently never fire, so the
   * accumulation is now positive and the guard is `=== 0`:
   *
   *  - every `perSeverity` in `WORKFORCE_PRIOR` is negative, so a `load <= 0` guard
   *    rejected *every* scenario including a 70 cm flood;
   *  - the ratio was then computed as `1 - load`, which *raised* it above 1.
   *
   * A test asserts that a flood reaches the workforce order at all, which is what
   * caught both. Neither was visible in a passing test suite, because the function
   * returned a well-formed "nothing happened" result rather than throwing.
   */
  let cost = 0;
  for (const hazard of HAZARD_KINDS) {
    const value = severity[hazard] ?? 0;
    if (value <= 0) continue;
    cost += Math.abs(WORKFORCE_PRIOR[hazard].perSeverity) * value;
  }
  if (cost === 0) return { touched: 0, worstNeighbourhood: null, worstRatio: 1, highlights: [] };

  let worstNeighbourhood: string | null = null;
  let worstRatio = 1;
  let touched = 0;
  const highlights: string[] = [];

  for (const [neighbourhood, ids] of graph.byNeighbourhood) {
    const stated = /waterlog|low.?lying|drain/i.test(neighbourhood) ? 0.35 : 0;
    const ratio = staffingRatio(cost, stated);
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstNeighbourhood = neighbourhood;
    }

    for (const id of ids) {
      const node = nodes.get(id);
      const current = directById.get(id);
      if (!node || !current) continue;
      const existing = current.workforce.multiplier;
      const proposed = round2(Math.min(existing, ratio));
      // A shelter-blind read is the point of this order: an indoor gallery loses staff
      // in a flood exactly as much as an open-air one does.
      if (proposed >= existing - 0.01) continue;
      const channels: ChannelSet = {
        ...current,
        workforce: { kind: "workforce", multiplier: proposed, confidence: round2(Math.max(0.1, current.workforce.confidence - ORDER_COST.workforce)) },
        capacity: { kind: "capacity", multiplier: round2(Math.max(0.2, current.capacity.multiplier * (0.5 + 0.5 * proposed))), confidence: round2(Math.max(0.1, current.capacity.confidence - ORDER_COST.workforce)) },
      };
      deepest.record(id, "workforce", current, channels);
      directById.set(id, channels);
      nodes.set(id, {
        ...node,
        channels,
        availability: {
          point: channels.availability.multiplier,
          low: round2(Math.max(0, channels.availability.multiplier - ORDER_COST.workforce - 0.12)),
          high: round2(Math.min(1, channels.availability.multiplier + 0.1)),
        },
        reason: `${node.reason ? `${node.reason} ` : ""}Staff cannot cross the water: ${neighbourhood} is at ${Math.round(proposed * 100)}% staffing, so it trades at ${Math.round(channels.capacity.multiplier * 100)}% capacity while open.`,
      });
      touched += 1;
      if (highlights.length < 6) highlights.push(id);
    }
  }
  return { touched, worstNeighbourhood, worstRatio, highlights };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summarise(nodes: ReadonlyMap<string, NodeImpact>, netShift: number): TwinState["summary"] {
  let open = 0;
  let degraded = 0;
  let closed = 0;
  let availabilitySum = 0;
  let lowSum = 0;
  let highSum = 0;
  for (const node of nodes.values()) {
    const point = node.availability.point;
    if (point <= 0.05) closed += 1;
    else if (point < 0.8) degraded += 1;
    else open += 1;
    availabilitySum += point;
    lowSum += node.availability.low;
    highSum += node.availability.high;
  }
  const total = nodes.size;
  const divide = (value: number): number => (total === 0 ? 1 : value / total);
  return {
    open,
    degraded,
    closed,
    total,
    availability: { point: round2(divide(availabilitySum)), low: round2(divide(lowSum)), high: round2(divide(highSum)) },
    demandShift: round2(netShift),
  };
}

function topNodes(nodes: ReadonlyMap<string, NodeImpact>, score: (node: NodeImpact) => number, limit: number): string[] {
  return [...nodes.values()]
    .map((node) => ({ id: node.id, score: score(node) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.id);
}

function modelAdjustment(model: ImpactModel, hazard: HazardKind, severity: number): number {
  if (severity <= 0) return 0;
  // The mean adjustment across the shelter bins that this severity could reach. A
  // single cell would be a guess about which entity is asking; the mean is the
  // model's overall opinion, and the per-entity cell is applied later in
  // `directImpact` where the entity is actually known.
  const bins = ["partial", "open", "exposed"] as const;
  const mean = bins.reduce((sum, bin) => sum + cellFor(model, hazard, shelterBinOf(bin === "partial" ? 1 : bin === "open" ? 2 : 3)).adjustment, 0) / bins.length;
  return mean * Math.min(1, severity / 2);
}

function averageConfidence(model: ImpactModel, hazard: HazardKind): number {
  const bins = ["sheltered", "partial", "open", "exposed"] as const;
  const sum = bins.reduce((total, bin) => total + cellFor(model, hazard, bin).confidence, 0);
  return sum / bins.length;
}

/** The month the scenario falls in, which the engine's season gate needs. */
export function scenarioMonth(scenario: WeatherScenario): number {
  return monthOf(scenario);
}

/** The weekday the scenario falls on, which the engine's hours gate needs. */
export function scenarioWeekday(scenario: WeatherScenario): number {
  return weekdayOf(scenario);
}

/** Channel names, re-exported so the UI does not import `hazards.ts` for a list. */
export const CHANNELS: readonly ChannelKind[] = ["availability", "capacity", "movement", "demand", "duration", "workforce"] as const;

export { HAZARD_KINDS };
