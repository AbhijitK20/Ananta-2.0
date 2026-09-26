# TravelBuddy (Ananta)

> **Don't optimise for places. Optimise for moments.**

An intelligent local discovery and experience platform for **time-constrained
travellers** — and an acquisition channel for the local providers they want to
reach.

Built for **PS ID 6 — Local & Experiences: Intelligent Local Discovery &
Experience Platform**. Research codename: ATHITI.

---

## The problem, and our answer

A traveller in Mumbai has three hours and a hotel in Colaba. Four people, one a
toddler, ₹1,500, it might rain, and an older relative who cannot manage stairs.

Every discovery tool returns a ranked list that ignores at least one of those.
Half of it is closed, the good places are forty minutes away in traffic, none of
it is step-free, the ₹800 tasting menu blows the budget, and the kid-friendly
options are six kilometres away.

And the same failure runs the other way: the local potter, the Koli fishing
community, the Textile Museum guide — none of them can reach a traveller who is
standing two kilometres away and would love what they do.

Both are one problem. There is no shared, structured, timely representation of
**what fits whom, where, and when**.

## What we do differently

**A recommendation must fit, or it is not shown.**

```
context → retrieve → FEASIBILITY GATE → score → pack → validate → relax
```

The gate is twelve hard constraints: travel time, duration, opening hours,
budget, capacity, group fit, accessibility, weather, availability, distance,
season, duplicates. Anything that fails is dropped **with a recorded reason** —
a finished sentence with a real number in it.

That record does two jobs. It becomes the traveller's *"why not that"* panel. And
aggregated per neighbourhood, it becomes the provider's **unmet-demand feed**:
what people nearby searched for and could not get, and which single constraint
killed them. That is the answer to the provider half of the problem statement,
and it costs almost nothing to build.

## Quick start

```bash
npm install
npm run db:seed        # load the curated Mumbai + Navi Mumbai catalogue
npm run db:harvest     # fetch the OpenStreetMap spine (optional; snapshot ships)
npm run dev            # http://localhost:3000

npm run eval           # the 28-scenario eval table
npm run eval -- --llm-off   # the credibility check
npm run typecheck
```

Everything external is keyless, cached, and has a fallback. The demo path works
with the network off.

## Architecture in one paragraph

**TypeScript only.** Next.js 15.5 + React 19.2 + `node:sqlite` (FTS5 with
`bm25()`, `json1`, `geopoly`, WAL) + MapLibre with OpenFreeMap. **The engine is
deterministic and has no LLM in the decision path** — the model does
natural-language understanding, explanation narration, and offline data
enrichment, and nothing else. That is why the eval suite means something and why
`LLM=off` still produces a full plan. Full detail in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Documentation

| Document | What it is |
|---|---|
| [`docs/MASTERPLAN.md`](docs/MASTERPLAN.md) | **Start here.** The whole thing, with decisions locked |
| [`docs/PRD.md`](docs/PRD.md) | Requirements, acceptance criteria, risks |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules, data model, algorithms, state machines |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Every contested question, resolved, with evidence |
| [`TASKS.md`](TASKS.md) | The three-way split, file ownership, day-by-day |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Tokens, components, copy, accessibility |
| [`docs/DATA_SPEC.md`](docs/DATA_SPEC.md) | Data layers, OSM tag semantics, harvest, ML plan |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Feature-by-feature acceptance criteria |
| [`docs/EVAL_SPEC.md`](docs/EVAL_SPEC.md) | The 28 scenarios and the metrics |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | The 3-minute script, with fallbacks |

## Team

Three people, three streams, **zero file overlap**.

| | Owns |
|---|---|
| **Abhijit** | Data, engine, ML. `src/engine/`, `src/data/`, `src/db/`, `tests/` |
| **Karan** | UI/UX. `src/components/`, `src/app/`, `src/styles/` |
| **Vishwesh** | Features, provider side, LLM integration, eval. `src/features/`, `src/llm/`, `content/` |

The three streams only meet at `src/contracts/index.ts`, which is **frozen**.
That is what makes the parallelism safe — see [`TASKS.md`](TASKS.md).

## Research

We studied **71 pinned reference repositories** and about 15,000 lines of
evidence-graded notes. It is not decoration: several of our decisions reverse
what the source material claims, because we read the code rather than the
abstract.

`research/findings/02-engine-internals.md` catalogues **27 claims from READMEs,
papers and file names that did not survive checking.** Three were load-bearing in
an earlier masterplan of ours:

- The Z3 "unsat core" relaxation we were planning to adopt **does not exist** in
  the reference implementation — `unsat_core()` is called on a solver with zero
  tracked assumptions, so it always returns empty, and the `minimize`/`maximize`
  on one `Optimize` object is lexicographic, so the penalty is lowest-priority and
  the relaxation is silently defeated.
- The spatial-optimisation stage of the paper we were citing raises `NameError`
  on a missing import, so it never runs.
- OR-Tools' routing library appears in **none** of the 71 repos, and there is no
  Node binding for it at all.

That is why the engine is ~150 lines of hand-written TypeScript instead of a
solver, and why it is faster, single-language, and easier to explain on stage.

Start at [`research/findings/00-SYNTHESIS.md`](research/findings/00-SYNTHESIS.md).

## Data provenance and licensing

| Layer | Source | Licence |
|---|---|---|
| Map backbone | OpenStreetMap via Overpass | **ODbL** — attribution required |
| Experience catalogue | Hand-curated + provider-submitted | Ours |
| Long-tail attributes | LLM inference, **labelled as inferred on screen** | Ours |
| Transit corridors, congestion model | Hand-seeded, documented estimates | Ours |
| Photos | Openverse, Wikimedia Commons | **CC** — per-image attribution, kept with the cache |
| Routing | OSRM, Valhalla, Nominatim, Open-Meteo | Keyless public endpoints |

We **do not scrape Google Maps, Instagram, Zomato or TripAdvisor.** It would fill
our ratings gap and it breaches their terms. The equivalent is
provider-submitted data — which is what a real marketplace has — plus inference
that is visibly labelled as inference. See `research/rejected/`.

Per-image and per-source attribution lives in `CREDITS.md`, generated by the
image pipeline.

## Status

Week 1 of 1. See [`TASKS.md`](TASKS.md) for the day-by-day and the definition of
done per stream.
