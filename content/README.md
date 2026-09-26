# CONTENT — Ananta's demo universe

Everything the demo needs that is not code. One rule applies to all of it:

> **Nothing here is a survey. Every number is an estimate and every invented
> thing says so.** If a judge asks "how do you know that", the honest answer is
> in the file, and the product shows the same badges the data carries.

## Layout

| path | what | count |
|---|---|--:|
| `experiences/` | the catalogue, one frozen-contract `Experience` per JSONL line | 133 |
| `reviews/` | synthetic demo reviews with party type, size, spend and sentiment | 291 |
| `events/` | demo event/calendar rows, all explicitly synthetic | 40 |
| `evaluation/` | eval scenarios, one per JSONL line | 31 |
| `eval/` | pointer only — see below | — |
| `tools/` | the single runnable check for all of the above | 1 file |

Per-locality counts, from the checker: Colaba 28, Fort 27, Marine Drive 23,
Bandra 35, adjacent 20 across eleven more localities. 24 of the 26 contract
categories are in use.

## The one check

```bash
npx tsx content/tools/validate-content.ts
```

It validates every record against `src/contracts/index.ts` (imported, never
restated), cross-references reviews, events and scenarios against the
catalogue, recomputes every rating from the reviews, and greps the copy for the
AI-slop patterns below. Two flags:

```bash
npx tsx content/tools/validate-content.ts --write-ratings   # rewrite rating blocks from the reviews
npx tsx content/tools/validate-content.ts --index          # regenerate experiences/INDEX.md
```

It exits non-zero on any problem. Everything quoted in the report below came out
of this tool, not out of a word count.

## Honesty conventions used consistently

| convention | meaning |
|---|---|
| `__meta.synthetic: true` | the operator name is invented for the demo. 76 of 133 |
| `__meta.nameSource` | `real-landmark`, `real-venue`, `real-museum`, `real-gallery`, `real-church`, `real-temple`, `real-mosque`, `real-market`, `real-street`, `real-space`, `real-cinema`, `real-theatre`, `real-beach`, `real-ruin`, `real-heritage`, `real-institution`, `real-synagogue`, `real-library`, `real-area`, `real-location`, `real-kissa` vs `invented-demo-operator`, `invented-demo-venue`, `invented-demo-programme`, `invented-demo-class`, `invented-demo-tour`, `invented-demo-route`, `invented-demo-cart`, `invented-demo-cluster`, `invented-demo-arrangement`, `invented-demo-location`, `invented-demo-property`, `approximate-landmark`, `approximate-lane`, `approximate-footpath`, `approximate-viewpoint`, `approximate-location` |
| `__meta.estimateBasis` | `demo-estimate` or `demo-placeholder-price` |
| `synthetic: true` on every review | a review is never presented as a real person's words |
| `authorPseudonym` | pseudonyms only. No real names, no handles, nothing scrapeable |
| `provenance: "inferred"` + a `__meta.note` | where an estimate needs a human sentence explaining itself |

`__meta` is a non-contract key. Zod strips unknown keys, so it is inert to the
engine and free to carry the notes.

## Copy rules applied

Every blurb and description was checked against a banned-phrase list: no
"world-class", "seamless", "unforgettable", "must-visit", "hidden gem",
"nestled", "bustling", "vibrant", "picturesque", "treasure trove", "must try",
"a journey", "escape to", "savour the", "not to be missed". Blurbs are capped at
200 characters, descriptions at 520, and a description that just restates the
blurb is a failure.

The house style is short, specific, and willing to say a place is a bad idea:
*"Nothing to do but look and take a photograph"*, *"You are paying for the view
and the food is very good rather than the reason"*, *"it is hot and broken and
everyone says avoid it"*. A travel product that never says anything is bad about
a place is not describing places.

## The `content/eval/` path

`docs/EVAL_SPEC.md` §3 says scenarios live at `content/eval/scenarios.jsonl`.
They live at **`content/evaluation/scenarios.jsonl`** per the session ownership
map, and `content/eval/README.md` points here. **Abhijit: the eval harness needs
its scenario path repointed.** Nothing else about the format changed; the shape
is exactly the block in EVAL_SPEC §3 plus a `notes` field and an
`expectKeptIntentTerms` addition, both optional.

## The four things in this dataset that are not what they look like

1. **Ratings are computed from synthetic reviews.** `4.6 (312)` in the UI is
   arithmetic on text we wrote. `count` is 2–4, never 312, and the shrinkage is
   visible on purpose: a 2-review record with a perfect 5.0 raw mean lands at
   `4.09`, not `5.0`. 46% of all reviews are 3 stars or below.
2. **Coordinates are neighbourhood-approximate.** Four decimal places, good for
   demo routing, not for publishing. Reconcile against the Overpass snapshot.
3. **`hours.lastVerified` is `null` on all 133 records.** Nothing has been
   checked, so the "hours unverified" badge is correct everywhere. Do not invent
   verification dates to make the badge go away.
4. **Five records claim a hearing loop and none of it is surveyed.** It exists
   so the compound-access-need scenario has something to satisfy. Say so in the
   demo.

## What the checker caught while this was being written

It is worth listing, because every one of these was a real error that would have
shipped:

- 4 reviews whose `spendMinor` was more than 3× the experience's price × party
  size. Two were off by a factor of 5.
- A rule I had written wrongly: it demanded zero spend on `pricePerPerson: null`
  records, which flags 12 perfectly good market and bazaar reviews. Free *entry*
  is not a free *visit*; the rule now has a ₹3,000-per-person incidental
  ceiling.
- 4 records with `indoorOutdoor: "indoor"` and `weatherSensitive: "rain"`, which
  claims the weather can neither reach the place nor ruin it.
- 3 malformed `endDate` strings containing a `/`, and one 70-minute event booked
  inside a 60-minute window.
- 16 uses of a rejection code, `no_negative_match`, that **is not in the
  contract**. The checker now validates every `forbiddenBecause` value against
  `RejectionCode.options`; the correct code is `excluded_by_traveller`, because
  `avoid` is an explicit traveller-supplied exclusion.
- 15 experience ids referenced by scenarios that did not exist, plus a
  placeholder function call that was not valid JSON.
- And, my own fault: the first `--write-ratings` implementation wrote one line
  per fix to the same file, which truncated all five experience files. The tool
  now groups by file and writes once. **If you extend it, keep that property.**
