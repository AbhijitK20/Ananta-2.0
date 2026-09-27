# Nugen Customization â€” the alignment job

`npm run assistant:align`

---

## 1. Result, stated first

**No customized model was produced. Nugen's training backend returned
`502 Bad Gateway` for every attempt.** No model id is claimed, and none is
hard-coded, because there is no artefact to point at.

The chain ran for real and got three quarters of the way:

```
[   0s] dataset: 113 train / 34 validation / 24 held out
[   0s] dataset sha256: 45e9dcecc6a695d9f6942ee173b5d41b3d6ad8979787e567819535b27d120749
[   1s] uploaded 0 documents, reused 12
[   1s] all documents READY
[   2s] benchmark: 34 samples, id benchmark_01m3gf73bak9p8de
[   2s] alignment alignment_01m3gf73kht8n4tb created on llama-v3p2-3b-reasoning (PROCESSING)
[   2s] alignment: QUEUED
[  17s] attempt 1/3 failed: Finetuning failed: Nugen job creation failed: HTTP 502 Bad Gateway
[  17s] retrying in 10s
[  27s] alignment alignment_01m3gf7wecx3rnq5 created on llama-v3p2-3b-reasoning (PROCESSING)
[  27s] alignment: QUEUED
[  42s] attempt 2/3 failed: Finetuning failed: Nugen job creation failed: HTTP 502 Bad Gateway
[  42s] retrying in 20s
[  63s] alignment alignment_01m3gf8z7g3tzrbz created on llama-v3p2-3b-reasoning (PROCESSING)
[  63s] alignment: QUEUED
[  78s] attempt 3/3 failed: Finetuning failed: Nugen job creation failed: HTTP 502 Bad Gateway
```

And the project's own record:

```json
{
  "alignment_id": "alignment_01m3gf73kht8n4tb",
  "base_model_id": "llama-v3p2-3b-reasoning",
  "status": "FAILED",
  "error": "Finetuning failed: Nugen job creation failed: HTTP 502 Bad Gateway",
  "stage_failures": ["training_data_upload: outcome_unknown", "training: finetuning_failure"],
  "degraded": null,
  "model_id": null,
  "gpu_training_completed": null,
  "is_adapter_available": null,
  "document_count": 12,
  "performance_metrics": null
}
```

**What this establishes, and what it does not.**

*Establishes:* our corpus is acceptable â€” 12 documents uploaded and ingested to
`READY`, a 34-sample benchmark accepted, an alignment project created and admitted
to a real queue. A malformed request or an unacceptable corpus is rejected at
submission. The 502 arrives ~15 s later, inside Nugen.

*Does not establish:* anything about model quality. There is no model, so there
is no before/after number, and none is printed anywhere in this repository.

The full log is committed at `data/ai_assistant/align-run.txt`.

---

## 2. Why it is their side, not ours

| Check | Result |
|---|---|
| `GET /models/base` | 200 â€” the account and key work |
| `POST /documents/create` Ã— 12 | 200, every document `READY` |
| `POST /benchmarks/upload` | 200, 34 samples accepted |
| `POST /alignment-projects/create` | 200, status `PROCESSING` |
| Queue admission | yes â€” the project sat `QUEUED` for 15 s |
| Failure | 502 at `training_data_upload`, inside their job orchestrator |
| `POST /inference/chat/completions` Ã— 5 models | 502 |

A project that entered a queue and failed inside the trainer cannot be a bad
request. Independently, the **data** plane returns 502 for every model on the same
account â€” the GPU tier is down, and training and inference share it.

Corroboration: the repository's existing `scripts/nugen-align.ts` carries a
hand-written comment recording the same 502 "for every base model and every corpus
size tried", independently of this work. The outage predates it.

---

## 3. What the script does

```
npm run assistant:dataset     # prerequisite; produces manifest.json + documents/
npm run assistant:align       # this script
```

| Stage | Call | Note |
|---|---|---|
| Verify | â€” | Recomputes `sha256(train.jsonl)` and refuses to run if it disagrees with `manifest.json`. |
| Upload | `POST /documents/create` | Per document. A `409` is parsed for the existing id and **reused** â€” a re-run costs nothing. |
| Wait | `GET /documents/{id}/status` | Until `READY`. Async uploads; an id used early 404s. |
| Benchmark | `POST /benchmarks/upload` | `validation.jsonl` only. **`test.jsonl` is never uploaded.** |
| Align | `POST /alignment-projects/create` | Async. |
| Wait | `GET /alignment-projects/{id}/status` | Until `READY`/`EVALUATED`, or `early_deployable` with `--early`. |
| Model id | `GET /alignment-projects/{id}` | The `model_id`, which is **not** the `alignment_id`. |
| Deploy | `POST /models/{id}/deployment[?early=true]` | Then poll its status. |
| Record | write `data/reference/nugen/assistant-alignment.json` | What `provider/config.ts` reads per request. |

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Print the corpus, touch no network. |
| `--early` | Deploy the newest checkpoint as soon as one exists. |
| `--skip-train` | Reuse the alignment id on disk, only deploy. |
| `--retries N` | Attempts at the whole run. Default 3. |
| `--timeout-min N` | Give up waiting. Default 45. |
| `--base-model X` | Override the base model. |

### A bug this run found, and the fix

The first version retried **project creation** and checked the status one second
later. It found `PROCESSING`, concluded the project was healthy, and let the 502
surface two minutes later from the wait â€” with no retry left. The log above shows
three real attempts because the retry now wraps the *whole* run: create, wait,
resolve the model id. A failed project cannot be resurrected, and the only place
that knows whether a new one survived is the end.

Only a 502 is retried blindly. A `400 base model does not support alignment`
fails identically forever and is reported immediately.

---

## 4. The artifact, and what happens without it

On success the script writes:

```jsonc
// data/reference/nugen/assistant-alignment.json
{
  "alignment_id": "alignment_â€¦",
  "model_id": "â€¦",              // the customized model
  "base_model_id": "llama-v3p2-3b-reasoning",
  "status": "DEPLOYED",
  "aligned_at": "2026-â€¦",
  "dataset_sha256": "45e9dcecâ€¦", // traces the model to exact training bytes
  "train_examples": 113,
  "validation_examples": 34,
  "benchmark_id": "benchmark_â€¦",
  "note": "â€¦"
}
```

**The file does not exist today**, because no run succeeded. That is the correct
state: its absence *is* the evidence that no alignment has happened, and the app
reads it per request rather than memoising at boot.

`provider/config.ts` then resolves:

```
NUGEN_CUSTOMIZED_MODEL_ID  â†’  alignment.json .model_id  â†’  null
                                                            â†“
                                            deterministic provider
```

**Never the base model.** That is the whole design, and it is why
`/api/assistant/health` can answer the audit question without anybody having to
take the code's word for it:

```json
{ "customized": false, "model": null, "detail": "no customized model; run `npm run assistant:align`" }
```

---

## 5. Reproduction

```bash
export NUGEN_API_KEY=â€¦

npm run assistant:dataset    # deterministic; same catalogue â‡’ same sha256
npm run assistant:align      # reuses uploaded documents, retries 502s with backoff
```

**Cost of a re-run: zero for the corpus.** Documents are deduplicated by name, so
only the alignment project is new. Observed: `uploaded 0 documents, reused 12`.

**Cost of a rebuild from nothing:** 12 document uploads + 1 benchmark + 1
alignment project. There is no other state to reproduce â€” the corpus is
deterministic, so the same catalogue always yields the same
`dataset_sha256: 45e9dcecâ€¦`, and that hash is written into the alignment record.

**When it succeeds,** the only further step is to set `NUGEN_API_KEY` in the app
environment. `NUGEN_CUSTOMIZED_MODEL_ID` is optional: the app reads the record.
`/api/assistant/health` then flips to `"customized": true` with a model id, every
reply in the UI is badged *aligned model* instead of *offline path*, and
`npm run assistant:eval -- --models base,customized` produces the comparison in
`docs/AI_MODEL_EVALUATION.md`.

**Verification checklist for that run** â€” none of it requires reading the source:

```bash
curl -s localhost:3000/api/assistant/health | jq '.customized, .model'
# expect: true, "<customized model id>" â€” and never a base model id

jq .model_id data/reference/nugen/assistant-alignment.json
# expect: the same id, and different from .base_model_id
```
