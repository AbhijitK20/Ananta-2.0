"use client";

/**
 * The chat client: state, the SSE reader, and the request lifecycle.
 *
 * `fetch` + a hand-read stream rather than `EventSource`, because `EventSource`
 * cannot issue a POST and this conversation needs one — the question is a request
 * body, not a URL. That also gives us `AbortController`, which is what makes
 * "stop generating" instant rather than a request that runs to completion
 * server-side.
 *
 * ## The rule this file exists to enforce
 *
 * **The user's message is added once, on submit, and never again.** Every failure
 * mode below — a network error, a 429, a stream that dies mid-answer — retries
 * by re-sending the *same* conversation, and the server appends the traveller's
 * turn only on the first call. `regenerate` is a different endpoint mode for the
 * same reason: it re-asks the last question without re-adding it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { Conversation, Message, StreamEvent } from "./types";
import { MAX_MESSAGE_CHARS } from "./orchestration/safety";

export type AssistantStatus = {
  source: "nugen-customized" | "deterministic";
  model: string | null;
  customized: boolean;
  promptVersion: string;
  detail: string;
};

export type ChatState = "idle" | "streaming" | "error";

export type AppContext = {
  city?: string;
  neighbourhood?: string;
  availableMin?: number;
  budgetMinor?: number;
  partyType?: string;
  stopCount?: number;
  planId?: string;
};

const CHAT_URL = "/api/assistant/chat";
const CONVERSATIONS_URL = "/api/assistant/conversations";

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Request failed (${response.status}).`;
  } catch {
    return `Request failed (${response.status}).`;
  }
}

/** Parse an SSE body into events. Same frame rules as the server's `readSseDeltas`. */
export async function* readEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
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
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          try {
            yield JSON.parse(payload) as StreamEvent;
          } catch {
            // A truncated frame is skipped rather than thrown on: the answer so
            // far is still worth showing.
          }
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function useAssistant() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<ChatState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const abortRef = useRef<AbortController | null>(null);
  /** The assistant row being filled in, so a delta knows which one to append to. */
  const streamingIdRef = useRef<string | null>(null);

  const refresh = useCallback(async (query = "") => {
    try {
      const response = await fetch(
        `${CONVERSATIONS_URL}?limit=100${query ? `&search=${encodeURIComponent(query)}` : ""}`,
      );
      if (!response.ok) return;
      const body = (await response.json()) as { conversations: Conversation[] };
      setConversations(body.conversations);
    } catch {
      // A failed sidebar load is not worth an error banner: the chat still works,
      // it just cannot show history. The empty list is the honest rendering.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/assistant/health");
        if (response.ok) setStatus((await response.json()) as AssistantStatus);
      } catch {
        // Unreachable health is not an error the traveller can act on.
      }
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  // Debounced search, so typing in the sidebar does not fire a request per key.
  useEffect(() => {
    const timer = setTimeout(() => void refresh(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search, refresh]);

  const open = useCallback(async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`${CONVERSATIONS_URL}?id=${encodeURIComponent(id)}&messages=1`);
      if (!response.ok) {
        setError(await readError(response));
        return;
      }
      const body = (await response.json()) as { conversation: Conversation; messages: Message[] };
      setConversationId(body.conversation.id);
      setMessages(body.messages);
    } catch {
      setError("Could not open that conversation.");
    }
  }, []);

  const startNew = useCallback(() => {
    abortRef.current?.abort();
    setConversationId(null);
    setMessages([]);
    setError(null);
    setState("idle");
    streamingIdRef.current = null;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`${CONVERSATIONS_URL}?id=${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!response.ok) {
          setError(await readError(response));
          return;
        }
        if (id === conversationId) startNew();
        await refresh(search.trim());
      } catch {
        setError("Could not delete that conversation.");
      }
    },
    [conversationId, refresh, search, startNew],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      try {
        const response = await fetch(CONVERSATIONS_URL, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, title }),
        });
        if (response.ok) await refresh(search.trim());
      } catch {
        setError("Could not rename that conversation.");
      }
    },
    [refresh, search],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Send, or re-send the last question.
   *
   * `regenerate` passes no message: the server keeps the traveller's turns and
   * re-asks the last one. Sending it here as well is how a conversation ends up
   * with the same question three times.
   */
  const send = useCallback(
    async (text: string, options: { regenerate?: boolean; context?: AppContext } = {}) => {
      const question = text.trim();
      if (question.length === 0) return;
      if (!options.regenerate && question.length > MAX_MESSAGE_CHARS) {
        setError(`That is ${question.length} characters. The limit is ${MAX_MESSAGE_CHARS}.`);
        return;
      }

      setError(null);
      setState("streaming");
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (options.regenerate) {
        setMessages((current) => current.filter((message) => message.role !== "assistant"));
      } else {
        // The one place the traveller's turn enters the UI.
        const optimistic: Message = {
          id: `local-${Date.now()}`,
          conversationId: conversationId ?? "",
          role: "user",
          content: question,
          status: "complete",
          createdAt: new Date().toISOString(),
          modelId: null,
          tokenUsage: null,
          latencyMs: null,
          metadata: {},
        };
        setMessages((current) => [...current, optimistic]);
        setDraft("");
      }

      const url = `${CHAT_URL}${options.regenerate ? "?regenerate=1" : ""}`;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(conversationId ? { conversationId } : {}),
            message: question,
            ...(options.context ? { context: options.context } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          setState("error");
          setError(await readError(response));
          if (!options.regenerate) {
            // Nothing was generated, so the optimistic turn is the only record of
            // what was asked. Removing it would lose the traveller's question.
            setMessages((current) => current);
          }
          return;
        }
        if (!response.body) {
          setState("error");
          setError("The server sent an empty response.");
          return;
        }

        for await (const event of readEvents(response.body, controller.signal)) {
          switch (event.type) {
            case "start":
              setConversationId(event.conversationId);
              streamingIdRef.current = event.messageId;
              setMessages((current) => [
                ...current,
                {
                  id: event.messageId,
                  conversationId: event.conversationId,
                  role: "assistant",
                  content: "",
                  status: "streaming",
                  createdAt: new Date().toISOString(),
                  modelId: event.model,
                  tokenUsage: null,
                  latencyMs: null,
                  metadata: { source: event.source },
                },
              ]);
              break;
            case "delta":
              setMessages((current) =>
                current.map((message) =>
                  message.id === streamingIdRef.current
                    ? { ...message, content: message.content + event.text }
                    : message,
                ),
              );
              break;
            case "message":
              setMessages((current) =>
                current.map((message) => (message.id === event.message.id ? event.message : message)),
              );
              streamingIdRef.current = null;
              break;
            case "error":
              setError(event.message);
              break;
            case "done":
              setState("idle");
              break;
          }
        }

        // The stream ended without a `done` — a dropped connection, most likely.
        if (streamingIdRef.current) {
          setMessages((current) =>
            current.map((message) =>
              message.id === streamingIdRef.current
                ? { ...message, status: message.content.length > 0 ? "stopped" : "error" }
                : message,
            ),
          );
          streamingIdRef.current = null;
          setError("The connection dropped part-way. The answer above is what arrived.");
        }
        setState((current) => (current === "streaming" ? "idle" : current));
        void refresh(search.trim());
      } catch (caught) {
        if (controller.signal.aborted) {
          // A deliberate stop. Whatever arrived is kept and labelled, which is
          // what the server persisted too.
          setMessages((current) =>
            current.map((message) =>
              message.id === streamingIdRef.current
                ? { ...message, status: message.content.length > 0 ? "stopped" : "error" }
                : message,
            ),
          );
          streamingIdRef.current = null;
          setState("idle");
          return;
        }
        setState("error");
        setError(
          caught instanceof Error && caught.message.length > 0
            ? `Could not reach the assistant: ${caught.message}`
            : "Could not reach the assistant.",
        );
      }
    },
    [conversationId, refresh, search],
  );

  /** The last traveller turn, which is what a regenerate re-asks. */
  const lastQuestion = useCallback((): string | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "user") return message.content;
    }
    return null;
  }, [messages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  return {
    conversations,
    conversationId,
    messages,
    draft,
    setDraft,
    state,
    error,
    setError,
    status,
    search,
    setSearch,
    loading,
    open,
    startNew,
    remove,
    rename,
    stop,
    send,
    lastQuestion,
  };
}
