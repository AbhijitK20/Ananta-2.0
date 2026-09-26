# DATA SPEC + ML PLAN — for Abhijit

> Your files. `src/data/`, `src/engine/`, `src/db/`, `scripts/`, `tests/`.
> Nobody else writes in these.

You own the thing that makes the product true. If the engine is wrong, the UI
polishes a lie.

---

# PART 1 — DATA SPEC

## 1. The measurement that shapes everything

An Overpass query over a Bandra West Mumbai bbox returns **199 POIs**:

| Tag | Coverage |
|---|---|
| `name` | 91% |
| `cuisine` | 39% |
| `opening_hours` | **16%** |
| `phone` | 15% |
| `website` | 11% |
| `wheelchair` | **1%** |
| `fee` | **0%** |
| ratings | **none — OSM has no ratings** |

**Conclusion: OSM is a spatial backbone, not a catalogue.** It gives real
coordinates, names, categories, addresses. It cannot supply a single factor the
PS grades on. Hence three layers.

| Layer | Volume | Contents | Provenance |
|---|---|---|---|
| **Spine** | 2–4k | real coords, names, categories, addresses, partial hours | `osm` |
| **Experience** | **~250** | duration, price, capacity, kid-friendly, step-free, indoor/outdoor, booking, seasonality, best time of day | `curated` |
| **Signals** | ~1.5k reviews, 30–50 events | party type, party size, spend, sentiment; festival calendar | `curated` |
| **Enriched** | the OSM long tail | inferred duration/price/family-fit/accessibility | `inferred` + confidence |

## 2. Tag semantics — match the schema, not your intuition

Source of truth: `data/id-tagging-schema/data/fields/`. Full extraction in
`research/findings/04-data-retrieval.md` §1.

**Zod rules for `src/contracts`:**

```ts
// 3-state, NOT boolean. iD `check` is yes/no/absent (SCHEMA.md:418).
// Collapsing to false means "we don't know" reads as "no".
fee:    z.boolean().nullable()
check:  z.enum(['yes','no','absent'])

// OPEN VOCABULARY, not an enum. iD's cuisine list has 103 values but omits
// mughlai, maharashtrian and chaat — all of which are load-bearing in Mumbai.
cuisines: z.array(z.string())
diets:    z.array(z.string())      // multiCombo, key prefix 'diet:'

// These two ARE genuinely closed: autoSuggestions:false AND customValues:false
smoking:        z.enum(['yes','no','outside','separated','isolated','no'])
internet_access: z.enum(['yes','wlan','terminal','no'])

// access.json has 10 documented values and matters more than fee for our
// accessibility gate.
access: z.enum(['yes','no','private','customers','permissive',
                'customers_permissive','restricted','destination',
                'permit','no'])

// Do NOT model. No field definition exists, and covid-era hours are junk.
opening_hours_covid: DROP — strip on ingest
// lastcheck is superseded by:
check_date: z.string()          // drives the "hours unverified" badge

// covered_no.json encodes "Assumed to be No" — a wrong assumption for India.
// Do not adopt it. Expose `coverageKnown` instead.
```

`craft` is a closed 56-value list. `typeCombo` vocabularies live in the preset
files — **those are now extracted for you**, so do not go hunting:

| Artefact | Size | What it gives you |
|---|---|---|
| `data/reference/osm-tagging-schema/preset-checklists.json` | 757 KB | per-category tag co-occurrence, the input to the Overpass harvest |
| `data/reference/osm-tagging-schema/constraint-field-coverage.json` | 535 KB | which constraint-bearing fields actually exist, and how often |
| `data/reference/isochrones/bandra-west-mumbai/` | ~1 MB | **real pre-computed isochrone polygons + travel-time matrices**, auto and pedestrian, 5/10/15/20/30 min, for Bandra West and Pali Hill |

The isochrones are not documentation — they are production data. Use them so
the demo never calls Valhalla, and add more origins with the same call
pattern as you cover the city.

## 3. The Overpass harvest

`scripts/harvest-osm.ts`. Behaviours copied from `osmnx/_overpass.py` and
`_http.py`, because they are battle-tested:

```qle
[out:json][timeout:90];
(
  node["amenity"~"^(restaurant|cafe|bar|marketplace|theatre|cinema|place_of_worship|marketplace)$"]({{bbox}});
  node["tourism"~"^(attraction|museum|artwork|gallery|viewpoint)$"]({{bbox}});
  node["craft"]({{bbox}});
  node["shop"~"^(craft|artwork|clothes)$"]({{bbox}});
  node["leisure"~"^(park|playground)$"]({{bbox}});
  node["sport"]({{bbox}});
  way["amenity"]["name"]({{bbox}});
  way["tourism"]["name"]({{bbox}});
  way["leisure"="park"]({{bbox}});
  relation["tourism"="attraction"]({{bbox}});
);
out center {{timeout}};
```

**Client contract, all nine points matter:**

1. **Three mirrors with failover**: `overpass.kumi.systems`,
   `overpass.private.coffee`, `maps.mail.ru/osm/tools/overpass`, then
   `overpass-api.de`. In that order — the main host is flaky (we saw 406s).
2. **Round the bbox ring to 6 decimal places before hashing.** Load-bearing for
   cache-key stability (`_overpass.py:280`).
3. **Never cache a `remark`** (`_http.py:56-58`). Overpass returns partial results
   with a remark; caching that silently truncates the dataset forever.
4. **429 / 504 → back off 55 s and retry** (`_overpass.py:477-486`).
5. `cache_only_mode` flag for the demo path, seeded from the committed snapshot.
6. Use `out center`, **not** OSMnx's `>;` down-recursion. We want points and
   centroid-representing ways, not full geometry.
7. Tile large bboxes. A whole-city query times out; a 0.02° grid does not.
8. Log which endpoint served which response, per fact. No silent sources.
9. Commit the output as an offline snapshot. **The demo must never need the
   network.**

## 4. Curated dataset — the actual demo catalogue

`data/cities/mumbai/experiences.jsonl`, one `Experience` per line, schema from
`src/contracts`.

**Split:**

| Owner | Count | Areas |
|---|---|---|
| Abhijit | ~120 | Colaba, Fort, Churchgate, Marine Drive, Kala Ghoda, Girgaon, Dadar, Matunga |
| Vishwesh | ~130 | Bandra, Juhu, Andheri, Powai, Chembur, Worli, Khar, Navi Mumbai |

```bash
npm run db:seed          # loads JSONL into SQLite, builds the FTS5 index
npm run db:harvest       # Overpass spine into data/cities/mumbai/osm.jsonl
npm run db:embed         # 3 perception dimensions, only if O3 says go
```

**Prioritise, do not over-curate.** A 250-record set with correct
`durationMin` and true `pricePerPerson` beats 400 with guesses. For each
record, the fields only a local knows:

- `durationMin` — the single most valuable field. OSM has none.
- `pricePerPerson` — for a *meal*, "what one person actually pays"
- `capacity` — can they take 6 people at once?
- `stepFree` / `kidFriendly` / `restroomOnSite` — the PS factors OSM misses
- `bestTimeOfDay` — when is this good, not just when is it open
- `weatherSensitive` — monsoon matters: `rain`, `heat`, `wind`, `any`

`provenance: { durationMin: 'curated' }` for each. If you guess, write
`inferred` and a confidence. Do not launder a guess into a fact — the provider
opportunity feed is built on this table being honest.

### Mumbai-specific notes worth encoding

- **Traffic invalidates free-flow routing.** OSRM understates peak by 3–5×.
  A `congestionModel` per corridor × time band, selected by IST clock, labelled
  an estimate. Peaks 08:00–11:00 and 17:00–21:00, lighter Sundays.
- **Transit beats road across the island.** Bandra ↔ Colaba is 21 min by train
  and 38 by car in traffic. Seed `transitCorridors` for Western, Central,
  Harbour, Metro 1 / 2A / 2B / 3, and the monorail.
- **The ferry is real** — Navi Mumbai ↔ South Mumbai waterfront.
- **Monsoon is the demo's best friend.** Jun–Sep in `monsoonMonths` flips the
  weather gate, which flips recommendations, which is our best replan demo.
- **Walled city topology** (Jaipur, if we ever add it) defeats radius filtering
  entirely. Mumbai's islands defeat straight-line distance. Isochrones, always.
- **Step-free is genuinely rare on older buildings** — and when you are wrong,
  a wheelchair user is stranded. False negatives are worse than false positives.
  When genuinely unsure, `null`, not `false`.

## 5. Reviews and events

Reviews carry `partyType`, `partySize`, `spend` and `sentiment`, because that
is what makes them useful rather than decorative: they feed the Bayesian rating
*and* they surface things like *"gets very crowded after 5 pm"*, which becomes a
`bestTimeOfDay` correction.

`Rating.value` is **Bayesian-smoothed** (Wilson lower bound, weighted by sample
size). Store `rawMean` and `count` alongside so the shrinkage is visible in the
UI — `4.6 (312)`, not a bare `4.6`.

Events: 30–50. Ganesh Chaturthi, monsoon-season events, weekly markets, gallery
nights, Koli community events. Each needs `capacity`, `openingMin/endMin`,
`weatherSensitive`.

## 6. Privacy

`UnmetDemand` stores **constraints, never identity**. No names, no contacts, no
free text from the traveller. Aggregate on a 24 h window. Anonymised geo to
neighbourhood, not coordinates, in anything a provider can read.

---

# PART 2 — ML PLAN

The user asked for training. Here is what is honestly trainable in one week with
no external data and no GPU, in order of value.

## M1. Feasibility model — the highest-value model

**The idea:** we can generate unlimited training data by *simulation*. Take a
`DiscoveryContext`, run it through the deterministic gate, and record which
experiences passed and why the others failed. That is a perfectly labelled
dataset for a model that predicts, for an arbitrary (context, experience) pair,
whether it is feasible and *which constraint binds*.

**Why it is worth it:** a learned model lets us pre-filter cheaply, estimate
constraint-binding probability for the unmet-demand feed, and — most valuable —
tell a traveller *"relaxing your time budget by 40 min would unlock 4 more
options"* without re-running the whole gate.

```
X  = [ travelMin, durationMin, bufferMin, availableMin, priceMinor, budgetMinor,
       partySize, capacity, isOpen, hoursStatus, stepFree, strollerOk, restroomOnSite,
       kidFriendly, minAge, childAges, weatherCondition, weatherSensitive,
       interestOverlap, cuisineOverlap, ratingValue, ratingCount, distMetres, isPeakHour ]
y  = multi-label feasibility: [ fits, travel_time_exceeds_budget, closed_now,
       over_budget, capacity_exceeded, not_step_free, sold_out, weather_unsafe, ... ]
       + scalar: minutesShort, moneyShort, shortfallUnits
```

| Item | Value |
|---|---|
| Model | **gradient-boosted trees** (LightGBM-style) or a small MLP; start with a decision tree so it is inspectable |
| Data | 200k+ simulated rows across 25 scenarios × ~250 experiences × noise |
| Output | `P(binds = constraint_k)`, which the UI turns into the relaxation ladder |
| Guard | **The model never gates. The deterministic gate gates.** The model only *orders* and *explains*. If they disagree, the gate wins and the disagreement is logged |
| Eval | precision/recall per constraint label vs. the gate on a held-out scenario set; and "does the model's top-ranked relaxation match the one that actually increases yield" |

This is the one to build first. It is genuinely trained, genuinely useful, and
provably cannot compromise correctness.

## M2. Per-traveller weight bandit

Not really training — online learning, which is the honest description.

**Thompson sampling** over a small set of weight configurations. Each arm is a
candidate weighting of the score components; pull an arm, rank, observe the
interaction, update.

```
reward: click .3 | save .6 | book_requested 1.0 | opened_directions .4 | shared .7
        dismiss -.4 | not_interested -.8 | reported_inaccurate -1.0
```

- **Cold start**: hand-set priors, plus 2 deliberate explore slots.
- **Shown to the user**, editable, deletable. Non-negotiable (D7, D8).
- ~20 observations before we trust it; say so in the UI rather than implying
  certainty.
- Explored with UCB, not pure Thompson, so new arms get a fair shake.

## M3. Perception-dimension embeddings

**Only if O3 says go.** The schema is worth keeping either way — three separate
dimensions beat one blended vector, and that is UGuideRAG's genuinely good idea
even though their implementation is broken.

- Model: a small ONNX sentence encoder in-process. No API, no GPU.
- Three vectors per experience: `landscape`, `activities`, `atmosphere`.
- Retrieval runs **per dimension with its own top-k, then merges** — the
  research's key finding is that the reference implementation does *not* do this
  (three cosines in one pass, unnormalised weights summing to 1.6).
- **Marathi/Devanagari is a real gap** — Orama supports Hindi and Nepali but not
  Marathi, which is a legitimate critique we would otherwise inherit.
- Retrieval: `0.4·cos(landscape) + 0.35·cos(activities) + 0.25·cos(atmosphere)`, with
  the negative channel (`neg` terms) as a separate penalty, and the weights
  **normalised**. Ship those three fixes as a stated contribution.

## M4. Popularity prior — trivial, do it anyway

A `(category, neighbourhood, hour, weekday) → engagement rate` table from
`interactions`. Laplace-smoothed. It is not "AI" but it is the cold-start prior
that beats nothing, and it is 40 lines.

## What we are NOT training, and why

| Tempting | Why not |
|---|---|
| Learning-to-rank (LightGBM ranker, two-tower) | We have no training data on day 1. `tensorflow/ranking`, `allRank` and `ptranking` are all in our `rejected/` tier for exactly this |
| A matrix-factorisation recommender | Same cold-start problem, and we are a *fit* engine, not a taste engine |
| A model that picks the itinerary | The whole architecture forbids it. Every repo that let a model order things leaked, and none had a validator |
| Anything needing a GPU or a training data purchase | One week, three people, no budget |

## Model governance — write this down

- Every model file is **versioned in git** with the seed and the data hash.
- Training is a script, not a notebook: `npm run train:feasibility` is
  reproducible or it is not a model.
- Ship the eval table with the model. A model without metrics is a liability.
- **The boundary test must pass**: no model artefact in `src/engine/`. The
  engine calls a scorer interface; the scorer loads a model. That is how we keep
  principle 1 true even as we add ML.
- Deterministic seed everywhere. Three people, one week, no time for a
  non-reproducible number.
