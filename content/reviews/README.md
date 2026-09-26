# REVIEWS — synthetic demo signals

**291 reviews** across the 133 catalogue records, split by locality to match
`content/experiences/`: `colaba.jsonl` (72), `fort.jsonl` (64),
`marine-drive.jsonl` (47), `bandra.jsonl` (69), `adjacent.jsonl` (39).

## There is no `Review` schema in the contract

`src/contracts/index.ts` defines `Interaction` and `Rating` but not `Review`, so
this is our shape, typed here rather than at the call site. It follows
`docs/DATA_SPEC.md` §5, which is explicit that reviews carry `partyType`,
`partySize`, `spend` and `sentiment` *"because that is what makes them useful
rather than decorative"*.

```ts
{
  id: string                 // rev-<locality>-<nnn>, stable
  experienceId: string       // must exist in content/experiences
  synthetic: true            // required. A review is never presented as real
  authorPseudonym: string    // pseudonyms only, no handles, nothing scrapeable
  rating: 1|2|3|4|5          // integer, and it must agree with `sentiment`
  partyType: PartyType       // the contract enum, not a free string
  partySize: number          // >= 1
  childAges: number[]        // present when partyType involves children
  spendMinor: number         // paise, observed party spend, not entry price
  visitedAt: string          // ISO 8601 with +05:30
  sentiment: "negative"|"mixed"|"positive"
  text: string               // at least 25 characters. A stub is a failure
  helpfulCount: number
  signalTags: string[]       // the extractable signals, see below
}
```

## What `signalTags` is for

`docs/DATA_SPEC.md` §5: reviews *"surface things like 'gets very crowded after
5pm', which becomes a `bestTimeOfDay` correction."* So every tag is a claim the
engine can act on, and the tags are the reason these are structured rather than
decorative:

| tag pattern | count | feeds |
|---|--:|---|
| `stair` / `step` — stairs only, a turn in them, uneven, a hundred of them | 71 | `accessibility` cross-check |
| crowd and noise — crowded after 17:00, a wall of people, shoulder to shoulder | 39 | the crowd penalty |
| `not for` / age floors — not for small children, under six, six and up | 38 | `kidFriendly` / `minAge` |
| `no restroom` / `no toilet` | 31 | the unmet-demand feed |
| `book` / `sells out` / `queue at the door` / `reserve` | 27 | the booking gate |
| time-of-day — come early, busy after 17:00, empty at 06:00, go at four | 18 | `bestTimeOfDay` |
| `stroller` / `pram` — stroller ok, not for a stroller, the pram would not fit | 18 | `strollerOk` |
| `toilets on site` / `toilet on the floor` / `toilets decide it` | 11 | the positive case of the same |
| season — sunday only, monday closed, june to september, october to november | 9 | `bestMonths` |
| `hearing` — hearing loop, no hearing loop, lost the microphone entirely | 8 | the compound-need scenario |
| `stairs only` / `floor seating` — a hard `false` where the data guessed | 6 | a correction, not a complaint |
| `closed <day>` | 5 | the hours gate |

Several tags **contradict** the curated field on purpose. That is the point: a
review signal that only ever agrees with the data is decoration. The most
instructive is `md-riverfront-evening`, which is `strollerOk: true` in the
catalogue and has a review saying the paving has washed out. We left the
disagreement standing rather than reconciling it, because reconciling it would
delete the demonstration of the correction loop.

## Consistency rules the checker enforces

`npx tsx content/tools/validate-content.ts` fails on any of these, and it caught
real errors while the file was being written:

- `sentiment` must agree with the star rating. `negative` is 1–2, `mixed` is
  exactly 3, `positive` is 4–5. Otherwise the Bayesian average is meaningless.
- `spendMinor` must be plausible. Where the experience has a `pricePerPerson`, a
  review claiming more than 3× price × party size is rejected.
- `pricePerPerson: null` means free **entry**, not a free visit. A market, a
  bazaar and a craft shop all have no ticket and still cost money, so free-entry
  records get a ₹3,000-per-person incidental ceiling rather than being forced
  to zero. The first version of this rule demanded zero and flagged 12 correct
  reviews.
- `text` must be a real sentence. No stubs.
- `synthetic: true` is mandatory.
- `experienceId` must resolve.

## Sentiment and rating distribution

Deliberately tilted negative, because a demo where everything is 5 stars tests
nothing:

| rating | count | share |
|--:|--:|--:|
| 5 | 70 | 24% |
| 4 | 88 | 30% |
| 3 | 90 | 31% |
| 2 | 43 | 15% |
| 1 | 0 | 0% |

**133 of 291 (46%) are 3 or below.** That is what makes the negative sentiment,
the crowd penalty and the `unmet-demand` feed believable, and it is why
`ban-dhobi-lane` and `ban-night-market-bar` read as honest records rather than as
places a travel product is embarrassed to recommend. Note the spread is
concentrated on 3 and 2, which is what a real review corpus looks like — most
disappointment is mild and specific ("the pavement is broken", "the queue at
half past ten"), not vitriol.

**One real gap: there is not a single 1-star review.** Every negative in the file
is a 2. Real corpora have 1s, and if the demo is asked to render a 1-star review
card there is nothing to render. Adding some would mean writing reviews that
are unambiguously bad, and the honest versions of those in this catalogue
(`ban-dhobi-lane`, `adj-banganga`, `ban-koli-versova` with a five year old) all
land at 2 because the reviewer is rating the visit, not the existence of the
place. Flagged rather than fabricated.

## Copy

Same banned-phrase list as the experiences, plus a second rule specific to
reviews: **no review may claim a fact the experience record does not carry.** No
"the manager came over", no "we will be back next year", no invented personal
history. A review is a description of a place, not a story about a relationship
with it. Reviewers complain about the stairs, the noise, the closing time, the
price and the queue, which are all things the engine has a field for.
