/**
 * Chat orchestration: the one function that turns "a conversation plus a new
 * message" into a streamed, persisted, ownership-checked answer.
 *
 * Everything else in `src/features/assistant/` is a part of that: `context.ts`
 * assembles the messages, `safety.ts` validates them, `grounding.ts` supplies the
 * facts, `store.ts` persists them, `provider/` sends them. This file owns the
 * order they happen in and the guarantees that depend on it.
 *
 * ## The degradation rule, which is the interesting part
 *
 * If the provider fails **before** any token, the deterministic provider answers
 * and the traveller never learns there was a problem. If it fails **after** some
 * tokens, the partial answer is kept and the failure is reported — switching to a
 * different answer mid-stream, underneath text the traveller is already reading,
 * is worse than an honest short reply. Both paths leave the transcript in a state
 * a later turn can be built on: never a `streaming` row that stays that way.
 *
 * ## Persistence order
 *
 * The assistant's message row is written *before* the first token, as
 * `streaming`. If the process dies mid-stream the row is left honestly labelled
 * rather than holding a half answer that reads as complete.
 */
import { log } from "@/llm/log";
import { newId } from "@/lib/id";

import {
  appendMessage,
  clearAssistantTurns,
  createConversation,
  getConversation,
  listMessages,
  renameConversation,
  titleFromMessage,
  updateMessage,
} from "../store";
import { buildGrounding } from "../grounding";
import { assembleContext } from "./context";
import { ChatRequest, screenResponse, ungroundedClaim, type ChatRequestBody } from "./safety";
import { DeterministicProvider } from "../provider/deterministic";
import { selectProvider } from "../provider";
import { PROMPT_VERSION } from "../prompt";
import { ownerFingerprint } from "../owner";
import type { Message, ProviderSource, StreamEvent } from "../types";

/**
 * A generation budget. A 3B model that keeps going is a bug, not a long answer.
 *
 * Exported so `scripts/assistant-eval.ts` scores the model on the same budget the
 * route serves it on. An eval that allowed twice as many tokens would flatter the
 * model on exactly the axis — rambling past the question — that matters.
 */
export const MAX_TOKENS = 700;
const TEMPERATURE = 0.3;

export type ChatOutcome =
  | { ok: false; status: number; error: string }
  | { ok: true; events: AsyncGenerator<StreamEvent> };

/**
 * Validate, then open a stream.
 *
 * The split is deliberate: everything that can fail cheaply — a malformed body, a
 * conversation id belonging to someone else — fails *before* a generator is
 * returned, so the route can answer with a real status code. Once the generator
 * is running the response is already 200 and a mid-stream problem has to be
 * reported as an SSE `error` frame instead.
 */
export async function openChat(
  ownerId: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<ChatOutcome> {
  const parsed = ChatRequest.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; "),
    };
  }
  // A supplied id that resolves to nothing is a 404, not a silent new chat. The
  // alternative is a UI that reports success while writing into a conversation the
  // traveller never asked for.
  if (parsed.data.conversationId) {
    const existing = await getConversation(ownerId, parsed.data.conversationId);
    if (!existing) return { ok: false, status: 404, error: "No conversation of yours with that id." };
  }
  return { ok: true, events: run(parsed.data, ownerId, signal, { appendUserMessage: true }) };
}

type RunOptions = { appendUserMessage: boolean };

// `async function*`, not `async function`. The star is redundant for an async
// generator and TypeScript says so, but 5.9.3 mis-parses `yield { … }` in a
// bare `async function` that carries an explicit `AsyncGenerator<T>` return
// annotation — it treats the `yield` as an identifier and fails the whole file.
// Dropping the star here looks like a tidy-up and breaks the build.
async function* run(
  body: ChatRequestBody,
  ownerId: string,
  signal: AbortSignal | undefined,
  options: RunOptions,
): AsyncGenerator<StreamEvent> {
  const started = Date.now();
  const requestId = newId("req");

  const history = body.conversationId ? await listMessages(ownerId, body.conversationId) : [];
  let conversation =
    (body.conversationId ? await getConversation(ownerId, body.conversationId) : null) ??
    (await createConversation(ownerId));
  const firstTurn = history.length === 0;

  // 1. The traveller's turn. Stored before anything is generated, so a crash
  //    leaves their question in the transcript rather than losing it. On a retry
  //    this is the only new row, so a retry cannot duplicate the question.
  if (options.appendUserMessage) {
    const stored = await appendMessage(ownerId, conversation.id, { role: "user", content: body.message });
    if (!stored) {
      yield { type: "error", message: "That conversation is not yours.", retryable: false };
      yield { type: "done", latencyMs: Date.now() - started };
      return;
    }
  }

  if (conversation.title === "") {
    const named = await renameConversation(ownerId, conversation.id, titleFromMessage(body.message));
    if (named) conversation = named;
  }

  // 2. Grounding and context, from the real catalogue.
  const facts = await buildGrounding(body.message, body.context);
  const context = assembleContext({ history, message: body.message, facts });

  // 3. The provider, chosen per request rather than memoised, so an alignment
  //    that lands mid-session is picked up without a restart.
  const { provider, degradedReason } = await selectProvider();
  const metadata = provider.metadata();

  const assistantMessage = await appendMessage(ownerId, conversation.id, {
    role: "assistant",
    content: "",
    status: "streaming",
    modelId: metadata.modelId,
    metadata: {
      promptVersion: PROMPT_VERSION,
      source: metadata.source,
      owner: ownerFingerprint(ownerId),
      requestId,
      factCount: facts.length,
      fresh: firstTurn,
    },
  });
  if (!assistantMessage) {
    yield { type: "error", message: "That conversation is not yours.", retryable: false };
    yield { type: "done", latencyMs: Date.now() - started };
    return;
  }

  yield {
    type: "start",
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    model: metadata.modelId ?? metadata.source,
    source: metadata.source as ProviderSource,
  };

  const request = { messages: context.messages, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, signal };
  let text = "";
  let source: ProviderSource = metadata.source as ProviderSource;
  let note = degradedReason;
  let failure: { message: string; retryable: boolean } | null = null;
  let sawDelta = false;
  let saved: Message | null = null;
  let latencyMs = 0;

  try {
    try {
      for await (const delta of provider.stream(request)) {
        if (delta.length === 0) continue;
        sawDelta = true;
        const screened = screenResponse(delta);
        if (!screened.ok) note = note || screened.reason;
        const piece = screened.ok ? delta : screened.sanitised;
        if (piece.length === 0) continue;
        text += piece;
        yield { type: "delta", text: piece };
      }
    } catch (error) {
      failure = { message: error instanceof Error ? error.message : "the model provider failed", retryable: true };
    }

    // Degrade, but only before a single token was shown.
    if (failure && !sawDelta) {
      const offline = new DeterministicProvider();
      try {
        for await (const delta of offline.stream(request)) {
          if (delta.length === 0) continue;
          text += delta;
          yield { type: "delta", text: delta };
        }
        source = "deterministic";
        note = `provider unavailable, answered offline: ${failure.message}`;
        failure = null;
      } catch (error) {
        failure = {
          message: error instanceof Error ? error.message : "the offline path failed too",
          retryable: false,
        };
      }
      if (source === "deterministic") {
        log.warn("assistant_provider_degraded", {
          requestId,
          owner: ownerFingerprint(ownerId),
          error: note,
        });
      }
    }
  } finally {
    // The write happens HERE, not after the try block, and that is the whole
    // point of this shape.
    //
    // A client that aborts closes the generator, which runs `finally` and skips
    // everything after it. With the persistence at the end of the function, an
    // aborted turn left its assistant row stuck at `streaming` forever — and the
    // next turn's context assembly would then read a message that claimed to be
    // mid-generation. The invariant "no row is ever left as `streaming`" holds
    // only if the write is in `finally`.
    //
    // `latencyMs` is stamped here rather than at the top of the function because
    // an abort is exactly the case where a missing latency is a lie.
    latencyMs = Date.now() - started;

    // 4. Screen the whole reply as well as each delta. A payload split across two
    //    deltas is invisible to a per-delta check — `<scr` + `ipt>` is a real
    //    bypass of that, and it costs one extra pass to close.
    const finalScreen = screenResponse(text);
    const finalText = finalScreen.ok ? text : finalScreen.sanitised;
    if (!finalScreen.ok) note = note || finalScreen.reason;
    const claim = ungroundedClaim(finalText, facts.length);
    if (claim) note = note || `possible ungrounded claim: ${claim}`;

    // 5. A `stopped` row is only written when the *client* asked to stop. A
    //    provider error is `error`, and the two are different to a reader.
    const status: Message["status"] = failure ? "error" : signal?.aborted ? "stopped" : "complete";
    saved = await updateMessage(ownerId, assistantMessage.id, {
      content: finalText,
      status,
      modelId: source === "nugen-customized" ? metadata.modelId : "deterministic",
      latencyMs,
      metadata: {
        promptVersion: PROMPT_VERSION,
        source,
        owner: ownerFingerprint(ownerId),
        requestId,
        factCount: facts.length,
        summarisedTurns: context.summarisedTurns,
        note,
      },
    });

    // No message content and no secrets, by construction: every field here is a
    // count, an id, a model name or a status.
    log.info("assistant_turn", {
      requestId,
      owner: ownerFingerprint(ownerId),
      source,
      model: source === "nugen-customized" ? metadata.modelId : null,
      status,
      latencyMs,
      facts: facts.length,
      chars: finalText.length,
      error: failure?.message,
    });
  }

  if (saved) yield { type: "message", message: saved };
  if (failure) yield { type: "error", message: failure.message, retryable: failure.retryable };
  yield { type: "done", latencyMs };
}

/**
 * Drop the assistant's previous answers and re-run the last question.
 *
 * The traveller's messages are kept, including the last one, so a regeneration is
 * a second answer to the same question rather than a new question. Appending the
 * question again — the obvious implementation — would put two copies of it in the
 * history the model reads, which teaches it to expect duplicated turns.
 */
export async function openRegenerate(
  ownerId: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<ChatOutcome> {
  const parsed = ChatRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid regenerate request." };
  }
  const conversationId = parsed.data.conversationId;
  if (!conversationId) return { ok: false, status: 400, error: "conversationId is required to regenerate." };

  const removed = await clearAssistantTurns(ownerId, conversationId);
  if (removed === 0) {
    return { ok: false, status: 404, error: "Nothing of yours to regenerate." };
  }
  const history = await listMessages(ownerId, conversationId);
  const lastUser = [...history].reverse().find((turn) => turn.role === "user");
  if (!lastUser) {
    return { ok: false, status: 400, error: "Nothing to regenerate: this conversation has no question." };
  }
  return {
    ok: true,
    events: run(
      { ...parsed.data, conversationId, message: lastUser.content },
      ownerId,
      signal,
      { appendUserMessage: false },
    ),
  };
}

/** The prompt version and model id, for the UI's provenance badge and health page. */
export async function assistantStatus(): Promise<{
  source: ProviderSource;
  model: string | null;
  customized: boolean;
  promptVersion: string;
  detail: string;
}> {
  const { provider, degradedReason } = await selectProvider();
  const metadata = provider.metadata();
  return {
    source: metadata.source,
    model: metadata.modelId,
    customized: metadata.modelId !== null,
    promptVersion: metadata.promptVersion,
    detail: degradedReason,
  };
}
