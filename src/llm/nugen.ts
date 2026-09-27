/**
 * Nugen Intelligence: the domain-aligned model behind the Digital Twin.
 *
 * **This is the alignment, not a wrapper around someone else's model.** The chain
 * the brief requires is:
 *
 * ```
 * base model (llama-v3p2-3b-reasoning)
 *   -> Nugen domain alignment over the TravelBuddy weather corpus   (scripts/nugen-align.ts)
 *   -> aligned model id, committed to data/reference/nugen/alignment.json
 *   -> THIS FILE, for inference
 * ```
 *
 * The base model id is the one Nugen reports as `alignment_ready: true` in
 * `GET /api/v3/models/base`. `scripts/nugen-align.ts` performs the training run and
 * writes the resulting aligned id to disk, so the app reads a real artefact rather
 * than a hard-coded string, and a re-alignment needs no code change.
 *
 * ## What the aligned model is allowed to decide
 *
 * Very little, and deliberately. `docs/ARCHITECTURE.md` §1 makes the engine's
 * central commitment that **no LLM sits in the decision path**, and §9 says the same
 * of `DialogueDecision`. The twin honours that rather than routing around it: the
 * aligned model is asked for a *hazard classification* over free text, and the
 * deterministic engine in `src/features/twin/propagate.ts` turns that classification
 * into multipliers, cascades and a re-solve. The model can change what the twin
 * *believes*; it cannot change what the twin *does*, because every number it
 * influences passes through `neutralChannels()` and a `clamp` before it reaches the
 * planner.
 *
 * The reason the aligned model is worth its latency is the one thing a rule-based
 * classifier cannot do. `classifyReport` in `social.ts` reads a curated 770-tag
 * vocabulary that this repository wrote. Live social text is none of those words:
 * "the flyover at Andheri is a swimming pool", "no point leaving the hotel", "the
 * seaside road is cut at Charni". No keyword list survives that, and an aligned
 * model is the right tool for it.
 *
 * ## Degradation is mandatory, not defensive
 *
 * `resolveWeather` already established the pattern in the weather feature and
 * `docs/ARCHITECTURE.md` §10 requires it: every external call is cached and every
 * cache has a fallback. So `assessText` cannot throw, cannot block a page render on
 * an unbounded network call, and returns the caller's own assessment when anything is
 * wrong. `NUGEN_OFF=1` — or no key, or no aligned model on disk — takes the same
 * path, and the twin is fully functional because the deterministic classifier handles
 * the committed corpus on its own.
 *
 * ## The fallback is the caller's, not this module's
 *
 * The obvious implementation of "degrade to a deterministic classifier" is to import
 * the classifier and call it here. That is wrong, and `src/llm/boundary.test.ts`
 * says so: this layer may read `src/contracts` and nothing else out of `src`, because
 * the understanding layer is allowed to patch a context and must never pack, score or
 * otherwise decide. A hazard classifier is domain logic and belongs to the feature
 * that owns the domain.
 *
 * So `assessText` takes the caller's assessment as `fallback` and its only job is to
 * try to *beat* it with the aligned model. The twin supplies the deterministic answer
 * and gets a better one back when the platform is up. That also means the fallback
 * cannot drift from the twin's own logic, because it is the twin's own logic.
 */
import { z } from "zod";

const BASE_URL = "https://api.nugen.in/api/v3";

/**
 * Where the alignment writes its result.
 *
 * Committed on purpose. The aligned model id is a build artefact of the corpus in
 * this repository, and a demo on a projector with no network should still be able
 * to name the model it is using. A missing file means "never aligned", which
 * degrades to the deterministic path rather than to a crash.
 */
export const ALIGNMENT_MANIFEST = "data/reference/nugen/alignment.json";

export type AlignmentManifest = {
  alignment_id: string;
  model_id: string;
  base_model_id: string;
  status: string;
  aligned_at: string;
  corpus_documents: number;
  benchmark_id: string | null;
  /** Scores from the benchmark, when one was attached to the run. */
  evaluation: { score: number; samples: number } | null;
  note: string;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export type NugenConfig = {
  enabled: boolean;
  apiKey: string | undefined;
  baseUrl: string;
  /** The aligned model. `null` until `scripts/nugen-align.ts` has run. */
  modelId: string | null;
  timeoutMs: number;
};

function envStr(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function isNugenOff(): boolean {
  const flag = envStr("NUGEN_OFF")?.toLowerCase();
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") return true;
  const generic = envStr("NUGEN")?.toLowerCase();
  return generic === "0" || generic === "off" || generic === "no" || generic === "false";
}

/**
 * Memoised on the inputs, for the same reason `llmConfig()` is: read per call, but
 * not re-parsed on every request.
 */
let cachedConfig: { key: string; value: NugenConfig } | undefined;

export function nugenConfig(manifest: AlignmentManifest | null = null): NugenConfig {
  const key = [
    isNugenOff(),
    envStr("NUGEN_API_KEY") ?? "",
    envStr("NUGEN_BASE_URL") ?? "",
    envStr("NUGEN_MODEL_ID") ?? "",
    envStr("NUGEN_TIMEOUT_MS") ?? "",
    manifest?.model_id ?? "",
  ].join(" ");
  if (cachedConfig?.key !== key) {
    const apiKey = envStr("NUGEN_API_KEY");
    const timeout = Number.parseInt(envStr("NUGEN_TIMEOUT_MS") ?? "12000", 10);
    cachedConfig = {
      key,
      value: {
        // A key is necessary; an aligned model is necessary for it to be the
        // *aligned* model doing the work. Both missing => deterministic only.
        enabled: !isNugenOff() && Boolean(apiKey),
        apiKey,
        baseUrl: envStr("NUGEN_BASE_URL") ?? BASE_URL,
        modelId: envStr("NUGEN_MODEL_ID") ?? manifest?.model_id ?? null,
        timeoutMs: Number.isFinite(timeout) ? Math.min(60_000, Math.max(500, timeout)) : 12_000,
      },
    };
  }
  return cachedConfig.value;
}

// ---------------------------------------------------------------------------
// The one structured thing the aligned model is asked for
// ---------------------------------------------------------------------------

/**
 * The hazard vocabulary, declared here rather than imported.
 *
 * `src/features/twin/hazards.ts` has an identical union, and it is a duplicate
 * rather than a shared type because the two layers are not allowed to know about
 * each other — see the header. Both are string unions over the same five members, so
 * they are mutually assignable with no cast and no mapping layer, and the twin
 * asserts the two agree.
 */
export const HAZARD_KINDS = ["rain", "heat", "wind", "flood", "storm"] as const;
export type NugenHazardKind = (typeof HAZARD_KINDS)[number];

/**
 * Strict, because this is the LLM boundary and `DialogueDecision`'s `.strict()` is
 * the precedent (`docs/ARCHITECTURE.md` §9). An extra key is a bug in the prompt, not
 * a field to keep, and `zod`'s strip-by-default would otherwise hide it.
 */
export const HazardAssessment = z
  .object({
    hazards: z
      .array(
        z.object({
          kind: z.enum(HAZARD_KINDS),
          /** 0 none · 1 degraded · 2 closes · 3 inoperable. */
          severity: z.number().int().min(0).max(3),
          /** 0-1. The model's own uncertainty, which the twin surfaces rather than hides. */
          confidence: z.number().min(0).max(1),
          /** A short quote or paraphrase from the input that justifies the call. */
          evidence: z.string().max(240),
        }),
      )
      .max(5),
    /** 0 sheltered · 1 open and suffering, judged across the whole batch. */
    exposure: z.number().min(0).max(1),
    /** Emerging conditions a rule would not have a phrase for. */
    emerging: z.array(z.string().max(120)).max(5),
  })
  .strict();

export type HazardAssessment = z.infer<typeof HazardAssessment>;

const SYSTEM_PROMPT = [
  "You assess how weather conditions affect hospitality and travel entities in Mumbai.",
  "Given short reports written by travellers, providers and the public, report:",
  "- hazards: which of rain, heat, wind, flood, storm the reports describe, with severity 0-3 and your confidence 0-1",
  "- exposure: 0 fully sheltered, 1 open air and suffering",
  "- emerging: conditions the reports describe that are not yet normal",
  "Judge only what the text supports. A report that praises a place for staying dry in rain is evidence the place is sheltered, not evidence of rain damage.",
  "Answer with JSON only.",
].join(" ");

async function postJson<T>(config: NugenConfig, path: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey ?? ""}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`nugen ${path} returned ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Read a batch of free text and return a structured hazard assessment.
 *
 * `deterministic` is always populated and is what the twin falls back to. When the
 * aligned model answered, `source` is `"aligned"` and `model` names the artefact —
 * both of which the UI prints, because a prediction whose provenance is invisible is
 * indistinguishable from a guess.
 */
export type TextAssessment = {
  assessment: HazardAssessment;
  source: "aligned" | "deterministic";
  model: string | null;
  /** Wall-clock for the model call, 0 on the deterministic path. */
  latencyMs: number;
  /** Why the aligned model was not used, when it was not. */
  note: string;
};

/**
 * The one inference call the twin makes.
 *
 * `fallback` is the caller's deterministic answer, returned verbatim whenever the
 * aligned model is unavailable, times out, or answers with something that does not
 * satisfy `HazardAssessment`. It is always populated, so this function always
 * returns.
 *
 * `reports` is capped and truncated hard: a 0.5B-class aligned model on a long
 * context will quietly start summarising instead of classifying, and a summariser
 * is exactly the failure mode this layer must not have. Twelve reports, 280
 * characters each, is 3,400 characters — comfortably inside what the model reads
 * carefully and short enough that a truncated answer is obvious.
 */
export async function assessText(
  reports: readonly string[],
  options: { fallback: HazardAssessment; manifest?: AlignmentManifest | null; signal?: AbortSignal },
): Promise<TextAssessment> {
  const usable = reports.map((text) => text.slice(0, 280)).filter((text) => text.length > 0).slice(0, 12);
  const fallback: TextAssessment = {
    assessment: options.fallback,
    source: "deterministic",
    model: null,
    latencyMs: 0,
    note: usable.length === 0 ? "no reports to assess" : "",
  };

  const config = nugenConfig(options.manifest ?? null);
  if (!config.enabled) return { ...fallback, note: usable.length === 0 ? fallback.note : "no Nugen API key" };
  if (!config.modelId) return { ...fallback, note: usable.length === 0 ? fallback.note : "no aligned model; run npm run nugen:align" };
  if (usable.length === 0) return fallback;

  const started = Date.now();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  const onAbort = (): void => timeout.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const raw = await postJson<{ choices?: { message?: { content?: string } }[] }>(
      config,
      "/inference/chat/completions",
      {
        model: config.modelId,
        max_tokens: 600,
        temperature: 0.1,
        stream: false,
        messages: [
          { role: "system", content: SYSTEM_PROMPT, name: "twin-hazard-assessor" },
          { role: "user", content: usable.map((text, index) => `${index + 1}. ${text}`).join("\n") },
        ],
      },
      timeout.signal,
    );
    const content = raw.choices?.[0]?.message?.content ?? "";
    const parsed = HazardAssessment.safeParse(extractJson(content));
    if (!parsed.success) {
      return { ...fallback, latencyMs: Date.now() - started, note: "aligned model returned unparsable JSON" };
    }
    return {
      assessment: parsed.data,
      source: "aligned",
      model: config.modelId,
      latencyMs: Date.now() - started,
      note: "",
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown transport failure";
    return { ...fallback, latencyMs: Date.now() - started, note: `aligned model unavailable: ${reason}` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Pull a JSON object out of a completion.
 *
 * A model that wraps JSON in a fence, or thinks out loud first, is the normal case
 * rather than the exception, and `JSON.parse` on a string we then trust is named in
 * `docs/ARCHITECTURE.md` §12 as the thing not to do. So: take the outermost brace
 * pair, unescape what a fence escapes, hand the result to `HazardAssessment`, and
 * let *that* be the validation. If the object does not satisfy the schema, the
 * caller gets the deterministic answer and a note saying why.
 */
export function extractJson(content: string): unknown {
  const text = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Rerank reports against a condition, using the aligned model.
 *
 * Used to decide *which* twelve of a larger live feed reach the classifier, so a
 * 429-costly model call is spent on the reports that matter. Returns indices into
 * the input, best first. Falls back to the input order.
 */
export async function rerankReports(
  query: string,
  reports: readonly string[],
  options: { manifest?: AlignmentManifest | null; signal?: AbortSignal } = {},
): Promise<number[]> {
  const config = nugenConfig(options.manifest ?? null);
  const order = reports.map((_, index) => index);
  if (!config.enabled || !config.modelId || reports.length <= 1) return order;

  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), config.timeoutMs);
  try {
    const raw = await postJson<{ results?: { index: number; relevance_score: number }[] }>(
      config,
      "/inference/rerank",
      {
        model: config.modelId,
        query: query.slice(0, 512),
        documents: reports.map((text) => text.slice(0, 512)),
        top_n: reports.length,
      },
      timeout.signal,
    );
    const ranked = (raw.results ?? [])
      .filter((row) => Number.isInteger(row.index) && row.index >= 0 && row.index < reports.length)
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((row) => row.index);
    return ranked.length === 0 ? order : ranked;
  } catch {
    return order;
  } finally {
    clearTimeout(timer);
  }
}
