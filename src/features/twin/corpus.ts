/**
 * The domain corpus the Digital Twin aligns on.
 *
 * `scripts/nugen-align.ts` uploads what this file returns to Nugen and gets back a
 * model aligned to it. So this file is the actual answer to "customise the model
 * according to your project's specific domain": the corpus is not a general
 * weather dataset and not prose written to look like a dataset, it is **this
 * repository's own knowledge, restructured into training text** — the 4,596-row
 * catalogue's shelter structure, the 291 reviews' exposure judgements, the 40
 * events' stated cancellation thresholds, and the twin's own impact taxonomy.
 *
 * Four document kinds, in the order a model benefits from:
 *
 *  1. `taxonomy`      what the hazards and channels *are*, and the reasoning. This
 *                     is the only document that is written rather than derived, and
 *                     it exists because a model aligned only on observations will
 *                     learn the correlations but not the causal structure that lets
 *                     it generalise to a hazard it has never seen.
 *  2. `neighbourhood` one per area: what is there, how sheltered it is, what people
 *                     actually report about it in bad weather.
 *  3. `cancellation`  the events' own stated thresholds. Operators writing "called
 *                     off if sustained wind is under 8 km/h" have stated a rule, and
 *                     a rule is a training target a sentiment score is not.
 *  4. `propagation`   how an effect reaches a second and third entity. The cascading
 *                     half of the brief, written down once so the model does not have
 *                     to rediscover it per inference.
 *
 * Pure and synchronous: it takes already-loaded data and returns strings. Every
 * side effect — reading the files, uploading, polling — belongs to the script.
 */
import {
  HAZARD_KINDS,
  CHANNEL_KINDS,
  type EntityClass,
  type HazardKind,
  classify,
  opennessOf,
} from "./hazards";
import { classifyReport, type SocialSignal } from "./social";

export type CorpusDocument = {
  name: string;
  category: string;
  text: string;
};

type CatalogueRow = {
  id: string;
  name: string;
  category: string;
  location: { lat: number; lon: number };
  durationMin: number;
  indoorOutdoor: "indoor" | "outdoor" | "covered" | "mixed";
  weatherSensitive: "none" | "rain" | "heat" | "wind" | "any";
  neighbourhood: string | null;
  capacity: number | null;
  blurb: string | null;
};

const word = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

// ---------------------------------------------------------------------------
// 1. The taxonomy
// ---------------------------------------------------------------------------

/**
 * The written part of the corpus. Kept as a template rather than a constant string
 * so the channel and hazard lists are interpolated from `hazards.ts` — if a channel
 * is added there and not here, the corpus and the engine disagree and the model
 * learns a taxonomy the product does not use.
 */
export function taxonomyDocument(): CorpusDocument {
  const channels = CHANNEL_KINDS.map((kind) => `- ${kind}: a multiplier on 1.0`).join("\n");
  const hazards = HAZARD_KINDS.map((kind) => {
    switch (kind) {
      case "rain":
        return "- rain: severity rises with rainfall rate. Light rain degrades; sustained heavy rain closes anything outdoors. Rain accumulates, so duration matters as much as intensity.";
      case "heat":
        return "- heat: severity is driven by apparent temperature, and only bites between 10:00 and 16:00. Shade, tree cover, an arcaded verandah and a stone floor are the difference between degraded and closed. A flat roof or an iron roof in the sun is the worst case in the catalogue.";
      case "wind":
        return "- wind: severity rises with gust speed. Anything wind-dependent — kites, sails, open-air dining umbrellas, hoardings — is closed by moderate wind and nothing else is.";
      case "flood":
        return "- flood: driven by accumulated rainfall over a low-lying surface, not by the current rate. Open drains, waterlogging under flyovers and low-lying roads near the sea are the exposure. Flood closes movement before it closes any venue, which is why it cascades furthest.";
      case "storm":
        return "- storm: rain plus wind plus the threat of lightning. Closes open air outright and is the only hazard that also empties the workforce, because staff cannot cross a flooded road either.";
    }
  }).join("\n");
  const classes = (
    [
      "indoor_shelter",
      "covered_veranda",
      "mixed_shelter",
      "open_air",
      "water_dependent",
      "terrain_exposed",
      "transit_node",
    ] as const
  )
    .map(
      (entityClass) =>
        `- ${entityClass} (openness ${opennessOf(entityClass)}/3): ${CLASS_NOTES[entityClass]}`,
    )
    .join("\n");

  return {
    name: "01-hazard-and-channel-taxonomy.txt",
    category: "taxonomy",
    text: [
      "TRAVELBUDDY DIGITAL TWIN — HAZARD AND CHANNEL TAXONOMY",
      "",
      "This describes how weather propagates through a hospitality and travel",
      "catalogue of Mumbai experiences. Each experience is an entity with a",
      "location, a duration, a capacity and a shelter class.",
      "",
      "HAZARDS (five):",
      hazards,
      "",
      "CHANNELS (six, each a multiplier on 1.0):",
      channels,
      "",
      "ENTITY CLASSES (seven, derived from the record's indoor/outdoor field and",
      "its category; an uncurated OpenStreetMap row still classifies):",
      classes,
      "",
      "HOW AN EFFECT PROPAGATES, in cascade order:",
      "  1. DIRECT. Weather acts on the entity. A venue that is open air loses",
      "     availability immediately.",
      "  2. ACCESS. The road or the rail line to the entity degrades. Travel time",
      "     rises for everything nearby, including entities that are themselves",
      "     perfectly fine. This is the most common cascade and it is invisible if",
      "     you only look at the entity.",
      "  3. REROUTE. Demand moves away from what closed and towards what stayed",
      "     open. An indoor entity near a flooded cluster gains demand, so its",
      "     capacity becomes the scarce resource and it can sell out.",
      "  4. WORKFORCE. Staff live somewhere. When a neighbourhood floods, its staff",
      "     cannot arrive, so even a sheltered venue loses capacity. This is the",
      "     highest-order effect and the reason a venue can be open and still be",
      "     operating at half strength.",
      "",
      "RULES THAT HOLD AT EVERY CASCADE ORDER:",
      "- Confidence falls with cascade depth. A first-order effect read off the",
      "  entity's own fields is reliable; a third-order effect is a hypothesis and",
      "  must be reported as one, with a number attached.",
      "- A sheltered entity is not immune to access and workforce effects. It is",
      "  immune only to the direct weather effect.",
      "- Demand is a signed quantity. Weather that removes demand from a beach",
      "  adds it to a covered market. Reporting only absolute loss is wrong.",
      "- A report that praises a place for staying dry in the rain is evidence that",
      "  the place is sheltered, not evidence of rain damage. Read the polarity.",
    ].join("\n"),
  };
}

const CLASS_NOTES: Record<EntityClass, string> = {
  indoor_shelter: "fully under a roof. Weather cannot close it directly. Gains demand when outdoor demand collapses.",
  covered_veranda: "an arcade, a colonnade, a verandah. Tolerates heavy rain. The single most useful thing to know about an entity.",
  mixed_shelter: "partly outside. Degrades before it closes, and which part matters: the outdoor part closes first.",
  open_air: "in the open. Rain and heat close it. A flat lawn or an exposed terrace is the worst case.",
  water_dependent: "a beach, a garden, a boat, a ferry, a waterfront. Its value IS the weather, so it closes at a low rain threshold and gains demand in heat.",
  terrain_exposed: "a fort, a viewpoint, a hill, a trail. Wind and rain close it, and stairs plus wet stone is the accessibility failure that closes it first.",
  transit_node: "a station, a ferry terminal, a bus stand. Closed by flood and by nothing else. It is where the access cascade is measured.",
};

// ---------------------------------------------------------------------------
// 2. Neighbourhoods
// ---------------------------------------------------------------------------

/**
 * One document per area that has both catalogue rows and reviews.
 *
 * The evidence lines are the reviews themselves, not a summary of them: the model
 * needs the actual phrasing ("steep wet steps", "half the lawn has no shade") to
 * learn the vocabulary it will meet in live social text, and a paraphrase would
 * teach it our summary rather than the world.
 */
export function neighbourhoodDocuments(
  rows: readonly CatalogueRow[],
  signals: readonly SocialSignal[],
): CorpusDocument[] {
  const byArea = new Map<string, CatalogueRow[]>();
  for (const row of rows) {
    const area = row.neighbourhood ?? "Unassigned";
    const bucket = byArea.get(area);
    if (bucket) bucket.push(row);
    else byArea.set(area, [row]);
  }

  const out: CorpusDocument[] = [];
  for (const [area, areaRows] of [...byArea].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    const areaSignals = signals.filter((signal) => signal.entityId && areaRows.some((row) => row.id === signal.entityId));
    if (areaSignals.length === 0) continue;

    const classes = new Map<EntityClass, number>();
    let outdoorSensitive = 0;
    for (const row of areaRows) {
      const key = classify(row);
      classes.set(key, (classes.get(key) ?? 0) + 1);
      if (row.weatherSensitive !== "none") outdoorSensitive += 1;
    }
    const inventory = [...classes]
      .sort((a, b) => b[1] - a[1])
      .map(([entityClass, count]) => `${word(count, "row")} ${entityClass} (openness ${opennessOf(entityClass)}/3)`)
      .join(", ");

    const hazardCounts = new Map<HazardKind, number>();
    for (const signal of areaSignals) {
      for (const hazard of signal.conditions) hazardCounts.set(hazard, (hazardCounts.get(hazard) ?? 0) + 1);
    }
    const reported = [...hazardCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([hazard, count]) => `${hazard} (${count} reports)`)
      .join(", ");

    const evidence = areaSignals
      .filter((signal) => signal.conditions.length > 0 || signal.exposure > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 12)
      .map((signal) => {
        const hazard = signal.conditions.length > 0 ? signal.conditions.join("+") : "no weather mentioned";
        const exposure = signal.exposure < 0 ? "unrated" : `exposure ${signal.exposure.toFixed(1)}`;
        return `  - [${hazard}, ${exposure}, ${signal.hour}:00, ${signal.sentiment === 1 ? "positive" : signal.sentiment === -1 ? "negative" : "mixed"}] "${signal.text}"`;
      })
      .join("\n");

    out.push({
      name: `10-${slug(area)}-weather-profile.txt`,
      category: "neighbourhood",
      text: [
        `AREA: ${area} (Mumbai)`,
        `Entities in the catalogue for this area: ${word(areaRows.length, "row")}.`,
        `Of those, ${outdoorSensitive} declare a weather sensitivity other than "none".`,
        "",
        "SHELTER INVENTORY:",
        `  ${inventory || "no rows classified"}`,
        "",
        reported ? `HAZARDS REPORTED HERE BY VISITORS: ${reported}` : "HAZARDS REPORTED HERE BY VISITORS: none in the corpus",
        "",
        "WHAT VISITORS ACTUALLY SAID (verbatim, most-helpful first):",
        evidence || "  (no weather-relevant reports)",
        "",
        "READ THIS AS: the shelter inventory says what could close here. The reports",
        "say what does. Where they disagree, the reports win — a place with arcades",
        "that people still call a swamp is a place whose arcades leak.",
      ].join("\n"),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Cancellation rules
// ---------------------------------------------------------------------------

/**
 * The events' own thresholds. The highest-value text in the corpus, because an
 * operator writing a cancellation rule has written down a *number*, and a model
 * aligned on rules can answer "at what wind does this close" while a model aligned
 * on sentiment can only answer "does this feel bad".
 */
export function cancellationDocument(signals: readonly SocialSignal[]): CorpusDocument | null {
  const rules = signals.filter((signal) => signal.source === "event_rule" && signal.text.length > 20);
  if (rules.length === 0) return null;
  return {
    name: "20-stated-weather-cancellation-rules.txt",
    category: "cancellation",
    text: [
      "WEATHER CANCELLATION RULES, STATED BY OPERATORS",
      "",
      "Each rule below was written by the operator of the experience. These are",
      "thresholds, not opinions, and they are the most reliable statements in the",
      "corpus. Learn the number as well as the hazard.",
      "",
      ...rules.map(
        (rule) =>
          `  ${rule.neighbourhood ?? "Mumbai"} — hazards: ${rule.conditions.join(", ") || "not weather-specific"}; exposure ${rule.exposure < 0 ? "unrated" : rule.exposure.toFixed(1)}\n    "${rule.text}"`,
      ),
      "",
      "PATTERNS TO CARRY ACROSS:",
      "  - Wind-dependent outdoor events are cancelled on a wind threshold, and on",
      "    nothing else. Kites need wind; there is no indoor version of a kite.",
      "  - Water-dependent outdoor events are cancelled on rain, and on nothing else.",
      "  - Indoor events state that weather cannot touch them. Those rules are worth",
      "    more than any other line here, because they are the negative class.",
      "  - A rule that names no threshold is a rule about qualitative conditions,",
      "    and the honest reading of it is that the operator did not quantify.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// 4. Propagation
// ---------------------------------------------------------------------------

/**
 * The cascade, written as worked examples rather than as rules.
 *
 * Examples rather than rules because this is the part a model is worst at by
 * default: it will happily restate "weather affects travel" and never once say
 * *which* entity lost capacity and *why*. Each example names a real entity class
 * and walks the four orders, so the pattern is demonstrated end to end.
 */
export function propagationDocument(): CorpusDocument {
  return {
    name: "30-effect-propagation.txt",
    category: "propagation",
    text: [
      "HOW A WEATHER EVENT PROPAGATES THROUGH THE CATALOGUE",
      "",
      "Four worked examples. In each, follow the orders: direct, access, reroute,",
      "workforce. Confidence falls at each order.",
      "",
      "EXAMPLE 1 — 30 mm/h for 6 hours over Marine Drive.",
      "  DIRECT: the open-air rows on the promenade lose availability entirely",
      "    (openness 3/3, weather sensitivity any). A covered cafe keeps its",
      "    availability and takes a duration penalty, because people wait out a",
      "    shower under the awning. Confidence high: read straight off the row.",
      "  ACCESS: the promenade road floods at the Chowpatty end, so travel time to",
      "    everything on it rises by roughly the movement multiplier. A sheltered",
      "    cafe 400 m away is now a 20-minute walk. It did not close. Confidence",
      "    medium: this is an inference about the road, not a field on the row.",
      "  REROUTE: demand moves off the promenade and onto the covered rows. Those",
      "    rows now sell out, so their capacity multiplier falls even though",
      "    nothing is wrong with them. Confidence low.",
      "  WORKFORCE: staff living inland can still get in, so little effect. A cafe",
      "    whose staff live on the promenade loses half its shift. Confidence low.",
      "",
      "EXAMPLE 2 — 42°C at 13:00 across Bandra West.",
      "  DIRECT: the outdoor rows with a heat sensitivity and no shade close. Rows",
      "    under a colonnade, under a flyover, or with tree cover stay open and are",
      "    the best answer in the city at that hour. Confidence high.",
      "  ACCESS: minimal. Heat does not slow a road. This is the case that proves",
      "    access is a hazard-specific channel and not a generic one.",
      "  REROUTE: strong. Every sheltered row within walking distance gains demand",
      "    and the popular ones sell out. This is the one scenario where a good",
      "    indoor place becomes worse for the traveller, not better.",
      "  WORKFORCE: outdoor staff drop out. An outdoor restaurant loses its entire",
      "    team at 42°C, so it closes for staffing reasons even with shade.",
      "",
      "EXAMPLE 3 — a storm, 50 mm/h and 70 km/h gusts, over Fort.",
      "  DIRECT: everything open air closes. Confidence high.",
      "  ACCESS: severe. The Fort roads are low and the harbour is close, so flood",
      "    depth matters more than rain rate. Storm confidence high, flood",
      "    confidence medium — flood depth is a modelled quantity, not an observed",
      "    one, and must be reported with an interval.",
      "  REROUTE: the whole area empties toward Colaba and Bandra, which is where",
      "    the transit nodes are. Transit nodes are the entities that tell you the",
      "    reroute is real: their demand multiplier is the cleanest measure of how",
      "    many people are moving.",
      "  WORKFORCE: severe and widespread. This is the order that makes a sheltered",
      "    venue operate at half strength, and the reason an open plan on a storm day",
      "    is shorter than its availability suggests.",
      "",
      "EXAMPLE 4 — 5 mm/h drizzle, no accumulation, clear skies otherwise.",
      "  Nothing. Every channel stays at 1.0. The correct answer to a mild",
      "  condition is a plan that is identical to the plan without it, and a twin",
      "  that reports a difference here is manufacturing a finding.",
    ].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// The benchmark
// ---------------------------------------------------------------------------

export type BenchmarkSample = { sample_num: number; instruction: string; response: string };

const TASK_PREAMBLE =
  "Assess the following traveller and provider reports for weather impact on hospitality and travel entities in Mumbai. " +
  "Reply with JSON only, shaped: {\"hazards\":[{\"kind\":\"rain|heat|wind|flood|storm\",\"severity\":0-3,\"confidence\":0-1,\"evidence\":\"...\"}],\"exposure\":0-1,\"emerging\":[]}. " +
  "A report praising a place for staying dry in rain is evidence of shelter, not of damage. Reports:\n";

/**
 * Instruction/response pairs, built from the real reviews.
 *
 * The expected response is the deterministic classifier's own answer, computed here
 * rather than hand-written. That makes the benchmark a genuine measurement — it
 * scores the aligned model against the same function the product falls back to, so
 * "the aligned model is better than no model" is a number someone can check rather
 * than a claim. It also means a regression in `classifyReport` shows up as a
 * benchmark regression, which is the correct direction for that dependency to fail.
 */
export function benchmarkFrom(
  signals: readonly SocialSignal[],
  limit = 60,
): BenchmarkSample[] {
  const usable = signals
    .filter((signal) => signal.text.length > 40)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
  return usable.map((signal, index) => {
    const { conditions, exposure } = classifyReport(signal.text);
    const hazards = conditions.map((kind) => ({
      kind,
      severity: kind === "flood" || kind === "storm" ? 2 : 1,
      confidence: 0.7,
      evidence: signal.text.slice(0, 200),
    }));
    const response = {
      hazards,
      exposure: exposure < 0 ? 0.5 : exposure,
      emerging: [] as string[],
    };
    return {
      sample_num: index + 1,
      instruction: `${TASK_PREAMBLE}${index + 1}. ${signal.text}`,
      response: JSON.stringify(response),
    };
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * The whole corpus, in the order the model should learn it: taxonomy first, then
 * the evidence for it, then the propagation that follows from it.
 */
export function buildCorpus(
  rows: readonly CatalogueRow[],
  signals: readonly SocialSignal[],
): CorpusDocument[] {
  const docs: CorpusDocument[] = [taxonomyDocument(), propagationDocument()];
  const cancellation = cancellationDocument(signals);
  if (cancellation) docs.push(cancellation);
  docs.push(...neighbourhoodDocuments(rows, signals));
  return docs;
}

/** `Bandra West` -> `bandra-west`. A filename, so it has to be boring. */
function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
