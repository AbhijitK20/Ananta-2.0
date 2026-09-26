# DECISIONS — the decisions we made, and why

Every contested question in this project, resolved. If you disagree with one of
these, change it **here** first and tell the other two — do not fork the codebase
around it.

Status key: **LOCKED** = build against it · **OPEN** = revisit at the checkpoint
marked.

---

## D1. Name — LOCKED

**TravelBuddy**, codename **Ananta**.

The docs have churned through four names for one product: TripFit (my working
name), ATHITI (masterplan v4), TravelBuddy / Ananta (the definitive masterplan),
and the repo is `Travel_buddy`. We are standardising on **TravelBuddy** because
`TRAVELBUDDY_MASTERPLAN_FINAL.md` is the baseline doc and it self-describes as
"the single baseline for any further architecture, coding plan, database design,
API design, UI plan, or implementation prompt".

`ATHITI` stays as the *research* codename so the existing docs in `research/`
remain navigable. Add the mapping to every doc header:

> TravelBuddy (Ananta) — research codename ATHITI

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
`"react": "^18 || ~19.0.1 || ~19.1.2 || ~19.2.1"` — four disjoint allow-lists.
React **19.0.0 exactly** and **19.3+** are both excluded. We are on 19.3.0.

Pin **19.2.0**. We do not use `@ai-sdk/react` at all (we stream raw SSE), but
pinning anyway keeps the door open.

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
- The half that actually differentiates us is the **unmet-demand feed**, which
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

Measured, not assumed: an Overpass query over a Bandra West Mumbai bbox returns
199 POIs. 91% have `name`, but only **16%** have `opening_hours`, **1%**
`wheelchair`, **0%** `fee`, and OSM has no ratings at all.

So: OSM is a **spatial backbone** (real coordinates, names, categories), and a
curated layer of ~250 Mumbai + Navi Mumbai records carries the fields the PS
actually grades on — duration, price, capacity, group fit, accessibility,
kid-friendliness.

**No Google Maps scraping.** It would fill the ratings gap, and it is the reason
we have a `rejected/` tier in `research/`. It breaches their ToS. We use
provider-submitted data (what a real marketplace has) plus clearly-labelled LLM
inference.

## D7. Provenance is visible — LOCKED

Every `Experience` field carries a `Provenance`. Anything `inferred` shows an
"AI-inferred" badge in the UI and a confidence number. We never blend a curated
fact with a guess without saying so.

This is not decoration. It is the direct product consequence of the masterplan's
own research mapping: real-time "vibe" sensing is a saturated space, so the
defensible version of atmosphere is **retrospective, from review text, clearly
attributed**.

## D8. The LLM never decides — LOCKED

Masterplan principle 1, and the thing every reference repo gets wrong. The
evidence: FloatTrip is the only repo that keeps the LLM out of the route, and it
is the only one with an independent validator. Every repo that leaked let the
model write the **ordering**, then tried to catch it with a prompt. None has a
validator.

Our version, in contracts:
- `DialogueDecision` is the **only** model output permitted to affect chat
  actions, and it may only emit a patch to `DiscoveryContext`.
- A `confidence >= 0.5` gate below which we ask instead of act.
- `ValidationResult` recomputes the objective independently and rejects on
  `objectiveDelta > 1e-6`.
- A test makes an LLM import in `src/engine/` a **build failure**.

## D9. Clusters before routes — LOCKED

The packer is **cluster-then-route**, not TSP on the raw shortlist. Maximum-clique
peeling on a radius graph (Bron–Kerbosch), which is diameter-bounded, needs no
`k`, and has no empty-cluster problem. From ITINERA, which is validated in
production at TuTu with thousands of real users.

Dropped: DBSCAN, k-means, and PuLP/CBC exact TSP.

## D10. Travel time, not radius — LOCKED

A 3 km crow-flies filter is actively wrong in Mumbai. Isochrones first, radius as
fallback. Keyless sources verified live: `valhalla1.openstreetmap.de/isochrone`
returned a real 15-minute polygon over Mumbai in 0.89 s, and
`routing.openstreetmap.de` serves `routed-car` and `routed-foot` (its *default*
profile is bike — always set it).

OSRM is free-flow, which understates Mumbai peak by 3–5×, so we apply a
**documented congestion multiplier** selected by IST clock and label the estimate
as an estimate.

---

## Open, with checkpoints

| # | Question | Decide by |
|---|---|---|
| O1 | Does the provider side ship, or become stretch? (D4 is "ship, lightweight") | Day 3 standup |
| O2 | Do we self-host any routing, or stay fully on public keyless endpoints? | Day 2 |
| O3 | Embeddings — ship, or leave behind the `Embedder` interface? | Day 4 |
| O4 | Deploy target. No `vercel`/`flyctl`/`railway` CLI and no creds on this machine. | Day 2 — needs an account from Abhijit |
| O5 | Second city, or deepen Mumbai? (Navi Mumbai is the obvious one — ferry corridors, planned-city grid, very different from island Mumbai) | Day 5 |

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
