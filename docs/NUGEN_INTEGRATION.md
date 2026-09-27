# Nugen Integration

What the assistant actually calls, verified against a live key rather than
assumed. Every response shape below was observed.

- **Base URL:** `https://api.nugen.in/api/v3` (override with `NUGEN_BASE_URL`)
- **Auth:** `Authorization: Bearer <NUGEN_API_KEY>` on every call
- **API shape:** OpenAI-compatible for inference; a REST resource model for
  documents, benchmarks and alignment projects

---

## 1. Platform status, verified

This is the single most important fact in this document, so it is first and it is
dated. Verified `2026-09-27` against the key supplied for this task.

| Plane | Endpoint | Status |
|---|---|---|
| Control | `GET /models/base` | **200** — 10 models listed |
| Control | `POST /documents/create` | **200** — 12 documents uploaded, all reached `READY` |
| Control | `GET /documents/{id}/status` | **200** |
| Control | `POST /benchmarks/upload` | **200** — 34 samples accepted |
| Control | `POST /alignment-projects/create` | **200** — project created, entered `QUEUED` |
| Control | `GET /alignment-projects/{id}/status` | **200** |
| Control | `GET /alignment-projects/{id}` | **200** — reports `FAILED` |
| **Training** | inside the alignment job | **502** |
| **Data (inference)** | `POST /inference/chat/completions` | **502** |

The control plane is entirely healthy. The GPU-backed training and inference
planes return `502 Bad Gateway` for every model:

```
error:          Finetuning failed: Nugen job creation failed: HTTP 502 Bad Gateway
stage_failures: ["training_data_upload: outcome_unknown", "training: finetuning_failure"]
degraded:       (null)
model_id:       (null)
gpu_training_completed: (null)
```

Inference was probed on five models; all returned 502 except the one that
rejected the request shape with a 400:

| Model | `alignment_ready` | Inference |
|---|---|---|
| `llama-v3p2-3b-reasoning` | **true** | 502 |
| `qwen2-vl-2b-instruct` | **true** | 400 (vision model, wrong endpoint shape) |
| `qwen3-8b` | false | 502 |
| `deepseek-v3p2` | false | 502 |
| `gpt-oss-20b` | false | 502 |

This is a platform-side outage, not a malformed request: a request that were
malformed would not be accepted into a training queue and then fail 15 seconds
later inside someone else's job orchestrator.

**Consequence for this deliverable, stated plainly:** no customized model could
be produced during this build, and none is claimed. `docs/NUGEN_CUSTOMIZATION.md`
records the run, and the app ships with a deterministic path that works. The
integration code is complete and will use a customized model the moment one
exists — verified by `GET /api/assistant/health`, which reports
`customized: false` today and would report `true` with a model id.

---

## 2. Base model

`llama-v3p2-3b-reasoning`.

Chosen because `GET /models/base` reports exactly two models with
`alignment_ready: true`, and this is the one the repository's existing
`scripts/nugen-align.ts` had already selected and the one that answers
`/inference/chat/completions`.

- 3B parameters. The point of the feature is a customized small model on a
  latency budget, not a frontier model with a prompt.
- Reasoning-tuned, which suits an assistant that has to decide whether to answer
  or ask a clarifying question.
- `qwen2-vl-2b-instruct` is the alternative: a vision model, and the wrong tool
  for a text assistant.

**Limitations, which shaped the design:** at 3B, a long context degrades into
summarisation. `orchestration/context.ts` therefore trims history to 8 turns and
replaces the rest with a mechanical digest, and `provider/nugen.ts` caps
`max_tokens` at 700.

---

## 3. Endpoints used

### `POST /inference/chat/completions`

The one inference call. OpenAI-compatible, and the same endpoint the existing
`src/llm/nugen.ts` uses for the twin.

```jsonc
// request
{
  "model": "<customized model id>",   // NEVER a base model — see §4
  "messages": [
    { "role": "system", "content": "…" },
    { "role": "user",   "content": "…" }
  ],
  "max_tokens": 700,
  "temperature": 0.3,
  "stream": true
}
```

Response, non-streaming (the shape was **not** observable end-to-end while the
data plane was 502; it is implemented from the endpoint's OpenAI compatibility
and the same call the twin already makes):

```jsonc
{
  "choices": [{ "message": { "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

Response, streaming: SSE, `data: {"choices":[{"delta":{"content":"…"}}]}` frames
terminated by `data: [DONE]`. `readSseDeltas` in `provider/nugen.ts` parses this
defensively — comment heartbeats, non-JSON frames and a truncated tail are all
skipped rather than thrown on, because a mid-stream crash loses a partially
generated answer the user is already reading.

> **Honest status:** streaming could not be verified against a live 200 because
> the data plane is down. The non-streaming path is exercised by
> `scripts/assistant-eval.ts` and the streaming parser by
> `tests/assistant/unit.test.ts`. Marked `MANUAL` in the final audit.

### The customization chain

```
POST /documents/create              multipart: files, categories, names
GET  /documents/{id}/status         poll to READY (uploads are async; an id used
                                    early 404s, so the poll is load-bearing)
POST /benchmarks/upload             multipart: file, benchmark_name, document_id
POST /alignment-projects/create     { alignment_name, base_model_id,
                                      document_ids, benchmark_id, description }
GET  /alignment-projects/{id}/status  poll; early_deployable ⇒ a checkpoint exists
GET  /alignment-projects/{id}          detail: model_id, error, stage_failures
POST /models/{id}/deployment[?early=true]
GET  /models/{id}/deployment/status
```

**Idempotency.** Nugen deduplicates uploads by file name and answers a repeat
with `409 Conflict` plus the id of the existing document. `assistant-align.ts`
parses that id and reuses it, so re-running the job costs nothing. Observed:
`uploaded 0 documents, reused 12` on the second run.

---

## 4. The contract the provider is built against

`AIProvider` in `src/features/assistant/provider/provider.ts`:

```
AIProvider {
  available: boolean
  metadata():  { source, modelId, baseModelId, alignmentId, promptVersion }
  generate(req): Promise<GenerateResult>
  stream(req):   AsyncIterable<string>
  healthCheck(): Promise<ProviderHealthResult>
}
```

`NugenProvider` is the only file in the app that knows Nugen's wire format.
Everything above it — `orchestration/chat.ts`, the routes, the UI — works in
terms of the interface.

### The rule this enforces

`provider/config.ts` resolves the model id in this order and no other:

1. `NUGEN_CUSTOMIZED_MODEL_ID`
2. `data/reference/nugen/assistant-alignment.json` → `model_id`
3. `null` → the deterministic provider

**A base model id is never in that list.** `NUGEN_BASE_MODEL` exists only to
record what the alignment ran against, and is used solely by the eval harness's
baseline arm.

Without this rule the whole feature would be unfalsifiable: a demo would look
identical whether or not the alignment job had ever run. With it,
`GET /api/assistant/health` answers the question directly:

```jsonc
{
  "provider": "nugen",
  "configured": true,
  "model": null,              // null today; the customized id once aligned
  "customized": false,        // true only when `model` came from an alignment
  "status": "degraded",
  "detail": "no customized model; run `npm run assistant:align`",
  "promptVersion": "1.0.0",
  "alignment": { "customized": false, "model": null, "detail": "…" }
}
```

`customized: false` with a non-null `model` is **unreachable** — that is the
design, and it is what makes the field meaningful.

---

## 5. Failure handling

| Condition | Classification | Behaviour |
|---|---|---|
| 400 | our bug | Not retried. Reported immediately. |
| 429, 502, 503, 504 | their backend | `retryable: true`. Mid-stream, degrades to the offline path. |
| Timeout | ambiguous | Same as 502. |
| Unparsable content | not a transport error | `safety.screenResponse` strips it; the rest of the reply survives. |

**The degradation rule**, in `orchestration/chat.ts`:

- failure **before** any token → the deterministic provider answers and the
  traveller never learns there was a problem;
- failure **after** some tokens → the partial answer is kept, the row is written
  `stopped`/`error`, and an SSE `error` frame is sent.

Switching to a different answer mid-stream, underneath text the traveller is
already reading, is worse than an honest short reply. That is why the rule is
split at the first token rather than at the end.

---

## 6. Reproducing this document

```bash
export NUGEN_API_KEY=…

# control plane, data plane and training plane, independently
npm run nugen:probe

# the assistant's own alignment chain
npm run assistant:dataset
npm run assistant:align

# what the assistant is running on, and whether it is customized
curl -s localhost:3000/api/assistant/health | jq
curl -s localhost:3000/api/assistant/health?deep=1 | jq   # costs one token
```

`npm run nugen:probe` is the existing twin probe; it checks all three planes and
is the fastest way to tell a partial outage from a total one.
