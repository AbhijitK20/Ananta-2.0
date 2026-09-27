/**
 * POST /api/chat — the assistant endpoint.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES, IN ORDER
 * ---------------------------------------------------------------------------
 *
 *   1. resolve which model may be called (and refuse if there is no aligned one)
 *   2. run a bounded tool loop against the deterministic game layer
 *   3. stream the answer out as SSE, including `confidence_score`
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODEL CHECK COMES FIRST
 * ---------------------------------------------------------------------------
 *
 * Before any token is produced, `resolveModel()` has to return an aligned model
 * id. If it cannot, this route returns 503 with a body that says exactly why,
 * and no request is made to Nugen at all.
 *
 * That ordering is the whole point of the exercise. A generic base model would
 * answer these questions perfectly well, so a demo that quietly fell back to
 * one would be indistinguishable from a demo that had genuinely been aligned.
 * Failing loudly is what makes the difference observable — from the client, from
 * `/api/health`, and from the absence of a `confidence` frame in the stream.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STREAM CARRIES ITS OWN FRAME TYPES
 * ---------------------------------------------------------------------------
 *
 * The stream is not raw provider SSE. It is re-framed as `text`, `confidence`,
 * `tool`, `done` and `error`, because the browser has to be able to tell a
 * confidence reading from a delta. In the provider's own stream those arrive as
 * one interleaved byte sequence, and a client that treats every `data:` payload
 * as text will render confidence numbers as prose.
 *
 * ---------------------------------------------------------------------------
 * THE TOOL LOOP
 * ---------------------------------------------------------------------------
 *
 * Bounded at `MAX_ROUNDS`. Each round either produces text or a set of tool
 * calls. The tools are pure functions of the player's save
 * (`lib/nugen/tools.ts`), so a loop that ran forever would be a provider bug
 * rather than an ambiguous answer, and bounding it keeps that from becoming a
 * hung request.
 */

import { NextResponse } from "next/server";
import type { ReadableStreamDefaultController } from "node:stream/web";

import { NugenError, stream, type ChatMessage } from "@/lib/nugen/client";
import { apiKey, providerDisabled, resolveModel } from "@/lib/nugen/config";
import { answerFromEngine } from "@/lib/nugen/engine-answer";
import { runTool, SYSTEM_PROMPT, TOOL_SPECS, type PlayerSave } from "@/lib/nugen/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROUNDS = 4;
const HISTORY_TURNS = 8;

type Frame =
  /** Emitted before any provider work, so the response headers flush at once. */
  | { type: "status"; phase: "thinking" }
  | { type: "text"; delta: string }
  | { type: "confidence"; score: number; spans: number }
  | { type: "tool"; name: string; summary: string }
  /**
   * The provider did not answer, so the deterministic engine did. `via` names the
   * rule that produced it and `unmatched` says whether it was a real answer or a
   * refusal. The client renders both as a visible "the model did not respond"
   * marker, and shows no confidence score, because no model generated this.
   */
  | { type: "degraded"; reason: string; via: string; unmatched: boolean; text: string }
  | { type: "done"; model: string; customized: true; confidence: number | null; rounds: number; latencyMs: number }
  | { type: "error"; message: string; code: string };

type Body = {
  messages?: Array<{ role: string; content: string }>;
  save?: Partial<PlayerSave>;
  sessionId?: string;
};

const encoder = new TextEncoder();

function sse(frame: Frame): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
}

function summaryOf(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (name) {
    case "lookup_place":
      return `${a.city ?? "?"}/${a.slug ?? "?"}`;
    case "search_places":
      return [a.city, a.category, a.budget, a.nameContains].filter(Boolean).join(" · ") || "all";
    case "city_summary":
      return String(a.city ?? "?");
    case "player_progress":
      return "the player's save";
    case "quest_board":
      return String(a.tier ?? "all tiers");
    case "collection_gaps":
      return "what is left";
    default:
      return "";
  }
}

export async function POST(req: Request) {
  const started = Date.now();

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "body was not valid JSON" }, { status: 400 });
  }

  const incoming = (body.messages ?? []).filter(
    (m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
  );
  if (!incoming.some((m) => m.role === "user")) {
    return NextResponse.json({ error: "no user message" }, { status: 400 });
  }

  const status = resolveModel();

  if (providerDisabled()) {
    return NextResponse.json(
      { error: "NUGEN_OFF=1 is set, so the provider was not called.", customized: false },
      { status: 503 },
    );
  }
  if (!apiKey()) {
    return NextResponse.json({ error: "NUGEN_API_KEY is not set", customized: false }, { status: 503 });
  }
  if (!status.customized) {
    // No aligned model: do not fall back to a base one. See lib/nugen/config.ts.
    return NextResponse.json(
      {
        error: "no domain-aligned model is available",
        detail: status.reason,
        customized: false,
        remedy: "run `npm run nugen:align`, then reload",
      },
      { status: 503 },
    );
  }

  const save: PlayerSave = {
    stamped: Array.isArray(body.save?.stamped) ? body.save.stamped : [],
    claimed: Array.isArray(body.save?.claimed) ? body.save.claimed : [],
    activeDays: Array.isArray(body.save?.activeDays) ? body.save.activeDays : [],
    dailiesDone: Array.isArray(body.save?.dailiesDone) ? body.save.dailiesDone : [],
  };

  // Trimmed so a long conversation cannot walk the model out of its context
  // window, which on a 3B base model is small enough to matter quickly.
  const trimmed = incoming.slice(-HISTORY_TURNS * 2);

  const stream_ = new ReadableStream({
    async start(controller: ReadableStreamDefaultController<Uint8Array>) {
      const send = (f: Frame) => controller.enqueue(sse(f));

      /**
       * Flush the response before doing anything slow.
       *
       * This frame exists purely to make the browser receive response headers
       * immediately. Without it the first `enqueue` happens only after the
       * provider call has either produced a token or timed out — up to
       * NUGEN_TIMEOUT_MS of silence — and two things go wrong in that window:
       * the page shows a dead spinner with no error, and any host with a
       * function timeout (Vercel's is 10s on Hobby) kills the connection, which
       * the browser reports as `Failed to fetch` with nothing in any log to
       * explain it.
       *
       * Enqueueing a status frame first opens the stream, so the slow part
       * happens inside an already-established response where it belongs.
       */
      send({ type: "status", phase: "thinking" });

      // Highest confidence seen and how many spans reported it. Nugen sends one
      // per generated span in streaming mode, so the number the player sees is
      // the worst-case of those, not the last one.
      let bestConfidence: number | null = null;
      let confidenceSpans = 0;
      let rounds = 0;

      try {
        const messages: ChatMessage[] = [
          { role: "system", content: SYSTEM_PROMPT },
          ...trimmed.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        ];

        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          rounds = round + 1;
          let sawText = false;
          const toolCalls: Array<{ id: string; name: string; args: string }> = [];

          for await (const ev of stream({
            model: status.model,
            messages,
            tools: TOOL_SPECS,
            maxTokens: 500,
            temperature: 0.3,
            ...(body.sessionId ? { sessionId: body.sessionId } : {}),
          })) {
            if (ev.type === "text") {
              sawText = true;
              send({ type: "text", delta: ev.delta });
            } else if (ev.type === "confidence") {
              confidenceSpans += 1;
              bestConfidence = bestConfidence == null ? ev.score : Math.min(bestConfidence, ev.score);
              send({ type: "confidence", score: ev.score, spans: confidenceSpans });
            } else if (ev.type === "tool_call") {
              toolCalls.push({ id: ev.call.id, name: ev.call.function.name, args: ev.call.function.arguments });
            }
          }

          if (!toolCalls.length) {
            if (!sawText && round === 0) {
              send({ type: "error", message: "the model returned nothing", code: "empty" });
            }
            break;
          }

          // Answer every requested tool before the model gets another turn, so a
          // single round can satisfy a question that needs two lookups.
          messages.push({ role: "assistant", content: "" });
          for (const call of toolCalls) {
            let parsed: unknown = {};
            try {
              parsed = call.args ? JSON.parse(call.args) : {};
            } catch {
              /* runTool reports this too; nothing to do here */
            }
            const result = runTool(call.name, call.args, save);
            send({ type: "tool", name: call.name, summary: summaryOf(call.name, parsed) });
            messages.push({
              role: "user",
              content: `Tool result for ${call.name}(${call.args || "{}"}):\n${JSON.stringify(result)}`,
            });
          }
        }

        send({
          type: "done",
          model: status.model,
          customized: true,
          confidence: bestConfidence,
          rounds,
          latencyMs: Date.now() - started,
        });
      } catch (err) {
        const e = err as NugenError;
        const why = e instanceof NugenError ? e.message : String(err);

        // The model is the preferred path and the alignment is the point of the
        // project, so it is tried first and its failure is not hidden. But the
        // questions this panel asks are answerable exactly by the deterministic
        // layer, and Nugen has been refusing inference for long stretches -- a
        // vendor outage should not make the product unusable, especially when the
        // engine path is *more* trustworthy than a 3B model's memory.
        //
        // What matters is that the answer is labelled. `degraded` tells the client
        // no model generated this, and the client shows that to the player. There
        // is deliberately no confidence score on this path: a number here would be
        // invented, which is the one thing this feature must never do.
        const last = [...trimmed].reverse().find((m) => m.role === "user");
        if (last) {
          const answer = answerFromEngine(last.content, save);
          send({ type: "degraded", reason: why, via: answer.via, unmatched: answer.unmatched, text: answer.text });
        } else {
          send({ type: "error", message: why, code: e instanceof NugenError ? (e.retryable ? "provider" : "bad_request") : "unknown" });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream_, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      // Set so the client can attribute an answer to a model without a second
      // round trip, and so `confidence: null` is visible as a null rather than
      // as an absent key.
      "X-Assistant-Model": status.model,
      "X-Assistant-Customized": "true",
    },
  });
}
