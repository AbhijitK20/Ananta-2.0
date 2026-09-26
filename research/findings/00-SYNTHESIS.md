# ATHITI — Research Synthesis & Implementation Guide

**What this is.** Five parallel deep-dives across 67 cloned reference repositories produced
~14,900 lines of evidence-graded notes in this folder. This file is the distillation: what to
build, what to copy, what the literature gets wrong, and what we must decide.

| Report | Lines | Domain |
|---|---|---|
| `01-traveler-uiux.md` | 1,153 | Screens, timeline, map coupling, confidence surfacing, cards, empty states, a11y |
| `02-engine-internals.md` | 2,906 | Request decomposition, cluster-then-route, penalty encoding, VRP, minimal TS design |
| `03-marketplace-booking.md` | 2,580 | Capacity model, oversell prevention, workflow engine, auth, state machines |
| `04-data-retrieval.md` | 2,300 | OSM tag semantics, Overpass, opening_hours, isochrones, geo utils, MapLibre perf |
| `05-llm-integration.md` | 5,999 | AI SDK v7, the engine/LLM boundary, chat UX, memory, guardrails, evaluation |

### Masterplan lineage — read in this order

| Doc | Status |
|---|---|
| `../Local-Experiences-Masterplan.md` (90 KB, 36 sections, 17 features) | v3. Origin of the provider/booking sections. Still the deepest product spec. |
| `../ATHITI_MASTERPLAN_V2.md` (v4) | Superseded v3. Introduced the five research upgrades, incl. the Z3 proposal. |
| **`../TRAVELBUDDY_MASTERPLAN_FINAL.md` (648 lines)** | **The baseline.** Says it "consolidates and supersedes the prior TRAVELBUDDY_MASTERPLAN.md, the source-trail reference table, and the CONTEXT_TRAVEL_BUDDY.pdf working notes." Brand: **TravelBuddy / ANANTA**, *"Don't optimize for places. Optimize for moments."* |

Note the naming has churned across documents — **TravelBuddy (Ananta)** and **ATHITI** are the same
project. Pick one before anything gets committed.

**Good news:** the new baseline's §25 core principle is *"LLM proposes; deterministic systems
verify"*, and its §9 pipeline (hard veto pre-filter → weighted scoring → diversity → feedback
learning) is the same architecture this synthesis recommends. The research did not overturn the
design — it sharpened it.

**Every claim in the five reports is tagged `repo/path:line`.** Where a README or a paper overstates its
own code, we recorded the discrepancy rather than the intent. **27 such claims did not survive
checking** — see §6. Several of them are load-bearing in the current masterplan.

---

## 1. The three decisions this research forces

### 1.1 Do not adopt Z3. Do adopt penalty minimisation.

`ATHITI_MASTERPLAN_V2.md` §2.11 made Z3 the centrepiece, and the current baseline
`TRAVELBUDDY_MASTERPLAN_FINAL.md` carries it forward into **§20 (stack: "Optimization/Validation: Z3 (constraint solving/relaxation), OR-Tools (routing)")** and **§25 principles 1 and 2** ("deterministic systems (Z3, OR-Tools, PostGIS arithmetic) verify"; "Z3 handling conflict detection and relaxation"), plus §21 naming TripWeaver the "Foundation of Z3 constraint-solving architecture"**. It originally ("the single most valuable upgrade in
this version") on the claim that TripWeaver derives *automatic minimal relaxation* from a Z3
**unsat core**. Read the code (`systems/tripweaver/`, 2,072 lines across three files):

| The plan claims | The code does |
|---|---|
| `unsat_core()` yields the minimal conflicting constraint set | `unsat_core()` is called at `:684` on a solver with **zero** `assert_and_track` calls (verified: 0 occurrences). It always returns empty. |
| Relaxation is derived algorithmically | A fixed, hand-written demotion of exactly **two** hard constraints (`s_start >= preferred_start_time`, `sleep >= 8h`) to penalty variables. No loop, no re-solve. |
| The solver reads its own unsat explanation | `prompts/solve_*.txt` writes `unsat_info.txt`. **No code anywhere reads that file.** Recovery is re-rolling the LLM. |
| `minimize(total_penalty)` prioritises the relaxation | `opt.minimize` (`:406`) and `opt.maximize` (`:502`, `:590`) on one `Optimize` object are **lexicographically ordered** — the penalty objective has the *lowest* priority. The relaxation is silently defeated. |

Independently, the tooling does not support the plan's stack either:

- Python `z3-solver` 5.1.0 — mature, fine.
- npm `z3-solver` **is** official (maintained by the Z3 authors) — and unusable as shipped on Node:
  `init()` returns an emscripten module whose high-level `Context` is empty, and the low-level
  `Z3_*` namespace exposes **zero** callable functions. Verified by installing it.
- **OR-Tools has no Node binding at all.** `ortools` and `node-ortools` are absent from npm. And
  across the entire 67-repo corpus, `routing.Model` / `RoutingIndexManager` /
  `ortools.constraint_solver` appear in **no repo** — everyone uses `cp_model` only.

**Verdict.** Our constraint set is filter-and-rank within one neighbourhood over 2–4 hours, not a
multi-day multi-city scheduling CSP. Take the *technique* — penalty variables under a minimised
objective, which gives per-constraint violation magnitudes for free — and implement it inside our
beam search in ~150 lines of TypeScript. One language, no native dependency, far easier to explain
live. **Revisit Z3 only if scope grows to multi-day itineraries.**

### 1.2 Three research systems are substantially broken. Do not model your architecture on them.

This is the most uncomfortable finding, and it changes which repos we cite for *design*:

| System | Problem found in code |
|---|---|
| **UGuideRAG** (ACM SIGSPATIAL 2025) | `SpatialSolver.py` imports only `from scipy.spatial.distance import cdist`, then calls `scipy.spatial.distance.cdist` (`:25`) and `nx.Graph()` (`:28`) with `networkx` never imported → **`NameError` on the spatial stage**. `get_candidates() → get_ordered_candidates() → route_planner()` are all dead. Retrieval is **not** per-dimension: three cosines are computed in one pass and linearly combined with hard-coded weights `0.6/0.5/0.5` summing to **1.6** (`SearchEngine.py:156`) — no normalisation, no per-dimension top-k, no `avoid` channel. Its selection loop (`:73-84`) is an unbounded `while True` with no iteration cap. |
| **TripWeaver** | Relaxation defeated by lexicographic objective (above). Generated code is `exec`'d raw (`:406`, `z3_code_execution.py:192`) with only three string replacements as sanitisation. The `Array`/`Select` model encodes only `city → count`; price, category and dedup are unrepresentable. `BASE_PATH` (`L835`) points at a directory absent from the repo, so the script cannot run. |
| **ITINERA** | Genuinely production-deployed and the best of the three, but: `find_clusters_containing_all_elements` (`utils/funcs.py:321-340`) `break`s after the first hit, so it returns clusters containing **any** must-see, not all — contradicting its own name and docstring. The general fallback path uses a hardcoded `thresh=1000` m regardless of trip length. The start-point LLM result is discarded on the main path (`itinera.py:425`). |

### 1.4 The closest prior art is one nobody had cloned yet

`TRAVELBUDDY_MASTERPLAN_FINAL.md` §21 says its §9 engine was *"directly shaped"* by
`haniabdemai/event-recommender` — **30+ hard veto rules, ~25 weighted signals, then an LLM
sense-check**. It was not in the original research list, so we cloned it
(`systems/event-recommender-engine/`) and **verified the claim holds**: the README states it
explicitly and the pipeline directory carries `apply_findings.py`, `sync_verdicts.py`,
`write_ready_check.py`, `verify_event_dates.py` — a veto/verdict architecture, not a chatbot.

This is the closest thing in all 71 repos to our feasibility gate plus ranking model: a hard-veto
pre-filter, weighted signals on survivors, and the LLM consulted **only on judgement calls the rules
cannot make**. Read it before writing `scoring.ts`.

**What survives from each:** ITINERA's `TIME2NUM` table, max-clique-peel clustering, closest-pair
stitching and the sum-of-cosines re-merge rule. UGuideRAG's *three-dimension schema* (a genuinely
good idea) — but not its implementation. TripWeaver's penalty-encoding idea — but not its solver.

### 1.3 The marketplace conflict is unresolved and it is the biggest scope fork.

- Masterplan v4 §3 lists an explicit exclusion: **"no booking marketplace"**.
- Masterplan **v3** (the 90 KB `Local-Experiences-Masterplan.md`) contains *Feature 14 Provider
  Dashboard*, *Feature 15 Provider Experience Creation*, *Phase 5 — Availability & Booking*, and
  *Feature 16 Review & Reputation Intelligence*.
- **You** told me directly: "Full marketplace loop."

Three sources, three positions. This needs a decision before any code is written, because it
changes the data model, the auth surface, and ~2 person-days.

---

## 2. The engine — concrete TypeScript design

Synthesised from `02-engine-internals.md` §9. Roughly 1,200–1,380 lines of dependency-free TS.

### 2.1 Pipeline

```
DiscoveryContext
  → RETRIEVE   FTS5 BM25 + tag facets + isochrone prefilter        → ~100 candidates
  → FEASIBLE   hard gate, emits RejectionLedger per candidate        → ~10–25
  → SCORE      utility model × learned bandit weights
  → PACK       beam search + 2-opt/Or-opt under LAHC                → chained plan
  → VALIDATE   independent re-derivation, rejects on delta > 1e-6
  → RELAX      named 4-step ladder when validation fails
```

### 2.2 Request decomposition — use ITINERA's real fields, not the three axes in the plan

The plan describes three axes. The code has a **four-field LLM record**
(`itinera.py:177-199`, `itinera_en.py:174-210`):

```ts
type Axis = 'location' | 'itinerary' | 'starting point' | 'ending point';
type Polarity = 'require' | 'prefer' | 'avoid' | 'fact';   // floattrip/chat/models.py:23

interface DecomposedRequest {
  pos: string;              // want  (negation must be extracted OUT of pos)
  neg: string | null;       // avoid
  mustsee: boolean;         // specificity: is `pos` a named place?
  type: Axis;               // granularity
}
```

No dataclass, no rules — 100% GPT-4o with a `json.loads` → regex → `{}` fallback chain. Re-merge is
**sum of cosines across requests, minus cosine of the `neg` terms** (`itinera.py:237`,
`search.py:113-117`) — four lines, and it works.

**Gap to close ourselves:** ITINERA fuzzy-matches must-see names at `score > 91` and *silently drops*
them on failure. For us a dropped must-see is a wrong answer, so that path must throw.

### 2.3 Cluster-then-route — the algorithm worth copying

Not DBSCAN, not k-means. **Maximum-clique peeling on a radius graph** (`itinera spatial.py:50-87`):

```
Euclidean distance on Web-Mercator metres;  edge if d < thresh
loop:  largest clique via nx.find_cliques  →  emit as a cluster  →  remove its nodes
```

Clusters are **diameter-bounded**, deterministic, need no `k`, and have no empty-cluster problem.
Routing is SA-TSP on cluster centroids → rotate the tour to open the heaviest edge → stitch
clusters at their closest POI pair → solve the open TSP per cluster.

The budget→scale table is the only empirically grounded mapping in the corpus (`itinera.py:25`,
linear in hours):

| Trip hours | clusters | POIs | radius (m) |
|---|---|---|---|
| 1 | 1 | 3 | 2000 |
| 8 | 4 | 17 | 9000 |

Take also: 1.5-sigma radial outlier prune (`:24-48`), heaviest-edge rotation (`:288-295`),
closest-pair stitching (`funcs.py:294-317`), and the score constants `1000 / 900 / 10` (`:238`,
`funcs.py:144`) which make downsampling provably preserve must-sees.

### 2.4 Scoring — one frozen, versioned, auditable scalar

From FloatTrip, the best-engineered of the seven and **the only one that keeps the LLM out of the
route**. Its `optimizer.py:380-400` achieves assignment + sequencing + subtour elimination with a
single `AddCircuit` (constant-1 closing arc + self-loops). We do the same semantics in ~80 lines:

```
cheapest-insertion  →  2-opt  →  Or-opt        (no solver, no PuLP/CBC)
```

Accepted under **LAHC + restart-from-best + adaptive penalties** — the only real anti-local-optima
mechanism anywhere in the corpus (`pyvrp/PenaltyManager.py:181-231`,
`IteratedLocalSearch.py:255-278`). 15 lines, and it beats hill-climbing.

Scalarise the objective. Never `minimize` and `maximize` on the same object (see §1.1).

### 2.5 The validator is what makes this trustworthy

FloatTrip's `optimizer.py:705-812` runs an **independent** post-solve check with 13 named violation
classes, including *"recompute the objective and reject if `delta > 1e-6`"*, and explicitly refuses
to let a diagnostic ratio hard-fail the plan. This is the pattern to copy verbatim.

`02-engine-internals.md` §9.8 adds re-solve rules no repo implements: per-day warm start, and
pinning already-booked items across a context change.

### 2.6 The relaxation ladder, honestly

FloatTrip's three-tier ladder (`optimizer.py:320-330`) — strict → drop-daily-minimum → greedy — is
the working alternative to unsat cores, and it is what we should present in the demo. Each rung is
**named**, so the UI can say *"relaxed: minimum 1 stop instead of 2"*.

---

## 3. The data layer — six things that change the build

From `04-data-retrieval.md`, plus my own live verification.

1. **Use the npm `opening_hours` port — it parses OSM format.** (Correcting the report: the
   underlying PHP package does *not* parse OSM syntax, but the npm port does. Verified:
   `getOpenIntervals` on `Mo-Fr 09:00-18:00` returns `03:30Z–12:30Z` = 09:00–18:00 **IST**;
   `getOpenDuration` returns 9 h.) Use `getOpenIntervals`, not a boolean — the gate needs the actual
   windows. `PH off` and inline comments are unsupported, so wrap in an adapter that degrades to
   "hours unknown" rather than throwing. LGPL-3.0, hence the adapter.
2. **Valhalla isochrones work with no API key.** `valhalla1.openstreetmap.de/isochrone` returned a
   real 15-minute GeoJSON polygon over Mumbai in **0.89 s**, verified live. That is the only free
   isochrone source we have, and it is multimodal. `routing.openstreetmap.de` gives keyless
   `routed-car` and `routed-foot` (note: its *default* profile is bike, so always set it explicitly).
3. **OSRM is free-flow, which is wrong for Mumbai by 3–5× at peak.** GraphHopper's `custom_model`
   is **POST-`/route` only** (`docs/core/custom-models.md:169-170`) — it cannot touch an isochrone,
   and custom models have no time predicate. So a congestion multiplier must be a **second profile
   file** (`car_mumbai_peak.json`) selected client-side by IST clock, or a client-side multiplier.
4. **GraphHopper 3.0 removed `routing.ch.disabling_allowed` and throws on it**
   (`GraphHopper.java:462-466`). Any config written from pre-3.0 docs crashes on boot.
5. **Skip Orama.** 11k stars, but no Marathi/Devanagari tokenizer (Hindi and Nepali are supported)
   and no SQLite backend — it would mean a second datastore. FTS5 stays primary. SQLite FTS5 with
   `bm25()` ranking, `json1`, `geopoly` and WAL are all verified working on `node:sqlite`.
6. **Model tags as the schema defines them, not as intuition suggests.** `fee` and `check` are
   **3-state** (`SCHEMA.md:418`) so `fee` must be `boolean | null`, not boolean. `cuisine` is
   `semiCombo` with a 103-value *suggestion* list that is missing `mughlai`, `maharashtrian` and
   `chaat` — so it is an **open vocabulary, not an enum**. `smoking` and `internet_access` are the
   only genuinely closed enums. `access` matters more than `fee` for our accessibility filtering.
   Do **not** model `opening_hours:covid` (no field definition); model `check_date`.

---

## 4. UI/UX — the patterns to build

From `01-traveler-uiux.md`. Ranked by payoff for a 90-second demo.

| # | Pattern | Source | Effort |
|---|---|---|---|
| 1 | **Inter-stop travel connector** — a hairline *sibling* of the stop list, not a property of a stop: `[icon] {duration} · {distance}`, clickable to change that leg's mode | `TREK/.../Planner/DayPlanSidebarRouteConnector.tsx:14-36` | S |
| 2 | **Time budget as countable blocks** — a bar masked with `repeating-linear-gradient`, one block per 30 min, overrun as a hatched tail. Masked, so it is real holes not paint | `TREK/.../Roadtrip/RangeStrip.tsx:57-72` | S |
| 3 | **Trip Stress Radar** — 7 weighted dimensions (`overload .25`, `pinDebt .18`, `weatherRisk .14`, `transitComplexity .10`, `fomoRisk .13`, `spreadRisk .12`, `reservationRisk .08`), three labels (`"High friction"` / `"Needs tuning"` / `"Trip feels sane"` at 68/38), and exactly **one** "Rescue move:" sentence for the worst factor only | `nomadnote/components/TripStressRadar.tsx:120-246` | M |
| 4 | **Per-day energy meter** — bar for a glance, number in the text as truth, `title` attribute for detail | `nomadnote/components/ItineraryBuilder.tsx:123-160` | S |
| 5 | **Accessibility as yes/no pills with glyph AND word** — `🐶 Yes` / `🐶 No` in green/red. The *negatives* are the decision-grade information | `trip-tracker/.../place-box-content.component.html:19-43` | S |
| 6 | **Map↔list that opens the cluster** — `revealInCluster()` → `getVisibleParent(marker).spiderfy()`. Solves "I clicked a card and nothing happened" | `TREK/.../Map/markerCluster.ts:47-64` | S |
| 7 | **Radius "Search this area" that re-arms on pan** — ladder `1/2/5/10/20/50 km`, re-arms at >0.002° drift, plus a real geofence circle | `AdventureLog/.../routes/map/+page.svelte:515-560,1226-1293` | M |
| 8 | **Cluster counts as HTML, not glyphs** — because raster basemaps and blocked glyph endpoints. The comment in the source says exactly why | `AdventureLog/.../FullMap.svelte:313-352` | S |
| 9 | **Best zero-result string found anywhere** — `"No recommendations in this area. Try a larger radius."`, paired with cause-branching (`"No places match your search"` vs `"No places yet — add your first one!"`) and `Try: {example}` chips | `AdventureLog` + `nomadnote` | S |
| 10 | **`inert` + grid-rows collapse** for disclosure panels, with a `prefers-reduced-motion` override — the only correct collapse pattern found | `trip-tracker/.../trip.component.html:337`, `styles.scss:373-390` | S |
| 11 | **Per-tier user font scaling** — `calc(12px * var(--fs-scale-body,1))`; the rule is that value and unit always share a tier. Real a11y feature, ~free | `TREK/client/src/index.css:762-765`, `Roadtrip/typeScale.ts:16-38` | S |
| 12 | **One hex = pill fill + marker colour + chip tint** via `color-mix()` for the dark variant | `TREK/.../poiCategories.ts:20-32` | S |

**Not found in any repo — we must design these ourselves**, which is precisely where our
differentiator lives: a per-POI *"fits your time / budget"* score; group-size and child-age input;
a request-to-host flow; host/provider listing editor with availability; range sliders for time and
budget; a horizontal or calendar-grid itinerary.

**MapLibre performance facts that matter** (`adopt/maplibre-gl-js/src`): use `circle` layers at all
zooms (one instanced quad per point, no placement pass) and reserve `symbol` for ≤20 live labels.
The load-bearing one: **`cluster: true` disables partial tile reload entirely**
(`geojson_source.ts:575-577`), so clustered and live-hit layers must live in *separate* sources or
you lose `updateData` speedups. Hit-test `circle`, not `symbol` — collision-hidden symbols are not
queryable. De-dup `e.features` by id (tile buffering guarantees duplicates). Use `promoteId`, not
`generateId`, or hover state dies on `setData`. `clusterProperties` gives a live
"12 of 40 open now" cluster label.

**Caveat on provenance:** `adopt/shadcn-ui`'s sparse checkout originally had no templates, and
`adopt/vercel-ai`'s had no code at all. Both were caused by a bug in my `fetch.sh` (a `sparse-checkout
set` missing `--no-cone`, which writes the include-nothing default `/*` + `!/*/`). Fixed in
`fetch.sh`, repaired by `repair-sparse.sh`, verified: all 30 sparse clones now populated. **The
UI/UX report was therefore written partly against the teammate's full clones at the repo root**
(`TREK/client/src`, `AdventureLog/frontend/src`) — which are the better sources anyway.

---

## 5. Marketplace & booking

From `03-marketplace-booking.md`.

**Capacity is derived, not stored.** pretix has **no remaining-capacity column**. `Quota.size` is
the only number (`models/items.py:2068`); availability is computed by subtracting five counts in
priority order — paid/pending orders → vouchers → carts → waiting list
(`services/quotas.py:226-500`). Four states: `GONE / RESERVED / ORDERED / OK` (`items.py:2046-2049`).
Cancellations free capacity automatically, so there is no counter to reconcile. **This is the
single best idea in the report** — it makes oversell structurally impossible rather than merely
unlikely.

**Oversell prevention** (`services/locking.py:100-122`): **Postgres advisory locks**, xact-scoped,
`pg_advisory_xact_lock` on Quota/Voucher/Seat and shared locks on Event, with `lock_timeout = 3s`;
`select_for_update` as the MySQL fallback. The ordering is **lock → re-count → assert**
(`services/orders.py:776-799`, then `models/orders.py:1109-1128`). Not a DB constraint, not
optimistic, not a counter. Lock timeout → Celery retry → "busy" (`orders.py:3214-3227`).

**Medusa: do not build it, steal four ideas.** `createStep(name, invokeFn, compensateFn?)`
(`composer/create-step.ts:434-467`), and specifically: (1) **orthogonal `state` × `status` axes**
(`utils/src/orchestration/types.ts:16-35`); (2) an **enforced allowed-transition table that throws**
(`transaction-step.ts:90-126`); (3) `compensateInput ≠ output`; (4) **idempotency by deterministic
transaction id** (`transaction/types.ts:156-159`). Durable execution does exist as a
`workflow_execution` table (`workflow-engine-inmemory/.../workflow-execution.ts:4-58`).

**Trust modelling:** trustroots' `Experience` is one row per *ordered* pair, unique on
`(userFrom, userTo)`, with `recommend: yes | no | unknown` and `public: false` by default. Simple
and right for us. rox's 21-status member enum is a **liability** — they needed `ACTIVE_ALL` SQL
string hacks. Do not copy it.

**Group modelling** (from `ai-tour-meeting`): constraints are **shared**, personas are
**per-person**, with an `alignment: aligned | mixed | conflicting` axis and a ready-made tension
taxonomy. The 1-hour highest-payoff item in the whole marketplace report is **pre-seeding
`alignment: 'conflicting'` personas** — it makes group tension visible and is a strong demo beat.

**Prioritised verdict for a 1-week hackathon:** ~12 mechanisms to build (~13 h for the core loop),
16 to skip. The `rejected/` tier exists so the skipped ones stay skipped.

---

## 6. LLM integration

From `05-llm-integration.md`.

**Vercel AI SDK v7 specifics that will bite us** (versions from the clone: `ai@7.0.116`,
`@ai-sdk/openai-compatible@3.0.57`, `@ai-sdk/react@4.0.119`):

- `generateObject` / `streamObject` are **deprecated**. v7 is
  `generateText({ output: Output.object({ schema }) })`
  (`packages/ai/src/generate-object/generate-object.ts:120`).
- There is **zero OpenRouter support** in the SDK. Two routes: `@ai-sdk/openai-compatible` with a
  `baseURL`, or `@ai-sdk/openai` with a `baseURL` override. tripsage-ai uses the latter and calls
  `.chat()`, not `.responses()` (`registry.ts:145-151`).
- The load-bearing flag is **`supportsStructuredOutputs: true`**, which switches the wire from
  `response_format:{type:"json_object"}` to real `json_schema` + `strict`
  (`openai-compatible-chat-language-model.ts:279-293`).
- ⚠️ `@ai-sdk/react` peer range is `"react": "^18 || ~19.0.1 || ~19.1.2 || ~19.2.1"` — four disjoint
  allow-lists. **React 19.0.0 exactly and 19.3+ are both excluded.** We are on 19.3.0. Either pin
  React to 19.2.x or skip `@ai-sdk/react` and stream raw SSE. Node ≥22, ESM-only.

**The boundary, and where it leaks.** FloatTrip is the reference:
`weather → search → candidate_builder(LLM) → optimizer(CP-SAT) → quality_gate(independent
recompute) → finalize`, with one repair loop. Three artefacts make it trustworthy:
`build_authoritative_candidates` (whitelist join + server top-up + rule precedence + per-drop
warning codes + `semantic_source: "rule" | "llm"`), `validate_solution` (13 named violation classes
including the objective-delta check), and a `test_architecture_boundaries.py` that makes a boundary
violation a **build failure** — including banning `import re` in the NLU layer.

**FloatTrip still leaks in three places**, which is the honest finding: its `planner` node is a full
LLM route author with prompt-only containment; papers are substring-matched over LLM name drift;
and `meal_scene` can stay LLM-derived.

Plan-It is the purest: 6 LLM fields, 2 dead, gated on `confidence >= 0.5`.

**The rule holds.** Every leaking repo fails the same way — someone let the model write the
*ordering*, then tried to catch it with a prompt. **None of them has a validator.** FloatTrip proves
the deterministic path works: its `optimizer` + `quality_gate` replaced a planner/reviewer loop for
the formal path entirely.

**Memory:** FloatTrip's `memory_facts` is the only corpus artefact with everything right —
explicit-vs-inferred, sensitivity, evidence, supersession, soft delete, PII blocking. Notably
`status="candidate"` never auto-activates, and its rule *"a chat can scope a fact out but never
delete it"* (`不得编造 ID，也不得借此删除长期记忆`).

**Input safety:** JauntAI's guardrail is **topic-only** — no injection, no PII, and it **fails
open**. tripsage's ordering is better: NFKC → zero-width → homoglyph → regex. Plan-It catches
`<|...|>` special tokens.

**Cache by deterministic result, not prompt hash** (FloatTrip's `route_fingerprint`). Vercel warns
that caching raw text in front of structured output is a hallucination amplifier.

---

## 7. What still needs deciding

| # | Decision | Why it blocks |
|---|---|---|
| 1 | **Marketplace: in or out?** | v4 says out, v3 says in, you said full loop. Changes data model, auth surface, ~2 person-days. |
| 2 | **One language or two?** | Our recommendation is now pure TS with no Z3/OR-Tools, which removes the only real forcing function for Python. v3/v4 still want FastAPI + Postgres/PostGIS/pgvector + Redis + BGE embeddings. |
| 3 | **React version pin.** | `@ai-sdk/react` excludes 19.3. Pin 19.2.x, or drop it and stream SSE. |
| 4 | **Embeddings: yes or no?** | v3/v4 assume BGE per perception dimension + pgvector. Adds a model dependency, a second datastore, and embedding latency. The 3-dimension *schema* is worth having even if the vectors are a single embedding. |
| 5 | **Name.** | Is it ATHITI or TripFit? |

## 8. Suggested build order, given the above

1. Scaffold + zod contracts for `DecomposedRequest`, `Poi`, `ScoreProfile` (§2.2, §2.3)
2. `opening_hours` adapter + feasibility gate → **the eval harness with 25–30 scenarios** (§2.5 validator)
3. Scoring + beam search + LAHC (§2.4) + the named relaxation ladder (§2.6)
4. Fit Console: travel connector, time-block bar, Stress Radar, why-ledger (§4 items 1–5, 9)
5. Replanner on context change, with the independent validator
6. Provider console — *only after* decision #1
7. Chat sidecar with `DialogueDecision` as the single model output permitted to affect chat actions
8. Docs, eval table, demo video, deck
