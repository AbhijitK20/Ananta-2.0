# AI Model Evaluation

`npm run assistant:eval` · reports in `data/ai_assistant/reports/`

---

## 1. The result, stated first

| Arm | Status | Why |
|---|---|---|
| **base model** | **UNAVAILABLE** | `POST /inference/chat/completions` returns `502`. |
| **customized model** | **UNAVAILABLE** | No customized model exists — the alignment job failed at their training backend. `docs/NUGEN_CUSTOMIZATION.md`. |
| offline path | **scored**, below | No network. |

**There is no base-vs-customized comparison, and none is printed.** A delta
computed from one available arm is not a comparison, so the harness says
"Not comparable: both arms were not available in the same run" rather than
producing a number that looks like a result.

This is the harness working. The one thing an eval must never do is print a
figure that was not measured — a "0% hallucination rate" for a model that returned
502 for all 24 prompts is indistinguishable from a real measurement in a report
nobody re-runs.

---

## 2. What was actually scored

24 held-out examples from `data/ai_assistant/test.jsonl` — a split that is
**never uploaded to Nugen** and never attached as a benchmark.

```
scoring 24 held-out examples
topics in the knowledge table: 12, refusal rules: 4

## offline
Model: none · examples: 24

| metric         | passed | applicable | rate    |
| -------------- | -----: | ---------: | ------: |
| domainTerms    |      6 |          6 | 100.0%  |
| format         |     24 |         24 | 100.0%  |
| noFabrication  |     11 |         11 | 100.0%  |
| refusalCorrect |      4 |          4 | 100.0%  |

Latency: mean 0 ms, p95 1 ms
```

Full output: `data/ai_assistant/reports/latest.md` and `latest.json` (per-example,
with every reply and which check it failed).

---

## 3. What each metric really detects

**These are heuristics, and they are labelled as heuristics.** There is no judge
model and no human rubric in the loop, because both were unavailable and a number
from a rubric nobody wrote down is worse than no number. Each row says what it
actually detects.

| Metric | Applicable to | Detects | Does **not** measure |
|---|---|---|---|
| `format` | all | The reply is non-empty and is not a bare refusal with nothing after it. | Whether it is *good*. |
| `noFabrication` | examples with no grounding | A price or clock time asserted with no fact behind it. The failure that matters most. | Hallucinations in general — it is a tripwire, not a proof. |
| `refusalCorrect` | `out-of-scope`, `refusal` | The reply redirects rather than complying. | Whether the redirect was *kind*. |
| `domainTerms` | `app-howto`, `terminology` | The app's own vocabulary appears, rather than an invented synonym. | Correctness of the explanation. |

`noFabrication` is deliberately narrow and honestly labelled: it fires on the
shape "<number> rupees" or a clock time appearing in a turn that supplied no
facts. It will not catch every hallucination and this document does not claim it
does. It catches the class that would survive into a product as "the Bandstand
closes at 10:30" when the catalogue never said so.

`domainTerms` was **revised during this build.** Its first list held only
traveller-facing terms, so every provider and analytics answer failed it for
using the operator-facing vocabulary instead — measuring nothing. It now spans
both halves of the app's language. That is recorded here rather than quietly
fixed, because a metric that is tuned until it passes is not a metric.

---

## 4. Reading the 100%s honestly

Every applicable metric is at 100% on the offline path, and that is **not**
evidence of a good assistant. It is evidence of a narrower thing: the offline
provider answers from the same `knowledge.ts` table the dataset was generated
from, and it is checked against examples built from that same table. It is
scoring a lookup against its own source.

The number that would be interesting is the model arm, and that arm could not be
run. The honest summary is: **the offline path is not embarrassing, and nothing
has been demonstrated about the model.**

What the eval *does* establish today, and it is worth something: the offline path
refuses out-of-scope questions correctly (4/4), never fabricates a price or an
opening time with no grounding (11/11), and uses the app's vocabulary (6/6). Those
are the behaviours a demo actually depends on.

---

## 5. Running it when the platform recovers

```bash
export NUGEN_API_KEY=…

# offline only (no key needed)
npm run assistant:eval

# the comparison
npm run assistant:align
npm run assistant:eval -- --models base,customized

# one arm, annotated
npm run assistant:eval -- --models customized --tag "post-realign"
```

`--models base` deliberately sends the base model id, and only in this harness.
`provider/config.ts` has no base-model fallback, so the app at runtime can never
do this. The arm exists so the customization claim becomes a number.

| Option | Default | Meaning |
|---|---|---|
| `--models` | `offline` | Comma list: `offline`, `base`, `customized`. |
| `--tag` | — | Free-text note recorded in the report. |

The report lands at `data/ai_assistant/reports/eval-<timestamp>.{md,json}`, with
`latest.md` / `latest.json` as copies.

**When it runs, the report will contain a table like this** — and, unlike this
document, with real numbers in it:

```
## Base vs customized

| metric         | base | customized | change |
| -------------- | ---: | ---------: | -----: |
| refusalCorrect |  …   |          … |  +… pts |
| noFabrication  |  …   |          … |  −… pts |

Mean latency: … ms -> … ms
```

Note the sign convention on latency: a slower customized model is not
automatically a better one, and the harness prints the delta rather than a verdict
so a reader can weigh it.

---

## 6. Honest gaps

- **No human evaluation.** Nobody rated a reply for helpfulness. Every number here
  is a property check, and a property check cannot tell you the assistant is
  *good*.
- **No multi-turn scoring.** The test split contains `multi-turn` examples, but
  each is scored on its final answer only. Whether the model correctly resolved a
  follow-up against the earlier turn is not measured.
- **Single-turn generation.** `evaluate` uses the non-streaming path. Streaming
  has the same prompt, so the content should match, but it is not separately
  measured.
- **A 24-example set is small.** A one-example change moves a rate by 4 points.
  The per-example JSON is committed precisely so a reader can see *which* examples
  moved rather than only the rate.
- **`performance_metrics` from Nugen's own benchmark** is not surfaced, because no
  run produced one. It would be `MANUAL` in the final audit rather than a
  fabricated score.
