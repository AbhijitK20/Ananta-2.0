# PROGRESS — TravelBuddy / ATHITI

Where the build actually is, and what was already decided so it doesn't get
re-litigated. Updated 2026-09-26.

**Naming.** One project, three names in the history. `TravelBuddy (Ananta)` is the
masterplan title, `ATHITI` is the v4 product thesis, `TripFit` is the research
folder name. They are the same thing. Don't treat them as three codebases.

## Status

| Phase | Scope | State |
|---|---|---|
| Research | 67 pinned repos, 8 tiers, 5 findings docs | **done** |
| Knowledge graph | graphify over research + `systems/` code | **done** |
| Datasets | tag schema, isochrones, coverage measurements | **done** (POI harvest blocked) |
| Phase 1 | constraint tree, retrieval, validator, adaptation, UI | **not started — no app code exists** |

The repo has no application code. Everything committed is research, tooling and
data. Phase 1 is a greenfield build against the specs below.

## MVP scope

From `TRAVELBUDDY_MASTERPLAN_FINAL.md` §23. Six items, one substitution.

- [ ] **Constraint tree parser** — ITINERA-inspired fields
- [ ] **Seeded experience dataset** — ~30 labelled places, one neighbourhood
- [ ] **Retrieval** — hard filter → geo + semantic → rerank
- [ ] **Validator** — feasibility gate + one relaxation demo
- [ ] **One adaptation trigger** — e.g. weather → new pool → same intent → re-solve
- [ ] **UI** — map, cards, "why this" panel, relaxation options
- [x] ~~Z3 validator~~ → **substituted**: weighted-penalty objective in beam search
      (~150 lines TS). Rationale below, decision D1.

Explicitly out of scope: multi-agent group negotiation, full TripCraft eval as a live
feature, large provider marketplace, GNN / Transformers4Rec / Merlin, heavy MLOps.

## Decisions already made — do not reopen without new evidence

**D1 — Penalty minimisation, not a Z3 solver.** The masterplan claimed an unsat
core yields minimal relaxation algorithmically. Reading
`systems/tripweaver/z3_temporal_scheduler_with_relaxation.py` (888 lines) shows the
reference technique is **penalty-based soft constraints under `Optimize`**, not unsat
cores. That's better for us: the solver always returns a plan and the per-constraint
penalty magnitudes *are* the relaxation ladder. Tooling settled it — Python `z3-solver`
is 5.1.0.0 and fine, but npm `z3-solver` ships an unusable Node surface (`Context`
empty, zero callable `Z3_*`), and OR-Tools for Node does not exist on npm at all.
Our constraint set is filter-and-rank over one neighbourhood in 2–4 hours, not a
multi-day CSP. Revisit only if scope becomes multi-day itineraries.
→ `findings/02-engine-internals.md` §3, `research/README.md`

**D2 — Isochrones, not radius.** Now measured, not asserted: at a 30-minute budget
walking reach is 8.85 km² and driving reach is 103.79 km² — **11.7× apart** — and a
3 km disc is simultaneously 3.2× too big for walking and misses 73% of driving reach.
The 30-min contour covers only 46% of its own circumscribed circle, so the shape is
not round either. Radius survives only as a fallback.
→ `data/reference/README.md` §2

**D3 — A retrieval stage exists.** `RecBole` / `RecSysDatasets` made the omission
obvious. Pipeline is now
`context → retrieve (FTS5 BM25 + tags + isochrone) → feasibility gate → rank → pack`.
FTS5 is primary; Orama is rejected (no Marathi/Devanagari tokenizer, no SQLite
persistence).
→ `findings/04-data-retrieval.md` §0.4

**D4 — Absent gate data is `unknown`, never `fail`.** Measured across all 1739 real
OSM presets: `opening_hours` appears in **8.9%**, `wheelchair` in **6.2%**, and
**84.4% of presets carry no gate field at all**. A gate that vetoes on missing
`opening_hours` would delete 91% of the catalogue before ranking. `diet:vegetarian`
and `wheelchair:description` are at **0%** and can only ever be soft or LLM-inferred
with an `inferred` provenance label.
→ `data/reference/osm-tagging-schema/constraint-field-coverage.json`

**D5 — Bookings are a durable workflow.** `medusa`'s step engine gave the
idempotent-step + compensation pattern, so a double-click or retried request cannot
oversell a slot.
→ `findings/03-marketplace-booking.md` §2

**D6 — Every field carries provenance.** `xrec` (EMNLP'24) and `pepler` (TOIS'23)
ground explanations in user and item features — that is the why-ledger. Every field is
labelled `curated` / `provider` / `osm` / `inferred`.
→ `findings/05-llm-integration.md`, `TRAVELBUDDY_MASTERPLAN_FINAL.md` §10

**D7 — Never use `rejected/google-maps-scraper`.** It scrapes Google Maps in breach
of their ToS. It would neatly fill the ratings gap, which is precisely why it is
rejected. Substitute provider-submitted data plus clearly-labelled LLM inference.
**Learning-to-rank also rejected** (`tf-ranking`, `allrank`, `ptranking`) — needs
training data we do not have; hand-designed interpretable features plus a contextual
bandit are more honest and demo better.
→ `research/README.md`

## Blockers

- **Live POI harvest is blocked.** Overpass is TCP-unreachable from this host on both
  IPv4 and IPv6, across 4 mirrors. The ~30-place seeded dataset (MVP item 2) needs
  another route: different network, self-hosted Overpass, or hand-curate from the
  `attraction`/`amenity` presets bounded by the isochrone polygons we already have.
- **The free matrix provider is gone.** `routing.openstreetmap.de` returns 404 on all
  OSRM paths. Matrices now come from Valhalla. `research/README.md` still claims
  FOSSGIS is the free matrix source — that row is stale.
- **Untracked research.** `research/findings/` (14k lines) and
  `TRAVELBUDDY_MASTERPLAN_FINAL.md` are not in git, and there is no remote. The whole
  research output is one `rm` from gone. Not committed per explicit instruction.

## Knowledge graph

Built with graphify. Query it instead of grepping 14k lines of findings.

```bash
graphify query "how does the constraint relaxation ladder work"      # research graph
graphify query "tripweaver z3 penalties" --graph graphify-out/merged-graph.json
graphify path "Penalty-Based Soft Constraints" "FloatTrip Routing"
graphify explain "Feasibility Gate"
```

- `graphify-out/` — research graph, 661 nodes / 975 edges / 57 named communities
- `graphify-systems-out/` — `systems/` code graph, 6631 nodes / 14542 edges
- `graphify-out/merged-graph.json` — both, 7292 nodes, for cross-cutting questions
- `graphify-out/wiki/` — 67 articles, `index.md` is the entry point
- `graphify-out/GRAPH_REPORT.md` — architecture context, don't read for lookups

The OpenCode plugin in `.opencode/plugins/graphify.js` now activates automatically
because `graphify-out/graph.json` exists.

Rebuild after changing research docs: `graphify update research`. The eight clone
tiers are gitignored, so detection skips all 33k reference files automatically.

## Reading order

Cold start, in order: `research/ATHITI_MASTERPLAN_V2.md` → this file →
`research/findings/02-engine-internals.md` (the algorithms) →
`research/findings/04-data-retrieval.md` (the data) → the specific reference files
listed in `research/README.md` §"Start here".
