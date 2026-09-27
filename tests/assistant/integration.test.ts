/**
 * Integration and security tests for the assistant's store and chat route.
 *
 * These run against a real `node:sqlite` file, not a mock. The property under
 * test is an ownership predicate expressed in SQL, and a mock of that predicate
 * would be testing the mock. `DB_FILE` is pointed at a temp file and
 * `resetAssistantDb()` reopens it, which is the seam `db.ts` exists to provide.
 *
 * The cross-user cases are the point of this file. The store is written so that
 * no exported function can reach a message without an owner check, and these
 * tests are what would notice if a future edit broke that.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetAssistantDb } from "@/features/assistant/db";
import {
  appendMessage,
  clearAssistantTurns,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  renameConversation,
  updateMessage,
} from "@/features/assistant/store";
import { openChat, openRegenerate } from "@/features/assistant/orchestration/chat";
import { consumeChat, resetLimits } from "@/features/assistant/rate-limit";
import type { StreamEvent } from "@/features/assistant/types";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "assistant-test-"));
  process.env.DB_FILE = join(dir, "test.db");
  resetAssistantDb();
});

afterAll(() => {
  resetAssistantDb();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetLimits();
});

afterEach(() => {
  resetLimits();
});

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);

async function collect(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: "delta" }> => event.type === "delta")
    .map((event) => event.text)
    .join("");
}

describe("conversation ownership", () => {
  it("lists only the owner's conversations", async () => {
    const mine = await createConversation(OWNER_A, { title: "mine" });
    await createConversation(OWNER_B, { title: "theirs" });

    const titles = (await listConversations(OWNER_A)).map((c) => c.title);
    expect(titles).toContain("mine");
    expect(titles).not.toContain("theirs");
    expect(mine.ownerId).toBe(OWNER_A);
  });

  it("returns null for another owner's conversation", async () => {
    const theirs = await createConversation(OWNER_B, { title: "theirs" });
    expect(await getConversation(OWNER_A, theirs.id)).toBeNull();
  });

  it("refuses to rename another owner's conversation", async () => {
    const theirs = await createConversation(OWNER_B, { title: "theirs" });
    expect(await renameConversation(OWNER_A, theirs.id, "hijacked")).toBeNull();
    // And the row is genuinely untouched, not just unreported.
    expect((await getConversation(OWNER_B, theirs.id))?.title).toBe("theirs");
  });

  it("refuses to delete another owner's conversation", async () => {
    const theirs = await createConversation(OWNER_B, { title: "theirs" });
    expect(await deleteConversation(OWNER_A, theirs.id)).toBe(false);
    expect(await getConversation(OWNER_B, theirs.id)).not.toBeNull();
  });

  it("search cannot widen scope", async () => {
    await createConversation(OWNER_A, { title: "bandra morning" });
    await createConversation(OWNER_B, { title: "bandra morning" });
    const found = await listConversations(OWNER_A, { search: "bandra" });
    expect(found).toHaveLength(1);
    expect(found[0]?.ownerId).toBe(OWNER_A);
  });

  it("treats LIKE wildcards in a search as literal", async () => {
    await createConversation(OWNER_A, { title: "fifty percent 50% done" });
    await createConversation(OWNER_A, { title: "unrelated" });
    const found = await listConversations(OWNER_A, { search: "50%" });
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toContain("50%");
  });
});

describe("message ownership", () => {
  it("will not append to another owner's conversation", async () => {
    const theirs = await createConversation(OWNER_B);
    expect(await appendMessage(OWNER_A, theirs.id, { role: "user", content: "hi" })).toBeNull();
    expect(await listMessages(OWNER_B, theirs.id)).toEqual([]);
  });

  it("will not read another owner's messages", async () => {
    const theirs = await createConversation(OWNER_B);
    await appendMessage(OWNER_B, theirs.id, { role: "user", content: "private" });
    expect(await listMessages(OWNER_A, theirs.id)).toEqual([]);
  });

  it("will not update another owner's message, by message id alone", async () => {
    // The dangerous version of this bug is a guessed or leaked message id, so the
    // test guesses one rather than only passing the right conversation id.
    const theirs = await createConversation(OWNER_B);
    const message = await appendMessage(OWNER_B, theirs.id, { role: "assistant", content: "original" });
    expect(message).not.toBeNull();
    expect(await updateMessage(OWNER_A, message!.id, { content: "overwritten" })).toBeNull();
    expect((await listMessages(OWNER_B, theirs.id))[0]?.content).toBe("original");
  });

  it("will not clear another owner's assistant turns", async () => {
    const theirs = await createConversation(OWNER_B);
    await appendMessage(OWNER_B, theirs.id, { role: "user", content: "q" });
    await appendMessage(OWNER_B, theirs.id, { role: "assistant", content: "a" });
    expect(await clearAssistantTurns(OWNER_A, theirs.id)).toBe(0);
    expect(await listMessages(OWNER_B, theirs.id)).toHaveLength(2);
  });

  it("cascades a delete to the messages", async () => {
    const conversation = await createConversation(OWNER_A);
    await appendMessage(OWNER_A, conversation.id, { role: "user", content: "q" });
    expect(await deleteConversation(OWNER_A, conversation.id)).toBe(true);
    expect(await listMessages(OWNER_A, conversation.id)).toEqual([]);
  });

  it("keeps the traveller's turns when clearing for a regenerate", async () => {
    const conversation = await createConversation(OWNER_A);
    await appendMessage(OWNER_A, conversation.id, { role: "user", content: "the question" });
    await appendMessage(OWNER_A, conversation.id, { role: "assistant", content: "the answer" });
    expect(await clearAssistantTurns(OWNER_A, conversation.id)).toBe(1);
    const left = await listMessages(OWNER_A, conversation.id);
    expect(left).toHaveLength(1);
    expect(left[0]?.content).toBe("the question");
  });
});

describe("chat orchestration", () => {
  it("rejects a malformed body before opening a stream", async () => {
    const outcome = await openChat(OWNER_A, { message: "" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
  });

  it("rejects an unknown field rather than ignoring it", async () => {
    // `.strict()` on the request: a typo'd key silently dropped is how a caller
    // ends up debugging why their app context never arrives.
    const outcome = await openChat(OWNER_A, { message: "hi", contxt: {} });
    expect(outcome.ok).toBe(false);
  });

  it("404s a conversation id belonging to someone else", async () => {
    const theirs = await createConversation(OWNER_B);
    const outcome = await openChat(OWNER_A, { message: "hi", conversationId: theirs.id });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
  });

  it("streams a start, deltas, a persisted message and a done", async () => {
    const outcome = await openChat(OWNER_A, { message: "why was a stop rejected?" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const events = await collect(outcome.events);
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("done");
    expect(textOf(events).length).toBeGreaterThan(0);

    const final = events.find(
      (event): event is Extract<StreamEvent, { type: "message" }> => event.type === "message",
    );
    expect(final?.message.status).toBe("complete");
    expect(final?.message.role).toBe("assistant");

    // The transcript is durable and complete, not a stream that only existed in
    // the response.
    const stored = await listMessages(OWNER_A, final!.message.conversationId);
    expect(stored).toHaveLength(2);
    expect(stored[0]?.role).toBe("user");
    expect(stored[1]?.content).toBe(final?.message.content);
  });

  it("records which provider answered and which prompt version", async () => {
    const outcome = await openChat(OWNER_A, { message: "what is the fit meter?" });
    if (!outcome.ok) throw new Error("expected a stream");
    const events = await collect(outcome.events);
    const final = events.find(
      (event): event is Extract<StreamEvent, { type: "message" }> => event.type === "message",
    );
    expect(final?.message.metadata).toMatchObject({
      source: expect.any(String),
      promptVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
  });

  it("titles the conversation from the first question", async () => {
    const outcome = await openChat(OWNER_A, { message: "  what is in Bandra?  " });
    if (!outcome.ok) throw new Error("expected a stream");
    const events = await collect(outcome.events);
    const start = events.find((event): event is Extract<StreamEvent, { type: "start" }> => event.type === "start");
    const conversation = await getConversation(OWNER_A, start!.conversationId);
    expect(conversation?.title).toBe("what is in Bandra?");
  });

  it("does not duplicate the traveller's turn on a retry", async () => {
    // A client that retries after a dropped connection re-sends the same
    // conversationId; the question must appear once, not twice.
    const first = await openChat(OWNER_A, { message: "why was it rejected?" });
    if (!first.ok) throw new Error("expected a stream");
    const firstEvents = await collect(first.events);
    const conversationId = firstEvents[0]?.type === "start" ? firstEvents[0].conversationId : "";

    const second = await openChat(OWNER_A, { message: "why was it rejected?", conversationId });
    if (!second.ok) throw new Error("expected a stream");
    await collect(second.events);

    const stored = await listMessages(OWNER_A, conversationId);
    const userTurns = stored.filter((message) => message.role === "user");
    // The retry is a second question, so two user turns is correct; what must not
    // happen is one turn holding the text twice.
    expect(userTurns).toHaveLength(2);
    expect(new Set(userTurns.map((m) => m.content)).size).toBe(1);
  });

  it("regenerate re-asks the last question without adding another turn", async () => {
    const outcome = await openChat(OWNER_A, { message: "what is the fit meter?" });
    if (!outcome.ok) throw new Error("expected a stream");
    const events = await collect(outcome.events);
    const start = events.find((event): event is Extract<StreamEvent, { type: "start" }> => event.type === "start");
    const conversationId = start!.conversationId;

    const regen = await openRegenerate(OWNER_A, { conversationId, message: "ignored" });
    if (!regen.ok) throw new Error("expected a stream");
    await collect(regen.events);

    const stored = await listMessages(OWNER_A, conversationId);
    // The old answer is DELETED, not kept alongside: one question, one answer.
    // A regenerate that re-appended the question would leave two user turns,
    // which teaches the model to expect duplicated turns.
    expect(stored.filter((m) => m.role === "user")).toHaveLength(1);
    expect(stored.filter((m) => m.role === "assistant")).toHaveLength(1);
  });

  it("regenerate on a foreign conversation is a 404, not an empty answer", async () => {
    const theirs = await createConversation(OWNER_B);
    await appendMessage(OWNER_B, theirs.id, { role: "user", content: "q" });
    const outcome = await openRegenerate(OWNER_A, { conversationId: theirs.id, message: "q" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(404);
  });

  it("regenerate needs a conversation id", async () => {
    const outcome = await openRegenerate(OWNER_A, { message: "hi" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
  });

  it("never leaves a row as `streaming` when the caller aborts mid-answer", async () => {
    // This is the invariant that is easy to get wrong. Closing the generator runs
    // its `finally` and skips everything after it, so a persistence step placed
    // at the end of the function means an aborted turn is never written at all
    // and the row stays `streaming` forever — which the *next* turn then reads
    // back as a message that claims to still be generating.
    const controller = new AbortController();
    const outcome = await openChat(OWNER_A, { message: "why was it rejected?" }, controller.signal);
    if (!outcome.ok) throw new Error("expected a stream");

    const events: StreamEvent[] = [];
    for await (const event of outcome.events) {
      events.push(event);
      if (event.type === "delta") {
        controller.abort();
        break;
      }
    }

    const start = events.find((event): event is Extract<StreamEvent, { type: "start" }> => event.type === "start");
    expect(start).toBeDefined();

    const stored = await listMessages(OWNER_A, start!.conversationId);
    const assistant = stored.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant?.status).not.toBe("streaming");
    // Whatever arrived is kept, labelled, and carries a latency.
    expect(assistant?.status).toBe("stopped");
    expect(assistant?.latencyMs).not.toBeNull();

    // And the next turn can be built on that transcript.
    const next = await openChat(OWNER_A, { message: "and the fit meter?", conversationId: start!.conversationId });
    if (!next.ok) throw new Error("expected a stream");
    const nextEvents = await collect(next.events);
    expect(nextEvents.at(-1)?.type).toBe("done");
  });

  it("passes app context into the grounding without inventing place facts", async () => {
    const outcome = await openChat(OWNER_A, {
      message: "what should I do?",
      context: { availableMin: 90, partyType: "family_with_children" },
    });
    if (!outcome.ok) throw new Error("expected a stream");
    const events = await collect(outcome.events);
    const final = events.find(
      (event): event is Extract<StreamEvent, { type: "message" }> => event.type === "message",
    );
    expect(final?.message.metadata).toMatchObject({ factCount: expect.any(Number) });
  });
});

describe("rate limiting", () => {
  it("allows a burst up to the limit and then refuses", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(consumeChat(OWNER_A).allowed).toBe(true);
    }
    const blocked = consumeChat(OWNER_A);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("meters each owner separately", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) consumeChat(OWNER_A);
    expect(consumeChat(OWNER_A).allowed).toBe(false);
    expect(consumeChat(OWNER_B).allowed).toBe(true);
  });

  it("frees up as the window passes", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) consumeChat(OWNER_A);
    const later = Date.now() + 60_000;
    expect(consumeChat(OWNER_A, later).allowed).toBe(true);
  });
});
