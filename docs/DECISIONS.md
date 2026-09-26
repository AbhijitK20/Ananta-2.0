# DECISIONS — the decisions we made, and why

Every contested question in this project, resolved. If you disagree with one of
these, change it **here** first and tell the other two — do not fork the codebase
around it.

Status key: **LOCKED** = build against it · **OPEN** = revisit at the checkpoint
marked.

---

## D1. Name — LOCKED

**Ananta.** That is the product name, in every document, on every screen, and in
the deck. The repository is `Travel-buddy`; that is a URL, not a brand.

The name churned during research, and the fix is to stop reusing retired names as
if they were current:

| Name | Status |
|---|---|
| **Ananta** | the product |
| TravelBuddy | retired — the repository name only |
| ATHITI | the **research** codename, so `research/` stays navigable |
| TripFit | retired — a working name that never shipped |

Every document header reads:

> Ananta — research codename ATHITI

**Do not introduce a new name for a new concept.** The product vocabulary is fixed
and listed in [`FEATURES.md`](FEATURES.md) § Terminology: Ananta,
`DiscoveryContext`, `DialogueDecision`, `Experience`, `Plan`, Replan, Unmet Demand,
Provider Opportunity. A screen that needs a new idea gets a new *label*, not a new
product noun.

## D2. Stack — one language — LOCKED

**TypeScript only.** Next.js 15.5.26 + React 19.2 + Node 22+, `node:sqlite`,
Drizzle. No Python service, no Redis, no Postgres, no pgvector.

This reverses the masterplan's §20 (FastAPI + PostgreSQL/PostGIS/pgvector +
Redis + BGE embeddings + Z3 + OR-Tools). We changed it because the research
removed the only things that forced Python:

| Masterplan required | What the research found |
|---|---|
| Z3 SMT solver | npm `z3-solver` is official but **broken on Node** — `init()` returns an emscripten module whose high-level `Context` is empty and whose low-level `Z3_*` namespace exposes **zero** callable functions. Verified by installing it. |
| OR-Tools routing | **No Node binding exists.** `ortools` and `node-ortools` are both absent from npm. Across all 71 reference repos, `routing.Model` / `RoutingIndexManager` / `constraint_solver` appear in **none** — everyone uses `cp_model`. |
| Why an SMT solver at all | TripWeaver's unsat-core relaxation **does not work**: `unsat_core()` is called on a solver with zero `assert_and_track` so it always returns empty; no code reads the `unsat_info.txt` it writes; and `minimize` + `maximize` on one `Optimize` object is lexicographic, so the penalty is lowest-priority and the relaxation is silently defeated. |

**We keep the technique, not the solver**: penalty-based soft constraints with a
minimised total penalty, implemented in ~150 lines of TypeScript inside our beam
search. It gives per-constraint violation magnitudes for free, which is exactly
the relaxation ladder we want to show in the demo.

Postgres/Redis/pgvector are deferred. SQLite is sufficient for 250 curated rows
plus an OSM spine, and `node:sqlite` gives us FTS5 with `bm25()`, `json1`,
`geopoly` and WAL — all verified working.

**Revisit if:** the demo needs multi-day itineraries, or we get Postgres creds.

## D3. React pinned to 19.2 — LOCKED

`@ai-sdk/react@4.0.119` declares
`"react": "^18 || ~19.0.1 || ~19.1.2 || ~19.2.1"` — four disjoint allow-lists, so
React **19.0.0 exactly** and **19.3+** are both excluded. `package.json` pins
**19.2.0**.

We do not use `@ai-sdk/react` at all (we stream raw SSE), but pinning anyway keeps
the door open.

**Revisit if:** the SDK ships a wider peer range.

## D4. Marketplace — LIGHTWEIGHT, not transactional — LOCKED

The three sources disagreed:

- masterplan v4 §3: explicit exclusion, "no booking marketplace"
- masterplan v3: *Feature 14 Provider Dashboard*, *Feature 15 Provider Experience
  Creation*, *Phase 5 — Availability & Booking*
- Abhijit, directly: "full marketplace loop"

**Decision: build the provider side, but as listings + booking *requests*, with
no payments and no commission.** Rationale:

- The PS explicitly asks for it: *"the platform may allow local businesses and
  experience providers to create listings, manage availability, define
  offerings."*
- A request/accept loop is ~1.5 person-days and is genuinely demo-able.
- Payments, payouts and refunds are ~4 person-days and are worth nothing to a
  judge.
- The half that actually differentiates us is the **Unmet Demand → Provider Opportunity**, which
  costs almost nothing and is what the PS means by "reach the right customers".

Scope: provider listing editor, availability slots, booking request inbox,
provider analytics. **Not** in scope: payments, commission, payouts, refunds,
disputes.

**Revisit at the Day 3 checkpoint** if we are ahead of schedule.

## D5. Embeddings — schema yes, vectors optional — LOCKED

Keep UGuideRAG's **three perception dimensions** (landscape / activities /
atmosphere) as a *schema*, because the separation is a genuinely good idea and
it costs nothing.

Do **not** commit to BGE-M3 + pgvector in week one. Reasons:

- UGuideRAG, the paper we would be copying, computes all three cosines in **one
  pass** and combines them with hard-coded weights `0.6/0.5/0.5` that sum to
  **1.6** — unnormalised, no per-dimension top-k, no `avoid` channel. And its
  spatial stage raises `NameError` (`networkx` never imported).
- A second datastore is a whole extra thing to keep alive during a 1-week build.

Phase 1 retrieval is **SQLite FTS5 BM25 + tag facets + isochrone prefilter**,
which is dependency-free. Orama was evaluated and rejected: 11k stars, but no
Marathi/Devanagari tokenizer (Hindi and Nepali are supported) and no SQLite
backend.

Embeddings are a stretch task, and only behind an interface (`Embedder`) so
swapping in a model changes one file.

## D6. Curated data is the catalogue — LOCKED

Measured, not assumed, and the measurement is **committed to the repo** so anyone
can re-derive it. From `data/reference/osm-tagging-schema/`, across **1,739 iD
presets** in the real tagging schema:

| Gate field | Presets | Coverage |
|---|---:|---:|
| `opening_hours` | 154 | **8.9%** |
| `wheelchair` | 108 | **6.2%** |
| `fee` | 71 | 4.1% |
| `diet:vegetarian` | 0 | **0.0%** |
| `wheelchair:description` | 0 | **0.0%** |

**1,468 of 1,739 (84.4%) carry no gate field at all**, and OSM has no ratings to
offer either.

So: OSM is a **spatial backbone** (real coordinates, names, categories), and a
curated layer of ~250 Mumbai + Navi Mumbai records carries the fields the problem
statement actually grades on — duration, price, capacity, group fit,
accessibility, kid-friendliness.

The second consequence is a schema one: **absent is `unknown`, never `fail`.** A
gate that vetoes on a missing field deletes most of the catalogue before ranking
starts, and a gate that asserts an unverified `wheelchair=yes` is exactly the
hallucination the provenance layer exists to prevent. That is why `Accessibility`
is a union of tri-state booleans.

**No Google Maps scraping.** It would fill the ratings gap, and it is why we have a
`rejected/` tier in `research/`. It breaches their ToS. We use provider-submitted
data (what a real marketplace has) plus clearly-labelled LLM inference.

## D7. Provenance is visible — LOCKED

Every `Experience` field carries a `Provenance`. Anything `inferred` shows an
"AI-inferred" badge in the UI and a confidence number. We never blend a curated
fact with a guess without saying so.

This is not decoration. It is the direct product consequence of the masterplan's
own research mapping: real-time "vibe" sensing is a saturated space, so the
defensible version of atmosphere is **retrospective, from review text, clearly
attributed**.

## D8. The LLM never decides — LOCKED

Masterplan principle 1, and the thing most of the reference set gets wrong.

The evidence, stated at the strength it actually holds
(`research/findings/05-llm-integration.md` §11): of the ten projects scored, three
keep the LLM out of the decision path — FloatTrip, Plan-It and XRec. The
containment mechanisms differ. Plan-It gates on `confidence >= 0.5` and has two
dead fields. XRec freezes the LLM and conditions it on frozen embeddings, so it
architecturally cannot touch the ranking. **FloatTrip is the closest to our design
and the strongest single artifact in the corpus**: its `planner` node does author
day order from prose, so "LLM-free" is *not* true of it — but it pairs that with
`validate_solution` re-deriving the objective, a closed-pool whitelist in
`candidate_builder`, one repair round then hard-fail, and
`test_architecture_boundaries.py` as a structural gate.

So the honest claim is not "nobody does this". It is: **the failure mode is
consistent, and it is always the same one.** Let the model write the *ordering*,
then try to catch it with a prompt. Prompt-level containment is what leaks.

Our version, in contracts:
- `DialogueDecision` is the **only** model output permitted to affect chat
  actions, and it may only emit a patch to `DiscoveryContext`. It is `.strict()`
  with eight permitted keys, so it cannot express a recommendation at all.
- A `confidence >= 0.5` gate below which we ask instead of act.
- `ValidationResult` recomputes the objective independently and rejects on
  `objectiveDelta > 1e-6`.
- A test makes an LLM import in `src/engine/` a **build failure**.
- The eval suite must pass with `LLM=off`.

## D9. Clusters before routes — LOCKED

The packer is **cluster-then-route**, not TSP on the raw shortlist. Maximum-clique
peeling on a radius graph (Bron–Kerbosch), which is diameter-bounded, needs no
`k`, and has no empty-cluster problem. The approach follows ITINERA, which the
paper reports as deployed in production; we take the technique, and we verify the
rest ourselves.

Dropped: DBSCAN, k-means, and PuLP/CBC exact TSP.

## D10. Travel time, not radius — LOCKED

A 3 km crow-flies filter is actively wrong in Mumbai, in both directions at once.
Measured from 20 committed isochrone polygons in `data/reference/isochrones/`
(Bandra West, pedestrian and auto, 5/10/15/20/30 min):

- Too permissive on foot — a 3 km disc is 28.27 km², **3.2× the entire true
  30-minute walking area** of 8.85 km².
- Too restrictive by car — it **excludes 73% of the true 30-minute driving area**
  of 103.79 km².
- The two costings differ by **11.7× in area at the same budget**, so no single
  radius can be correct for both.
- The contour is not circular: 30-minute walking reach covers 8.85 km² against
  19.1 km² for a circle of its own 2.47 km radius — **46% of the circumscribed
  disc**.

Isochrones first, radius as fallback.

**Endpoint status, measured on this host** (`data/reference/README.md` §"Endpoint
status checked on this host"):

| Endpoint | Status |
|---|---|
| `valhalla1.openstreetmap.de` | working — `/status` advertises `isochrone` and `sources_to_targets`. The only free isochrone source confirmed live, and the polygons are committed. |
| `routing.openstreetmap.de` | **404 on all OSRM paths** from here. The committed matrices came from Valhalla instead. Do not plan around OSRM. |
| `overpass-api.de` + 3 mirrors | **unreachable** from here, on IPv4 and IPv6. Live POI harvest is blocked on this host, which is why the seed dataset is hand-authored. |

Two consequences we accept rather than hide: routing needs a haversine fallback
behind the facade, and Overpass reachability is a build-environment risk, not a
runtime one, because the snapshot ships.

OSRM free-flow is not Mumbai either, so we apply a **documented congestion
multiplier** selected by IST clock and label the estimate as an estimate.

---

## Open, with checkpoints

A day-based checkpoint is the only forcing function a three-way split has. Keep
the column; "the demo spine" is a component, not a moment, and nothing happens at
a component.

| # | Question | Blocks | Checkpoint |
|---|---|---|---|
| O1 | Does the provider side ship, or become stretch? (D4 is "ship, lightweight") | the demo spine | Day 3 standup |
| O2 | Do we self-host routing, or stay on public keyless endpoints? Given the 404s in D10, self-hosting Valhalla is the obvious answer | the routing facade | Day 2 |
| O3 | Embeddings — ship, or leave behind the `Embedder` interface? | Phase 4 of the roadmap | Day 4 |
| O4 | Deploy target. No deployment CLI or credentials are available in the build environment | a live URL for the demo | Day 2 — needs an account from Abhijit |
| O5 | Second city, or deepen Mumbai? (Navi Mumbai is the obvious one — ferry corridors, planned-city grid, very different from island Mumbai) | the multi-city claim | Day 5 |

## Corrections we are carrying forward

Recorded so nobody re-derives them:

1. **npm `opening_hours` DOES parse OSM format.** The underlying PHP package
   (`spatie/opening-hours`) does not — that package only accepts a normalised
   structure and its README defers OSM syntax to a separate package. But the npm
   port we install is an extended codebase with the tokenizer. Verified live:
   `getOpenIntervals` on `Mo-Fr 09:00-18:00` → `03:30Z–12:30Z` = 09:00–18:00
   **IST**; `getOpenDuration` → 9 h. We do **not** write our own tokenizer.
   `PH off` and inline comments are unsupported, so the adapter degrades to
   `hoursStatus: 'unparsable'` rather than throwing.
2. **`routemind-pritesh` is not a travel project.** It is an LLM-provider router
   for a chat app. Zero `ortools`, zero `itinerary`, zero `poi`. Its description
   in our `repos.tsv` was copy-pasted from the *other* RouteMind. Corrected.
3. **`systems/routemind-pritesh`, not `peer/routemind-pritesh`** — the clone
   landed under `systems/`.
4. **Repo descriptions get copy-pasted.** Two of ours did. Descriptions are now
   annotated in `repos.tsv` and every claim is checked against the code before
   it enters a doc.

## Sources for every claim here

All of it is in `research/`:

- `research/findings/00-SYNTHESIS.md` — **read this first**, it is the
  distillation
- `research/findings/01-traveler-uiux.md` … `05-llm-integration.md` — the long
  reports, every claim tagged `repo/path:line`
- `research/findings/02-engine-internals.md` §"CLAIMS THAT DID NOT SURVIVE
  CHECKING" — **27 catalogued claims**, three of which were load-bearing in an
  earlier masterplan
- `research/MANIFEST.json` — 75 entries, 71 clones, all pinned to a commit
