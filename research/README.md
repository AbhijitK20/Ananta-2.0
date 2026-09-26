# TripFit research folder

Reference implementations we studied while designing TripFit, cloned locally so
the team can **read the actual code** instead of guessing at a pattern from a
blog post.

These repos are **not vendored dependencies**. Runtime dependencies come from the
npm registry at install time. Everything here is shallow-cloned
(`--depth 1`), and 17 of them are blobless partial clones that skip the datasets,
docs sites, test fixtures and logs we will never read. Total footprint ~470 MB.

## Why this exists

TripFit's differentiator is a **constraint-fit engine**: hard-filter by time,
budget, opening hours, capacity, group fit and accessibility, *then* rank what
survives, *then* pack a time-boxed itinerary, *then* re-solve when reality changes.
Most hackathon entries skip straight to "list nearby places sorted by rating".

Building that honestly requires answering questions we should not answer by
guesswork, so each repo below is pinned to a commit and annotated with the
specific thing we take from it — or the specific reason we rejected it.

## The seven tiers

| Tier | Meaning |
|---|---|
| `adopt/` | Installed as an npm dependency. Cloned so we can read how it's built. |
| `systems/` | **Published, code-released research solving this exact problem.** The strongest tier. Read before designing anything they already solved; cite in the deck. |
| `domain/` | Travel/hospitality product references. Not installed. Answer "what does a real travel product actually do?" |
| `data/` | POI data semantics, geocoding and retrieval. Decides what we can honestly store, query and rank. |
| `patterns/` | **Not installed.** We take an architectural idea, not the code. |
| `peer/` | Hackathon and AI travel-planner projects. Mostly small and low-star — read for techniques and for the competitive landscape, not as engineering exemplars. |
| `related/` | **Not installed.** Prior work. Cited in the deck; proves we know the field. |
| `rejected/` | Evaluated and declined. Cloned so nobody re-litigates it mid-build. |

## Findings — the distillation

`research/findings/` holds the output of a five-way parallel deep dive across all 67 repos
(~14,900 lines, every claim tagged `repo/path:line`).

| File | Lines | Domain |
|---|---|---|
| **`00-SYNTHESIS.md`** | ~300 | **Start here.** Distillation: what to build, what to copy, what the literature gets wrong |
| `01-traveler-uiux.md` | 1,153 | Screens, timeline, map coupling, confidence surfacing, cards, empty states, a11y |
| `02-engine-internals.md` | 2,906 | Request decomposition, cluster-then-route, penalty encoding, VRP, minimal TS design |
| `03-marketplace-booking.md` | 2,580 | Capacity model, oversell prevention, workflow engine, auth, booking state machine |
| `04-data-retrieval.md` | 2,300 | OSM tag semantics, Overpass, opening_hours, isochrones, geo utils, MapLibre perf |
| `05-llm-integration.md` | 5,999 | AI SDK v7, the engine/LLM boundary, chat UX, memory, guardrails, evaluation |

**27 claims from READMEs, papers and file names did not survive checking** — they are catalogued in
`02-engine-internals.md` §"CLAIMS THAT DID NOT SURVIVE CHECKING", and three of them
(UGuideRAG's spatial stage, TripWeaver's relaxation, the masterplan's Z3 story) are load-bearing
in `ATHITI_MASTERPLAN_V2.md`. Read the synthesis before trusting any of those papers again.

## Housekeeping

`repair-sparse.sh` exists because `fetch.sh` had a bug: its existing-clone path called
`sparse-checkout set` **without `--no-cone`**, so git wrote the include-nothing default
(`/*` + `!/*/`) and 11 clones ended up with a valid `.git` but an **empty working tree**. Fixed in
both scripts; `repair-sparse.sh` re-applies every declared pattern and verifies each tree is
populated. Run it after any re-clone.

## `systems/` — the tier that matters most

Cloned from the repo list in `ATHITI_MASTERPLAN_V2.md`, every URL verified against
the GitHub API:

| System | What it gives us |
|---|---|
| `systems/itinera` | arXiv 2402.07204, **deployed in production at TuTu with thousands of real users.** Request decomposition (granularity × specificity × attitude) + cluster-then-route. Source of our soft-constraint field schema. GPL-3.0. |
| `systems/uguiderag` | ACM SIGSPATIAL 2025. Landscape / Activity / Atmosphere extraction with per-dimension retrieval instead of one blended embedding. |
| `systems/tripweaver` | LLM + Z3 planner. `z3_temporal_scheduler_with_relaxation.py` is 888 lines. **Read the Z3 finding below before adopting it.** |
| `systems/tripcraft` | ACL 2025 Main benchmark (Microsoft + IIT Bhubaneswar). Source of the five continuous eval metrics. |
| `systems/ai-tour-meeting` | NTT Research. Persona-simulated group consensus instead of averaging preference vectors. |
| `systems/nomadnote` | "Trip Stress Radar" — overload / rain-risk / anchor-pressure / transit-complexity 0-100. |
| `systems/jauntai` | Multi-agent + domain guardrails + human-in-the-loop approval. Reference for an input-safety layer. |
| `systems/inkle` | Shipped evidence that a staged pipeline (Places → Route → Cost → Synthesizer) is implementable. |
| `systems/tourwise` | ML crowd "Busyness Index" folded into scoring. Method source for a `crowd_fit` feature. Cite-only; its code fetch is partial. |
| `systems/routemind-pritesh` | The masterplan flags this as modest-scope. Kept as a counter-example, not an authority. |
| `systems/tourism-spot-baseline` | Academic CF recommender. Baseline-quality comparison only. GPL-3.0. |

## Z3 finding — measured, not assumed

The masterplan proposes replacing hand-rolled constraint assertions with a **Z3 SMT
solver**, and claims this yields an *unsat core* from which minimal relaxation is
derived algorithmically. I checked both halves of that claim.

**The unsat-core half is not what the reference code does.** Reading
`systems/tripweaver/z3_temporal_scheduler_with_relaxation.py`, the actual technique
is **penalty-based soft constraints under `Optimize`**:

```
early_start_penalty >= 0
early_start_penalty >= preffered_start_time - s_start
...
opt.minimize(Sum([...early_start_penalties, ...short_sleep_penalties]))
opt.maximize(meal_score)
opt.maximize(attr_score)
```

That is not worse for us — it is arguably better. You need no unsat core at all: the
solver always returns a plan, and the per-constraint penalty values tell you
**exactly which constraints it violated and by how much**. Those violation
magnitudes *are* the relaxation ladder, obtained for free.

**The tooling half decides the stack.** Checked directly on this machine:

| Option | Result |
|---|---|
| Python `z3-solver` | **5.1.0.0** — mature, documented, pure `pip install` |
| npm `z3-solver` | Installs and loads on Node 24, and *is* official (maintained by the Z3 authors, `bakkot`/`levnach`). But its Node/CommonJS surface is unusable as shipped: `init()` returns an emscripten module whose high-level `Context` is empty, and the low-level `Z3_*` namespace exposes zero callable functions. Needs a spike. |
| OR-Tools for Node | **Does not exist.** `ortools` and `node-ortools` are both absent from npm. Python `ortools` is 9.15. |

**Recommendation: adopt the penalty-minimisation technique, skip the solver.** Our
constraint set (time budget, price, opening hours, capacity, group size,
accessibility, travel time) is a filter-and-rank problem within one neighbourhood
over 2–4 hours — not a multi-day, multi-city scheduling CSP. A feasibility gate plus
a weighted-penalty objective inside our beam search gives equivalent relaxation
behaviour in ~150 lines of TypeScript, keeps the whole system in one language, and
is far easier to explain live. Revisit Z3 only if scope grows to multi-day
itineraries.

## The five ideas that actually changed the build

1. **A retrieval stage existed at all.** `RecBole` and `RecSysDatasets` made the
   omission obvious: we were going to jump from context straight to the
   constraint gate. The pipeline is now
   `context → retrieve (FTS5 BM25 + tags + isochrone) → feasibility gate → rank → pack`.
2. **Isochrones instead of radius.** `galton` and `osrm-isochrone`. A 3 km
   crow-flies filter is actively wrong in Mumbai — 3 km across the harbour is not
   a 20-minute walk. Radius survives only as a fallback.
3. **Bookings became a durable workflow.** `medusa`'s step engine gave us the
   idempotent-step + compensation pattern for availability decrements, so a
   double-click or a retried request cannot oversell a slot.
4. **The explainability layer got academic backing.** `xrec` (EMNLP'24) and
   `pepler` (TOIS'23) generate explanations *grounded in user and item features*.
   That is exactly our why-ledger, and it is why every field carries a
   provenance label (`curated` / `provider` / `osm` / `inferred`).
5. **The eval table speaks standard RecSys.** `recbole` gave us Recall@K, NDCG@K
   and MRR to report next to our own constraint-satisfaction and time-utilisation
   metrics, and `crslab` gave us the user-simulator idea for testing the
   conversational path.

## Start here — reading order

If you are picking up this project cold, read in this order:

| # | Read | For |
|---|---|---|
| 1 | `ATHITI_MASTERPLAN_V2.md` (same folder) | The product thesis and the v4 upgrades. v3, which it supersedes, is 90 KB at `../travel-like-local/Local-Experiences-Masterplan.md` |
| 2 | `adopt/nextjs-boilerplate/src` | How we lay out the repo, validate env, wire lint/CI |
| 3 | `systems/itinera/main.py` | Request decomposition and cluster-then-route, validated in production |
| 4 | `systems/tripweaver/z3_temporal_scheduler_with_relaxation.py` | Penalty-based soft constraints. Read the 30 lines around `opt.minimize(total_penalty)` |
| 5 | `patterns/pyvrp/pyvrp` | `Model.py`, `PenaltyManager.py` — how time windows, capacity and precedence are modelled. Read before writing `packer.ts` |
| 6 | `patterns/medusa/packages/core/utils/src` | Workflow/step primitives we copy conceptually into the booking state machine |
| 7 | `data/id-tagging-schema/data/fields` | The tag semantics our zod schemas must match |
| 8 | `systems/uguiderag/Code` | Landscape/Activity/Atmosphere extraction |
| 9 | `systems/tripcraft/evaluation` | The five continuous metrics our eval harness will mirror |
| 10 | `domain/pretix/src/pretix/base` | Capacity, availability and order state machines for the provider side |
| 11 | `adopt/vercel-ai/content/docs` | Structured output, streaming, provider fallback |
| 12 | `adopt/maplibre-gl-js/src` | Style spec and source setup for our vector map |
| 13 | `related/recbole/recbole/evaluator/metrics.py` | Standard RecSys metric definitions |
| 14 | `adopt/opening-hours-php` | Correct OSM `opening_hours` semantics before we wrap it |
| 15 | `adopt/routingpy` | The provider-adapter shape our `travel.ts` follows |
| 16 | `peer/plan-it` | Someone else's deterministic-engine + optional-AI split, for comparison |

## Rejected, and why

Read `repos.tsv` for the full rationale. The two that matter most:

- **`rejected/tf-ranking`, `allrank`, `ptranking`** — learning-to-rank needs
  training data we do not have. Hand-designed interpretable features plus a
  contextual bandit are more honest and demo far better.
- **`rejected/google-maps-scraper`** — this scrapes Google Maps in breach of
  their ToS. It would have neatly filled our ratings gap, which is exactly why it
  is here: **do not use it.** Our equivalent is provider-submitted data (which is
  what a real marketplace has anyway) plus clearly-labelled LLM inference.

## Licences

These clones are read-only references. Two carry obligations if their code is ever
*copied* rather than merely read:

- `adopt/opening-hours-php` / npm `opening_hours` — **LGPL-3.0**. Keep it behind a
  thin adapter so it stays swappable.
- `adopt/turf` — MIT. `adopt/faker` — MIT. `adopt/better-auth` — MIT.

Most monorepos here (`shadcn-ui`, `maplibre-gl-js`, `vercel-ai`, `medusa`) keep
per-package licence files rather than a root one, which is why the manifest shows
an empty `license_file` for them. Check the individual package before reusing code.

## Operational notes

```bash
./fetch.sh              # clone anything missing, refresh MANIFEST.json
./fetch.sh --update     # also fast-forward existing clones to origin/HEAD
./fetch.sh --verify     # confirm each pinned commit still resolves upstream
./fetch.sh --resparse   # rebuild sparse/partial clones from the patterns in repos.tsv
./fetch.sh --force      # nuke and re-clone everything
```

`repos.tsv` is the source of truth. Columns: `tier`, `dir`, `url`, `purpose`,
`sparse` (git sparse-checkout include patterns, `-` for everything). A `url` of
`alias:<tier>/<dir>` points at an existing clone instead of making a second copy;
`raw:<url>` fetches a single file.

These clones are **gitignored** at the project root. Do not commit them — that
would add half a gigabyte of third-party code to our history.
