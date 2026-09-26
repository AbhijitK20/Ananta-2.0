/**
 * A fake OpenRouter, so the client can be tested for real without a key, a
 * network, or a credit card. It speaks just enough of the Chat Completions wire
 * format for `@ai-sdk/openai-compatible` to parse a response.
 *
 * What it buys us: the malformed-output, network-failure, fallback-chain and
 * circuit-breaker tests exercise the actual transport rather than a mock of it.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeReply = { status: number; body: string; contentType?: string };

export type FakeOpenRouter = {
  baseUrl: string;
  /** Every request body the server received, in order. */
  requests: unknown[];
  close: () => Promise<void>;
  hitCount: () => number;
};

const OPENAI_CHAT = (content: string): string =>
  JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model: "fake/model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  });

export function chatCompletion(content: string): FakeReply {
  return { status: 200, body: OPENAI_CHAT(content) };
}

/** Well-formed HTTP, content the schema will reject. */
export function garbage(): FakeReply {
  return chatCompletion("Sure! You should definitely head to Bandra Fort and grab a vada pav.");
}

/** Valid JSON, wrong shape: the model invented fields the contract forbids. */
export function hallucinated(): FakeReply {
  return chatCompletion(
    JSON.stringify({
      contextPatch: { availableMin: 120, plan: { stops: ["exp-fort"] }, experienceId: "exp-fort" },
      reply: "Booked.",
      confidence: 0.99,
      suggestions: ["go to Bandra Fort"],
      toolCall: { name: "book" },
    }),
  );
}

export function valid(content: unknown): FakeReply {
  return chatCompletion(JSON.stringify(content));
}

export async function startFakeOpenRouter(replies: FakeReply[] | (() => FakeReply)): Promise<FakeOpenRouter> {
  const requests: unknown[] = [];
  let i = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        requests.push(null);
      }
      const reply = typeof replies === "function" ? replies() : (replies[i++] ?? replies[replies.length - 1] ?? chatCompletion(""));
      res.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" });
      res.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    hitCount: () => requests.length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
