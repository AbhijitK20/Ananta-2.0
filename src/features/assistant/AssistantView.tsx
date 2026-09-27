"use client";

/**
 * The assistant surface: sidebar, transcript, composer, voice.
 *
 * One file, and the reason is that every part of it shares the same state object
 * from `useAssistant()`. Splitting it across four files would mean threading a
 * dozen props through three layers to no benefit — the rule of thumb is one file
 * per independent state machine, and there is one here.
 *
 * ## Decisions worth knowing about
 *
 * **The provenance badge is always visible.** Every reply says which provider
 * answered, and the header names the model. A demo that cannot be distinguished
 * from a prompt wrapped around a base model is not evidence of anything, so the
 * thing the brief asks to be verifiable is made visible rather than asserted.
 *
 * **Stop is a real abort.** The button aborts the fetch, the server sees the same
 * signal, and the partial answer is kept and labelled "stopped" rather than
 * discarded — throwing away half an answer the traveller read is worse than
 * showing it honestly.
 *
 * **A stopped or errored message says so and offers a retry**, because a
 * truncated reply that looks complete is the single most misleading thing a chat
 * UI can do.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Mic,
  MicOff,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet } from "@/components/ui/Overlays";
import { cn } from "@/components/cn";

import { Markdown } from "./Markdown";
import { useAssistant, type AppContext } from "./useAssistant";
import {
  VOICE_HINT,
  VOICE_LABEL,
  browserSpeechToText,
  browserTextToSpeech,
  nextVoiceState,
  type SpeechToTextProvider,
  type TextToSpeechProvider,
  type VoiceState,
} from "./voice";
import type { Message } from "./types";
import { MAX_MESSAGE_CHARS } from "./orchestration/safety";

const SUGGESTIONS = [
  "What is there in Bandra?",
  "Why was a stop rejected?",
  "We have 90 minutes and it is raining",
  "What does the fit meter actually mean?",
] as const;

export interface AssistantViewProps {
  /** App state the traveller is looking at, passed to the assistant as grounding. */
  context?: AppContext;
}

export function AssistantView({ context }: AssistantViewProps) {
  const chat = useAssistant();
  const [drawer, setDrawer] = useState(false);
  const [voice, setVoice] = useState<VoiceState>("idle");
  const [interim, setInterim] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Built once. `useMemo` with no deps would rebuild on every render and drop a
  // recognition session mid-sentence.
  const stt = useMemo<SpeechToTextProvider>(() => browserSpeechToText(), []);
  const tts = useMemo<TextToSpeechProvider>(() => browserTextToSpeech(), []);

  const busy = chat.state === "streaming";
  const listEnd = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Follow the stream, but only while one is running: scrolling on every render
  // yanks the view out from under someone who has scrolled up to read.
  useEffect(() => {
    if (busy) listEnd.current?.scrollIntoView({ block: "end" });
  }, [busy, chat.messages]);

  // Stop speech if the component goes away, or a new answer starts talking over.
  useEffect(() => () => tts.cancel(), [tts]);

  const send = useCallback(
    (text: string, regenerate = false) => {
      tts.cancel();
      setSpeakingId(null);
      void chat.send(text, { regenerate, ...(context ? { context } : {}) });
    },
    [chat, context, tts],
  );

  const toggleVoice = useCallback(() => {
    if (voice === "listening") {
      stt.stop();
      setVoice("processing");
      return;
    }
    if (!stt.supported) {
      setVoice("error");
      return;
    }
    tts.cancel();
    setSpeakingId(null);
    setInterim("");
    setVoice(nextVoiceState(voice, "start"));
    stt.start(
      (partial) => setInterim(partial),
      (final) => {
        setInterim("");
        setVoice("processing");
        if (final.length > 0) send(final);
        else setVoice("idle");
      },
    );
  }, [send, stt, tts, voice]);

  const speak = useCallback(
    (message: Message) => {
      if (!tts.supported || message.content.length === 0) return;
      tts.cancel();
      setSpeakingId(message.id);
      setVoice(nextVoiceState(voice, "speaking"));
      tts.speak(message.content, () => {
        setSpeakingId(null);
        setVoice((current) => nextVoiceState(current, "end"));
      });
    },
    [tts, voice],
  );

  const copy = useCallback(async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // Clipboard access is refused in some contexts and there is nothing useful
      // to say about it. The text is on screen and selectable.
    }
  }, []);

  const source = chat.status?.source;
  const modelLabel =
    source === "nugen-customized" ? (chat.status?.model ?? "customized model") : "offline answer path";

  return (
    <div className="mx-auto flex h-[calc(100dvh-var(--space-16))] w-full max-w-[90rem] gap-4 px-4 py-4">
      {/* ---------------- sidebar ---------------- */}
      <aside className="hidden w-72 shrink-0 flex-col gap-3 lg:flex">
        <Sidebar {...chat} renaming={renaming} renameDraft={renameDraft} setRenaming={setRenaming} setRenameDraft={setRenameDraft} />
      </aside>

      {/* ---------------- transcript ---------------- */}
      <section className="flex min-w-0 flex-1 flex-col rounded-lg border border-rule bg-surface">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-rule px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            iconLeft={<Plus aria-hidden className="size-4" />}
            aria-label="New conversation"
            onClick={chat.startNew}
          />
          <h1 className="text-body font-medium text-ink">TravelBuddy assistant</h1>

          {/* The provenance badge. Always present, including on the offline path,
              because "which model answered" is the first question and hiding the
              answer is how a demo ends up claiming something it did not do. */}
          <Badge tone={source === "nugen-customized" ? "fit" : "warn"}>
            {source === undefined ? "checking" : source === "nugen-customized" ? "aligned model" : "offline path"}
          </Badge>

          <span className="truncate font-data text-meta-sm text-ink-muted" title={modelLabel}>
            {modelLabel}
          </span>
          {chat.status?.promptVersion ? (
            <span className="font-data text-meta-sm text-ink-faint">prompt {chat.status.promptVersion}</span>
          ) : null}

          <span className="ml-auto">
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              iconLeft={<Menu aria-hidden className="size-4" />}
              onClick={() => setDrawer(true)}
            >
              Chats
            </Button>
          </span>
        </header>

        {chat.status?.source === "deterministic" && chat.status.detail ? (
          <p
            role="status"
            className="border-b border-rule bg-warn-soft px-4 py-2 text-meta text-ink"
          >
            Answering without a model: {chat.status.detail}. The assistant is fully usable; it just
            is not being generated right now.
          </p>
        ) : null}

        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          role="log"
          aria-live="polite"
          aria-relevant="additions text"
          aria-label="Conversation"
        >
          {chat.messages.length === 0 ? (
            <EmptyState
              kind="no_data"
              title="Ask about your time, your budget, or how the app works."
              body="The assistant answers from this app's own catalogue. If it does not have a fact, it will say so rather than guess."
              suggestions={SUGGESTIONS}
              onSuggestion={(suggestion) => send(suggestion)}
            />
          ) : (
            <div className="space-y-4">
              {chat.messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  speaking={speakingId === message.id}
                  copied={copiedId === message.id}
                  ttsSupported={tts.supported}
                  onCopy={() => void copy(message)}
                  onSpeak={() => speak(message)}
                  onRegenerate={() => send(message.content, true)}
                />
              ))}
              {interim.length > 0 ? (
                <p className="text-meta italic text-ink-muted" role="status">
                  {interim}
                </p>
              ) : null}
              <div ref={listEnd} />
            </div>
          )}
        </div>

        {chat.error ? (
          <div
            role="alert"
            className="flex items-start gap-2 border-t border-rule bg-alarm-soft px-4 py-2 text-meta text-ink"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-alarm" />
            <span className="min-w-0 flex-1">{chat.error}</span>
            <Button variant="quiet" size="sm" onClick={() => chat.setError(null)} aria-label="Dismiss">
              <X aria-hidden className="size-4" />
            </Button>
          </div>
        ) : null}

        {/* ---------------- composer ---------------- */}
        <form
          className="border-t border-rule px-3 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            const text = chat.draft.trim();
            if (text.length > 0 && !busy) send(text);
          }}
        >
          <div className="flex items-end gap-2">
            <label className="sr-only" htmlFor="assistant-composer">
              Your message
            </label>
            <textarea
              id="assistant-composer"
              ref={textarea}
              value={chat.draft}
              onChange={(event) => chat.setDraft(event.target.value.slice(0, MAX_MESSAGE_CHARS))}
              onKeyDown={(event) => {
                // Enter sends, Shift+Enter breaks the line. A chat box where Enter
                // inserts a newline is a notes app; one where it never breaks the
                // line is unusable on a phone.
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const text = chat.draft.trim();
                  if (text.length > 0 && !busy) send(text);
                }
              }}
              rows={1}
              placeholder="Ask about your hours, your budget, or how the app works."
              aria-describedby="composer-hint"
              className="max-h-40 min-h-11 w-full resize-y rounded-md border border-rule bg-canvas px-3 py-2.5 text-body text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />

            {busy ? (
              <Button
                type="button"
                variant="danger"
                iconOnly
                aria-label="Stop generating"
                iconLeft={<Square aria-hidden className="size-4 fill-current" />}
                onClick={chat.stop}
              />
            ) : (
              <Button
                type="button"
                variant="ghost"
                iconOnly
                aria-label={voice === "listening" ? "Stop listening" : "Speak your message"}
                aria-pressed={voice === "listening"}
                disabled={!stt.supported}
                title={stt.supported ? VOICE_HINT[voice] : stt.reason}
                className={cn(voice === "listening" && "border-alarm text-alarm")}
                iconLeft={
                  stt.supported ? (
                    <Mic aria-hidden className={cn("size-4", voice === "listening" && "text-alarm")} />
                  ) : (
                    <MicOff aria-hidden className="size-4 opacity-45" />
                  )
                }
                onClick={toggleVoice}
              />
            )}

            <Button
              type="submit"
              variant="primary"
              loading={busy}
              loadingLabel="Thinking"
              disabled={chat.draft.trim().length === 0}
            >
              Send
            </Button>
          </div>

          {/* The state is text as well as colour, so it is available to a screen
              reader and to anyone who cannot tell the states apart. */}
          <div
            id="composer-hint"
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta-sm text-ink-muted"
            role="status"
            aria-live="polite"
          >
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-pill",
                  voice === "listening" && "bg-alarm",
                  voice === "processing" && "bg-warn",
                  voice === "speaking" && "bg-accent",
                  voice === "error" && "bg-alarm",
                  voice === "idle" && "bg-rule",
                )}
              />
              {VOICE_LABEL[voice]}
              <span className="text-ink-faint">— {VOICE_HINT[voice]}</span>
            </span>
            {busy ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 aria-hidden className="size-3 animate-spin" />
                Generating
              </span>
            ) : null}
            <span className="text-ink-faint">
              {chat.draft.length}/{MAX_MESSAGE_CHARS} · Enter to send, Shift+Enter for a new line
            </span>
          </div>
        </form>
      </section>

      {/* ---------------- mobile drawer ---------------- */}
      <Sheet open={drawer} onOpenChange={setDrawer} title="Conversations" label="Conversation list">
        <div className="flex h-full min-h-0 w-[min(20rem,85vw)] flex-col">
          <Sidebar
            {...chat}
            renaming={renaming}
            renameDraft={renameDraft}
            setRenaming={setRenaming}
            setRenameDraft={setRenameDraft}
            onPicked={() => setDrawer(false)}
          />
        </div>
      </Sheet>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

type SidebarProps = ReturnType<typeof useAssistant> & {
  renaming: string | null;
  renameDraft: string;
  setRenaming: (id: string | null) => void;
  setRenameDraft: (value: string) => void;
  onPicked?: () => void;
};

function Sidebar({
  conversations,
  conversationId,
  search,
  setSearch,
  open,
  startNew,
  remove,
  rename,
  loading,
  renaming,
  renameDraft,
  setRenaming,
  setRenameDraft,
  onPicked,
}: SidebarProps) {
  return (
    <>
      <Button variant="primary" fullWidth iconLeft={<Plus aria-hidden className="size-4" />} onClick={() => { startNew(); onPicked?.(); }}>
        New conversation
      </Button>

      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
        <label className="sr-only" htmlFor="assistant-search">
          Search conversations
        </label>
        <input
          id="assistant-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search"
          className="min-h-11 w-full rounded-md border border-rule bg-canvas pl-9 pr-3 text-body text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      </div>

      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <p className="px-1 py-2 text-meta text-ink-muted">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="px-1 py-2 text-meta text-ink-muted">
            {search ? `Nothing matches “${search}”.` : "No conversations yet."}
          </p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conversation) => {
              const active = conversation.id === conversationId;
              return (
                <li key={conversation.id}>
                  {renaming === conversation.id ? (
                    <form
                      className="flex gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename(conversation.id, renameDraft);
                        setRenaming(null);
                      }}
                    >
                      <label className="sr-only" htmlFor={`rename-${conversation.id}`}>
                        Conversation name
                      </label>
                      <input
                        id={`rename-${conversation.id}`}
                        autoFocus
                        value={renameDraft}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        className="min-h-9 w-full rounded-sm border border-accent bg-canvas px-2 text-meta text-ink focus:outline-none"
                      />
                      <Button type="submit" variant="quiet" size="sm" aria-label="Save name">
                        <Check aria-hidden className="size-4" />
                      </Button>
                    </form>
                  ) : (
                    <div
                      className={cn(
                        "group flex items-center gap-1 rounded-md border px-2",
                        active ? "border-accent bg-accent-soft" : "border-transparent hover:bg-accent-soft",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void open(conversation.id);
                          onPicked?.();
                        }}
                        aria-current={active ? "true" : undefined}
                        className="min-h-11 min-w-0 flex-1 truncate py-1 text-left text-meta text-ink"
                      >
                        {conversation.title || "New chat"}
                      </button>
                      <Button
                        variant="quiet"
                        size="sm"
                        iconOnly
                        aria-label={`Rename ${conversation.title || "conversation"}`}
                        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => {
                          setRenaming(conversation.id);
                          setRenameDraft(conversation.title);
                        }}
                      >
                        <Pencil aria-hidden className="size-3.5" />
                      </Button>
                      <Button
                        variant="quiet"
                        size="sm"
                        iconOnly
                        aria-label={`Delete ${conversation.title || "conversation"}`}
                        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 hover:text-alarm"
                        onClick={() => void remove(conversation.id)}
                      >
                        <Trash2 aria-hidden className="size-3.5" />
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </>
  );
}

// ---------------------------------------------------------------------------
// One message
// ---------------------------------------------------------------------------

interface MessageRowProps {
  message: Message;
  speaking: boolean;
  copied: boolean;
  ttsSupported: boolean;
  onCopy: () => void;
  onSpeak: () => void;
  onRegenerate: () => void;
}

function MessageRow({
  message,
  speaking,
  copied,
  ttsSupported,
  onCopy,
  onSpeak,
  onRegenerate,
}: MessageRowProps) {
  const mine = message.role === "user";
  const streaming = message.status === "streaming";
  const meta = message.metadata as {
    source?: string;
    modelId?: string;
    promptVersion?: string;
    latencyMs?: number;
    note?: string;
  };
  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <article
      aria-label={mine ? "You said" : "Assistant said"}
      className={cn("group flex flex-col gap-1", mine ? "items-end" : "items-start")}
    >
      <div
        className={cn(
          "max-w-[min(46rem,100%)] rounded-lg border px-3.5 py-2.5",
          mine ? "border-accent bg-accent-soft text-ink" : "border-rule bg-canvas text-ink",
        )}
      >
        {mine ? (
          <p className="whitespace-pre-wrap break-words text-body">{message.content}</p>
        ) : streaming && message.content.length === 0 ? (
          <p className="flex items-center gap-2 text-meta text-ink-muted" role="status">
            <Loader2 aria-hidden className="size-4 animate-spin" />
            Thinking
          </p>
        ) : (
          <Markdown>{message.content}</Markdown>
        )}

        {streaming && message.content.length > 0 ? (
          <span aria-hidden className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-text-bottom" />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-meta-sm text-ink-faint">
        <time dateTime={message.createdAt}>{time}</time>

        {mine ? null : (
          <>
            {message.status === "stopped" ? <Badge tone="warn">stopped early</Badge> : null}
            {message.status === "error" ? <Badge tone="alarm">failed</Badge> : null}
            {meta.source === "deterministic" ? <span>offline answer path</span> : null}
            {meta.modelId ? <span className="font-data">{meta.modelId}</span> : null}
            {meta.latencyMs !== undefined ? <span>{meta.latencyMs} ms</span> : null}
          </>
        )}

        {mine ? null : (
          <span className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-[:focus-visible]:opacity-100">
            <Button variant="quiet" size="sm" onClick={onCopy} aria-label={copied ? "Copied" : "Copy reply"}>
              {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
            </Button>
            {ttsSupported ? (
              <Button
                variant="quiet"
                size="sm"
                onClick={onSpeak}
                aria-label={speaking ? "Stop reading" : "Read aloud"}
                aria-pressed={speaking}
              >
                {speaking ? <Square aria-hidden className="size-3" fill="currentColor" /> : <Volume2 aria-hidden className="size-3.5" />}
              </Button>
            ) : null}
            <Button variant="quiet" size="sm" onClick={onRegenerate} aria-label="Ask again">
              <RefreshCw aria-hidden className="size-3.5" />
            </Button>
          </span>
        )}
      </div>
    </article>
  );
}

/** Imported here so the sidebar's "Chats" button has an icon without a second import block. */
function Menu(props: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden {...props}>
      <path d="M3 5h14M3 10h14M3 15h14" strokeLinecap="round" />
    </svg>
  );
}
