# AI Assistant — Architecture

The complete picture: how a message becomes an answer, what happens when things
break, and where the security boundaries are.

---

## 1. The path of one message

```
composer (client)
  │  POST /api/assistant/chat   { conversationId?, message, context? }
  ▼
chat/route.ts
  │  parse JSON ── 400 on malformed
  │  resolveOwner(cookie) ── mints tb_owner if absent
  │  consumeChat(owner) ── 429 with Retry-After
  ▼
orchestration/chat.ts   openChat()
  │  ChatRequest.safeParse ── .strict(), 400 listing every issue
  │  getConversation ── 404 if the id is not yours
  ▼
run()                                   ← an async generator
  │  listMessages        history, owner-scoped
  │  createConversation  if new
  │  appendMessage       the traveller's turn, BEFORE generating
  │  renameConversation  title from the first message
  │
  ├─ grounding.buildGrounding(message, context)
  │     real catalogue → the only facts a reply may state
  │
  ├─ context.assembleContext(history, message, facts)
  │     system prompt · grounding · digest · last 8 turns · user turn
  │
  ├─ provider.selectProvider()          ← per request, not memoised
  │     nugen (key + customized model)  |  deterministic
  │
  ├─ appendMessage(status: "streaming") ← BEFORE the first token
  │
  ├─ yield start                        provenance, before any text
  │
  ├─ for await (delta of provider.stream(request))
  │     screenResponse(delta) → yield delta
  │     on throw: 0 deltas so far → degrade to the offline path
  │                1+ delta so far  → keep the partial, mark it
  │
  └─ finally:                           ← the write lives HERE
        screenResponse(whole reply)
        ungroundedClaim(whole reply)
        updateMessage(status, latency, modelId, metadata)
        log.info("assistant_turn", …)   counts and ids, never content
  ▼
yield message → yield error? → yield done
```

**Why the persistence is in `finally`.** A client that aborts closes the
generator, which runs `finally` and skips everything after it. With the write at
the end of the function, an aborted turn was never written at all and its row sat
at `streaming` forever — and the *next* turn's context assembly then read a
message claiming to still be generating. A test asserts the invariant directly:
`never leaves a row as streaming when the caller aborts mid-answer`.

---

## 2. The provider seam

```
AIProvider { available, metadata(), generate(), stream(), healthCheck() }

  NugenProvider          — the only module that knows Nugen's wire format
  DeterministicProvider  — the offline path
```

Two implementations is what makes the interface worth having rather than
speculative: the orchestrator cannot tell them apart, so the degraded path is
exercised by **every test that does not stub a provider**. `NUGEN_OFF=1` is a
supported mode, not an outage.

### The offline path is a real assistant, not a stub

Nugen's data plane is 502 for every model, so this is currently the path a demo
takes. It reads the *same* assembled messages — same system prompt, same
grounding block, same history — and answers from three sources in order: the
out-of-scope table, the app-topic table, and the grounding block. It streams, on a
timer, because "the offline path returns a whole string" would mean the streaming
route has a branch that only runs in production.

---

## 3. Model resolution — the one rule

```
NUGEN_CUSTOMIZED_MODEL_ID
  → data/reference/nugen/assistant-alignment.json .model_id
  → null  ⇒  deterministic provider
```

**No base-model fallback exists**, anywhere. `NUGEN_BASE_MODEL` records what the
alignment ran against and is read only by the eval harness's baseline arm.

Without this, a demo would look identical whether or not the alignment job had
ever run, and the central claim of the brief would be unfalsifiable. With it,
`GET /api/assistant/health` answers the question in one `curl`.

---

## 4. Context management

```
system prompt (PROMPT_VERSION 1.0.0)
+ grounding block          ← catalogue facts, or an explicit "you know nothing"
+ rolling summary          ← only once history exceeds the budget
+ last 8 raw turns
+ the new user turn
```

**The digest is mechanical, not a model call.** Three reasons, in order of weight:
it costs nothing on the hot path; it cannot be steered by whoever wrote the
earlier turns; and its output is inspectable, so a test can assert on it. An LLM
summariser would let a user inject an instruction into their own history and have
it promoted into the context the model treats as authoritative.

**User content is never concatenated into a system message.** It arrives as its
own `user` turn. There is no code path in this feature that splices a traveller's
words into a system message, which makes injection resistance a structural
property rather than a property of the prompt's wording. A stored `system` row in
history is dropped for the same reason.

Budget: 8 turns, 6,000 characters, evicting from the oldest end so the newest
context is always the one kept.

---

## 5. Grounding — the supply side of honesty

The system prompt says *"never state a price not in the grounding block"*. A rule
in a prompt is a **request**. `grounding.ts` is the **supply**: if a fact is not
there, there is nothing to quote, so hallucinating requires inventing a number
outright rather than misremembering one.

Facts come from `src/app/_lib/catalogue.ts` — the same validated catalogue the
planner searches, not a second copy and not a model-written summary. Every fact is
assembled from contract fields, so `pricePerPerson: null` produces *"price not
listed"* rather than a fact that omits the price and lets the gap read as zero.

`factFor()` emits at most one claim per sentence, so a reader can check any single
assertion in isolation.

---

## 6. Streaming

SSE, not WebSocket. The traffic is one-directional (the question is in the request
body; the client only reads afterwards), SSE is plain HTTP so it survives proxies
and serverless without an upgrade handshake, and a dropped connection is
recoverable by re-sending rather than by reimplementing a resume protocol.

| Frame | Meaning |
|---|---|
| `start` | `conversationId`, `messageId`, `model`, `source` — provenance before the first token |
| `delta` | a piece of the reply |
| `message` | the persisted, final row |
| `error` | mid-stream failure, with whether a retry is worth it |
| `done` | total latency |

**Client-side:** `fetch` + a hand-read stream, because `EventSource` cannot POST
and this needs to. That also gives `AbortController`, which is what makes "stop"
instant rather than a request that runs to completion server-side.

**Retry never duplicates the traveller's message.** The user turn is appended on
the server on the first call only; `?regenerate=1` re-asks the last question
*without* re-appending it. A regenerate that re-added the question would put two
copies in the history the model reads, teaching it to expect duplicates.

---

## 7. Voice

```
Mic → SpeechRecognition → transcript → orchestrator → reply → speechSynthesis
```

`SpeechToTextProvider` / `TextToSpeechProvider` in `voice.ts` are the seams, and
the UI only calls them — swapping in a server-side provider touches that one file.

**Why browser-native:** no audio leaves the device for transcription, no second
secret to protect, no per-minute bill, no third party to be down during a demo.
The cost, stated plainly: Firefox has no `SpeechRecognition` at all, so the mic
button is **disabled with a visible reason** rather than hidden, and typing works
everywhere.

State machine, with a text label and a text hint for every state — a dot changing
colour is not an accessible status:

```
idle → listening → processing → speaking → idle
        ↓            ↓
      error ─────────┴────────→ idle
```

`continuous: false` deliberately: a continuously-listening recogniser picks up the
assistant reading its own answer and turns a conversation into a feedback loop.
TTS carries a bounded backstop because Safari fires neither `onend` nor `onerror`
when a tab is backgrounded, which would otherwise strand the UI in "speaking".

---

## 8. Security

| Concern | Where it is handled |
|---|---|
| **Secret isolation** | `NUGEN_API_KEY` read in exactly **one** module. A test walks the import graph from every `"use client"` file and asserts none reaches `provider/config.ts`. Verified against the build: the key, all `NUGEN_*` names and `api.nugen.in` are **absent from all 37 client chunks**. |
| **Cross-user access** | Structural. Every message read/write takes `ownerId`; `updateMessage` resolves the parent conversation through an owner-scoped subquery, so a guessed message id matches no row. Not-found and not-yours return the same 404. |
| **Owner id storage** | `sha256(cookie secret)`. A database dump cannot be replayed as a live session. |
| **Prompt injection** | User content is never concatenated into a system message; stored `system` rows are dropped; the digest is mechanical. |
| **XSS** | `Markdown.tsx` never calls `dangerouslySetInnerHTML`. `href` goes through a scheme allowlist (`links.ts`); `javascript:`, `data:`, `vbscript:` are refused and the words render as plain text. |
| **Model-output markup** | `screenResponse` strips `script`/`iframe`/`on*=`/`javascript:`. Run on **each delta and the assembled reply** — `<scr` + `ipt>` is a real bypass of a per-delta check. |
| **Prompt leakage** | A reply reciting the system instructions is withheld and replaced. |
| **Hallucination tripwire** | `ungroundedClaim` flags a price or clock time asserted with no grounding fact. Heuristic, and documented as one. |
| **Oversized input** | 4,000 chars, ~1,000 tokens. Also where per-call cost stops being free. |
| **Strict bodies** | `ChatRequest` is `.strict()` — a typo'd key is rejected, not silently dropped. |
| **Rate limiting** | 20/min **and** burst 5/10s, per owner. Two limits because they stop different things: the burst stops a client retrying on a 502, which spends a paid call per attempt. |
| **Logs** | `src/llm/log.ts` (existing, has secret redaction). Assistant logs carry counts, ids, model names and statuses — never message content. |
| **Health payload** | The provider builds its own headers and never stores them, so there is no field that could hold a key. |
| **Control chars** | Stripped on input, including zero-width — invisible in a terminal *and* in a screenshot, which makes them a review-evasion vector. |

### Known limitations, not hidden

- **No accounts.** Ownership is a cookie capability token. Clearing cookies starts
  a new history. That is the cost of not having auth, and the app's own metadata
  says it is keyless on purpose.
- **In-memory rate limits.** Per-process, so with N instances the effective limit
  is N×. Correct for one process, which is every way this is deployed today. The
  interface is one file's change from Redis.
- **The grounding block is in the prompt.** So a determined injection can try to
  contradict it. The output screening and the tripwire are the backstop, not a
  guarantee.

---

## 9. Observability

`log.info("assistant_turn", …)` — request id, owner fingerprint (12 hex chars),
source, model id, status, latency, fact count, char count, error. No content.

`GET /api/assistant/health` — provider, configured, model, `customized`, status,
detail, prompt version, timestamp. `?deep=1` makes a one-token call to separate
*"a model is configured"* from *"the provider is answering"*. Returns **200 even
when degraded**: the assistant is working, on the offline path, and a 503 would
tell a monitor the product is down.

---

## 10. Data model

```
assistant_conversation
  id, owner_id, title, created_at, updated_at, metadata
  idx (owner_id, updated_at DESC)          ← the sidebar query, no join

assistant_message
  id, conversation_id → conversation.id ON DELETE CASCADE
  role, content, status, created_at, model_id, token_usage, latency_ms, metadata
  idx (conversation_id, created_at)
```

`status` is why a truncated answer is distinguishable from a short one:
`streaming` is written before the first token and rewritten in `finally` to
`complete` / `stopped` / `error`. The UI renders the difference; a silent
truncation is indistinguishable from a finished reply.

---

## 11. Deliberate non-goals

- **No `react-markdown`.** A large transitive tree whose main risk is
  `rehype-raw` — the exact thing being guarded. ~80 lines of auditable renderer
  that never touches `dangerouslySetInnerHTML` is the better trade, and it makes
  "no raw HTML" a property of the code rather than a configuration.
- **No embedding retrieval for grounding.** 4,596 rows with keyword + category +
  neighbourhood scoring, deterministic and free. At this size it is not the
  bottleneck; a 3B model's attention over a long context is.
- **No judge model in the eval.** A rubric nobody wrote down is worse than no
  number. See `docs/AI_MODEL_EVALUATION.md`.
- **No prompt-injection "defence" in the prompt.** Structural separation plus
  output screening, not a paragraph asking the model to resist.
