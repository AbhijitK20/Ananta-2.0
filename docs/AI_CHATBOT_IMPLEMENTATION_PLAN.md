# AI Chatbot Implementation Plan

Phase 0 output. The audit of the real repository, and the architecture this work
actually followed. Every claim here was read out of the code, not assumed.

---

## 1. What the repository already was

The audit changed the plan substantially, so it is worth being concrete about what
was found.

| Area | Finding |
|---|---|
| Framework | Next.js 15.5.26, App Router, React 19.2. Pages in `src/app/**`, one `"use client"` island per interactive surface. |
| Language | TypeScript 5.9.3, `strict` plus `noUncheckedIndexedAccess`. |
| Styling | Tailwind v4 with a three-layer token system in `src/styles/tokens.css` — raw hex → semantic → `@theme`. `npm run theme:lint` **fails the build on any hex literal outside the token file**. |
| Components | `src/components/ui/*` — Button, Card, Badge, EmptyState, Sheet, Dialog, Toggle, Slider, Skeleton, Tooltip. A design system with a lint gate, not a mood board. |
| Database | SQLite via **`node:sqlite`**, driven by Drizzle's `sqlite-proxy` shim (`src/db/driver.ts`). Hand-rolled ordered migrations in `src/db/migrations.ts`. File at `DB_FILE`, default `data/app.db`. |
| Catalogue | 4,596 rows in `content/experiences/*.jsonl` + `data/cities/mumbai/experiences.jsonl`, validated against the frozen `Experience` contract at load time by `src/app/_lib/catalogue.ts`. |
| Auth | **None.** `better-auth` is a dependency but nothing in `src/` mounts it. `src/app/layout.tsx` states the intent: keyless public endpoints, "nothing here needs an account". |
| Existing AI | **Substantial, and it already used Nugen.** `src/llm/**` (OpenRouter-backed NLU / narrator / enricher) and `src/llm/nugen.ts` — a Nugen provider for the Digital Twin's hazard classification, with `scripts/nugen-align.ts` and `scripts/nugen-probe.ts`. |
| Tests | Vitest, node environment, 50 files. `npm test` / `npm run typecheck` / `npm run lint` / `npm run build` all wired. |
| Lint gates | `theme:lint`, `contrast:lint`, `copy:lint` — three non-obvious domain linters that fail the build. |
| Deployment | Vercel-shaped. Node runtime required (`node:sqlite` is not edge-safe). |

### The two findings that changed the plan

**1. Nugen was already integrated, for a different feature.**
`src/llm/nugen.ts` and `scripts/nugen-align.ts` had already established the exact
API shapes — `/models/base`, `/inference/chat/completions`, `/inference/rerank`,
`/documents/create`, `/benchmarks/upload`, `/alignment-projects/create`,
`/models/{id}/deployment` — and the established conventions: an alignment
manifest committed to disk, a deterministic fallback, and provenance surfaced in
the UI. Phase 1 of the brief ("read the docs, discover the endpoints") was
therefore *verification against a live key* rather than greenfield research, and
the assistant was built to those same shapes rather than to a second set.

This also fixed the base model: `GET /models/base` reports exactly two entries
with `alignment_ready: true` — `llama-v3p2-3b-reasoning` and `qwen2-vl-2b-instruct`.

**2. There is no auth, so "scope every read by `user_id`" needed a decision.**
Inventing an auth system for a chat feature would be both a large unrequested
change and a worse product than the one that exists. The assistant uses a
**capability token** instead — the same primitive a session is. See §4.

---

## 2. Domain decision

**The assistant's domain is travel-planning assistance for Mumbai, plus how the
TravelBuddy app works.** Confirmed against the real app, not assumed:

- the app plans itineraries under a time budget, budget, access needs and weather
  (`src/engine/`, `src/features/discovery/`);
- it surfaces named **rejections** and **unmet needs** rather than hiding them
  (`src/contracts` `RejectionCode`, `AccessNeed`);
- it has a **what-if twin**, a **why ledger**, a **provider surface** and a
  **demand analytics** surface;
- the catalogue is Mumbai only, 4,596 rows.

So the assistant answers four things — trip planning, travel logistics, app usage,
and what the app cannot do — and redirects everything else. `docs/AI_MODEL_CUSTOMIZATION.md`
explains how that scope became the dataset.

---

## 3. Architecture as built

```
src/features/assistant/
├── types.ts                  wire types; StreamEvent, Message, ProviderHealth
├── prompt.ts                 SYSTEM_PROMPT, PROMPT_VERSION = 1.0.0, grounding block
├── knowledge.ts              12 app topics + 4 refusal rules (app's own wording)
├── links.ts                  href scheme allowlist (XSS)
├── voice.ts                  Web Speech API, SpeechToText/TextToSpeech seams, state machine
├── grounding.ts              question + real catalogue -> the facts a reply may state
├── owner.ts                  cookie capability token, sha256 owner id
├── rate-limit.ts             20/min + burst 5/10s, in-memory
├── store.ts                  every query owner-scoped by construction
├── titles.ts                 pure title derivation
├── db.ts                     lazy singleton over the existing DB_FILE
├── Markdown.tsx              no dangerouslySetInnerHTML, anywhere
├── useAssistant.ts           SSE reader + chat state
├── AssistantView.tsx         the surface
├── provider/
│   ├── provider.ts           the AIProvider contract
│   ├── config.ts             resolves the CUSTOMIZED model; no base-model fallback
│   ├── nugen.ts              the only module that knows Nugen's wire format
│   ├── deterministic.ts      the offline path
│   └── index.ts              per-request selection
└── orchestration/
    ├── context.ts            system + digest + recent turns + user turn
    ├── safety.ts             inbound validation, outbound screening
    └── chat.ts               the stream, the persistence, the degradation
```

```
src/app/api/assistant/
├── chat/route.ts             POST  SSE stream, ?regenerate=1
├── conversations/route.ts    GET/POST/PATCH/DELETE
└── health/route.ts           GET  what it is actually running on
```

### The one line that matters

`provider/config.ts` resolves the model id in exactly this order:

1. `NUGEN_CUSTOMIZED_MODEL_ID`
2. the alignment record on disk
3. `null` — and `null` means the **offline path**, not the base model

There is no fourth option. That is what makes "did you actually align a model?"
a question with an answer, and it is why `health/route.ts` can report
`customized: true` honestly.

---

## 4. Ownership without accounts

`owner_id` is `sha256` of a 128-bit random secret in an `httpOnly`,
`SameSite=Lax` cookie (`Secure` over https). Possession of the cookie is the
authorisation; the database stores only the hash, so a dump cannot be replayed
as a live session.

The store is written so this is structural rather than reviewed: **every function
that reads or writes a message takes `ownerId`** and filters on it, including
`updateMessage`, which resolves the parent conversation through an owner-scoped
subquery so that a guessed message id matches no row. There is no exported
function that can reach a message without proving ownership first.

**The honest cost:** clearing cookies starts a new conversation history. That is
the price of not having accounts, and it is stated here rather than hidden.

---

## 5. File-by-file change list

### Created

| File | Purpose |
|---|---|
| `src/features/assistant/*` (19 files) | The assistant module. See §3. |
| `src/app/api/assistant/chat/route.ts` | SSE streaming endpoint. |
| `src/app/api/assistant/conversations/route.ts` | Sidebar CRUD. |
| `src/app/api/assistant/health/route.ts` | Provider + customization status. |
| `src/app/assistant/page.tsx` | The route. |
| `scripts/assistant-dataset.ts` | Builds the domain dataset. |
| `scripts/assistant-align.ts` | The Nugen alignment job. |
| `scripts/assistant-eval.ts` | Scores the held-out test split. |
| `data/ai_assistant/*` | Dataset, corpus documents, manifest, reports. |
| `tests/assistant/{unit,integration,security}.test.ts` | 80 tests. |
| `docs/AI_*.md`, `docs/NUGEN_*.md` | This documentation set. |
| `.env.example` | Every variable, all optional. |

### Modified

| File | Change | Why |
|---|---|---|
| `src/db/schema.ts` | +2 tables | The assistant needs persistence. Same file, same conventions. |
| `src/db/migrations.ts` | +migration 5 | Appended, never edited, per the file's own rule. |
| `src/db/driver.ts` | **bug fix** | See below. |
| `src/app/_components/SiteHeader.tsx` | +1 nav item | A surface nobody can reach is worse than a short nav. |
| `src/app/_components/SituationEditor.tsx` | +`"use client"` | Build was broken at HEAD. |
| `src/app/_components/TwinControls.tsx` | import path | Build was broken at HEAD. |
| `package.json` | +3 scripts | `assistant:dataset`, `assistant:align`, `assistant:eval`. |

### Two pre-existing bugs fixed, because they blocked verification

**`src/db/driver.ts` — JSON columns could not be read.**
Drizzle's `sqlite-proxy` maps results **positionally** (`mapResultRow` reads
`row[columnIndex]`), but `createRemoteCallback` returned row *objects*. Every
column decoder therefore received `undefined`. Boolean columns masked it
(`undefined` → `false`); JSON columns threw `SyntaxError: "undefined" is not valid
JSON`. It went unnoticed because nothing had ever run a Drizzle `select()` over a
JSON column — the catalogue is read from JSONL files. The assistant's tables are
the first to. Fix: return `Object.values(row)`.

**The production build was already broken at HEAD**, in two independent ways:
`SituationEditor.tsx` used `useState` without `"use client"`, and `TwinControls.tsx`
(a client component) imported two pure symbols through the `@/features/twin`
barrel, which re-exports `observe.ts` (`node:fs/promises`) and `apply.ts`
(`src/engine/geo.ts` → `node:fs`) — so the browser bundle tried to bundle `fs`.
Both confirmed by stashing my changes and rebuilding. Fixes are one line each and
are noted in the files.

---

## 6. Strategy sections

| Section | Document |
|---|---|
| Nugen integration, endpoints, base model, live probe | `docs/NUGEN_INTEGRATION.md` |
| Dataset design, split policy, why the base model is insufficient | `docs/AI_MODEL_CUSTOMIZATION.md` |
| The alignment job, its real result, reproduction | `docs/NUGEN_CUSTOMIZATION.md` |
| Evaluation, metrics, baseline vs customized | `docs/AI_MODEL_EVALUATION.md` |
| Full architecture, security, degradation, limits | `docs/AI_ASSISTANT_ARCHITECTURE.md` |
| Requirement-by-requirement PASS/FAIL/MANUAL/N/A | `docs/AI_ASSISTANT_FINAL_AUDIT.md` |

---

## 7. What deviates from the original plan, and why

1. **No `server/ai/` tree.** The repository is Next.js App Router with features
   under `src/features/*`, not a `server/` directory. Following the existing
   convention beat reproducing a layout the repo does not use.
2. **No React 19 `use()` / server actions for the transcript.** The transcript is
   per-cookie and inherently client state; a server-action round trip per delta
   would be slower and no simpler than SSE.
3. **No markdown library.** `react-markdown` plus `rehype-raw` is a large
   transitive tree whose main risk is the exact thing being guarded. About eighty
   lines of auditable renderer that never calls `dangerouslySetInnerHTML` is the
   better trade here, and it is the only way to make "no raw HTML" a property of
   the code rather than a configuration.
4. **Voice is browser-native only.** The plan already preferred this. Firefox has
   no `SpeechRecognition`, so the mic button is disabled with a stated reason
   rather than hidden, and the seams exist for a server-side provider later.
5. **The eval metrics are heuristics, not a judge model.** A rubric nobody wrote
   down produces a number nobody can defend. Each metric documents what it
   actually detects.
6. **In-memory rate limiting.** Correct for one process, which is every way this
   is deployed today. The limitation is documented in the file and the interface
   is one file's change away from Redis.
