# EXPERIENCES — the curated catalogue

**133 records. Generated index: [`INDEX.md`](INDEX.md).**

Every line in these five files is one `Experience` from the frozen contract in
`src/contracts/index.ts`. Zod strips unknown keys on parse, so the `__meta`
block on every record is inert to the engine and free to carry the honesty
notes. Split by locality so a human can review one neighbourhood at a time:

| file | records | localities |
|---|--:|---|
| `colaba.jsonl` | 28 | Colaba |
| `fort.jsonl` | 27 | Fort |
| `marine-drive.jsonl` | 23 | Marine Drive |
| `bandra.jsonl` | 35 | Bandra |
| `adjacent.jsonl` | 20 | Kala Ghoda, Girgaon, Malabar Hill, Pali Hill, Khar, Juhu, Dadar, Matunga, Worli, Mahalaxmi, Byculla |

---

## 1. Read this before you quote a single number

**This is a demo dataset. It is not a survey, and it must never be presented as
one.** 76 of 133 records have an invented operator name. The other 57 are real
places with real names, but every operational attribute on them — price, hours,
duration, capacity, accessibility, rating — is an **estimate written offline**,
not a verified fact. `__meta.estimateBasis` says which kind of estimate:

- `demo-estimate` — a plausible number for the demo. Not surveyed.
- `demo-placeholder-price` — the venue is real; the figure is a placeholder, not
  its published tariff. Only `col-taj-palace-kitchen` carries this.

Money and hours on real venues are the most likely things to be wrong, because
both change. If this catalogue is ever used outside a demo, re-derive `hours`
and `pricePerPerson` from the Overpass snapshot and the providers before
anything else.

## 2. The provenance policy

`docs/DATA_SPEC.md` §4 says the fields only a local knows are the valuable
ones, and that a guess must be written `inferred` with a confidence rather than
laundered into a fact. That is the rule these files follow, which is why the
provenance tally looks the way it does:

```
inferred 844 · curated 134 · osm 113
```

Most of this catalogue is `inferred`, and that is the honest state of it. The
split we actually used:

| provenance | used for | example |
|---|---|---|
| `osm` | name, coordinates, neighbourhood — things a gazetteer knows | Gateway of India, Crawford Market, Mount Mary |
| `curated` | structural facts that follow from what the place *is*, and that a local would state without checking | `accessibility.restroomOnSite: false` on a public promenade, `weatherSensitive` on an outdoor fort, `pricePerPerson: null` for a mosque |
| `inferred` | every number, every hours string, every rating, and every accessibility claim about a real building | `durationMin`, `pricePerPerson`, `capacity`, `hours`, `rating`, `accessibility.*` |

Two deliberate exceptions to "inferred everywhere":

- **`accessibility.hearingLoop: true` on 7 records** is an inferred estimate
  with no survey behind it. It exists so the compound-need eval scenario
  (older adult + hearing loop) has anything to satisfy. Two records set it
  explicitly `false` and prove that is `curated`: `ban-sunday-organ` and
  `ban-goan-church-choir` are unamplified mechanical tracker organs, so there
  is no microphone to lose and therefore no induction loop. This is the weakest
  honest part of the catalogue and the demo should say so out loud.
- **`accessibility.restroomOnSite`** is `curated` in both directions. 40 records
  claim a toilet and 93 say there is none, and those negatives are load-bearing:
  they are the reason the provider unmet-demand feed has something true to
  report. Guessing `null` everywhere would have been easier and would have
  quietly destroyed the best demo beat we have.

## 3. `null` versus `false` on accessibility

`docs/DATA_SPEC.md` §4: *"Step-free is genuinely rare on older buildings — and
when you are wrong, a wheelchair user is stranded. False negatives are worse
than false positives. When genuinely unsure, `null`, not `false`."*

We took that literally, and it shows in the field tallies:

| field | true | false | null |
|---|--:|--:|--:|
| `stepFree` | 95 | 38 | 0 |
| `strollerOk` | 89 | 34 | 10 |
| `lowStairs` | 98 | 35 | 0 |
| `seatingAvailable` | 124 | 9 | 0 |
| `hearingLoop` | 7 | 4 | 122 |
| `restroomOnSite` | 40 | 93 | 0 |

`hearingLoop` is `null` on 122 records because almost nobody has one and we
have surveyed nobody. That is not a data-quality failure; it is the truth, and
it is why the field is a 3-state union in the contract rather than a boolean.
`strollerOk` carries the 10 nulls where a step-free place is genuinely unclear
for a pram.

## 4. Coordinates

Coordinates are **neighbourhood-approximate, rounded to four decimal places**,
good enough for demo routing and not good enough to publish. They are marked
`location: "inferred"` rather than `osm` on the synthetic records precisely so
nobody mistakes them for surveyed points. Reconcile them against the committed
Overpass snapshot at seed time; `data/reference/isochrones/` already covers
`bandra-west-mumbai` and `pali_hill`, so travel-time estimates for anything in
those two corridors are real rather than modelled.

## 5. Ratings are derived, not written

`rating.count` and `rating.rawMean` are computed from `content/reviews` by
`content/tools/validate-content.ts`. Do not hand-edit them; run:

```bash
npx tsx content/tools/validate-content.ts --write-ratings
```

Smoothing, declared once in the tool so it is auditable:

```
value = (sum + 12 × 4.1) / (count + 12)
```

prior `4.1`, prior weight `12`. Every record has 2–4 reviews, so shrinkage is
visible and strong: a 2-review record with a perfect 5.0 raw mean lands at
`4.09`, not `5.0`. That is the point of storing `rawMean` and `count`
alongside. `docs/DATA_SPEC.md` §5 suggests Wilson lower bound instead; if the
engine swaps to that, delete `--write-ratings` and hand the numbers over.

**Three records are deliberately ratingless** and carry
`__meta.ratingless: true` with a single review: `md-print-room-lantern`,
`ban-board-games-cafe`, `adj-byculla-mansion`. They exist so the cold-start
path is exercised by catalogue data rather than only by a unit test. The tool
fails if a `ratingless` record grows a second review.

## 6. Hours: four states on purpose

`hours.status` is not decorative. The `opening_hours` npm port (LGPL-3.0, hence
the adapter) parses real OSM strings but **not** `PH off` and **not** inline
comments. So the catalogue contains all three failure modes, and ordinary
retrieval exercises them:

| status | records | what it is |
|---|--:|---|
| `ok` | 122 | clean OSM expression, including `24/7` |
| `partial` | 5 | a real constraint the raw string cannot express, e.g. a lunch closure |
| `absent` | 3 | never surveyed. `col-tiffin-at-the-wadi`, `fort-kissa-corner`, `adj-mill-museum` |
| `unparsable` | 3 | deliberately unparsable raw strings with a trailing parenthetical. `col-farsi-reading-room`, `fort-basement-gallery`, `md-print-room-lantern` |

`lastVerified` is `null` on **every** record. None of these hours strings have
been checked, so the "hours unverified" badge is correct for the entire
catalogue. Do not paper over it by inventing verification dates.

## 7. Records that exist to be rejected

Some records are there specifically so the engine has something honest to say
no to, and the validator enforces their shape:

- `ban-dhobi-lane` — real, photographed constantly, wet broken ground, open
  drains, not step-free. Carries two 2-star reviews that say so.
- `adj-mosque-lamps-lane` — deliberately hostile `perception.atmosphere`
  (`crowded`, `festive`, `bright`, `loud`) so the crowd penalty has real
  material in the Fort district, which is where the "I want to be alone"
  scenario needs somewhere to go.
- `ban-night-market-bar` — same, for Bandra. `stepFree: false`,
  `strollerOk: false`, highest crowd density in the file.
- `col-solar-cafe-apollo` — appears in the naive acceptable set of the PS
  scenario in older drafts and is genuinely wrong there: it is `outdoor` and
  `weatherSensitive: rain`.
- `adj-mahalaxmi-racecourse` — the record `docs/DEMO_SCRIPT.md` beat 3 depends
  on. From a Colaba origin it must be rejected on `too_far` with a real
  distance, and the relaxation ladder must offer something the traveller can
  actually afford to unlock.
- `fort-metro-inox`, `ban-cinema-neo`, `ban-ceramicist`, `col-stained-glass-bench`,
  `col-taj-palace-kitchen` — 90 to 150 minute records. They exist so the
  duration gate has something to reject in a short window.

## 8. Coverage on the diversity axes

| axis | how it is covered |
|---|---|
| food | 8 `street_food`, 7 `restaurant`, 13 `cafe`, plus `diets` and `cuisines` on every record |
| heritage | 15 `heritage_site` + 5 `church` + 2 `temple` + 1 `mosque` + 1 `synagogue`-as-heritage |
| culture | `theatre`, `dance_performance`, `music_live` (6), `festival` |
| art | 5 `art_studio`, 4 `gallery`, plus three perception-dimension sets on all 133 |
| markets | 11 `market` across four localities, Sunday-only and every-day variants |
| crafts | 6 `craft_workshop` from 60 to 150 minutes |
| family | `kidFriendly: true` on 98 records, `minAge` set on 68, `ban-sukoon` and `adj-matunga-dine-out` built for a party of six |
| indoor / outdoor | 58 `indoor`, 65 `outdoor`, 5 `covered`, 5 `mixed` |
| photography | 14 records whose `perception.activities` include photographing, framing or a tripod, not just a place that happens to be photogenic |
| local / not-a-chain | 10 records written in the first-person singular of the operator: "the caretaker will talk about the house for as long as you let him", "he opens when he closes up", "the owner just looked up" |
| low budget | 74 free, 3 under ₹100, the cheapest stop is ₹60 for 20 minutes |
| premium | 4 over ₹2,000 per head |
| short | 22 records at 30 minutes or less, shortest is 15 |
| long | 8 records at 120 minutes or more, longest is 150 |
| accessibility-aware | every record carries all six fields; 40 have a toilet; 5 have a usable hearing loop; 10 `strollerOk` nulls where we genuinely do not know |
| dietary data | 40 records carry `diets`, and every restaurant and street-food record carries `cuisines` |

## 9. One known data disagreement, left in on purpose

`md-riverfront-evening` is `strollerOk: true` and one of its reviews says the
paving has been washed out by past seasons. The curated field and the review
signal disagree. We did **not** silently reconcile them, because
`docs/DATA_SPEC.md` §5 says review text is supposed to feed `bestTimeOfDay`
corrections, and deleting the disagreement would delete the demonstration of
that loop. The engine should pass the record and surface the review as a
caveat. Eval scenario `stroller-3h-uneven` documents this.
