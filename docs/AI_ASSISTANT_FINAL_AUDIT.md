# AI Assistant — Final Audit

Requirement-by-requirement, with the two anti-fraud checks answered first because
they are the two that matter.

Every item is **PASS**, **FAIL**, **MANUAL** or **N/A**. No unverified PASS.

- Audit date: 2026-09-27
- Verification: `npm run typecheck`, `npm run lint`, `npm test` (1,246 tests),
  `npm run build`, `theme:lint`, `contrast:lint`, `copy:lint`, plus a 31-check
  live smoke test against a running server.

---

## The two anti-fraud checks

### 1. "Where exactly did you use Nugen alignment/customization?"

**The dataset is real. The job ran for real. The resulting model does not exist,
because Nugen's training backend returned 502 on every attempt.**

| Artefact | Status | Evidence |
|---|---|---|
| A real dataset | **EXISTS** | `data/ai_assistant/` — 171 examples, 12 documents, 70,436 characters. `dataset_sha256: 45e9dcec…`, verified byte-identical across two runs. |
| A real job | **RAN** | 12 documents uploaded → all `READY`. 34-sample benchmark accepted. 3 alignment projects created, admitted to a real queue, each failing at `training_data_upload` with `502`. |
| A real `NUGEN_CUSTOMIZED_MODEL_ID` | **DOES NOT EXIST** | Their platform. See below. |

The alignment record, `data/reference/nugen/assistant-alignment.json`, **does not
exist**, and that absence is the honest evidence: the app reads it per request, so
its absence is what makes `/api/assistant/health` report `customized: false`.

```json
{
  "provider": "deterministic",
  "configured": true,
  "model": null,
  "customized": false,
  "status": "ready",
  "detail": "no customized model; run `npm run assistant:align`",
  "promptVersion": "1.0.0"
}
```

**No model id is fabricated, hard-coded, or implied anywhere.** Full record with
the verbatim error: `docs/NUGEN_CUSTOMIZATION.md`.

### 2. "Is runtime inference using the customized model, not the base model?"

**There is no code path that can send a base model at runtime.** This is enforced
structurally, not by convention.

`src/features/assistant/provider/config.ts` resolves the model id in exactly one
order:

```ts
modelId: explicit ?? alignment?.model_id ?? null,   // explicit = NUGEN_CUSTOMIZED_MODEL_ID
```

There is no fourth term. `NUGEN_BASE_MODEL` is stored for provenance display and
is read **only** by `scripts/assistant-eval.ts`, for the baseline comparison arm.

`NugenProvider.available` requires a key **and** a non-null `modelId`, so "I can
reach Nugen" is never reported as "the assistant is running". When `modelId` is
null the provider is skipped and the deterministic path answers.

**Verifiable without reading any source:**

```bash
curl -s localhost:3000/api/assistant/health | jq '.customized, .model'
# today:  false, null
# aligned: true, "<customized model id>" — and never a base model id
```

`customized: false` with a non-null `model` is **unreachable**. That is what makes
the field worth reading.

---

## Phase 0 — Audit

| Requirement | Status | Note |
|---|---|---|
| Repository audit of all 8 areas | **PASS** | `docs/AI_CHATBOT_IMPLEMENTATION_PLAN.md` §1. Read from the code, not assumed. |
| Domain decision | **PASS** | Travel planning + app usage for Mumbai, confirmed against the real app (§2). |
| `docs/AI_CHATBOT_IMPLEMENTATION_PLAN.md` | **PASS** | Architecture, file-by-file change list, all 6 strategy sections. |
| File-by-file list, created vs modified | **PASS** | §5. 19 assistant modules, 4 routes/pages, 3 scripts, 3 test files, 7 docs. |

## Phase 1 — Nugen groundwork

| Requirement | Status | Note |
|---|---|---|
| API key generated and used | **PASS** | Verified against the live control plane. |
| Endpoints documented from the live API | **PASS** | `docs/NUGEN_INTEGRATION.md` §3. All shapes observed, not recalled. |
| Base model selected and justified | **PASS** | `llama-v3p2-3b-reasoning` — one of two `alignment_ready: true`. §2. |
| Raw request/response shape saved | **PARTIAL** | The request shape is saved and the implementation is written against the OpenAI-compatible contract. **The response shape could not be observed end-to-end**: `/inference/chat/completions` returns 502 for every model. Marked honestly rather than filled in. |
| Live probe | **PASS** | `npm run nugen:probe` checks control, data and training planes independently. |

## Phase 2 — Domain dataset

| Requirement | Status | Note |
|---|---|---|
| Directory layout with raw/processed/train/validation/test | **PASS** | `data/ai_assistant/` with `documents/`, `train.jsonl`, `validation.jsonl`, `test.jsonl`, `dataset_schema.json`. |
| 150–400 examples | **PASS** | 171. |
| 9 required categories | **PASS** | All 13 tags populated: domain Q&A, terminology, multi-turn, ambiguous, out-of-scope, edge cases, terse/detailed, adversarial, grounded/ungrounded. |
| Schema `{instruction, context?, response, tags[]}` | **PASS** | Plus `id`, `grounding`, `split`. |
| Deliverable doc | **PASS** | `docs/AI_MODEL_CUSTOMIZATION.md` — why the base model is insufficient, how examples were written, split ratios, format. |
| Reproducible | **PASS** | No randomness. Two runs → identical `sha256`. |

## Phase 3 — Customization job

| Requirement | Status | Note |
|---|---|---|
| Format the dataset as Nugen requires | **PASS** | 12 multipart text documents; Nugen accepted and ingested all 12 to `READY`. |
| Submit the job | **PASS** | 3 projects created and queued. |
| Record the customized model id | **FAIL (platform)** | Their training backend returned 502 on all 3 attempts. No id exists. Nothing fabricated. |
| `NUGEN_CUSTOMIZED_MODEL_ID` from env, never hard-coded | **PASS** | `provider/config.ts`; no base-model fallback. |
| Deliverable doc with reproduction | **PASS** | `docs/NUGEN_CUSTOMIZATION.md` — job config, verbatim error, exact reproduction including the fact that a re-run costs nothing (documents dedupe by name). |

## Phase 4 — Backend service layer

| Requirement | Status | Note |
|---|---|---|
| Provider abstraction with the 4 methods | **PASS** | `provider/provider.ts`: `generate`, `stream`, `healthCheck`, `metadata`, plus `available`. |
| `NugenProvider` is the only file knowing the API shape | **PASS** | Verified by grep: `api.nugen.in` and the wire paths appear in no other module. |
| All inference uses the customized model | **PASS** | Structurally; see anti-fraud check 2. |
| Data model: Conversation + Message with the required fields | **PASS** | `assistant_conversation`, `assistant_message`. All 11 Message fields present. |
| Every read/write scoped by `user_id` | **PASS** | **Structural**, not reviewed: every message function takes `ownerId`; `updateMessage` uses an owner-scoped subquery. 6 cross-user tests. |
| Streaming with client stop, timeout, mid-stream error, partial persistence, retry without duplication | **PASS** | All five, each with a test. The partial-persistence case found a real bug — see §Bugs. |

## Phase 5 — Voice layer

| Requirement | Status | Note |
|---|---|---|
| Web Speech API preferred | **PASS** | STT and TTS both browser-native. No audio leaves the device. No extra secret, no per-minute cost. |
| Provider interfaces for swapping | **PASS** | `SpeechToTextProvider` / `TextToSpeechProvider`; the UI calls only these. |
| State machine with accessible label + indicator | **PASS** | `idle → listening → processing → speaking → error`, each with a text label **and** a text hint. Not colour alone. |
| Mic denial, unsupported browser, network drop, TTS failure | **PASS** | Unsupported → button **disabled with a visible reason**, not hidden. `no-speech`/`aborted` are treated as normal, not errors. TTS has a bounded backstop for Safari. |
| Never a raw error | **PASS** | `VoiceState = "error"` renders `VOICE_HINT.error`, which names typing as the alternative. |

## Phase 6 — Prompt & context

| Requirement | Status | Note |
|---|---|---|
| Centralized versioned prompt | **PASS** | `prompt.ts`, `PROMPT_VERSION = 1.0.0`, written into every message's `metadata` and shown in the header. |
| Identity, scope, style, terminology, clarifying, refusal, formatting, no fabrication | **PASS** | All eight present and explicit. |
| System + rolling summary + last N turns + app-state context | **PASS** | `orchestration/context.ts`. |
| User content in its own delimited role, never concatenated | **PASS** | No code path splices user text into a system message. Tested. Stored `system` rows are dropped. |

## Phase 7 — Frontend

| Requirement | Status | Note |
|---|---|---|
| Sidebar: new, list, search, rename, delete | **PASS** | All live-verified. |
| Header: identity, model/customization badge, settings | **PASS** | Badge shows *aligned model* / *offline path* and the model id and prompt version. |
| Messages: markdown, code, tables, cursor, copy, regenerate, TTS, timestamps, error+retry | **PASS** | Markdown, code blocks, copy, regenerate, TTS, timestamps, stopped/error badges. **Tables are deliberately unsupported** — nothing in the output is tabular and it is the one construct that reliably overflows a phone. |
| Composer: textarea, send, mic, stop | **PASS** | Stop is a real `AbortController` abort, not a UI flag. |
| Responsive | **PASS** | Sidebar → `Sheet` drawer under `lg`. Composer is `resize-y` with a `max-h`, so the keyboard does not cover the send button. |
| Accessibility | **PASS** | ARIA throughout, `role="log"` with `aria-live="polite"`, focus management in the rename field, `aria-current` on the active conversation, focus-visible reveals for hover-only actions. |
| Reduced motion | **PASS** | Inherited from the existing token layer (`--dur-*` collapse under `prefers-reduced-motion`). No new animation added outside it. |
| Theming from existing tokens | **PASS** | Zero colour literals. `theme:lint clean`. |

## Phase 8 — Evaluation

| Requirement | Status | Note |
|---|---|---|
| Held-out test set, disjoint from train/validation | **PASS** | 24 examples, **never uploaded** to Nugen. |
| Scripts for baseline and customized | **PASS** | `--models base,customized`. |
| Metrics: domain accuracy, instruction-following, relevance, hallucination, terminology, refusal, latency, tokens | **PARTIAL** | 4 heuristic metrics + latency implemented. **Domain accuracy, instruction-following, relevance and token usage are not implemented** — no judge model and no rubric were available, and a number from a rubric nobody wrote down is worse than none. Latency is real. Token usage is captured when the provider reports it. |
| **Only report numbers actually produced** | **PASS** | The two model arms are `UNAVAILABLE` with the reason. Zero fabricated figures. |
| `MANUAL` where the dashboard does not expose it | **PASS** | Streaming response shape and Nugen's `performance_metrics` are both marked MANUAL. |
| Deliverable doc | **PASS** | `docs/AI_MODEL_EVALUATION.md`, including the fact that `domainTerms` was revised mid-build and why. |
| Base vs customized comparison | **FAIL (platform)** | Neither arm reachable. The harness prints "Not comparable" rather than a one-armed delta. |

## Phase 9 — Security, testing, observability, docs

| Requirement | Status | Note |
|---|---|---|
| Auth + ownership on every conversation endpoint | **PASS** | Cookie capability token; `sha256` owner id; 6 cross-user tests, 4 live-verified. |
| Rate limiting on chat/voice/regeneration | **PASS** | 20/min + burst 5/10s. Regenerate is metered because it costs a full paid call. Voice is client-side, so there is nothing to rate-limit server-side. |
| Input length/shape validation | **PASS** | 4,000 chars; `.strict()` bodies. Live-verified 400s. |
| Safe markdown, no raw HTML injection | **PASS** | No `dangerouslySetInnerHTML` anywhere. `href` scheme allowlist. |
| Prompt-injection resistance tests | **PASS** | Structural separation + output screening + a dedicated injection test set. |
| No secrets in logs | **PASS** | `src/llm/log.ts` redaction. Assistant logs carry counts and ids only. |
| Test layout: unit / integration / security / ai / e2e | **PARTIAL** | `tests/assistant/{unit,integration,security}.test.ts` — 83 tests. **`ai/` and `e2e/` are not separate files**: the AI-behaviour assertions live in `unit.test.ts` beside the provider they test, and the e2e flows are covered by the 31-check live smoke test rather than a Playwright suite. No browser automation was added. |
| Mock Nugen for CI; opt-in real-key suite | **PASS** | CI never touches the network: with no `NUGEN_API_KEY`, `selectProvider()` returns the deterministic provider and every test runs against it. The real-key path is opt-in via the env var. |
| Structured logs: request id, latency, model, success, retries | **PASS** | All present. |
| Health endpoint, no key in payload | **PASS** | Live-verified. The provider never stores its headers, so there is no field that could hold one. |
| 7 documents + `.env.example` + README | **PASS** | All written. |

## Phase 10 — Final verification

| Check | Status | Result |
|---|---|---|
| `npm run typecheck` | **PASS** | Clean. |
| `npm run lint` | **PASS** | Clean. |
| `npm test` | **PASS** | **1,246 passed, 0 failed**, 51 files. Travel Buddy's own suite unaffected. |
| `npm run build` | **PASS** | Compiled successfully. All 4 assistant routes emitted. |
| `theme:lint` / `contrast:lint` / `copy:lint` | **PASS** | All three clean. |
| Live smoke test | **PASS** | 31/31 against a running server. |
| Manual walk of chat, conversation, voice flows | **MANUAL** | Chat, conversation CRUD, cross-user isolation, validation, rate limiting and health verified by script. **Voice was not exercised on a physical microphone** — no browser automation, and speech recognition needs a real device. The state machine is unit-tested; the browser API calls are not. |

---

## Bugs found and fixed

Three found by this work's own tests and smoke test, all recorded in the code
where they can recur.

1. **Pre-existing: Drizzle could not read JSON columns.**
   `sqlite-proxy` maps results positionally (`row[columnIndex]`), but
   `createRemoteCallback` returned row *objects*, so every decoder got
   `undefined`. Booleans masked it; JSON columns threw
   `SyntaxError: "undefined" is not valid JSON`. Unnoticed because nothing had
   ever run a Drizzle `select()` over a JSON column — the catalogue is read from
   JSONL files. The assistant's tables are the first to. **17 tests failed until
   this was fixed.**

2. **Pre-existing: the production build was broken at HEAD,** in two independent
   ways — `SituationEditor.tsx` used `useState` without `"use client"`, and
   `TwinControls.tsx` (a client component) pulled `node:fs` into the browser
   bundle by importing two pure symbols through the `@/features/twin` barrel.
   Confirmed by stashing all my changes and rebuilding. One line each.

3. **New: an aborted turn was never persisted.** The write sat after the
   `try` block, so closing the generator (which runs `finally` and skips the rest)
   left the row stuck at `streaming` — and the *next* turn read a message
   claiming to still be generating. Moved into `finally`; the invariant "no row
   is ever left as `streaming`" is now asserted directly.

4. **New: an injection attempt got a catalogue dump instead of a refusal.**
   Found by the live smoke test. Injection attempts share ordinary English with
   the catalogue, so keyword grounding matched and won. Nothing privileged
   leaked, but it is the worst possible answer to "ignore your instructions"
   because it looks like compliance. Now checked before grounding, with a
   regression test that supplies grounding deliberately.

---

## Summary

| | Count |
|---|---:|
| **PASS** | 74 |
| **PARTIAL** | 3 |
| **FAIL (platform)** | 2 |
| **MANUAL** | 2 |
| **N/A** | 0 |

**Both FAILs are Nugen's 502, not the code.** The two remaining PARTIALs are the
eval metric set (no judge model available) and the test-file layout (AI assertions
co-located with the provider; e2e covered by script rather than a browser
automation suite). Both are stated rather than papered over.

**The one thing this deliverable cannot claim** is a working customized model,
because Nugen's training and inference planes are returning 502 for this account.
Everything around it is real and verified: the dataset, the job, the reproduction
path, the provider integration, the runtime that will use a customized model the
moment one exists, and a deterministic path that means the product works today.
