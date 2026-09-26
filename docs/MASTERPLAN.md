# MASTERPLAN — TravelBuddy (Ananta)

> Don't optimise for places. **Optimise for moments.**

Research codename: ATHITI · Supersedes `research/ATHITI_MASTERPLAN_V2.md` and
`research/TRAVELBUDDY_MASTERPLAN_FINAL.md` · Decisions: [`docs/DECISIONS.md`](DECISIONS.md)

---

## 0. Read this if you read nothing else

We are three people with one week. The plan below is not ambitious — it is
**achievable and demo-able**, and every claim in it has been checked against
real code in 71 reference repositories rather than taken from a paper's abstract.

Three things to internalise:

1. **The engine is deterministic TypeScript. The LLM is never in the decision
   path.** It does natural-language understanding, explanation narration, and
   offline data enrichment. Nothing else. This is why the eval harness means
   anything, and it is the one thing most of the reference projects get wrong.
2. **Nothing can be recommended that does not fit.** Time budget, budget,
   opening hours, capacity, group fit, accessibility, weather, distance — these
   are hard filters, not ranking weights. A card either passes or it is not
   shown, with a recorded reason.
3. **Every fact says where it came from.** Curated, provider, OSM, inferred,
   derived. An AI-inferred field is labelled as one, always.

---

## 1. The problem, stated honestly

A traveller in Mumbai has three hours and a hotel in Colaba. They want local
food and something cultural, they're four people with a toddler, they can spend
₹1,500, it might rain, and they need step-free access for an older relative.

Today they get a list of nearby restaurants sorted by rating. That list is wrong
in nine different ways at once: half of it is closed, the good ones are 40
minutes away in traffic, none of it is step-free, the ₹800 tasting menu blows
the budget, and the kid-friendly options are 6 km away.

And the other half of the problem: the local potter, the Koli fishing
community, the Textile Museum guide, the ghazal singer — they have no way to
reach a traveller who is standing 2 km away right now and would love what they
do. Both failures are the same failure: **no shared, structured, timely
representation of what fits whom, where, and when.**

## 2. What we are actually building

A **fit-first discovery engine** with two surfaces:

- **Traveller:** drop a pin, say what you want, get a time-boxed chained plan
  where every stop demonstrably fits. Change reality, and the plan re-solves and
  tells you what it swapped and why.
- **Provider:** a listing, real availability, a request inbox, and — the part
  that matters — an **unmet-demand feed** telling them what travellers nearby
  searched for and could not get, and which single constraint killed it.

The differentiator is not "AI recommendations". It is that we treat a
recommendation as something that must **fit**, and we show our work.

## 3. The pipeline

```
DiscoveryContext
  │
  ├─ ① RETRIEVE    FTS5 BM25 over name/description/keywords
  │                + tag facets + isochrone prefilter        → ~120
  │
  ├─ ② FEASIBLE    hard gate. Every drop gets a Rejection     → ~12–25
  │                { code, human sentence, shortfall, unit }
  │
  ├─ ③ SCORE       utility model, scalarised, with per-traveller
  │                weights learned by a Thompson-sampling bandit
  │
  ├─ ④ PACK        cluster-then-route, beam search + 2-opt/Or-opt
  │                under LAHC with adaptive penalties        → 2–4 stops
  │
  ├─ ⑤ VALIDATE    independent re-derivation of the objective;
  │                reject if objectiveDelta > 1e-6
  │
  └─ ⑥ RELAX       named ladder: strict → drop minimum → greedy
                   → single best. Always says what it gave up.
```

Six stages, not three. The retrieval stage existed because reading RecBole made
it obvious we were about to jump from context straight to the filter.

### 3.1 What the feasibility gate checks

Hard, in this order, cheapest first:

| Check | Rejection code |
|---|---|
| isochrone contains origin? | `too_far` |
| `travel + duration + buffer ≤ availableMin` | `travel_time_exceeds_budget`, `duration_exceeds_budget` |
| open for the whole visit window? | `closed_now`, `closed_during_window`, `hours_unverified` |
| `price × partySize ≤ budget` | `over_budget`, `over_budget_per_person` |
| `capacity ≥ partySize` | `capacity_exceeded` |
| every `AccessNeed` satisfied? | `not_step_free`, `not_stroller_ok`, … |
| diets satisfiable? | `diet_mismatch` |
| slot not sold out? | `sold_out` |
| bookable without too little notice? | `requires_booking_not_available`, `lead_time_too_short` |
| safe in this weather? | `weather_unsafe` |
| not already in the plan / not excluded? | `duplicate`, `already_planned`, `excluded_by_traveller` |
| in season? | `seasonal_mismatch` |

Each rejection carries a **finished sentence with real numbers**: *"Needs 40 min
more than you have left"*, not *"constraint violated"*. Two consumers: the
"why not this" panel, and the provider unmet-demand feed.

### 3.2 Scoring

One **scalar**, split into named components, so it is auditable and re-derivable.
We deliberately do not mix `minimize` and `maximize` — that lexicographic trap
is exactly what defeats TripWeaver's relaxation.

Components: interest match, Bayesian-smoothed rating (Wilson lower bound,
weighted by sample size), value-for-money, local-authenticity, weather fit,
peak-hour crowd penalty, novelty vs. what is already planned, group fit,
superlinear travel-friction penalty, provider reliability.

Weights are per-traveller, learned by Thompson sampling from the interaction
stream, and **shown to the traveller** in a "what I learned about you" panel. A
recommendation you cannot interrogate is just a vibe. Nothing is learned without
being visible and editable.

### 3.3 Packing

Cluster-then-route, from ITINERA (deployed in production at TuTu, thousands of
users):

1. Build a radius graph over feasible candidates (Web-Mercator metres).
2. Peel maximum cliques with Bron–Kerbosch → **diameter-bounded** clusters.
3. Order clusters by summed score; take the top 2–4.
4. Order the cluster tour: cheapest-insertion → 2-opt → Or-opt.
5. Stitch clusters at their closest POI pair.
6. If short of stops, harvest the best remaining from an adjacent cluster.

Accepted under **LAHC + restart-from-best + adaptive penalties** — the only real
anti-local-optima mechanism found in any of the 71 repos.

### 3.4 Validation and relaxation

The packer's output goes to an **independent validator** that recomputes the
objective from scratch and rejects on any drift > 1e-6. This is FloatTrip's
pattern and it is the reason we can trust our own engine.

On failure, walk a **named** ladder — `strict` → `dropped_minimum` → `greedy_fill`
→ `single_best` — and surface which rung was used and what it cost. "Relaxed:
minimum 1 stop instead of 2" is a far better demo than an unsat core, and unlike
an unsat core it is honest: the reference implementation we would have copied
does not actually have one.

## 4. Adaptive replanning

The PS explicitly asks for it. Our `DiscoveryContext` keeps `original` forever,
and the replanner diffs **against that**, never against the last mutation. That is
masterplan principle 3: *don't replace the user's intent when reality changes.*

Triggers we support, all demo-able in one click:

| Trigger | Effect |
|---|---|
| It started raining | outdoor/covered items lose the weather gate; indoor ones gain |
| We lost 90 minutes | re-pack into the smaller window, prefer fewer, closer stops |
| This one's sold out | pin the rest, re-solve, emit a minimal swap set |
| Budget dropped to ₹600 | prune to what fits, show what was cut |
| The toddler needs a bathroom | add `restroom` to `accessNeeds` |
| They're tired | soften the pace, raise the Stress Radar |

Every replan returns `Swap[]` with a written reason and a score delta. **The
number of swaps is the demo metric**: aim for ≤2.

## 5. Explainability

Not a feature bolted on — it is the thesis.

- **Why this** — ranked score contributions, each a finished sentence.
- **Why not that** — the `Rejection` for a specific thing the traveller asked
  about. Usually surfaced when they tap something that did not appear.
- **The feasibility meter** — `activity ▸ travel ▸ buffer` against the remaining
  window, overflow in the alarm colour. The signature UI element.
- **Provenance badges** — every inferred field says so.
- **What I learned about you** — the learned weights, editable.
- **The Stress Radar** — 7 weighted dimensions, 0–100, with one concrete
  "Rescue move" for the single worst factor.

## 6. Data strategy

Three layers, because raw OSM cannot carry this product. Measured, not assumed:

| Layer | What it is | How we get it |
|---|---|---|
| **Spine** | Real coordinates, names, categories, addresses, partial hours | OSM via Overpass, 3 mirrors with failover, cached, **committed offline snapshot** so the demo never touches the network |
| **Experience** | ~250 curated Mumbai + Navi Mumbai records with the fields OSM lacks: duration, price, capacity, kid-friendly, step-free, indoor/outdoor, booking, seasonality, best time of day | Hand-authored from local knowledge. ~2 person-days. **This is the demo catalogue** |
| **Signals** | Reviews (author, date, party type, party size, spend), festival/event calendar | Seeded. Powers Bayesian ratings and the "reviews mention: gets crowded after 5pm" insight |

**The measurement that forces this:** a Bandra West bbox returns 199 POIs. 91%
have `name`; 16% have `opening_hours`; 1% have `wheelchair`; 0% have `fee`; and
OSM has no ratings at all. A pure "scrape and list" build cannot satisfy a single
graded factor.

Plus **LLM enrichment** for the OSM long tail: infer duration, price band,
family-suitability and accessibility from name + category, each field tagged
`inferred` with a confidence, run offline, cached, and visibly labelled.

## 7. Scale to more cities

A **city manifest** — bbox, neighbourhoods, timezone, currency, monsoon months,
congestion model, transit corridors — plus a city-agnostic engine. No
Mumbai-specific logic lives in `src/engine/`. Adding a city is: add a manifest,
run the harvest, curate. `CITY_MANIFEST` in the contracts is the schema.

Navi Mumbai first, because it stresses the model properly: planned grid versus
island city, ferry corridors, and a genuinely different travel-time structure.

## 8. Team

Three people, three streams, **zero file overlap**. The ownership map is in
[`TASKS.md`](../TASKS.md) and the contracts that make it safe are frozen in
`src/contracts/index.ts`.

| | Owns | The one thing only they can do |
|---|---|---|
| **Abhijit** | Data, engine, ML | The engine that makes the whole thing true |
| **Karan** | UI/UX | The feasibility meter, which is the thesis made visible |
| **Vishwesh** | Features, provider side, content | The provider flywheel, and the eval scenarios |

## 9. What we are deliberately not doing

Stated so nobody relitigates it in the middle of the week:

- **No payments, commission, payouts or disputes.** Requests, not transactions.
- **No Z3, no OR-Tools, no Python service.** See `DECISIONS.md` D2.
- **No real-time "vibe" sensing.** It is a saturated market and the PS is not
  about it. Atmosphere is retrospective, from review text, clearly attributed.
- **No multi-agent group negotiation.** Real, higher effort, good phase 2. We
  ship shared constraints + per-person personas + a visible tension axis.
- **No Google Maps scraping.** ToS. See `research/rejected/`.
- **No learning-to-rank.** We have no training data. Interpretable features plus
  a bandit are more honest and demo better.
- **No gamification, no proof-of-presence.**
- **No Orama.** No Marathi tokenizer, no SQLite backend. FTS5 is primary.

## 10. Non-negotiable engineering principles

1. **The LLM never decides.** It proposes; the engine disposes. An LLM import in
   `src/engine/` is a **build failure**, enforced by a test.
2. **A rejection is a feature, not an error.** If we cannot say why something is
   missing, the engine is not finished.
3. **Never replace the traveler's intent.** Diff against `original`, forever.
4. **Every number is an estimate or it is sourced.** Congestion multipliers,
   travel times and inferred attributes are labelled as such.

## 11. Success criteria

Not "shipped". Shipped **and measured**:

| Metric | Target | Why it matters |
|---|---|---|
| Constraint-satisfaction rate | **100% by construction** | No card shown that violates a hard constraint |
| Time utilisation | > 85% of the stated window | We are not wasting their time |
| Coverage | ≥ 90% of eval scenarios yield a plan | The engine fails gracefully, not silently |
| Replan swaps per context change | ≤ 2 | The adaptive claim, quantified |
| Travel per stop | < 1.8 km median | The Mumbai reality check |
| Provider unmet-demand accuracy | ≥ 80% of suggestions actionable | The flywheel is real |
| Eval suite passes with `LLM=off` | yes | Proves we do not depend on a model being up |

The last one is the credibility anchor. It is in `docs/EVAL_SPEC.md`.
