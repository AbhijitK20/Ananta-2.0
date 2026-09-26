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

## The four tiers

| Tier | Meaning |
|---|---|
| `adopt/` | Installed as an npm dependency. Cloned so we can read how it's built. |
| `patterns/` | **Not installed.** We take an architectural idea, not the code. |
| `related/` | **Not installed.** Prior work. Cited in the deck; proves we know the field. |
| `rejected/` | Evaluated and declined. Cloned so nobody re-litigates it mid-build. |

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
| 1 | `adopt/nextjs-boilerplate/src` | How we lay out the repo, validate env, wire lint/CI |
| 2 | `adopt/shadcn-ui/packages` + `templates` | The UI layer we will be assembling |
| 3 | `adopt/vercel-ai/content/docs` | Structured output, streaming, provider fallback |
| 4 | `adopt/maplibre-gl-js/src` | Style spec and source setup for our vector map |
| 5 | `patterns/pyvrp/pyvrp` | `Model.py`, `PenaltyManager.py` — how time windows, capacity and precedence are actually modelled. Read this before writing `packer.ts` |
| 6 | `patterns/medusa/packages/core/utils/src` | The workflow/step primitives we copy conceptually into our booking state machine |
| 7 | `related/xrec/explainer` | Feature-grounded explanation generation |
| 8 | `related/recbole/recbole/evaluator/metrics.py` | The metric definitions our eval harness will mirror |
| 9 | `adopt/opening-hours-php` | Correct OSM `opening_hours` semantics before we wrap it |
| 10 | `adopt/routingpy` | The provider-adapter shape our `travel.ts` follows |

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
