/**
 * `NugenProvider` — the only file in the app that knows Nugen's wire format.
 *
 * Everything above it (`orchestration/chat.ts`, the routes, the UI) works in
 * terms of `AIProvider`. That isolation is the whole point: when Nugen's
 * response shape changes, this file changes and nothing else does.
 *
 * ## What is sent
 *
 * `POST {baseUrl}/inference/chat/completions`, OpenAI-compatible, bearer auth.
 * The `model` field is the **customized** model id resolved by `config.ts`, which
 * has no base-model fallback. `src/llm/nugen.ts` is the sibling that calls the
 * same endpoint for the twin's hazard classification, and it has its own config
 * because the twin's manifest is a different alignment.
 *
 * ## Streaming
 *
 * `stream: true` returns SSE: `data: {choices:[{delta:{content}}]}` terminated by
 * `data: [DONE]`. `parseSse` is written defensively — a provider that emits a
 * bare `data:` line, a comment heartbeat, or a chunk with no `delta` must not
 * crash the reader, because a mid-stream crash here loses a partially generated
 * answer that the user is already reading.
 *
 * ## Failure is not exceptional
 *
 * Nugen's data plane has returned `502 Bad Gateway` for every listed model while
 * its control plane answers normally. So a 502 here is an expected outcome, not
 * a bug: it is classified as retryable, reported on the health endpoint, and the
 * route degrades to the deterministic provider. See `docs/NUGEN_INTEGRATION.md`
 * for the probe output that establishes this.
 */
import { assistantNugenConfig, type AssistantNugenConfig } from "./config";
import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  ProviderHealthResult,
  ProviderMessage,
} from "./provider";
import type { ProviderHealth } from "../types";
import { PROMPT_VERSION } from "../prompt";

const SYSTEM_ROLE = "system";

export class NugenProvider implements AIProvider {
  readonly name = "nugen";
  private config: AssistantNugenConfig;

  constructor(config: AssistantNugenConfig) {
    this.config = config;
  }

  static async create(): Promise<NugenProvider> {
    return new NugenProvider(await assistantNugenConfig());
  }

  /**
   * Available only when a key AND a customized model exist.
   *
   * A key with no alignment is `false`, not `true`, and that is deliberate: the
   * assistant's whole claim is that it runs on an aligned model, so "I can reach
   * Nugen" is the wrong question to answer affirmatively.
   */
  get available(): boolean {
    return this.config.enabled && this.config.modelId !== null;
  }

  metadata() {
    return {
      source: "nugen-customized" as const,
      modelId: this.config.modelId,
      baseModelId: this.config.baseModelId,
      alignmentId: this.config.alignmentId,
      promptVersion: PROMPT_VERSION,
    };
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey ?? ""}`,
    };
  }

  private payload(request: GenerateRequest, stream: boolean): string {
    return JSON.stringify({
      // The customized model. Not the base model — see the file header.
      model: this.config.modelId,
      messages: request.messages.map((m: ProviderMessage) => ({ role: m.role, content: m.content })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream,
    });
  }

  /** `AbortSignal.any` is not in the Node 22 baseline this repo targets. */
  private withTimeout(signal: AbortSignal | undefined): {
    signal: AbortSignal;
    done: () => void;
  } {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
    const forward = (): void => timeout.abort();
    signal?.addEventListener("abort", forward, { once: true });
    return {
      signal: timeout.signal,
      done: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", forward);
      },
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (!this.available) {
      return {
        text: "",
        modelId: this.config.modelId ?? "none",
        usage: null,
        latencyMs: 0,
        finishReason: "error",
      };
    }
    const started = Date.now();
    const { signal, done } = this.withTimeout(request.signal);
    try {
      const response = await fetch(`${this.config.baseUrl}/inference/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: this.payload(request, false),
        signal,
      });
      if (!response.ok) throw new NugenError(response.status, await safeText(response));
      const body = (await response.json()) as ChatCompletion;
      return {
        text: body.choices?.[0]?.message?.content ?? "",
        modelId: this.config.modelId ?? "none",
        usage: usageFrom(body.usage),
        latencyMs: Date.now() - started,
        finishReason: body.choices?.[0]?.finish_reason === "length" ? "length" : "stop",
      };
    } finally {
      done();
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<string> {
    if (!this.available) {
      throw new NugenError(503, this.config.reason || "provider unavailable");
    }
    const { signal, done } = this.withTimeout(request.signal);
    try {
      const response = await fetch(`${this.config.baseUrl}/inference/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: this.payload(request, true),
        signal,
      });
      if (!response.ok || !response.body) {
        throw new NugenError(response.status, await safeText(response));
      }
      // A 502 from an OpenAI-compatible gateway is the documented shape of "their
      // GPU is down" and is worth retrying; a 400 is our bug and is not.
      if (isGatewayError(response.status)) {
        throw new NugenError(response.status, "nugen data plane unavailable", true);
      }
      for await (const delta of readSseDeltas(response.body, signal)) {
        if (delta.length > 0) yield delta;
      }
    } finally {
      done();
    }
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    const started = Date.now();
    if (!this.available) {
      return { ok: false, detail: this.config.reason || "no customized model", latencyMs: 0 };
    }
    const { signal, done } = this.withTimeout(undefined);
    try {
      const response = await fetch(`${this.config.baseUrl}/inference/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        // One token, no conversation: a health check must not cost a real
        // completion or land in someone's context window.
        body: JSON.stringify({
          model: this.config.modelId,
          max_tokens: 1,
          temperature: 0,
          stream: false,
          messages: [{ role: SYSTEM_ROLE, content: "ping" }],
        }),
        signal,
      });
      const body = response.ok ? await safeText(response) : "";
      return {
        ok: response.ok,
        detail: response.ok ? `ok in ${Date.now() - started}ms` : `HTTP ${response.status}: ${body.slice(0, 200)}`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "unknown transport failure",
        latencyMs: Date.now() - started,
      };
    } finally {
      done();
    }
  }

  /** Never contains the key: the header is built here and never stored. */
  health(): ProviderHealth {
    return {
      provider: "nugen",
      configured: this.config.enabled,
      model: this.config.modelId,
      customized: this.config.modelId !== null,
      status: !this.config.enabled ? "unconfigured" : this.config.modelId ? "ready" : "degraded",
      detail: this.config.reason,
      checkedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

type ChatCompletion = {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
};

/**
 * Nugen's OpenAI-shaped usage keys into the app's own keys.
 *
 * Null when the provider reported nothing, which is different from zero. A
 * "0 tokens" badge is a lie about a call that never happened, and this
 * distinction is what lets the health page say "the provider did not report
 * usage" rather than rendering a number.
 */
function usageFrom(usage: ChatCompletion["usage"]): { prompt?: number; completion?: number; total?: number } | null {
  if (!usage) return null;
  const out: { prompt?: number; completion?: number; total?: number } = {};
  if (typeof usage.prompt_tokens === "number") out.prompt = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") out.completion = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") out.total = usage.total_tokens;
  return Object.keys(out).length > 0 ? out : null;
}

export class NugenError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly retryable: boolean = isGatewayError(status),
  ) {
    super(`nugen ${status}: ${detail.slice(0, 300)}`);
    this.name = "NugenError";
  }
}

function isGatewayError(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 429;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * Split an SSE body into `delta.content` strings.
 *
 * Hand-rolled rather than pulled from a library because the format is four lines
 * of spec and the alternatives all bring a parser, a stream polyfill and a
 * dependency. Handles: multi-line frames separated by a blank line, `:` comment
 * heartbeats, `[DONE]`, and frames whose JSON is truncated by a dropped
 * connection (skipped, not thrown — the caller decides whether it has enough).
 */
export async function* readSseDeltas(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const delta = deltaFromFrame(frame);
        if (delta) yield delta;
        split = buffer.indexOf("\n\n");
      }
    }
    // A well-behaved server terminates with a blank line, but a stream cut
    // mid-frame still has a usable tail.
    const tail = deltaFromFrame(buffer);
    if (tail) yield tail;
  } finally {
    // Releasing lets an aborted fetch tear the socket down instead of leaking it
    // until the timeout fires.
    reader.releaseLock();
  }
}

function deltaFromFrame(frame: string): string {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as {
        choices?: { delta?: { content?: string } }[];
      };
      const content = parsed.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length > 0) return content;
    } catch {
      // Truncated or non-JSON frame. Skipping is right: the alternative is
      // discarding a partially generated answer the user is reading.
    }
  }
  return "";
}
