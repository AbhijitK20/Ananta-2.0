/**
 * Offline enrichment of the long tail.
 *
 * OSM gives us a name, a category and a coordinate. It does not give us how long
 * a visit takes, roughly what it costs, whether a stroller fits, or whether the
 * place is indoors. Those are the fields the engine's feasibility gate and the
 * traveller's decisions actually depend on, and the long tail is where they are
 * missing. This file fills them — carefully, and never as ground truth.
 *
 * Five rules, each one learned from a reference implementation that got it wrong:
 *
 *  1. VALIDATED. Output is parsed against a strict schema, then checked field by
 *     field against the source text. A value with no verbatim evidence is thrown
 *     away, with a machine-readable code.
 *  2. PROVENANCE-AWARE. Anything written lands as `Sourced` with
 *     `provenance: "inferred"` and the model's confidence. The contract's whole
 *     premise is that the UI can always say where a fact came from.
 *  3. CONFIDENCE-AWARE. Below the gate nothing is written. For accessibility the
 *     gate is far higher than for a duration, because a wrong "step-free" sends a
 *     wheelchair user to a building with no ramp, and the cost of that is not
 *     symmetric.
 *  4. REPLACEABLE. Inference only ever fills fields that are currently empty and
 *     not already sourced from a human, the provider, or OSM. Re-running the
 *     enrichment with a better model overwrites the inferred value and nothing
 *     else.
 *  5. SAFE WHEN UNAVAILABLE. No key, `LLM_OFF`, a dead provider, a malformed
 *     response: the batch returns an abstain for every record and writes nothing.
 *     There is no partial state to clean up.
 */

import { z } from "zod";
import { Category, type Experience, type LLMEnvelope } from "../contracts";
import { callStructured, toEnvelope } from "./client";
import { guardTrip } from "./guardrails";
import { log } from "./log";

export const ENRICH_FIELDS = [
  "duration_min",
  "price_minor",
  "indoor",
  "category",
  "kid_friendly",
  "step_free",
  "tags",
] as const;
export type EnrichField = (typeof ENRICH_FIELDS)[number];

/** A record thin enough that inference is the only way to learn anything. */
export type EnrichCandidate = {
  experienceId: string;
  name: string;
  category?: string;
  description?: string | null;
  blurb?: string | null;
  keywords?: string[];
  neighbourhood?: string | null;
  /** Whatever OSM gave us. A rule is a tag, not a model. */
  osmTags?: Record<string, string>;
};

export type EnrichRejection =
  | { code: "SCHEMA_INVALID"; detail: string }
  | { code: "EVIDENCE_MISSING"; field: EnrichField }
  | { code: "EVIDENCE_NOT_VERBATIM"; field: EnrichField; quote: string }
  | { code: "LOW_CONFIDENCE"; field: EnrichField; confidence: number }
  | { code: "VALUE_OUT_OF_RANGE"; field: EnrichField; value: unknown }
  | { code: "UNKNOWN_CATEGORY"; value: string }
  | { code: "CONTRADICTS_OSM_TAG"; field: EnrichField; osm: string; llm: string }
  | { code: "ABSTAINED"; reason: string };

const InferenceSchema = z.strictObject({
  duration_min: z.number().int().min(5).max(720).nullable().default(null),
  price_minor: z.number().int().min(0).max(100_000_000).nullable().default(null),
  indoor: z.enum(["indoor", "outdoor", "covered", "mixed", "unknown"]).default("unknown"),
  category: z.string().max(40).nullable().default(null),
  kid_friendly: z.boolean().nullable().default(null),
  step_free: z.boolean().nullable().default(null),
  tags: z.array(z.string().min(2).max(40)).max(6).default([]),
  evidence: z
    .array(
      z.strictObject({
        field: z.enum(ENRICH_FIELDS),
        quote: z.string().min(4).max(300),
      }),
    )
    .max(8)
    .default([]),
  confidence: z.number().min(0).max(1),
  abstain_reason: z.string().max(200).nullable().default(null),
});

export type Inference = z.infer<typeof InferenceSchema>;

export type ValidatedInference = {
  value: Inference;
  /** Fields that survived validation and the confidence gate. */
  accepted: EnrichField[];
  rejections: EnrichRejection[];
  confidence: number;
};

/** Accessibility is a safety claim, not a preference. Higher bar, on purpose. */
const CONFIDENCE_GATE: Record<EnrichField, number> = {
  duration_min: 0.55,
  price_minor: 0.55,
  indoor: 0.55,
  category: 0.6,
  kid_friendly: 0.5,
  step_free: 0.85,
  tags: 0.4,
};

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ₹₹+&'/.-]/g, "");

/** The single text blob every inference must be quotable from. */
export function candidateBlob(c: EnrichCandidate): string {
  return [c.name, c.category ?? "", c.neighbourhood ?? "", c.blurb ?? "", c.description ?? "", ...(c.keywords ?? [])]
    .filter(Boolean)
    .join(" \u2014 ");
}

function isPresent(v: unknown): boolean {
  return !(v == null || v === "unknown" || v === "" || (Array.isArray(v) && v.length === 0));
}

/**
 * Pure. No model, no I/O — the same function a batch job, a test, and a reviewer
 * at 2am can all run. A non-null value with no verbatim quote never survives.
 */
export function validateInference(raw: unknown, blob: string, osmTags: Record<string, string> = {}): ValidatedInference | { error: EnrichRejection } {
  const parsed = InferenceSchema.safeParse(raw);
  if (!parsed.success) {
    return { error: { code: "SCHEMA_INVALID", detail: parsed.error.issues[0]?.message ?? "invalid" } };
  }
  const v = parsed.data;
  const rejections: EnrichRejection[] = [];
  const haystack = normalize(blob);
  const evidenceFor = new Set(v.evidence.map((e) => e.field));

  for (const e of v.evidence) {
    if (!haystack.includes(normalize(e.quote))) {
      rejections.push({ code: "EVIDENCE_NOT_VERBATIM", field: e.field, quote: e.quote });
    }
  }

  let category: string | null = null;
  if (isPresent(v.category)) {
    const match = Category.options.find((c) => c === String(v.category).toLowerCase().replace(/\s+/g, "_"));
    if (match) category = match;
    else rejections.push({ code: "UNKNOWN_CATEGORY", value: String(v.category) });
  }

  // A rule is the OSM tag, not the model.
  if (osmTags.wheelchair === "yes" && v.step_free === false) {
    rejections.push({ code: "CONTRADICTS_OSM_TAG", field: "step_free", osm: "wheelchair=yes", llm: "false" });
  }
  if (osmTags.indoor === "yes" && v.indoor === "outdoor") {
    rejections.push({ code: "CONTRADICTS_OSM_TAG", field: "indoor", osm: "indoor=yes", llm: "outdoor" });
  }

  const rejected = new Set(rejections.map((r) => ("field" in r ? r.field : null)));
  const accepted: EnrichField[] = [];
  for (const field of ENRICH_FIELDS) {
    if (!isPresent((v as Record<string, unknown>)[field])) continue;
    if (rejected.has(field)) continue;
    if (!evidenceFor.has(field)) {
      rejections.push({ code: "EVIDENCE_MISSING", field });
      continue;
    }
    if (v.confidence < CONFIDENCE_GATE[field]) {
      rejections.push({ code: "LOW_CONFIDENCE", field, confidence: v.confidence });
      continue;
    }
    accepted.push(field);
  }

  if (v.category && category) v.category = category;
  return { value: v, accepted, rejections, confidence: v.confidence };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  "You fill in missing attributes for one place, using ONLY the text given to you.",
  "An honest null is a correct answer. A plausible guess is a defect.",
  "Never use outside knowledge. If the text does not support a value, return null, \"unknown\" or [].",
  "price_minor is in paise: 500 rupees is 50000. Use 0 for a place that is free.",
  "category must be one of: " + Category.options.join(", ") + ".",
  "Every non-null value needs an `evidence` entry whose `quote` appears word for word in the text.",
  "Set confidence high (0.85-1.0) only for explicitly stated facts, and low (0.3-0.5) when reading between the lines.",
  "If the text is too thin to say anything useful, set `abstain_reason` and return nulls.",
  "Return only the structured object.",
].join(" ");

// ---------------------------------------------------------------------------
// One record
// ---------------------------------------------------------------------------

export type EnrichResult = {
  experienceId: string;
  applied: EnrichField[];
  rejections: EnrichRejection[];
  inference: ValidatedInference | null;
  degraded: boolean;
  envelope: LLMEnvelope;
};

const NOTHING_REASON = "no inference attempted";

/** Model, then validation, then the deterministic no-op. Never throws. */
export async function enrichOne(candidate: EnrichCandidate): Promise<EnrichResult> {
  const blob = candidateBlob(candidate);
  const base = { experienceId: candidate.experienceId, applied: [] as EnrichField[], inference: null as ValidatedInference | null };

  const result = await callStructured({
    role: "enricher",
    schema: InferenceSchema,
    schemaName: "ExperienceInference",
    schemaDescription: "Missing attributes for one place, each backed by a verbatim quote from its text.",
    instructions: INSTRUCTIONS,
    prompt: `<place data-only="true">\n${JSON.stringify({ name: candidate.name, category: candidate.category, text: blob })}\n</place>`,
    maxOutputTokens: 1_200,
    temperature: 0,
  });

  if (!result.ok) {
    log.info("enrich_degraded", { experienceId: candidate.experienceId, reason: result.reason });
    return {
      ...base,
      rejections: [{ code: "ABSTAINED", reason: `${NOTHING_REASON}: ${result.reason}` }],
      degraded: true,
      envelope: toEnvelope(result),
    };
  }

  const validated = validateInference(result.value, blob, candidate.osmTags ?? {});
  if ("error" in validated) {
    guardTrip("enrich.schema_invalid", "detail" in validated.error ? validated.error.detail : validated.error.code);
    return { ...base, rejections: [validated.error], degraded: true, envelope: toEnvelope(result) };
  }
  if (validated.value.abstain_reason) {
    validated.rejections.push({ code: "ABSTAINED", reason: validated.value.abstain_reason });
  }
  return { ...base, applied: validated.accepted, rejections: validated.rejections, inference: validated, degraded: false, envelope: toEnvelope(result) };
}

// ---------------------------------------------------------------------------
// Applying — the only writer of `Experience`
// ---------------------------------------------------------------------------

/** Provenance we never overwrite. A human, a provider or OSM outranks a guess. */
const TRUSTED = new Set(["curated", "provider", "osm", "derived"]);

export type ApplyResult = {
  experience: Experience;
  applied: string[];
  skipped: string[];
  /** Per-field model confidence, for the caller to persist next to the value. */
  confidence: Record<string, number>;
  source: string;
  at: string;
};

/**
 * Writes only into fields that are empty, or that a previous run of *this*
 * enrichment wrote. So the function is idempotent and re-runnable: a better model
 * replaces its own earlier guess and leaves every human fact alone.
 */
export function applyInference(experience: Experience, result: EnrichResult): ApplyResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  const confidence: Record<string, number> = {};
  const inference = result.inference;
  const source = `llm:${result.envelope.model ?? "unknown"}`;
  const at = new Date().toISOString();
  if (!inference) return { experience, applied, skipped, confidence, source, at };

  const next: Experience = { ...experience, provenance: { ...experience.provenance } };
  const mark = (field: string, value: number): void => {
    (next.provenance as Record<string, string>)[field] = "inferred";
    confidence[field] = value;
    applied.push(field);
  };

  /** Fill an empty field, or replace a value this layer previously wrote. */
  const fillable = (field: string, empty: boolean): boolean => {
    if (empty) return true;
    const existing = experience.provenance[field];
    if (existing === "inferred") return true;
    if (TRUSTED.has(existing ?? "")) {
      skipped.push(field);
      return false;
    }
    // A value we cannot trace refuses to be overwritten. The contract's premise is
    // that every field knows its origin; an untraceable one is somebody's work.
    skipped.push(field);
    return false;
  };

  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

  for (const field of result.applied) {
    const value = (inference.value as Record<string, unknown>)[field];
    if (field === "duration_min") {
      if (same(experience.durationMin, Number(value)) || !fillable("durationMin", false)) {
        if (same(experience.durationMin, Number(value))) skipped.push("durationMin");
        continue;
      }
      (next as unknown as Record<string, unknown>).durationMin = Number(value);
      mark("durationMin", inference.confidence);
    } else if (field === "price_minor") {
      const price = { minor: Number(value), currency: "INR" };
      if (same(experience.pricePerPerson, price)) {
        skipped.push("pricePerPerson");
        continue;
      }
      if (!fillable("pricePerPerson", experience.pricePerPerson === null)) continue;
      (next as unknown as Record<string, unknown>).pricePerPerson = price;
      mark("pricePerPerson", inference.confidence);
    } else if (field === "category") {
      if (same(experience.category, value) || !fillable("category", false)) {
        if (same(experience.category, value)) skipped.push("category");
        continue;
      }
      (next as unknown as Record<string, unknown>).category = value as Experience["category"];
      mark("category", inference.confidence);
    } else if (field === "indoor") {
      if (same(experience.indoorOutdoor, value) || !fillable("indoorOutdoor", false)) {
        if (same(experience.indoorOutdoor, value)) skipped.push("indoorOutdoor");
        continue;
      }
      (next as unknown as Record<string, unknown>).indoorOutdoor = value as Experience["indoorOutdoor"];
      mark("indoorOutdoor", inference.confidence);
    } else if (field === "kid_friendly") {
      const kidFriendly = Boolean(value);
      if (same(experience.kidFriendly, kidFriendly)) {
        skipped.push("kidFriendly");
        continue;
      }
      if (!fillable("kidFriendly", experience.kidFriendly === null)) continue;
      (next as unknown as Record<string, unknown>).kidFriendly = kidFriendly;
      mark("kidFriendly", inference.confidence);
    } else if (field === "step_free") {
      const stepFree = Boolean(value);
      if (same(experience.accessibility.stepFree, stepFree)) {
        skipped.push("accessibility.stepFree");
        continue;
      }
      if (!fillable("accessibility.stepFree", experience.accessibility.stepFree === null)) continue;
      next.accessibility = { ...next.accessibility, stepFree };
      mark("accessibility.stepFree", inference.confidence);
    } else if (field === "tags") {
      // Keywords are a set, not a scalar: fresh tags are appended and the curated
      // ones are kept. `provenance` is per-field, so a list that mixes sources
      // cannot be labelled honestly — it is left as it was found, and the added
      // tags are reported in `applied` for the caller to badge per item if it wants.
      const existing = new Set(experience.keywords.map((k) => k.toLowerCase()));
      const fresh = (value as string[]).filter((t) => !existing.has(t.toLowerCase())).slice(0, 6);
      if (fresh.length === 0) {
        skipped.push("keywords");
        continue;
      }
      (next as unknown as Record<string, unknown>).keywords = [...experience.keywords, ...fresh];
      if (!TRUSTED.has(experience.provenance.keywords ?? "")) {
        (next.provenance as Record<string, string>).keywords = "inferred";
      }
      confidence.keywords = inference.confidence;
      applied.push("keywords");
    }
  }

  return { experience: next, applied, skipped, confidence, source, at };
}

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export type EnrichBatchOptions = { concurrency?: number };

/**
 * Runs a batch. With the model unavailable every record comes back abstained and
 * nothing is written, so the caller needs no special case for `LLM=off`.
 */
export async function enrichMany(
  candidates: EnrichCandidate[],
  opts: EnrichBatchOptions = {},
): Promise<EnrichResult[]> {
  const limit = Math.min(4, Math.max(1, opts.concurrency ?? 2));
  return mapWithLimit(candidates, limit, enrichOne);
}
