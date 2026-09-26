# ATHITI — Master Plan v4
### A context-aware local discovery & experience platform, grounded in published, checkable research

> **Don't optimize for places. Optimize for moments.**

This supersedes ATHITI_MASTERPLAN.md (v3). It keeps everything from v3 that still holds and replaces three components with better, published, code-backed versions found since — most importantly, the constraint validator, which now has a concrete open-source implementation to point to instead of a from-scratch design.

---

## 0. What's New in v4

Since v3, five more real, checkable systems were found and reviewed — three of them peer-reviewed and code-released, one production-deployed at scale. Each replaces or upgrades a specific piece of the plan rather than just padding the reference list:

| Finding | Replaces / upgrades | Why it matters |
|---|---|---|
| **UGuideRAG** (ACM SIGSPATIAL 2025) | v3 §2.7 "review intelligence" (vague) | Concrete LLM extraction schema: Landscape / Activities / Atmosphere, mined from review text |
| **ITINERA** (arXiv 2402.07204, deployed at TuTu — thousands of real users) | v3 §2.3 geo-first retrieval | Production-validated request decomposition + cluster-then-route pattern |
| **TripWeaver** (LLM+Z3 SMT hybrid) | v3 §2.2 Deterministic Plan Validator | A working implementation using an SMT solver, with a **relaxation-with-soft-constraints** variant already built — this is a strictly better version of the validator this plan already called its strongest idea |
| **AI Tour Meeting** (NTT Research) | v3's flat "merge preference profiles" group logic | Persona-simulated multi-agent negotiation instead of static averaging |
| **TripCraft** (ACL 2025, Microsoft + IIT Bhubaneswar) | v3 §10 evaluation (single metric) | Five named, continuous evaluation dimensions instead of one pass/fail rate |

---

## 1. Full Research & Repo Grounding

### 1.1 Product-level open source (UX reference only — none of these do context-aware discovery)
| Project | What it is | Take from it |
|---|---|---|
| **TREK** (`Xaler1/TREK` + active forks) | Self-hosted collaborative trip planner: drag-drop day planner, budgets, packing lists, PDF export, MCP server exposing 150+ tools | Mature trip-management UX; not a recommender |
| **AdventureLog** (`seanmorley15/AdventureLog`) | Self-hosted travel logger: map history, itineraries, country stats, SvelteKit+Django/PostGIS | Travel-history → preference-profile pattern |
| **NomadNote** (`Ghostsheep1/NomadNote`) | Local-first planner with a **"Trip Stress Radar"** — scores overload/rain-risk/anchor-pressure/transit-complexity 0–100 with concrete fixes | Cleanest existing version of your Fatigue/Buffer model — steal the single-score framing |

### 1.2 LLM-agent travel planners (architecture reference)
| Project | What it is | Take from it |
|---|---|---|
| **JauntAI** (`Param-Pandya/JauntAI`) | Multi-agent system: Supervisor Agent decomposes queries, Domain Guardrails filter unsafe/off-topic input, specialist sub-agents (flights/hotels/weather/budget), human-in-the-loop approval gate | Shipped version of your "Companion Orchestrator" — including an input-safety layer your plan lacked |
| **Inkle** (`vipa22aiml/inkle`) | Gemini-based planner with explicit pipeline nodes (Places → Route → Cost → Synthesizer) | Concrete evidence the staged-pipeline pattern is implementable, not just theoretical |
| **AI Tour Meeting** (`ntt-dkiku/ai-tour-meeting`, NTT) | Persona-instantiated LLM agents hold a structured **discussion** to reach group consensus on an itinerary, used as a simulation/analysis tool | Direct upgrade path for group recommendation — see §2.12 |
| **tourwise** (`lasa1015/tourwise-springboot-react`) | Academic capstone: ML-predicted crowd "Busyness Index" folded into itinerary scoring | Concrete, sourceable method for the `crowd_fit` ranking feature v1 listed but never grounded |

### 1.3 Research systems solving your exact problem (the strongest tier — cite these directly)
| System | Venue / status | What it contributes |
|---|---|---|
| **UGuideRAG** (`tangjsysu/UGuideRAG`) | ACM SIGSPATIAL 2025 (Univ. Zürich / NYU Shanghai) | Four-stage pipeline: UGC→structured Landscape/Activity/Atmosphere extraction → dimension-aware retrieval → LLM rerank → cluster-aware spatial optimization. See §2.9. |
| **ITINERA** (`YihongT/ITINERA`) | arXiv 2402.07204; **deployed in production at TuTu online travel service, thousands of real users** | Request Decomposition (pos/neg × specific/vague × POI-level/itinerary-level) + a user-owned POI database built by LLM-extracting attractions from social posts (text/OCR/ASR) + Cluster-aware Spatial Optimization (the likely origin of UGuideRAG's CSO module). See §2.10. |
| **TripWeaver** (`suprit-code/TripWeaver`) | Open repo, built on the TripCraft dataset | Hybrid LLM+Z3 pipeline: LLM turns the request into planning steps → generates constraint code → **Z3 SMT solver** checks/solves it → a second module (`z3_temporal_scheduler_with_relaxation.py`) does **soft-constraint relaxation** when no exact solution exists. See §2.11 — this is the single most important upgrade in v4. |
| **TripCraft** (ACL 2025, Microsoft + IIT Bhubaneswar) | Peer-reviewed benchmark, dataset/code released | Five **continuous** evaluation metrics (not binary pass/fail): Temporal Meal Score, Temporal Attraction Score, Spatial Score, Ordering Score, Persona Score. See §2.13. |
| **TravelPlanner** (Xie et al. 2024) / **ChinaTravel** (ICLR 2026) / **TriFlow** (2026) / **TourPlanner** (2026) | Peer-reviewed benchmarks/systems (kept from v3) | Slot-filling fails on compositional requests (basis for §2.1's constraint tree); staged rule–LLM narrowing beats monolithic ranking; constraint-gated RL for learning without cheating on hard constraints |

### 1.4 Geo-aware recommendation (kept from v3, still current)
OneLoc (Kuaishou, 400M daily users, +21% GMV from geo-first candidate representation) · Reasoning Over Space (2026, spatial reasoning degrades when coordinates are passed as raw numbers) · RALLM-POI (2025, zero-shot cold-start via retrieved similar trajectories)

### 1.5 Corrections to earlier drafts (still valid, repeat because it matters)
- **"MargDarshak" as cited in v1/v2 doesn't exist as described.** The real public repo of that name is a small Kotlin photo-based monument-identification app — unrelated to "deterministic planning/provenance." Drop the citation; **TripWeaver (§1.3) is the real, working version of that idea.**
- **RouteMind** (`pritesh-4/RouteMind`) looks like a small, active but modest-scope project — don't quote it as a benchmark without checking current state yourself.
- **Real-time "vibe"/atmosphere sensing is a saturated space** (Boppin', Vybras, Dash's Venue Vibes, a granted US patent) — don't build this as a differentiator. UGuideRAG's *retrospective* atmosphere-from-reviews approach (§2.9) is a different, still-open angle and is what this plan actually uses.
- **Hybrid CB/CF tourism recommenders** (`Jess607/Tourism-Spot-Recommendation-System` and similar academic systems) are useful as baseline-quality comparisons only — static catalog, no real-time constraints, same cold-start problem this plan already solves differently (§2.6).

---

## 2. Core Design (v3's innovations, kept, plus five upgrades)

### 2.1 Compositional Constraint Representation — kept from v3
Requests are parsed into a small tree of typed hard/soft constraint nodes, not a flat slot-filled JSON object (ChinaTravel shows flat slot-filling caps constraint satisfaction on open-ended, compositional requests — see v3 §2.1 for the full schema).

### 2.9 — NEW — Perception-Dimension Extraction (from UGuideRAG)
Rather than one blended embedding per experience, extract three separate structured signals from review/description text via LLM, each with its own embedding:
- **Landscape & Content** — what it physically is/looks like
- **Activities** — what you actually do there
- **Atmosphere** — the felt quality (romantic, lively, calm, etc.) — sourced retrospectively from years of review text, distinct from live crowd-sensing (§1.5)

A user request is decomposed into the same three dimensions (this composes cleanly with the constraint tree in §2.1 — atmosphere/activity/landscape become typed soft-constraint nodes), and retrieval runs **per-dimension before merging**, which UGuideRAG shows is more precise than one merged semantic-similarity pass.

### 2.10 — NEW — Request Decomposition + Cluster-Then-Route (from ITINERA, production-validated)
ITINERA's Request Decomposition splits a query along three axes simultaneously:
- **granularity**: POI-level ("find a cafe") vs itinerary-level ("a historical afternoon")
- **specificity**: named/specific ("Yuyuan Garden") vs vague ("a nice park")
- **attitude**: positive (wants) vs negative (avoid)

This is a concrete refinement of your constraint tree's hard/soft split — use it as the actual field schema for `soft` nodes in §2.1.

For routing: **cluster candidates geographically first, then solve TSP within/across clusters** — not TSP on the raw shortlist. This is cheap, already proven at production scale (thousands of real users on TuTu), and slots directly into your existing Feasibility Engine.

### 2.11 — NEW, REPLACES v3 §2.2 — SMT-Based Validator with Automatic Relaxation (from TripWeaver)
v3's Deterministic Plan Validator was hand-rolled Python assertions. **TripWeaver shows a better, already-implemented approach:** translate the constraint tree into symbolic constraints and hand them to the **Z3 SMT solver** (`pip install z3-solver` — no infrastructure, pure Python, hackathon-feasible).

This gets you two things assertions don't:
1. **A real satisfiability proof**, not a checklist — Z3 either finds a valuation that satisfies every constraint simultaneously, or proves none exists.
2. **Automatic minimal relaxation.** When Z3 reports unsatisfiable, it can return an **unsat core** — the exact minimal subset of constraints that conflict. This directly generates your Relaxation Ladder (v3 §5) *algorithmically* — "relax the budget constraint by ₹100" isn't a hand-coded heuristic anymore, it's read off the solver's own explanation of why it failed. TripWeaver's `z3_temporal_scheduler_with_relaxation.py` is a working reference implementation of exactly this for POI/time scheduling.

This is the single most valuable upgrade in this version — it turns your best v3 idea (deterministic validation) from a good design into a design with working, citable code behind it.

### 2.12 — NEW — Persona-Simulated Group Consensus (from AI Tour Meeting)
v3's group recommendation (v1 §26) statically merged preference vectors into one "group profile." AI Tour Meeting's approach: instantiate one LLM agent per group member with that member's stated persona/constraints, and have them hold a **structured discussion** (bounded turns, explicit disagreement) to reach a plan, rather than averaging vectors upstream of the ranker. This surfaces genuine tradeoffs ("low-walking parent vs. want-to-hike teenager") as explicit dialogue the user can see and interject in, not a hidden weighted average — which is also a stronger demo moment than a static merge.

### 2.13 — NEW, REPLACES v3 §10 — Continuous, Multi-Dimensional Evaluation (from TripCraft)
Replace the single "Constraint Satisfaction Rate" metric with five named, continuous scores, adapted from TripCraft:
- **Temporal Score** — does timing (meals, hours, transit) actually fit, not just "budget ok / not ok"
- **Attraction Score** — quality/diversity of the specific picks
- **Spatial Score** — how coherent/walkable the resulting route is (directly measurable once §2.10's clustering is in place)
- **Ordering Score** — does the sequence make sense (no backtracking, sensible meal placement)
- **Persona Score** — does the plan respect the *stated and inferred* persona (ties to v3 §2.5's implicit-constraint extraction)

Keep the Z3 pass/fail (§2.11) as the hard gate; use these five as the quality signal on top of a plan that already passed the gate.

---

## 3. Everything Else — Unchanged From v3

The following sections carried over as-is because nothing found since changes them:
- **Product definition** ("the unit of intelligence is the moment, not the destination") and the explicit exclusion list (no gamification, no Proof-of-Presence, no booking marketplace)
- **Memory & personalization safety** (three layers; explicit vs inferred; user can see/edit/delete)
- **Retrieval-augmented cold start** (v3 §2.6 — similar-past-session retrieval, zero-shot, no GNN needed on day one)
- **LLM-synthesized, data-verified context enrichment** (v3 §2.7)
- **Contextual bandit for diversity/novelty** (v3 §2.8)
- **Architecture diagram, data model, MVP scope (§6–8 of v3)** — only change: the Plan Validator box in the architecture diagram now explicitly says "Z3 SMT solver," and `z3-solver` is added to the MVP dependency list (§4 below)
- **Anti-patterns list** (v3 §12) — still holds, add: "don't hand-roll constraint checking when Z3 does it with proof and automatic relaxation for the same effort"

---

## 4. Updated Hackathon MVP Scope

Same order as v3 §8, with one substitution:

1. Constraint tree parser (§2.1, using ITINERA's granularity/specificity/attitude fields, §2.10)
2. Seeded experience dataset, one neighborhood, extracted into Landscape/Activity/Atmosphere (§2.9) — even a manually-labeled 30-place seed set demonstrates the schema
3. Stage 0–2 of the retrieval pipeline (hard filter → geo+semantic → simple rerank)
4. **Z3-based Plan Validator with relaxation** (§2.11) — replaces the plain-assertion version; `pip install z3-solver`, no other infra, and it demos better ("here's the solver's proof, here's what it relaxed and why")
5. One adaptation trigger (weather changed → re-solve with Z3, same constraints, updated candidate pool)
6. Map + card UI, "why this" panel showing the Z3-derived relaxation explicitly when triggered

Skip for the hackathon: multi-agent group negotiation (§2.12 — real but higher-effort, good Phase 2 demo), the five-metric evaluation suite (§2.13 — use it for your own testing, not the live demo), provider dashboard.

---

## 5. Updated Tech Stack

```
Frontend:      Next.js, TypeScript, Tailwind, MapLibre
Backend:       FastAPI, Pydantic, SQLAlchemy
Database:      PostgreSQL + PostGIS + pgvector
Cache:         Redis
Embeddings:    BAAI/bge-m3 or multilingual-e5-large — one embedding space per
               perception dimension (§2.9: landscape / activity / atmosphere)
Reranker:      BAAI/bge-reranker-v2-m3
Constraint
 validation:   z3-solver (Z3 SMT) — NEW, replaces plain Python assertions;
               pure pip install, no infrastructure, gives unsat-core-based
               automatic relaxation for free (§2.11)
Routing:       cluster first (simple geo clustering), then OR-Tools or a
               small TSP heuristic within clusters (§2.10)
```

---

## 6. Sources Consulted (v4 additions in bold)

Xie et al., *TravelPlanner* (2024) · Shao et al., *ChinaTravel* (ICLR 2026) · Wang et al., *TripTailor* (ACL 2025) · *TriFlow* (2026) · *TourPlanner* (2026) · *TREK agent benchmark* (2026) · Li & Lim, *RALLM-POI* (2025) · Wei et al., *OneLoc* (Kuaishou, 2025) · *Reasoning Over Space* (2026) · **Tang, Kong & Wang, *UGuideRAG*, ACM SIGSPATIAL 2025 (`tangjsysu/UGuideRAG`)** · **Tang et al., *ITINERA*, arXiv 2402.07204, deployed at TuTu (`YihongT/ITINERA`)** · **`suprit-code/TripWeaver` — LLM+Z3 SMT hybrid planner** · **Kikuta (NTT), *AI Tour Meeting* (`ntt-dkiku/ai-tour-meeting`)** · **Chaudhuri, Purkar et al., *TripCraft*, ACL 2025 (Microsoft + IIT Bhubaneswar)** · AdventureLog, TREK, NomadNote, JauntAI, Inkle, tourwise (GitHub, active repos).
