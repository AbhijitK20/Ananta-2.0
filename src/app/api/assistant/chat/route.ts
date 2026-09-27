/**
 * POST /api/assistant/chat — the streaming chat endpoint.
 *
 * SSE rather than a WebSocket, and the reason is worth stating because it is a
 * decision, not a default: the traffic is one-directional (the client sends the
 * question in the request body, then only reads), SSE is plain HTTP so it
 * survives proxies and serverless without an upgrade handshake, and a dropped
 * connection is recoverable by re-sending the request rather than by
 * reimplementing a resume protocol.
 *
 * ## Frames
 *
 *   start   conversationId, messageId, model, source — so the UI can show
 *           provenance before the first token
 *   delta   a piece of the reply
 *   message the persisted, final row
 *   error   a mid-stream failure, with whether a retry is worth it
 *   done    total latency
 *
 * ## Abort
 *
 * The request signal is threaded into the provider, and the generator's `finally`
 * semantics are what leave a `stopped` row rather than an orphan `streaming` one.
 * The client aborts with `AbortController`; the server notices via the same
 * signal Next hands the route.
 */
import { resolveOwner } from "@/features/assistant/owner";
import { consumeChat } from "@/features/assistant/rate-limit";
import { openChat, openRegenerate } from "@/features/assistant/orchestration/chat";
import type { StreamEvent } from "@/features/assistant/types";

/** Streaming must not be cached by a CDN; the body depends on the owner cookie. */
export const dynamic = "force-dynamic";
/** Node runtime: the provider reads a body stream and node:sqlite is not edge-safe. */
export const runtime = "nodejs";

const HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function frame(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body was not valid JSON." }, { status: 400 });
  }

  const url = new URL(request.url);
  const secure = url.protocol === "https:";
  const { ownerId, setCookie } = resolveOwner(request.headers.get("cookie"), secure);

  // Regenerate is a mode of the same endpoint rather than a second route: it
  // shares the provider, the context assembly and every streaming guarantee, and
  // duplicating those is how the two drift apart.
  const regenerate = url.searchParams.get("regenerate") === "1";
  // Regenerate costs a full paid call, so it is metered like any other turn; the
  // consume() happens exactly once, because calling it twice to "check then
  // check" would charge the traveller for two messages.
  if (!regenerate) {
    const verdict = consumeChat(ownerId);
    if (!verdict.allowed) {
      return Response.json(
        { error: "Too many messages. Give it a moment." },
        {
          status: 429,
          headers: {
            "Retry-After": String(verdict.retryAfterSec),
            ...(setCookie ? { "Set-Cookie": setCookie } : {}),
          },
        },
      );
    }
  }

  const outcome = regenerate
    ? await openRegenerate(ownerId, body, request.signal)
    : await openChat(ownerId, body, request.signal);

  if (!outcome.ok) {
    return Response.json(
      { error: outcome.error },
      { status: outcome.status, headers: setCookie ? { "Set-Cookie": setCookie } : undefined },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: StreamEvent): void => {
        try {
          controller.enqueue(encoder.encode(frame(event)));
        } catch {
          // The client disconnected between the enqueue and this call. Nothing to
          // do: the generator below observes the abort and finalises the row.
        }
      };
      try {
        for await (const event of outcome.events) {
          if (request.signal.aborted) break;
          send(event);
        }
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : "the stream failed",
          retryable: true,
        });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed by a disconnect. Closing twice is not an error worth
          // surfacing to a client that has gone.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: setCookie ? { ...HEADERS, "Set-Cookie": setCookie } : HEADERS,
  });
}
