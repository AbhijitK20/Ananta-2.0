# EVAL SPEC — for Vishwesh (author) and Abhijit (runs)

> The credibility anchor. A demo proves the product works. An eval table proves
> you know whether it does.

---

## 1. Why this exists

We will be tempted to believe our own numbers. Every hackathon recommender
screenshots its best result. The counter is a fixed scenario suite with
human-labelled acceptable sets, run automatically, with a **baseline to beat**
printed next to our numbers.

Two rules make it honest:

1. **Every scenario must pass with `LLM=off`.** If it needs a model, it is
   testing the wrong thing.
2. **The baseline is the naive thing.** Not a strawman — the actual thing a
   reasonable person would ship: FTS5 text match, sort by rating, take the top
   N, ignore time and budget entirely.

## 2. Run it

```bash
npm run eval              # full table
npm run eval -- --llm-off
npm run eval -- --json    # for the deck
```

Output goes to `docs/EVAL_RESULTS.md` and is committed. A regression is visible
in the diff.

## 3. Scenario format

`content/eval/scenarios.jsonl`, one per line, typed by `src/contracts`:

```ts
{
  id: "family-2h-rain-stepfree",
  title: "Family of four, toddler, 2h, ₹1,500, rain, step-free",
  context: DiscoveryContext,          // full, realistic, IST
  acceptableIds: string[],            // what a competent curator would pick
  forbiddenIds: string[],             // must never appear
  forbiddenBecause: { [id]: RejectionCode },
  expectCoverage: boolean,            // must a plan exist at all?
  assertions: {
    minUtilisation?: number,          // default 0.85
    maxSwaps?: number,                // after a context change
    minStops?: number,
    maxStops?: number,
    requireReasonedStop?: boolean,    // every stop has a real why-ledger
  },
  replan?: { change: ContextChange; expectAddedIds: string[]; maxSwaps: number },
  why: "one line — what this is testing"
}
```

## 4. Metrics

### Hard constraints — pass/fail, no averages

| Metric | Target | Note |
|---|---|---|
| Constraint satisfaction | **100%** | By construction. Any violation is a bug, not a low score. |
| No forbidden item shown | 100% | With the **correct** `RejectionCode` for each |
| Every rejection has a finished message | 100% | No "constraint violated" |
| Every stop has a non-empty why-ledger | 100% | |
| `preservedIntent` after a replan | 100% | Principle 3 |

### Quality — the numbers we report

| Metric | Target | Why |
|---|---|---|
| **Time utilisation** | > 0.85 | `plannedMin / availableMin`. The headline. A recommender that fills 40% of a window is not respecting the window. |
| Coverage | ≥ 0.90 | % of `expectCoverage: true` scenarios producing a plan. The engine fails gracefully. |
| **Top-5 precision** | vs. `acceptableIds` | Standard RecSys metric — `RecBole` |
| **NDCG@10** | vs. `acceptableIds` | Standard, and better than precision for ranked lists |
| MRR | vs. `acceptableIds` | Rewards putting the right thing first |
| Median travel per stop | < 1.8 km | The Mumbai reality check. If a plan makes us cross the city twice, it is wrong. |
| Replan swaps | ≤ 2 per trigger | The adaptation claim, quantified |
| Relaxation rung used | distribution reported | If we silently sit on `greedy_fill` everywhere, the packer is not good enough |
| **Improvement over baseline** | > 2× utilisation | The "we are not a list" proof |

### Provider side

| Metric | Target |
|---|---|
| Unmet-demand suggestions actionable | ≥ 80% |
| Suggestions with a supporting count | 100% |
| Duplicate suggestions (already offered) | 0 |
| Booking capacity integrity | no oversell across 1,000 randomised concurrent request pairs |

## 5. Baseline

Not a strawman. The best honest comparison we can build in the time:

```
FTS5 text match on the context's interests
  → sort by Bayesian rating
  → take top N
  → ignore availableMin, budget, capacity, accessibility, weather entirely
```

That is roughly what a competent engineer's first afternoon produces, and it is
what most submissions will do. If we cannot beat it on utilisation *and*
constraint satisfaction, we have not earned the architecture.

## 6. The 28 scenarios

Written from the traveller's voice. Grouped by what they break.

### Core fit (1–6)

| # | Scenario | Tests |
|---|---|---|
| 1 | Family of 4, toddler, 2h, ₹1,500, rain, step-free, near a Colaba hotel | The PS's own example. The whole pipeline. |
| 2 | Solo backpacker, 6h, no constraints | Cold start, diversity, must not return 6 restaurants |
| 3 | 45 minutes, nothing booked | Tiny window. Graceful degradation. |
| 4 | ₹0, "just a walk somewhere nice" | Zero budget. Free-only path. |
| 5 | 8 hours, everything open | Upper bound, over-long plans, ordering |
| 6 | 2 adults, wants to be alone | Negative-only. Avoids crowd noise. |

### Accessibility (7–10)

| # | Scenario | Tests |
|---|---|---|
| 7 | Wheelchair user, 90 min, monsoon | `not_step_free` must bind; restroom; indoor |
| 8 | Stroller, 3h, uneven ground | stroller filter |
| 9 | Elder with low stairs + hearing loop | Rare compound need |
| 10 | Someone who needs a restroom, 60 min | The single most common hidden constraint |

### Party and dietary (11–14)

| # | Scenario | Tests |
|---|---|---|
| 11 | Jain/veg, lunch, near a temple | Multi-tag diet filter with a narrow window |
| 12 | Teen (16) + grandparent (70), 3h, one wants to hike | Group tension made visible, not averaged |
| 13 | 3 adults, one Jain, budget tight | Party size × diet × budget interaction |
| 14 | Business traveller, 40 min between meetings | Extreme tightness, opening-hours boundary |

### Time and hours (15–18)

| # | Scenario | Tests |
|---|---|---|
| 15 | 23:00, 2h — night market and live music | Night hours, `bestTimeOfDay`, day boundary |
| 16 | 06:00, shift worker | Early morning — most places closed. Graceful. |
| 17 | Lunch 12:30–14:00 exactly | `opening_hours` window precision, meal placement |
| 18 | Place with `hoursStatus: unparsable` | Must not 500. Must not silently pass. |

### Weather and season (19–20)

| # | Scenario | Tests |
|---|---|---|
| 19 | Heavy rain, 3h, ₹1,200 | `weather_unsafe`; beach drops; indoor rises |
| 20 | Heat wave, 11:00–16:00 | `weather_sensitive: heat`, outdoor penalized |

### Geography (21–23)

| # | Scenario | Tests |
|---|---|---|
| 21 | Navi Mumbai CBD → South Mumbai, 2h, transit only | Ferry + rail corridors, seed table |
| 22 | Two islands, peak hour, 1h | Congestion multiplier. Must not trust free-flow. |
| 23 | Origin is not a landmark — a residential lane | Geocoding fallback, centroid heuristic |

### Negative and preference (24–25)

| # | Scenario | Tests |
|---|---|---|
| 24 | "I don't want tourists" | Negative channel, no positive request at all |
| 25 | "Something local, not a chain" | Authenticity signal in scoring |

### Adaptation (26–28)

| # | Scenario | Tests |
|---|---|---|
| 26 | Plan built, then 90 minutes lost | ≤ 2 swaps, intent preserved |
| 27 | Plan built, then heavy rain | ≤ 2 swaps, outdoor→indoor |
| 28 | First stop sells out mid-session | Pin the rest, minimal replacement, no duplicate |

## 7. Assertions per scenario, beyond the universal ones

| # | Extra assertions |
|---|---|
| 1 | `minStops: 2`, `minUtilisation: 0.85`, every stop `stepFree === true` or `null` |
| 2 | `maxStops: 5`, at most 2 stops share a category |
| 3 | `expectCoverage: true` — must produce something, even if it is 1 stop |
| 4 | every stop `pricePerPerson === null \|\| pricePerPerson.minor === 0` |
| 5 | `maxStops: 5`, total cost within budget |
| 6 | ≥ 1 stop with `atmosphere` containing a solitude-ish term |
| 7 | every stop `stepFree !== false`, ≥ 1 with `restroomOnSite === true` |
| 8 | every stop `strollerOk !== false` |
| 10 | every stop `restroomOnSite === true` |
| 11 | every stop `diets` intersects the requirement |
| 12 | the tension is visible: at least one stop serves both halves |
| 15 | ≥ 1 stop, every stop `night` in `bestTimeOfDay` or not flagged closed |
| 16 | `expectCoverage: true` |
| 17 | visit window fully inside the place's open interval |
| 18 | no 500, and the hours-unverified badge appears |
| 19 | no `weatherSensitive: 'rain' \| 'any'`-outdoor stop unless `forecastNote` justifies it |
| 21 | every leg `mode === 'transit'` or `estimated === true` |
| 22 | reported travel time > 2× the straight-line distance at peak |
| 24 | ≥ 2 stops, and none in the top-10 tourist list |
| 26–28 | `replan` block, `maxSwaps: 2`, `preservedIntent: true` |

## 8. Output format

`docs/EVAL_RESULTS.md`, regenerated on every run:

```
Scenario                       cov  util  top5  ndcg@10  mrr   swaps  status
family-2h-rain-stepfree       ✓    0.91  0.80  0.78     1.00  -      PASS
solo-6h-open                  ✓    0.88  0.60  0.55     0.83  -      PASS
45min-nothing-booked          ✓    0.97  1.00  1.00     1.00  -      PASS
...

AGGREGATE   coverage 26/28 (0.93)  util 0.87  top5 0.71  ndcg 0.68  mrr 0.84
BASELINE    coverage 26/28 (0.93)  util 0.31  top5 0.34  ndcg 0.29  mrr 0.41
VIOLATIONS  0    FORBIDDEN 0    UNREASONED 0    ERROR 0
LLM=off     PASS (28/28)
```

**The baseline row is the one a judge reads.** Utilisation 0.87 against 0.31 is
the entire argument for the architecture, in one number.

## 9. What we report if we fail

Report it. A published failure with a diagnosis is worth more than a hidden
bug, and the eval suite is only credible if it is allowed to fail.

Known-risky, predicted before we run:

- **Scenario 12** (teen + grandparent) — we have shared constraints and per-person
  personas, but no negotiation. Expect it to average. The honest fix is to
  surface the tension rather than resolve it.
- **Scenario 21** (Navi → South, transit only) — the transit corridors are
  hand-seeded. Expect gaps.
- **Scenario 22** (peak, two islands) — the congestion multiplier is a
  heuristic. Expect it to be directionally right and not precise.

## 10. Timeline

| When | What |
|---|---|
| Day 2 | 8 scenarios, first 4 running end to end |
| Day 3 | 20 scenarios |
| Day 5 | All 28 authored, harness complete |
| Day 6 | `npm run eval` green, baseline compared, `LLM=off` passing |
| Day 7 | `EVAL_RESULTS.md` in the deck |

**Day 6 is the gate.** If the table is not green, the deck says so.
