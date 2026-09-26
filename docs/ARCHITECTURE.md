# ARCHITECTURE — Ananta

Decisions: [`DECISIONS.md`](DECISIONS.md) · Contracts: `src/contracts/index.ts` ·
Research: `research/findings/00-SYNTHESIS.md` · Features:
[`FEATURES.md`](FEATURES.md)

---

## 1. The one architectural commitment

> **The recommendation engine is pure TypeScript. No LLM in the decision path.**

The LLM does three things: natural-language understanding, explanation narration,
and offline data enrichment. Nothing else.

This is not a style preference — it is what makes the rest of this document
possible:

| Consequence | Because |
|---|---|
| The eval harness means something | A deterministic engine has a reproducible output |
| The demo cannot break on a rate limit | `LLM=off` still produces a full plan |
| Explanations are auditable | Every score component is a number we computed, not a sentence a model wrote |
| Replans are fast and cheap | No model in the loop |
| The claim is defensible | 71 reference repos. Three of them keep the LLM out of the decision path; the closest to our design also re-derives the objective in an independent validator |

And the counter-evidence, which is why we are strict about it: **the projects
that leaked, leaked the same way.** Someone let the model write the *ordering*,
then tried to catch it with a prompt. Containment at the prompt layer is what
leaks; containment at the schema and validator layers is what holds. We have all
three, and we make boundary violations a build failure.

## 2. System shape

```
┌──────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                             │
│  Next.js App Router · React 19.2 · MapLibre + OpenFreeMap            │
│  src/app  ·  src/components/{ui,map,fit}          [KARAN]            │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ typed contracts both ways
┌───────────────────────────▼──────────────────────────────────────────┐
│  SERVER  (route handlers, src/app/api)                               │
│  chat ──► src/llm ──► OpenRouter (fallback chain, circuit breaker)   │
│                                      [VISHWESH]                      │
│  discover ──► src/engine (pure) ──► src/db ──► src/data             │
│                            [ABHIJIT]                                 │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│  SQLite via node:sqlite   (WAL, FTS5 + bm25(), json1, geopoly)       │
│  experiences · experiences_fts · reviews · slots · bookings          │
│  interactions · unmet_demand · weight_profiles · city_manifests      │
│  embeddings (BLOB, nullable) · provenance                            │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ best-effort, cached, snapshot fallback
┌───────────────────────────▼──────────────────────────────────────────┐
│  EXTERNAL  (every one keyless, every one cached, every one optional) │
│  Overpass ×3 mirrors · Valhalla isochrones + matrices · OSRM ·        │
│  Nominatim · Open-Meteo · Openverse + Wikimedia images · OpenRouter  │
│                                                                       │
│  Reachability measured on this host — see DECISIONS D10: Valhalla up, │
│  OSRM 404s on every path, Overpass unreachable. Isochrones and         │
│  matrices are committed, so none of this is on the demo path.         │
└──────────────────────────────────────────────────────────────────────┘
```

`src/engine` imports **nothing** from `src/llm`, `src/db`, or Next.js. That is
enforced by a test.

## 3. Module map

| Module | Stage | Owns | Sibling ports learned from |
|---|---|---|---|
| `engine/hours.ts` | ② | OSM `opening_hours` → window check, via the npm port | `spatie/opening-hours` semantics |
| `engine/travel.ts` | ② | routing facade: OSRM / Valhalla / haversine fallback, congestion multiplier, transit corridors | `routingpy` adapter shape |
| `engine/geo.ts` | all | haversine, isochrone client, cluster primitive | `@turf/turf` |
| `engine/retrieve.ts` | ① | FTS5 BM25 + tag facets + geo prefilter | `RecBole` retrieval stage |
| `engine/feasibility.ts` | ② | 12 hard checks, emits `Rejection[]` | `haniabdemai/event-recommender` veto rules |
| `engine/scoring.ts` | ③ | scalarised utility, Bayesian ratings | `RecBole` metrics |
| `engine/packer.ts` | ④ | clique peel → cluster order → 2-opt/Or-opt under LAHC | `ITINERA` (production at TuTu), `PyVRP` ILS |
| `engine/validator.ts` | ⑤ | independent recompute, reject on drift | `FloatTrip` `validate_solution` |
| `engine/replanner.ts` | ⑥ | diff vs `original`, minimal swaps, named ladder | `FloatTrip` 3-tier relaxation |
| `engine/bandit.ts` | ③ | Thompson sampling on the weight profile | standard contextual bandit |
| `llm/nlu.ts` | — | NL → `DiscoveryContext` patch, confidence gate | `Plan-It` (6 fields, 2 dead, `confidence >= 0.5`) |
| `llm/narrate.ts` | — | plan → sentences | `XRec` (feature-grounded) |
| `llm/enrich.ts` | offline | OSM row → inferred attributes | UGuideRAG's 3-dimension *schema* only |
| `llm/client.ts` | — | provider chain + breaker | `mediamtx` adapter pattern, simplified |

## 4. Data model

Sixteen tables. SQLite, so the types are the simple ones.

```sql
experiences          -- the catalogue. ONE row, all attributes, per-field provenance
  id TEXT PK, name, category, lat, lon, duration_min INT, price_minor INT NULL,
  capacity INT NULL, hours_raw TEXT NULL, hours_status, hours_verified TEXT NULL,
  indoor_outdoor, step_free INT NULL, stroller_ok INT NULL, low_stairs INT NULL,
  hearing_loop INT NULL, restroom INT NULL, kid_friendly INT NULL, min_age INT NULL,
  diets JSON, cuisines JSON, rating REAL, rating_count INT, rating_mean REAL NULL,
  blurb, description, keywords JSON,
  landscape JSON, activities JSON, atmosphere JSON,          -- 3 perception dims
  best_time_of_day JSON, requires_journey INT, weather_sensitive,
  book_required INT, lead_time_min INT, walk_in INT,
  best_months JSON, provider_id TEXT NULL, neighbourhood, city,
  provenance JSON,                                         -- field -> Provenance
  search_blob TEXT,                                        -- FTS5 input

experiences_fts       -- FTS5 virtual table over search_blob, bm25() ranking
slots                 -- availability. capacity is the ONLY number. No `remaining`.
bookings              -- request/response with an enforced transition table
booking_events        -- audit: every transition, who, when, why
providers             -- listing owner
reviews               -- author, date, party_type, party_size, spend
interactions          -- the bandit + analytics stream
unmet_demand          -- zero-result searches with top blocking constraint
weight_profiles       -- learned per-traveller weights
city_manifests        -- bbox, monsoon, congestion model, transit corridors
embeddings            -- BLOB, nullable. 3 rows per experience when enabled
```

### Two schema decisions worth defending

**`slots` has no `remaining` column.** Availability is **derived** by subtracting
committed counts in priority order — confirmed orders, then pending, then carts.
This is pretix's design and it is the single best idea in the whole reference
set: overselling becomes **structurally impossible** rather than merely unlikely,
and a cancellation needs no counter to reconcile. A `remaining` column is a
cache that will eventually lie.

**Every POI is one row, all attributes together.** TripWeaver keeps separate
restaurant / attraction / hotel / accommodation lists and therefore cannot
express price or category inside its solver — item identity is assigned
post-hoc by enumeration order. One row, all attributes, so the feasibility gate
is a flat predicate and the packer can reason about category diversity.

## 5. Money, time, and coordinates

Three rules, because three bugs are guaranteed otherwise.

- **Money is always integer minor units** (paise). Never a float. `1500` rupees
  is `150000`.
- **Time is always integer minutes from local midnight.** Never a `Date` inside
  the engine. The `Date` ↔ minutes boundary lives in exactly one module
  (`lib/time.ts`) and everything else takes integers.
- **Distance is metres on Web-Mercator (EPSG:3857).** Cluster thresholds are in
  metres and are linear in trip duration, from the only empirically grounded
  table we found:

  | Window | Clusters | Candidates | Radius |
  |---|---|---|---|
  | 1 h | 1 | 3 | 2 000 m |
  | 8 h | 4 | 17 | 9 000 m |

## 6. The feasibility gate

Twelve checks, cheapest first, and **every drop emits a `Rejection`**. This is
the part the whole product rests on, so the shape matters more than the count.

```ts
filterFeasible(ctx, items): { passed: string[]; rejected: Rejection[] }
```

A `Rejection` is `{ experienceId, code, message, shortfall, unit, relaxable }`
where `message` is a **finished sentence with real numbers**: *"Needs 40 min more
than you have left"*, *"₹300 over your per-person limit"*, *"Closed — opens
tomorrow 09:00"*.

Two consumers, and this is why it is a first-class value rather than a log line:

1. **Traveller** — the "why not this" panel, when they ask about something
   missing.
2. **Provider** — aggregated into `UnmetDemand` with `topBlockingCode` and
   `topBlockingCount`, then surfaced as a `ProviderOpportunity`. The shape of one
   is a finished sentence with a count in it: *"N travellers near you wanted a
   step-free craft workshop under ₹500 on Thursday evenings, and you were the
   only match."* N is a real count from the log, or the suggestion is not shown.

That aggregation is the acquisition channel. It is the answer to the provider
half of the problem statement, and it costs almost nothing to build.

## 7. Scoring, packing, validating, relaxing

**Score** is one scalar, split into named `ScoreComponent`s. Never mix
`minimize` and `maximize` — that lexicographic trap is exactly what silently
defeats TripWeaver's relaxation. A single number, with a `profileVersion`, is
also what lets the validator recompute it independently.

**Pack** is cluster-then-route, not TSP on the shortlist:

```
radius graph over feasible candidates  (metres, edge if d < thresh)
  → Bron-Kerbosch max clique, peel, repeat        diameter-bounded clusters
  → order clusters by summed score, take top 2–4
  → per cluster: cheapest-insertion → 2-opt → Or-opt
  → stitch clusters at closest POI pair
  → if short of stops, harvest the best from an adjacent cluster
```

Accepted under **LAHC + restart-from-best + adaptive penalties** — the only
anti-local-optima mechanism we found in the systems tier of the corpus, and 15
lines.

**Validate** independently: recompute the objective from the `Plan` and reject
if `objectiveDelta > 1e-6`. There is a negative test that corrupts a plan and
asserts the validator catches it.

**Relax** down a named ladder, never a silent fallback:

| Rung | What it gives up |
|---|---|
| `strict` | nothing |
| `dropped_minimum` | minimum 2 stops → 1 |
| `greedy_fill` | ordering optimality, just fill the window |
| `single_best` | the whole plan is one option |

The UI always shows which rung was used. "Relaxed: minimum 1 stop instead of 2"
is honest, specific, and demo-able. An unsat core would be better — **if the
reference implementation actually had one, which it does not.**

## 8. Booking state machine

Medusa's pattern, without Medusa: a **transition table that throws**.

```
requested ──► confirmed ──► completed
    │             │
    ├──► declined └──► cancelled
    └──► cancelled
```

- `state` and `status` are **orthogonal axes**, not one field.
- Illegal transitions throw at runtime, not silently.
- `compensateInput ≠ output` — cancelling a booking has a different effect than
  confirming it.
- **Idempotency by deterministic transaction id** — a retried request or a
  double-click cannot double-decrement capacity.
- Every transition writes a `booking_events` row with actor and reason.

Oversell prevention, in the order pretix uses, because the order is the whole
point:

```
1. begin transaction
2. take the lock        (advisory lock on slot, xact-scoped, 3 s timeout)
3. RE-COUNT from source of truth   (never trust a cached remaining)
4. ASSERT sufficient
5. insert the booking row
6. commit — lock releases
```

Lock timeout → retry → "busy", not a 500.

## 9. LLM boundary

```
user text ──► src/llm/nlu.ts ──► DialogueDecision
                                    │
                       contextPatch  (the ONLY permitted effect)
                                    │
                                    ▼
                          DiscoveryContext mutated
                                    │
                                    ▼
                     engine.replan()  ← deterministic, no model
```

`DialogueDecision` carries `{ contextPatch, reply, confidence, suggestions }`.
It **cannot** name a recommendation, reorder a plan, or edit a feasibility
result. Enforced by an import-boundary test.

Confidence gate at `0.5`, borrowed from Plan-It (6 LLM fields, 2 of them dead
code, gated on `confidence >= 0.5`). Below it we ask a clarifying question
instead of acting.

**Deterministic fallback is mandatory.** A regex/keyword parser produces the
same `DiscoveryContext` when the model is unavailable, and the whole product
works with `LLM=off`. The eval suite must pass in that mode.

Provider chain: `google/gemini-2.5-flash-lite` (1.4 s, verified) →
`deepseek/deepseek-v4-flash` (1.9 s, verified) → deterministic parser. OpenRouter
free-tier models are rate-limited (429s, 60 s timeouts) and are never primary.

For AI SDK v7 specifically: `generateObject` / `streamObject` are **deprecated**
in favour of `generateText({ output: Output.object({ schema }) })`; there is no
OpenRouter provider, so we use `@ai-sdk/openai-compatible` with a `baseURL`; and
the flag that actually matters is `supportsStructuredOutputs: true`, which
switches the wire from `json_object` to real `json_schema` + `strict`.

## 10. Caching and degradation

Every external call is cached, and every cache has a fallback.

| Call | Cache | Fallback |
|---|---|---|
| Overpass | SQLite, keyed by rounded bbox | **committed offline snapshot** |
| OSRM / Valhalla | SQLite, keyed by coord pair + profile + time band | haversine × mode speed factor |
| Nominatim | SQLite | city centroid |
| Open-Meteo | 30 min TTL | simulated condition, labelled `source: 'simulated'` |
| Images | on disk, attributed | category placeholder |
| LLM | **keyed by the deterministic result**, not the prompt hash | regex parser |

Caching LLM output keyed by the deterministic result is deliberate, and Vercel's
own docs warn why: **caching raw text in front of structured output is a
hallucination amplifier.** Cache the *narration*, never the *decision*.

## 11. Testing strategy

| Layer | What | Owner |
|---|---|---|
| Engine unit | each check, each rejection message, hours edge cases | A |
| Golden | the eval suite — 25–30 scenarios with expected-acceptable sets | V writes, A runs |
| Negative | corrupted plan must fail `validate()` | A |
| Property | packer never exceeds `availableMin`; never returns a duplicate | A |
| Boundary | **an LLM import in `src/engine/` fails the build** | A |
| Component | Vitest + Testing Library on the 8 skeleton patterns and the meter | K |
| E2E | Playwright over the exact demo path | K |
| `LLM=off` | the whole eval suite passes | A |

The last two are what protect a live demo. Everything external is mocked or
served from the committed snapshot.

## 12. Security and privacy

- Row-level auth on providers and bookings. Traveller rows are per-session.
- No PII in analytics. `UnmetDemand` stores constraints, never identity.
- Input safety: NFKC → zero-width strip → homoglyph normalise → regex, in that
  order, then reject. No order matters more and the last one matters most.
- Guardrails **fail closed** on malformed input. JauntAI's fail-open topic
  guardrail is the wrong default.
- LLM output parsed with a real parser, never `JSON.parse` on a string we then
  trust.
- Scrape nothing behind a login. OSM, Overpass and the keyless endpoints only —
  logged with the endpoint that served each fact.

## 13. Scaling beyond the prototype

Honest about where this breaks:

| Limit | Symptom | Fix |
|---|---|---|
| ~10k experiences | FTS5 still fine; the `O(n²)` clustering hurts | Precompute clusters per grid cell |
| ~50k | `node:sqlite` writes serialise | Move to libSQL/Turso (same schema) or Postgres |
| Concurrent writes | WAL helps readers, not writers | Provider console is low-write; fine at hackathon scale |
| Transit routing | seeded corridors do not generalise | Valhalla + GTFS, behind the existing `travel.ts` facade |
| Embeddings | single blob per experience | 3 rows, one per perception dimension, behind the `Embedder` interface |

The seams are already in place: `CityManifest` for geography, the `travel.ts`
facade for routing, `Embedder` for vectors, and `provenance` for trust. None of
those decisions needs redoing to grow.
