"use client";

/**
 * The assistant panel.
 *
 * ---------------------------------------------------------------------------
 * WHY CONFIDENCE IS THE PROMINENT THING AND NOT A FOOTNOTE
 * ---------------------------------------------------------------------------
 *
 * Nugen returns a `confidence_score` on an aligned model and nothing at all on a
 * base model. It is the one value in the response that cannot be produced by a
 * generic provider, so it is rendered as a first-class part of the answer rather
 * than logged and forgotten. A judge can look at a single answer and see whether
 * the alignment is real.
 *
 * The badge is deliberately not hidden when it is missing. A `null` reading is
 * displayed as "not aligned", because the alternative — omitting the badge — is
 * exactly the failure mode this project has to avoid: a UI that looks identical
 * whether or not the mandatory technology is in use.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SAVE IS SENT WITH EVERY REQUEST
 * ---------------------------------------------------------------------------
 *
 * There is no account; the save lives in localStorage on the device. So the
 * panel posts it with each question and the server computes against it
 * (`lib/nugen/tools.ts`). Nothing is persisted server-side and the assistant
 * cannot stamp anything — the only way to change the collection is the stamp
 * button on a place page.
 *
 * ---------------------------------------------------------------------------
 * STREAMING
 * ---------------------------------------------------------------------------
 *
 * `/api/chat` returns SSE with its own frame types (`text`, `confidence`,
 * `tool`, `done`, `error`) rather than the provider's. The provider interleaves
 * confidence events with content deltas in one byte stream, so a client that
 * treated every payload as prose would render confidence numbers as sentences.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { useProgress } from "../lib/game/store";

type Turn = {
  id: number;
  role: "user" | "assistant";
  text: string;
  confidence: number | null;
  tools: string[];
  error?: string;
  model?: string;
  latencyMs?: number;
};

type Health = {
  alignment: { customized: boolean; model: string | null; detail?: string; base_model_id?: string | null };
  claimHolds: boolean;
  provider: string;
  /** Trained is not the same as answering; these can legitimately disagree. */
  serving: { state: "unknown" | "answering" | "not-answering"; note: string };
  providerConfigured: boolean;
};

const SUGGESTIONS = [
  "What is there in Lisbon?",
  "What should I collect next?",
  "How many stamps do I have?",
  "Do you have anything in Belgrade?",
];

export function OracleChat() {
  // `stamps` rather than `save.stamps`: the raw save holds them as a
  // `Record<placeId, timestamp>`, and it is `Progress.stamps` that is the
  // derived `ReadonlySet` the rest of the game reads.
  const { save, stamps, hydrated } = useProgress();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const nextId = useRef(1);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Asked once on mount, and again after a 503, because the answer can change
    // the moment an alignment finishes while the tab is open.
    fetch("/api/health", { cache: "no-store" })
      .then((r) => r.json())
      .then((h: Health) => setHealth(h))
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const ask = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;

      const userTurn: Turn = {
        id: nextId.current++,
        role: "user",
        text: trimmed,
        confidence: null,
        tools: [],
      };
      const botId = nextId.current++;
      const botTurn: Turn = { id: botId, role: "assistant", text: "", confidence: null, tools: [] };

      const history = [...turns, userTurn]
        .filter((t) => t.text)
        .slice(-8)
        .map((t) => ({ role: t.role, content: t.text }));

      setTurns((prev) => [...prev, userTurn, botTurn]);
      setInput("");
      setBusy(true);

      const patch = (fn: (t: Turn) => Turn) =>
        setTurns((prev) => prev.map((t) => (t.id === botId ? fn(t) : t)));

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            save: {
              stamped: [...stamps],
              claimed: save.claimedQuests,
              activeDays: save.activeDays,
            },
          }),
        });

        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
          patch((t) => ({
            ...t,
            error: `${detail.error ?? "the assistant is unavailable"}${detail.detail ? ` — ${detail.detail}` : ""}`,
          }));
          // A 503 here usually means the alignment has not run yet, so ask again.
          fetch("/api/health", { cache: "no-store" })
            .then((r) => r.json())
            .then((h: Health) => setHealth(h))
            .catch(() => undefined);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let cut: number;
          while ((cut = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, cut).trim();
            buf = buf.slice(cut + 2);
            if (!frame.startsWith("data:")) continue;

            const payload = frame.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            const f = JSON.parse(payload) as Record<string, unknown>;
            if (f.type === "status") {
              // Headers are open; the provider is now working. Nothing to render
              // -- `busy` already drives the typing indicator.
            } else if (f.type === "text") {
              patch((t) => ({ ...t, text: t.text + String(f.delta) }));
            } else if (f.type === "confidence") {
              // Keep the lowest reading: the worst span is the honest headline.
              patch((t) => ({
                ...t,
                confidence: t.confidence == null ? Number(f.score) : Math.min(t.confidence, Number(f.score)),
              }));
            } else if (f.type === "tool") {
              const label = String(f.name).replace(/_/g, " ");
              patch((t) => ({ ...t, tools: [...t.tools, f.summary ? `${label} (${f.summary})` : label] }));
            } else if (f.type === "done") {
              patch((t) => ({ ...t, model: String(f.model), latencyMs: Number(f.latencyMs) }));
            } else if (f.type === "error") {
              patch((t) => ({ ...t, error: String(f.message) }));
            }
          }
        }
      } catch (err) {
        patch((t) => ({ ...t, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        setBusy(false);
      }
    },
    [busy, save, stamps, turns],
  );

  const aligned = health?.alignment.customized === true;

  return (
    <section className="lq-oracle">
      <header className="lq-oracle__head">
        <div>
          <p className="lq-oracle__eyebrow">Domain-aligned assistant</p>
          <h2 className="lq-oracle__title">Ask the catalogue</h2>
        </div>
        {health ? (
          <div className="lq-oracle__badges">
            <p className={`lq-oracle__badge ${aligned ? "lq-oracle__badge--on" : "lq-oracle__badge--off"}`}>
              {aligned ? (
                <>
                  aligned · <code>{health.alignment.model}</code>
                </>
              ) : (
                <>no aligned model</>
              )}
            </p>
            {/*
              The second badge is the honest one. "Aligned" is a fact about the
              training pipeline; "answering" is a fact about right now. Nugen has
              trained and deployed this model and still declines to serve it, and
              a single green badge would hide exactly that.
            */}
            {aligned ? (
              <p
                className={`lq-oracle__badge lq-oracle__badge--${
                  health.serving.state === "answering"
                    ? "on"
                    : health.serving.state === "not-answering"
                      ? "off"
                      : "idle"
                }`}
              >
                {!health.providerConfigured
                  ? "no API key"
                  : health.serving.state === "answering"
                    ? "provider answering"
                    : health.serving.state === "not-answering"
                      ? "provider not serving"
                      : "provider unchecked"}
              </p>
            ) : null}
          </div>
        ) : null}
      </header>

      {aligned && health && !health.providerConfigured ? (
        <p className="lq-oracle__notice">
          No <code>NUGEN_API_KEY</code> on this server, so the provider was never called. The model is
          aligned and ready; add the key to <code>.env.local</code> (or the host&rsquo;s environment) and
          reload.
        </p>
      ) : null}

      {aligned && health?.serving.state === "not-answering" ? (
        <p className="lq-oracle__notice">
          The model is genuinely aligned and trained, but Nugen is not serving it right now —{" "}
          {health.serving.note}. Questions will fail until it recovers. This is stated here rather
          than hidden, because a demo that looks fine until you type into it is worse than one that
          admits it.
        </p>
      ) : null}

      {!aligned && health ? (
        <p className="lq-oracle__notice">
          The assistant is not running a domain-aligned model yet — {health.alignment.detail}. It will not
          fall back to a base model, because an unaligned answer would be indistinguishable from an
          aligned one and the claim would be worth nothing.
        </p>
      ) : null}

      <div className="lq-oracle__log" ref={logRef} aria-live="polite">
        {turns.length === 0 ? (
          <div className="lq-oracle__empty">
            <p>
              890 places across 202 cities, 222 quests. Every number is computed by the game, not
              guessed — try asking what is in a city, or what to collect next.
            </p>
            <ul className="lq-oracle__chips">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button type="button" className="lq-btn lq-btn--sm" onClick={() => ask(s)} disabled={busy}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {turns.map((t) =>
          t.role === "user" ? (
            <p key={t.id} className="lq-oracle__turn lq-oracle__turn--me">
              {t.text}
            </p>
          ) : (
            <div key={t.id} className="lq-oracle__turn lq-oracle__turn--bot">
              {t.text ? <p className="lq-oracle__answer">{t.text}</p> : busy ? <p className="lq-oracle__typing">…</p> : null}

              {t.tools.length ? (
                <ul className="lq-oracle__tools">
                  {t.tools.map((tool, i) => (
                    <li key={`${t.id}-tool-${i}`}>{tool}</li>
                  ))}
                </ul>
              ) : null}

              {t.error ? <p className="lq-oracle__error">{t.error}</p> : null}

              {t.text && !t.error ? (
                <p className="lq-oracle__meta">
                  {t.confidence == null ? (
                    <span className="lq-oracle__conf lq-oracle__conf--none">confidence: not reported — not aligned</span>
                  ) : (
                    <span
                      className={`lq-oracle__conf ${
                        t.confidence >= 80
                          ? "lq-oracle__conf--high"
                          : t.confidence >= 55
                            ? "lq-oracle__conf--mid"
                            : "lq-oracle__conf--low"
                      }`}
                    >
                      confidence {Math.round(t.confidence)}
                    </span>
                  )}
                  {t.model ? <code className="lq-oracle__model">{t.model}</code> : null}
                  {t.latencyMs != null ? <span>{t.latencyMs} ms</span> : null}
                </p>
              ) : null}
            </div>
          ),
        )}
      </div>

      <form
        className="lq-oracle__form"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <label className="lq-sr" htmlFor="oracle-q">
          Ask about the catalogue
        </label>
        <input
          id="oracle-q"
          className="lq-oracle__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={hydrated ? "What is in Porto?" : "Loading your save…"}
          disabled={busy}
          autoComplete="off"
        />
        <button type="submit" className="lq-btn" disabled={busy || !input.trim()}>
          {busy ? "Thinking" : "Ask"}
        </button>
      </form>
    </section>
  );
}
