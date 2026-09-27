/**
 * The twin's graph: the real-world things this planner already addresses, and the
 * relationships between them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ENTITIES ARE NOT INVENTED
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit that this must be an *enhancement* to the existing
 * solution rather than a new application, and that has a concrete consequence
 * here: the nodes are the traveller's own stops and the cities they sit in, and
 * the edges are the legs the planner has already routed between them. Nothing is
 * fabricated, so a claim the twin makes can be checked against the itinerary
 * printed next to it.
 *
 * That also means the graph is *empty until there is a trip*, which is the honest
 * behaviour. A twin that populated itself with invented hotels so the panel had
 * something to draw would be answering a question nobody asked.
 *
 * ---------------------------------------------------------------------------
 * WHY PROXIMITY IS A REAL EDGE AND NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 *
 * The access cascade *is* a proximity effect. A flooded road between you and a
 * perfectly dry café is the single most common way weather changes a plan without
 * changing anything about the destination, and it is the case the whole `access`
 * edge exists to express. So `access` is not a map helper — it is the cascade's
 * reachability primitive, and the map overlay consumes the same adjacency so the
 * picture and the arithmetic cannot disagree.
 */

import { haversineKm } from "../plan/geo";
import { PLACES } from "../plan/places";
import type { Day, Leg, Stop } from "../plan/types";
import type { EntityClass, TwinEdge, TwinGraph, TwinNode } from "./types";

/**
 * Beyond this, a stop is too far from the city centre to be explained by the
 * city's weather, and a straight-line walk between two coordinates is not a road.
 * Chosen so a day of city-centre stops (the common case, since the directory has
 * no per-venue coordinates) stays inside it.
 */
const ACCESS_CUTOFF_KM = 12;

/** Comfortable speeds, matching `lib/plan/geo`. Only used for derived edges. */
const SPEED_KMH: Record<string, number> = { car: 80, bike: 16, foot: 4.5 };

/* -------------------------------------------------------------------------- *
 * Classification
 * -------------------------------------------------------------------------- */

/**
 * Words that mean "the weather *is* the product".
 *
 * A harbour in a squall is not a degraded harbour, and neither is a viewpoint on
 * a ridge in a gale. These are the classes where a hazard takes availability
 * toward zero outright rather than shaving it.
 */
const WATER_WORDS = [
  "beach", "garden", "park", "boat", "ferry", "harbour", "harbor", "waterfront",
  "marine", "island", "wetland", "river", "lake", "seaside", "promenade",
] as const;

const TERRAIN_WORDS = [
  "viewpoint", "fort", "hill", "peak", "trail", "hike", "monument", "tower",
  "mountain", "cliff", "cable car", "funicular", "rooftop",
] as const;

/**
 * Words that mean "you can stand inside it", found in the source's own prose
 * rather than in a taxonomy this file would have to invent.
 *
 * The directory's own `cats` covers most of this, but the 578 uncategorised
 * entries — which the planner's own file note calls the awkward part — are
 * exactly the rows a tag-only classifier gets wrong. A snippet that says
 * "inside a converted church" is indoor whether or not the row carries a
 * category.
 */
const INDOOR_WORDS = [
  "museum", "gallery", "church", "cathedral", "basilica", "chapel", "mosque",
  "synagogue", "temple", "aquarium", "library", "bookshop", "market hall",
  "castle", "palace", "monastery", "theatre", "theater", "cinema", "spa",
  "sauna", "bathhouse", "shop", "store", "cafe", "café", "restaurant", "bar",
  "brewery", "distillery", "winery", "hotel", "hostel", "guesthouse", "resort",
  "mall", "arcade", "centre", "center", "institute", "academy", "university",
] as const;

const COVERED_WORDS = [
  "arcade", "colonnade", "veranda", "terrace", "portico", "loggia", "pavilion",
  "promenade", "cloister", "atrium", "shaded", "underground", "passage",
] as const;

export type Classification = { entityClass: EntityClass; reason: string };

const has = (haystack: string, words: readonly string[]) =>
  words.some((w) => haystack.includes(w));

/**
 * The one classifier. Pure, total, never returns null.
 *
 * Precedence is deliberate and worth stating, because it is not alphabetical:
 *
 *   1. A pin has no category and no prose. It is `unknown`, and the UI says the
 *      shelter is not recorded. Guessing either way would be inventing a closure
 *      or inventing safety.
 *   2. Water and terrain outrank the indoor/outdoor tag, because a row tagged
 *      `attractions` that is a harbour is a harbour whatever the tag says.
 *   3. Then the directory's own tag, which is authoritative when it is present.
 *   4. Then the prose, which is the only thing left for the untagged rows.
 */
export function classifyStop(stop: Stop): Classification {
  const place = stop.placeId ? PLACES.find((p) => p.id === stop.placeId) : undefined;

  if (stop.source === "pin" || !place) {
    return {
      entityClass: "unknown",
      reason: "A pin you dropped. The planner has no category for it, so the twin will not guess one.",
    };
  }

  const tags = place.tags;
  const prose = `${place.name} ${place.hood} ${place.snippet}`.toLowerCase();
  const name = place.name.toLowerCase();

  if (has(name, WATER_WORDS) || tags.some((t) => t === "sightseeing" && has(name, WATER_WORDS))) {
    return {
      entityClass: "water_dependent",
      reason: `"${place.name}" depends on the water, so rainfall and flood act on it directly.`,
    };
  }

  if (has(name, TERRAIN_WORDS)) {
    return {
      entityClass: "terrain_exposed",
      reason: `"${place.name}" is exposed terrain, where wind is the binding constraint.`,
    };
  }

  if (tags.includes("hotels")) {
    return {
      entityClass: "indoor_shelter",
      reason: "Hotels are the most sheltered thing in the directory.",
    };
  }

  if (tags.includes("restaurants")) {
    return {
      entityClass: "indoor_shelter",
      reason: "Restaurants are indoors, though a terrace room is not — treat the shelter figure as an upper bound.",
    };
  }

  if (tags.includes("shopping") || tags.includes("nightlife")) {
    return {
      entityClass: "mixed_shelter",
      reason: `Tagged ${tags.includes("shopping") ? "shopping" : "nightlife"}, which is part indoors and part out.`,
    };
  }

  if (tags.includes("tours") || tags.includes("sightseeing") || tags.includes("attractions")) {
    if (has(prose, INDOOR_WORDS)) {
      return {
        entityClass: "indoor_shelter",
        reason: "Tagged as a sight, but its own description says you go inside.",
      };
    }
    if (has(prose, COVERED_WORDS)) {
      return {
        entityClass: "covered_veranda",
        reason: "Its description names a covered walkway or arcade, so it is partly sheltered.",
      };
    }
    return {
      entityClass: "open_air",
      reason: "Tagged as a sight with nothing in its description suggesting shelter.",
    };
  }

  // The untagged rows. The planner's own file note says these are the awkward
  // part, and they are the ones a tag-only classifier would have to discard.
  if (has(prose, INDOOR_WORDS)) {
    return { entityClass: "indoor_shelter", reason: "Untagged, but its description says you go inside." };
  }
  if (has(prose, COVERED_WORDS)) {
    return { entityClass: "covered_veranda", reason: "Untagged, but its description names cover." };
  }

  return {
    entityClass: "open_air",
    reason: "Untagged in the source, so the twin has no evidence it is sheltered and assumes it is not.",
  };
}

/* -------------------------------------------------------------------------- *
 * Assembly
 * -------------------------------------------------------------------------- */

export type BuildGraphInput = {
  /** Every stop, skipped included: a "maybe" is weather-relevant even though it
   *  is not routed. */
  stops: readonly Stop[];
  legs: readonly Leg[];
  days: readonly Day[];
  /** `coordsFor`, injected so this module stays free of the data file and testable. */
  coordFor: (city: string) => { name: string; lat: number; lon: number } | null;
};

/**
 * Build the graph. Pure: the same trip always yields the same graph, which is
 * what makes a counterfactual comparable to its baseline.
 */
export function buildTwinGraph(input: BuildGraphInput): TwinGraph {
  const { stops, legs, days, coordFor } = input;

  const dayOfStop = new Map<string, number>();
  days.forEach((day, i) => day.stopIds.forEach((id) => dayOfStop.set(id, i)));

  const nodes = new Map<string, TwinNode>();
  const stopNodes: TwinNode[] = [];
  const edges: TwinEdge[] = [];

  /* ---- stops ---- */

  for (const stop of stops) {
    const { entityClass, reason } = classifyStop(stop);
    const node: TwinNode = {
      id: `stop:${stop.id}`,
      kind: "stop",
      name: stop.name,
      city: stop.city,
      at: stop.at,
      entityClass,
      classReason: reason,
      isPin: stop.source === "pin",
      dwell: stop.dwell,
      day: dayOfStop.get(stop.id) ?? -1,
      href: stop.href,
    };
    nodes.set(node.id, node);
    stopNodes.push(node);
  }

  /* ---- cities, one per distinct city the trip touches ---- */

  const cityNode = new Map<string, string>();
  const cityNodes: TwinNode[] = [];
  const seenCities = new Set<string>();

  for (const stop of stops) {
    if (!stop.city || seenCities.has(stop.city)) continue;
    seenCities.add(stop.city);

    const coord = coordFor(stop.city);
    if (!coord) continue;

    const node: TwinNode = {
      id: `city:${stop.city}`,
      kind: "city",
      name: coord.name,
      city: stop.city,
      at: { lat: coord.lat, lon: coord.lon },
      // A city is the weather itself. It is the one node the hazards attach to
      // directly with no shelter scaling, which is why `opennessOf` is never
      // consulted for it.
      entityClass: "open_air",
      classReason: "The city centre, where the observation is taken.",
      isPin: false,
      dwell: 0,
      day: -1,
    };
    nodes.set(node.id, node);
    cityNode.set(stop.city, node.id);
    cityNodes.push(node);
  }

  /* ---- `contains`: every stop belongs to its city's weather ---- */

  for (const stop of stops) {
    const parent = stop.city ? cityNode.get(stop.city) : undefined;
    if (!parent) continue;
    edges.push({
      from: `stop:${stop.id}`,
      to: parent,
      kind: "contains",
      km: 0,
      hours: 0,
    });
  }

  /* ---- `leg`: the routed itinerary, in order ---- */

  const order = new Map<string, number>();
  stops.filter((s) => !s.skipped).forEach((s, i) => order.set(s.id, i));

  legs.forEach((leg) => {
    const from = `stop:${leg.fromId}`;
    const to = `stop:${leg.toId}`;
    if (!nodes.has(from) || !nodes.has(to)) return;
    edges.push({ from, to, kind: "leg", km: leg.km, hours: leg.hours });
  });

  /* ---- `access`: the derived proximity the cascade walks ----
     Cutoff is 12 km rather than infinity on purpose. A "nearby" edge across a
     continent is not a reason to expect a road to be passable, and an unbounded
     adjacency would let a storm in one country close a café in another. */

  const routedStops = stopNodes.filter((n) => order.has(n.id.slice(5)));
  for (let i = 0; i < routedStops.length; i++) {
    for (let j = i + 1; j < routedStops.length; j++) {
      const a = routedStops[i];
      const b = routedStops[j];
      const km = haversineKm(a.at, b.at);
      if (km > ACCESS_CUTOFF_KM) continue;
      edges.push({
        from: b.id,
        to: a.id,
        kind: "access",
        km,
        hours: km / SPEED_KMH.car,
      });
    }
  }

  /* ---- inbound adjacency, for the cascade ---- */

  const inbound = new Map<string, string[]>();
  for (const edge of edges) {
    const list = inbound.get(edge.to);
    if (list) list.push(edge.from);
    else inbound.set(edge.to, [edge.from]);
  }

  return {
    nodes,
    edges,
    inbound,
    cityNode,
    stops: stopNodes,
    cities: cityNodes,
  };
}

/** The edges leaving a node, for callers that need the forward direction. */
export function outboundOf(graph: TwinGraph, nodeId: string): readonly TwinEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

/** A compact description of the graph, for the provenance panel. Counts read off
 *  the graph so the number in the UI cannot drift from the model. */
export function describeGraph(graph: TwinGraph): {
  nodes: number;
  stops: number;
  cities: number;
  legs: number;
  access: number;
  pins: number;
  unclassified: number;
} {
  return {
    nodes: graph.nodes.size,
    stops: graph.stops.length,
    cities: graph.cities.length,
    legs: graph.edges.filter((e) => e.kind === "leg").length,
    access: graph.edges.filter((e) => e.kind === "access").length,
    pins: graph.stops.filter((n) => n.isPin).length,
    unclassified: graph.stops.filter((n) => n.entityClass === "unknown").length,
  };
}
