/**
 * A small typed client for Nugen's inference API.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS RATHER THAN CALLING FETCH IN A ROUTE HANDLER
 * ---------------------------------------------------------------------------
 *
 * Three reasons, in order of how much they matter.
 *
 * 1. `confidence_score` has to survive the whole way to the UI, and it arrives
 *    in two different shapes. In a non-streaming response it is a single field on
 *    the completion. In a streaming response it is *not* on the final chunk — it
 *    arrives as its own `{"object":"confidence", ...}` events interleaved between
 *    content deltas, one per generated span. A route handler that reads
 *    `json.confidence_score` and forwards the text has silently dropped the one
 *    number that distinguishes an aligned model from a base one. This module
 *    parses both shapes and reports them the same way.
 *
 * 2. The aligned model id is the only id this is ever allowed to be called with,
 *    and that is enforced one layer down in `config.ts`. Passing a model in from
 *    a caller would be a way to route around it.
 *
 * 3. The failure vocabulary needs to be precise. Nugen's errors split cleanly
 *    into "our bug" (400) and "their problem" (429, 502, 503, 504, timeout), and
 *    only the second is worth retrying. Collapsing both into "request failed"
 *    would mean retrying a malformed request forever.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not decide anything. It has no notion of a quest, a stamp or a player.
 * The model is given tools that read the deterministic game layer
 * (`lib/nugen/tools.ts`); the answers that matter come from there, not from the
 * weights. See that file for why.
 */

import { apiKey, timeoutMs } from "./config";

const BASE = process.env.NUGEN_BASE_URL ?? "https://api.nugen.in/api/v3";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
};

export type ToolSpec = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

/** What the model reported about its own certainty, if it reported anything. */
export type Confidence = {
  /** Highest score seen across all spans. 0-100. */
  score: number;
  /** How many separate confidence events arrived. */
  spans: number;
};

export class NugenError extends Error {
  readonly status: number;
  /** True for 429/502/503/504 and transport failures. False for 400 and other 4xx. */
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "NugenError";
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/* -------------------------------------------------------------------------- *
 * Non-streaming
 * -------------------------------------------------------------------------- */

export type CompletionResult = {
  text: string;
  confidence: Confidence | null;
  toolCalls: ToolCall[];
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  model: string;
  latencyMs: number;
};

export async function complete(args: {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<CompletionResult> {
  const started = Date.now();
  const res = await post(
    "/inference/chat/completions",
    {
      model: args.model,
      messages: args.messages,
      max_tokens: args.maxTokens ?? 400,
      temperature: args.temperature ?? 0.3,
      ...(args.tools?.length ? { tools: args.tools, tool_choice: "auto" } : {}),
    },
    args.sessionId,
    args.signal,
  );

  const choice = res.choices?.[0];
  const score = typeof res.confidence_score === "number" ? res.confidence_score : null;

  return {
    text: choice?.message?.content ?? "",
    confidence: score == null ? null : { score, spans: 1 },
    toolCalls: (choice?.message?.tool_calls ?? []).map(normaliseToolCall),
    usage: res.usage ?? null,
    model: res.model ?? args.model,
    latencyMs: Date.now() - started,
  };
}

/* -------------------------------------------------------------------------- *
 * Streaming
 * -------------------------------------------------------------------------- */

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "confidence"; score: number }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; finishReason: string | null; model: string };

/**
 * Parse a Nugene SSE stream into a flat event sequence.
 *
 * Yields `confidence` events as they arrive rather than holding them for the end,
 * because in a streaming response they are interleaved with the content and a
 * consumer that only reads deltas will simply never see them.
 */
export async function* stream(args: {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
  sessionId?: string;
  signal?: AbortSignal;
}): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${BASE}/inference/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey() ?? ""}`,
      "Content-Type": "application/json",
      ...(args.sessionId ? { "X-Session-ID": args.sessionId } : {}),
    },
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      max_tokens: args.maxTokens ?? 400,
      temperature: args.temperature ?? 0.3,
      stream: true,
      ...(args.tools?.length ? { tools: args.tools, tool_choice: "auto" } : {}),
    }),
    signal: args.signal,
  }).catch((err: unknown) => {
    throw new NugenError(`transport failure: ${String(err)}`, 0, true);
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new NugenError(
      `HTTP ${res.status}: ${body.slice(0, 300)}`,
      res.status,
      RETRYABLE.has(res.status),
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let model = args.model;
  let finishReason: string | null = null;
  /** Tool calls arrive as deltas with a growing argument string, keyed by index. */
  const partial = new Map<number, { id: string; name: string; args: string }>();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. The last frame in the buffer
      // is usually incomplete, so it is left for the next read.
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);

        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue; // a partial frame is not an error worth surfacing
          }

          if (typeof ev.model === "string") model = ev.model;

          // The aligned model's confidence arrives as its own event type, one per
          // generated span, not as a field on the final chunk.
          if (ev.object === "confidence") {
            const s = (ev as { confidence_score?: unknown; score?: unknown }).confidence_score ??
              (ev as { score?: unknown }).score;
            if (typeof s === "number") yield { type: "confidence", score: s };
            continue;
          }

          const choices = (ev.choices ?? []) as Array<Record<string, unknown>>;
          for (const c of choices) {
            if (typeof c.finish_reason === "string") finishReason = c.finish_reason;

            const delta = c.delta as Record<string, unknown> | undefined;
            if (!delta) continue;

            if (typeof delta.content === "string" && delta.content) {
              yield { type: "text", delta: delta.content };
            }

            const tcs = (delta.tool_calls ?? []) as Array<Record<string, unknown>>;
            for (const tc of tcs) {
              const idx = typeof tc.index === "number" ? tc.index : 0;
              const fn = (tc.function ?? {}) as { name?: string; arguments?: string };
              const cur = partial.get(idx) ?? { id: "", name: "", args: "" };
              if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
              if (typeof fn.name === "string" && fn.name) cur.name += fn.name;
              if (typeof fn.arguments === "string") cur.args += fn.arguments;
              partial.set(idx, cur);
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  for (const [, call] of [...partial].sort((a, b) => a[0] - b[0])) {
    if (call.name) yield { type: "tool_call", call: normaliseToolCall(call) };
  }
  yield { type: "done", finishReason, model };
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

/** What a non-streaming completion looks like, as far as this client reads it. */
type RawCompletion = {
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: { role?: string; content?: string; tool_calls?: unknown[] };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  /** Present only on an aligned model. Absent on a base model. */
  confidence_score?: number | null;
};

async function post(
  path: string,
  body: unknown,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<RawCompletion> {
  const timeout = AbortSignal.timeout(timeoutMs());
  const composite = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey() ?? ""}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "X-Session-ID": sessionId } : {}),
    },
    body: JSON.stringify(body),
    signal: composite,
  }).catch((err: unknown) => {
    if (composite.aborted) {
      throw new NugenError(`timed out after ${timeoutMs()}ms`, 408, true);
    }
    throw new NugenError(`transport failure: ${String(err)}`, 0, true);
  });

  const text = await res.text();
  if (!res.ok) {
    throw new NugenError(`HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, RETRYABLE.has(res.status));
  }
  try {
    return JSON.parse(text) as RawCompletion;
  } catch {
    throw new NugenError(`unparseable response: ${text.slice(0, 200)}`, res.status, false);
  }
}

function normaliseToolCall(raw: unknown): ToolCall {
  const r = raw as { id?: string; function?: { name?: string; arguments?: string } };
  return {
    id: r?.id ?? "",
    type: "function",
    function: { name: r?.function?.name ?? "", arguments: r?.function?.arguments ?? "{}" },
  };
}
