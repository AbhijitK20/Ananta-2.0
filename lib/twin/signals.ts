/**
 * The real-world signal layer: what the outside world is saying, and how much of
 * it counts as evidence.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SIGNALS COME FROM, AND WHY THESE THREE
 * ---------------------------------------------------------------------------
 *
 * The brief asks for "social-media or publicly available social signals" that
 * capture traveller reactions, reports and emerging conditions. Everything here is
 * a public feed read without an account, a key, or a login, and nothing is
 * attributed beyond what the feed itself attributes.
 *
 *  - **GDACS** is the European Commission's Global Disaster Alert and Coordination
 *    System. It is not social, and it is the most valuable of the three: it is
 *    the only source that carries a *geospatial* emergency, which is what lets a
 *    hazard be attached to a stop at all rather than to a guess about which city
 *    the traveller is in.
 *  - **Reddit** is the closest thing to traveller chatter that is readable without
 *    credentials, and it is the only source that says what *people* are
 *    experiencing. It rate-limits aggressively from datacentre addresses, so it is
 *    best-effort by design and its absence is reported rather than hidden.
 *  - **Hacker News** is a weak relevance match and is included for a specific
 *    reason: it is the one source that answers reliably when the other two do not,
 *    so it keeps the panel honest about "no signal" versus "no signal available".
 *
 * ---------------------------------------------------------------------------
 * POLARITY IS A KEYWORD COUNT, AND IS LABELLED AS ONE
 * ---------------------------------------------------------------------------
 *
 * `polarityOf` is a word list. It is not a sentiment model, it does not handle
 * negation, and it will happily misread a sarcastic post. It is used for exactly
 * one thing — to nudge a severity by at most a third of a step, with a
 * Laplace-smoothed confidence that keeps a handful of posts from moving anything
 * — and every surface that shows a polarity shows it with that caveat. A number
 * that looked authoritative would be worse than no number.
 */

import { haversineKm } from "../plan/geo";
import type { CalibrationInput } from "./impact";
import type { CityObservation, ImpactSeverity, SignalSource, SocialSignal } from "./types";

/* -------------------------------------------------------------------------- *
 * Polarity
 * -------------------------------------------------------------------------- */

/**
 * Word lists rather than a model, and the asymmetry is intentional: the unhappy
 * words are longer than the happy ones because "fine" is rarer and more
 * informative than "closed". A generic sentiment lexicon would be symmetrical
 * here, and symmetrical is wrong for weather complaints.
 */
const NEGATIVE_WORDS = [
  "cancelled", "canceled", "closed", "closure", "shut", "flooded", "flooding",
  "deluge", "drenched", "soaked", "unusable", "stranded", "evacuated", "evacuation",
  "dangerous", "unsafe", "impassable", "washed out", "landslide", "storm damage",
  "no power", "power cut", "refused", "turned away", "disaster", "nightmare",
  "rubbish", "awful", "terrible", "horrible", "miserable", "swamped", "stuck",
  "disrupted", "cancelled train", "flights cancelled", "no trains", "bottleneck",
] as const;

const POSITIVE_WORDS = [
  "sunny", "clear", "dry", "still open", "staying open", "open as usual",
  "no problem", "great time", "lovely", "beautiful", "worth it", "recommend",
  "surprisingly good", "packed with people", "busy but", "everything open",
] as const;

/**
 * -1 (unhappy) to 1 (happy), from a word count, or null when there is no text.
 *
 * Null is a real answer and is preferred over 0: "nobody has said anything" and
 * "nobody has said anything nice" must not read the same, and returning null
 * lets the calibration skip the reports term entirely rather than halving a
 * severity on the strength of silence.
 */
export function polarityOf(text: string | null | undefined): number | null {
  if (!text) return null;
  const hay = text.toLowerCase();

  let negative = 0;
  for (const word of NEGATIVE_WORDS) if (hay.includes(word)) negative += 1;
  let positive = 0;
  for (const word of POSITIVE_WORDS) if (hay.includes(word)) positive += 1;

  const total = negative + positive;
  if (total === 0) return null;

  return Math.round(((positive - negative) / total) * 100) / 100;
}

/* -------------------------------------------------------------------------- *
 * GDACS
 * -------------------------------------------------------------------------- */

/** GDACS alert levels, 0-3, matching the service's own Green/Orange/Red scale. */
export function alertLevelOf(level: string | null | undefined): number | null {
  if (!level) return null;
  const v = level.trim().toLowerCase();
  if (v === "green") return 0;
  if (v === "orange") return 1;
  if (v === "red") return 2;
  return null;
}

/**
 * Centimetres of standing water an alert implies.
 *
 * GDACS publishes an alert *level*, never a depth in centimetres, and there is no
 * honest conversion between the two. So this returns the low edge of the band the
 * alert level names, using the same thresholds as every other flood reading, and
 * `signals.ts` reports the provenance. A reader is told "an orange flood alert"
 * means "at least 5 cm", which is true, rather than being shown 12 cm and left to
 * assume it was measured.
 */
export function floodCmFromAlert(level: number | null): number {
  if (level === null || level <= 0) return 0;
  if (level === 1) return 5;
  return 20;
}

/* -------------------------------------------------------------------------- *
 * Bucketing
 * -------------------------------------------------------------------------- */

/**
 * How close a signal has to be to a city to count as being about it.
 *
 * 150 km, and the reason is that these are travel cities spread over two
 * continents rather than one metropolitan area. A storm 200 km away does not
 * close a hotel, and a signal 400 km away is somebody else's trip. Anything
 * further is still shown in the feed — it is just not allowed to move a severity.
 */
const RELEVANCE_KM = 150;

/** What a signal is allowed to say about a city, gathered in one place. */
export type CityEvidence = {
  /** Highest alert level seen, 0-3. Null when no alert named this city. */
  alertLevel: number | null;
  /** Public reports, whichever source. */
  reports: number;
  /** Weighted mean polarity, or null when nothing readable came through. */
  reportPolarity: number | null;
  /** The signals themselves, for the feed and for the per-stop readout. */
  signals: readonly SocialSignal[];
  floodCm: number;
};

export const EMPTY_EVIDENCE: CityEvidence = {
  alertLevel: null,
  reports: 0,
  reportPolarity: null,
  signals: [],
  floodCm: 0,
};

/**
 * Attach every signal to the cities it is about.
 *
 * A signal matches a city two ways, and both are needed:
 *
 *  - **By name.** A Reddit post that says "Mumbai" is about Mumbai. Cheap, and
 *    right far more often than not.
 *  - **By position.** A GDACS alert carries `georss:point`, and matching that
 *    against the directory's own city centroids is the only way an emergency with
 *    no city name in it still reaches the right stop.
 *
 * The directory has no per-venue coordinates, so "the city" means the centroid
 * and the tolerance is generous. `lib/plan/geo` says the same thing about pins
 * and the map says it under its own edge; this is the same trade in a third place
 * and it is stated here rather than left to be discovered.
 */
export function bucketSignals(
  signals: readonly SocialSignal[],
  cities: readonly { slug: string; name: string; at: { lat: number; lon: number } }[],
): Map<string, CityEvidence> {
  const out = new Map<string, CityEvidence>();
  for (const city of cities) {
    out.set(city.slug, { ...EMPTY_EVIDENCE, signals: [] });
  }

  for (const signal of signals) {
    const slug = signal.city && out.has(signal.city) ? signal.city : nearestCity(signal.at, cities);
    if (!slug) continue;

    const current = out.get(slug);
    if (!current) continue;

    const list = [...current.signals, signal];

    // Only an alert-shaped source may move the alert term. A Reddit post is not an
    // official warning however unhappy it is, which is why `alertLevel` is its own
    // field rather than something read back out of `weight`.
    const signalAlert = signal.alertLevel;

    out.set(slug, {
      alertLevel:
        signalAlert === null || signalAlert === 0
          ? current.alertLevel
          : Math.max(current.alertLevel ?? 0, signalAlert),
      reports: current.reports + 1,
      reportPolarity: blendPolarity(current.reportPolarity, current.reports, polarityOf(signal.title), signal.weight),
      signals: list,
      floodCm: Math.max(current.floodCm, floodCmFromAlert(signalAlert)),
    });
  }

  return out;
}

function nearestCity(
  at: { lat: number; lon: number } | null,
  cities: readonly { slug: string; at: { lat: number; lon: number } }[],
): string | null {
  if (!at) return null;
  let best: { slug: string; km: number } | null = null;
  for (const city of cities) {
    const km = haversineKm(at, city.at);
    if (km > RELEVANCE_KM) continue;
    if (!best || km < best.km) best = { slug: city.slug, km };
  }
  return best?.slug ?? null;
}

/** Running weighted mean, so a later signal does not erase an earlier one. */
function blendPolarity(
  current: number | null,
  count: number,
  next: number | null,
  weight: number,
): number | null {
  if (next === null) return current;
  if (current === null) return next;
  return Math.round(((current * count + next * weight) / (count + weight)) * 100) / 100;
}

/* -------------------------------------------------------------------------- *
 * Folding evidence into the observations
 * -------------------------------------------------------------------------- */

/**
 * Apply the evidence to the observations: correct each severity and, for flood,
 * raise the reading to whatever an alert supports.
 *
 * The correction is the only learned part of the model, and it is deliberately
 * small — a third of a step, damped by `n / (n + 4)`. The UI shows the resulting
 * evidence figure beside every severity, so a number that is entirely prior reads
 * 0 and a number that is mostly evidence reads high.
 */
export function applyEvidence(
  observations: readonly CityObservation[],
  evidence: ReadonlyMap<string, CityEvidence>,
  calibrate: (severity: ImpactSeverity, input: CalibrationInput) => { severity: ImpactSeverity; evidence: number; delta: number },
): CityObservation[] {
  return observations.map((observation) => {
    const cityEvidence = evidence.get(observation.city);
    if (!cityEvidence || !observation.hazards) return observation;

    return {
      ...observation,
      hazards: observation.hazards.map((hazard) => {
        const corrected = calibrate(hazard.severity, {
          alertLevel: cityEvidence.alertLevel,
          reports: cityEvidence.reports,
          reportPolarity: cityEvidence.reportPolarity,
        });

        // An alert can only make a hazard worse, never better, so a raised
        // severity from an alert is taken even if the mean polarity is positive.
        const alertOnly = calibrate(hazard.severity, {
          alertLevel: cityEvidence.alertLevel,
          reports: 0,
          reportPolarity: null,
        });
        const severity = Math.max(
          corrected.severity,
          alertOnly.severity,
        ) as 0 | 1 | 2 | 3;

        const intensity =
          hazard.kind === "flood" ? Math.max(hazard.intensity, cityEvidence.floodCm) : hazard.intensity;

        return { ...hazard, severity, intensity, evidence: Math.max(corrected.evidence, alertOnly.evidence) };
      }),
    };
  });
}

/** How many observations fed the calibration, for the provenance panel. */
export function calibrationCount(evidence: ReadonlyMap<string, CityEvidence>): number {
  let n = 0;
  for (const city of evidence.values()) n += city.reports + (city.alertLevel !== null ? 1 : 0);
  return n;
}

/** The sources that answered, and the ones that did not. Both are reported. */
export function describeSources(
  signals: readonly SocialSignal[],
): { source: SignalSource; ok: boolean; count: number; note: string }[] {
  const notes: Record<SignalSource, string> = {
    gdacs: "European Commission disaster alerts, with coordinates.",
    reddit: "Public search. Rate-limits hard from shared addresses.",
    hackernews: "Low relevance to travel, but answers when the others do not.",
  };
  const sources: SignalSource[] = ["gdacs", "reddit", "hackernews"];
  return sources.map((source) => {
    const count = signals.filter((s) => s.source === source).length;
    return { source, ok: count > 0, count, note: notes[source] };
  });
}
