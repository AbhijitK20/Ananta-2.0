/**
 * The only place in the product that opens a socket to a model.
 *
 * Everything else in `src/llm` is a parser or a prompt, and all of them work
 * with this file switched off. That is the whole architecture: the LLM is not
 * in the decision path, so its failure modes are latency and prose quality,
 * never a wrong plan.
 *
 * Guarantees, in order of how much they have bitten other people:
 *  1. `LLM_OFF` or a missing key short-circuits BEFORE the provider is built.
 *  2. A fallback chain per role, tried in order. A `fallbackProvider` is a name
 *     resolver, not a retry mechanism, so the chain here is explicit.
 *  3. A circuit breaker per model, so a provider having a bad minute costs one
 *     timeout instead of one timeout per user turn.
 *  4. Retries only for transient classes. A 400 is a schema bug: retrying it
 *     triples the latency and the bill and fixes nothing. A 401/403 aborts the
 *     whole chain, because every model on it shares the one key.
 *  5. Output is validated with a real schema (zod), never `JSON.parse` on a
 *     string we then trust. A response that fails validation is a failure, and a
 *     failure advances the chain.
 *
 * `supportsStructuredOutputs: true` is the load-bearing provider option: it
 * moves the wire from `response_format:{type:"json_object"}` to a real
 * `json_schema` with `strict`, so the model is constrained at decode time
 * instead of us apologising for its output afterwards. The flip side: a model
 * that does not implement `json_schema` answers 400, and 400 is not retried.
 * That is deliberate — drop the model from the chain, do not paper over it.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output, type LanguageModel } from "ai";
import type { z } from "zod";
import type { LLMEnvelope } from "../contracts";
import { llmConfig, type LlmConfig, type LlmRole } from "./config";
import { log } from "./log";

export type Attempt = { model: string; ok: boolean; reason?: string; ms: number };

export type LlmResult<T> =
  | { ok: true; value: T; model: string; latencyMs: number; attempts: Attempt[] }
  | { ok: false; reason: string; attempts: Attempt[]; latencyMs: number };

export type CallOptions = {
  role: LlmRole;
  instructions: string;
  prompt: string;
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type StructuredCall<S extends z.ZodType> = CallOptions & {
  schema: S;
  schemaName: string;
  schemaDescription: string;
};

type Outcome =
  | { ok: true; value: unknown; raw: string }
  | { ok: false; reason: string; transient: boolean; status?: number };

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

type Breaker = { failures: number; openedAt: number | null };

const breakers = new Map<string, Breaker>();

/** Test and eval hook: forget every breaker's history. */
export function resetBreakers(): void {
  breakers.clear();
}

function breakerFor(model: string): Breaker {
  let b = breakers.get(model);
  if (!b) breakers.set(model, (b = { failures: 0, openedAt: null }));
  return b;
}

function isOpen(b: Breaker, cfg: LlmConfig): boolean {
  if (b.openedAt == null) return false;
  if (Date.now() - b.openedAt >= cfg.breakerCooldownMs) {
    b.openedAt = null;
    b.failures = 0;
    return false;
  }
  return true;
}

function recordFailure(model: string, cfg: LlmConfig): void {
  const b = breakerFor(model);
  b.failures += 1;
  if (b.failures >= cfg.breakerFailures && b.openedAt == null) {
    b.openedAt = Date.now();
    log.warn("breaker_open", { model, failures: b.failures, cooldownMs: cfg.breakerCooldownMs });
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * AI SDK v7 does not surface an HTTP error status: a 401 from the provider comes
 * back as an empty completion and a `NoObjectGeneratedError` about "could not
 * parse the response". That is unusable for a retry policy — every 401 would look
 * like a model that returned bad JSON, and the chain would keep paying for it.
 * So the provider gets a `fetch` seam that sees the status first. This is the
 * documented reason that option exists.
 */
class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`provider returned ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
  }
}

const observedFetch: typeof fetch = async (input, init) => {
  const res = await globalThis.fetch(input, init);
  if (res.ok) return res;
  throw new ProviderHttpError(res.status, (await res.text().catch(() => "")).slice(0, 300));
};

let providerMemo: { key: string; chat: (id: string) => LanguageModel } | undefined;

function chat(cfg: LlmConfig): (id: string) => LanguageModel {
  const key = `${cfg.baseUrl}|${cfg.apiKey ?? ""}`;
  if (providerMemo?.key !== key) {
    const provider = createOpenAICompatible({
      name: "openrouter",
      baseURL: cfg.baseUrl,
      apiKey: cfg.apiKey,
      includeUsage: true,
      supportsStructuredOutputs: true,
      fetch: observedFetch,
      headers: {
        "X-Title": "Ananta",
        "HTTP-Referer": process.env.PUBLIC_SITE_URL?.trim() || "http://localhost:3000",
      },
    });
    providerMemo = { key, chat: (id: string) => provider.chatModel(id) };
    log.info("openrouter_ready", { baseUrl: cfg.baseUrl, hasKey: Boolean(cfg.apiKey) });
  }
  return providerMemo.chat;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function statusOf(err: unknown): number | undefined {
  const e = err as { statusCode?: unknown; status?: unknown; cause?: { statusCode?: unknown } };
  for (const v of [e?.statusCode, e?.status, e?.cause?.statusCode]) {
    if (typeof v === "number") return v;
  }
  return undefined;
}

/**
 * Transient = worth spending wall clock on again. Deliberately narrow: 408/425/429,
 * 5xx, and transport-level failures. A structured-output miss is NOT transient —
 * the same prompt to the same model will miss again — but it does advance the
 * chain, because a different model may be better at JSON than this one.
 */
function isTransient(err: unknown, status: number | undefined): boolean {
  const e = err as { name?: string; message?: string; cause?: { message?: string } };
  if (e?.name === "AbortError") return false;
  if (status != null) return status === 408 || status === 425 || status === 429 || status >= 500;
  const text = `${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  return /fetch failed|econnreset|etimedout|eai_again|enotfound|socket hang up|network|load failed|terminated|timeout/i.test(
    text,
  );
}

function reasonOf(err: unknown, status: number | undefined): string {
  const e = err as { name?: string; message?: string; text?: string; body?: string };
  const head = `${e?.name ?? "Error"}${status != null ? ` ${status}` : ""}`;
  const detail = String(e?.body ?? e?.message ?? e?.text ?? "").slice(0, 180);
  return detail ? `${head}: ${detail}` : head;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function runOnce<S extends z.ZodType>(
  model: LanguageModel,
  modelId: string,
  opts: CallOptions,
  structured?: { schema: S; name: string; description: string },
): Promise<Outcome> {
  const cfg = llmConfig();
  const started = Date.now();
  try {
    const res = await generateText({
      model,
      instructions: opts.instructions,
      prompt: opts.prompt,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature ?? 0,
      // Our loop classifies errors, so the SDK must not also retry blindly and
      // hide the attempt count from the breaker.
      maxRetries: 0,
      timeout: { totalMs: cfg.timeoutMs, stepMs: cfg.stepMs },
      abortSignal: opts.signal,
      ...(structured
        ? { output: Output.object({ schema: structured.schema, name: structured.name, description: structured.description }) }
        : {}),
    });

    for (const w of res.warnings ?? []) {
      if (w.type === "deprecated") log.warn("provider_option_deprecated", { model: modelId, warning: w });
    }

    if (structured) {
      if (res.output == null) return { ok: false, reason: "no_structured_output", transient: false };
      return { ok: true, value: res.output, raw: res.text };
    }
    const text = res.text.trim();
    if (!text) return { ok: false, reason: "empty_text", transient: false };
    return { ok: true, value: text, raw: text };
  } catch (err) {
    const status = statusOf(err);
    const reason = reasonOf(err, status);
    log.warn("call_failed", { model: modelId, ms: Date.now() - started, reason });
    return { ok: false, reason, transient: isTransient(err, status), status };
  }
}

/**
 * The chain loop, shared by both call shapes: breaker, retry, fallback, then the
 * caller's own validation. `T` is decided by the validator, which is why a prose
 * call and a schema call share one implementation instead of two.
 */
async function runChain<T>(
  role: LlmRole,
  run: (modelId: string, model: LanguageModel) => Promise<Outcome>,
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; reason: string },
): Promise<LlmResult<T>> {
  const cfg = llmConfig();
  const attempts: Attempt[] = [];
  const startedAll = Date.now();
  const fail = (reason: string): LlmResult<T> => ({ ok: false, reason, attempts, latencyMs: Date.now() - startedAll });

  if (!cfg.enabled) {
    const reason = cfg.apiKey ? "llm_off" : "no_api_key";
    log.info("llm_skipped", { role, reason });
    return fail(reason);
  }

  for (const modelId of cfg.models[role]) {
    if (isOpen(breakerFor(modelId), cfg)) {
      attempts.push({ model: modelId, ok: false, reason: "breaker_open", ms: 0 });
      continue;
    }

    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      const t0 = Date.now();
      const out = await run(modelId, chat(cfg)(modelId));
      if (out.ok) {
        const checked = validate(out.value);
        if (checked.ok) {
          const b = breakers.get(modelId);
          if (b) b.failures = 0;
          attempts.push({ model: modelId, ok: true, ms: Date.now() - t0 });
          log.info("call_ok", { role, model: modelId, ms: Date.now() - t0, attempt: attempt + 1, chars: out.raw.length });
          return { ok: true, value: checked.value, model: modelId, latencyMs: Date.now() - startedAll, attempts };
        }
        attempts.push({ model: modelId, ok: false, reason: checked.reason, ms: Date.now() - t0 });
        break; // same model, same prompt, same miss
      }

      attempts.push({ model: modelId, ok: false, reason: out.reason, ms: Date.now() - t0 });
      if (out.status === 401 || out.status === 403) {
        log.error("unauthorized", { model: modelId, note: "one key serves the whole chain; aborting" });
        return fail(out.reason);
      }
      if (!out.transient || attempt === cfg.retries) break;
      await sleep(Math.min(1_500, 150 * 2 ** attempt + Math.floor(Math.random() * 100)));
    }

    recordFailure(modelId, cfg);
  }

  log.info("chain_exhausted", { role, models: cfg.models[role].length });
  return fail("all_models_failed");
}

/** Structured call. The schema is enforced twice: at decode time, and here. */
export function callStructured<S extends z.ZodType>(opts: StructuredCall<S>): Promise<LlmResult<z.output<S>>> {
  return runChain<z.output<S>>(
    opts.role,
    (modelId, model) => runOnce(model, modelId, opts, { schema: opts.schema, name: opts.schemaName, description: opts.schemaDescription }),
    (value) => {
      const parsed = opts.schema.safeParse(value);
      if (parsed.success) return { ok: true, value: parsed.data as z.output<S> };
      const first = parsed.error.issues[0];
      return { ok: false, reason: `schema:${first?.path.join(".") || "$"}:${first?.message ?? "invalid"}` };
    },
  );
}

/** Prose call. Same breaker, same chain, same retry policy, no JSON envelope. */
export function callText(opts: CallOptions): Promise<LlmResult<string>> {
  return runChain<string>(opts.role, (modelId, model) => runOnce(model, modelId, opts), (value) => ({
    ok: true,
    value: String(value),
  }));
}

/** The contract's envelope, for logging, the eval harness, and cost tables. *//** The contract's envelope, for logging, the eval harness, and cost tables. */
export function toEnvelope<T>(result: LlmResult<T>, error: string | null = null): LLMEnvelope {
  return result.ok
    ? { ok: true, data: result.value, error: null, model: result.model, latencyMs: result.latencyMs, degraded: false }
    : { ok: false, data: null, error: error ?? result.reason, model: null, latencyMs: result.latencyMs, degraded: true };
}
