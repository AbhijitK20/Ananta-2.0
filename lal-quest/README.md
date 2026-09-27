# Local Legends

A gamified stamp album for the 890 places locals recommended across 202 cities.
Clear quests, keep a streak, fill the book.

```bash
npm install
npm run dev        # http://localhost:4311
npm run typecheck
npm run check      # game rules against the real dataset
npm run verify     # typecheck + check + build + drive it in a browser
```

`npm run verify` is the one that matters. It builds, serves, drives every screen
in a real browser with Playwright, and asserts the game loop end to end — then
tears the server down again. See [Verifying](#verifying) for what it checks and
which bugs it caught.

---

## Why this is not inside `research/lal-clone`

The clone is **reference material, not product surface**. It is pixel-locked and
`tools/verify.mjs` compares the border box of 56 named elements against the live
site; adding a stateful XP bar to it would fail that comparison by construction,
and its own README says nothing in product surface should import from it.

So this is a sibling app at the repository root, which takes two things from the
clone and nothing else:

- **the dataset** — copied into `data/`, not imported, for the reason above
- **the visual language** — Fraunces + Inter self-hosted via `next/font`, the
  magenta accent, light-only ground, plain CSS with a prefixed class namespace

No shared code. The clone is a brochure; this is a game, and they have almost
nothing in common beyond where the photographs came from.

---

## The data, and the four things it does not know

890 unique places, 202 cities, 8 categories, 4 budget bands. The source held 892
records and 2 were dropped; the numbers below are what the album actually holds.

| | |
|---|---|
| **576 places carry no category** | the extractor reads category from a node the site only renders on some cards. `data/social-impact.json` has 578 such records; two of the dropped collisions were among them |
| **2 records collided on their own id** | `vienna/magdas-hotel` and `parnu/uuskasutuskeskus-parnu` each appear twice, differing by case or a dropped diacritic. First occurrence wins |
| **202 places have no neighbourhood** | rendered as nothing, not as a repeat of the city name |
| **282 places have no budget band** | `unknown` is a first-class band, not a missing one |

**All four are surfaced in the UI rather than smoothed over.** Unfiled and
unknown-budget get a dashed outline so they cannot be mistaken for real
coverage; the two collisions are named on the cities page; 189 of the 202 city
labels are marked as reconstructed from a URL slug rather than presented as
authoritative.

The alternative — dropping unfiled places, or guessing a category for them —
would make the collection look emptier or better-sourced than it is. The whole
premise of the source data is that a local said this, so the app declines to say
anything they did not.

---

## The game

### Everything derives from one set

`Save.stamps` — a map of place id to the time it was stamped — is the **only**
thing stored that describes what you have. XP, levels, quest progress,
collection counts, city clearance and achievement unlocks are all computed from
it at read time.

Four representations of "how many places has this person collected" that can
disagree with each other is a bug factory, and every one of them needs a
migration when the rules change. Deriving costs a `filter` over 890 records,
which is nothing, and it makes it structurally impossible for the XP bar to
contradict the stamp book.

What *is* stored is everything that records **when** rather than **what**:

| field | why it cannot be derived |
|---|---|
| `claimedQuests` | a claim is a one-shot payout; re-deriving it from progress pays twice the moment a rule changes |
| `unlocked` | the date a condition was first met is gone by the time you read the save |
| `dailiesDone` | only the current day's nomination is kept, so yesterday's pick is unknown |
| `activeDays`, `dailyCounts` | a streak is a claim about the past |

### Quests — 222 of them, all winnable

Progress is *evaluated* from the stamp set, never tracked, so a quest cannot go
half-credited and closing the app cannot lose progress.

City quests are generated from the data's own shape rather than hand-listed: one
per city with two or more places, so a player who has collected in Reykjavík
finds Reykjavík on the board, and a four-place city is a four-place quest.
Category quests target a quarter of the places carrying that tag.

`npm run check` asserts no quest asks for more than exists — an impossible quest
is worse than no quest.

### Streaks — and the DST trap

A streak is a promise about **your** days, so a day key is `YYYY-MM-DD` in local
time and day arithmetic runs on UTC-noon parsed dates rather than on
milliseconds. Adding 86 400 000 ms to a local date lands on the wrong day twice
a year in any timezone observing DST — and would reset a Kolkata player's streak
at 00:00 UTC, around five in their evening.

The current streak deliberately tolerates "not played today yet": it anchors on
yesterday, and the chip says **at risk** rather than claiming a streak that is
still alive. A missed day in the week strip is drawn hatched, not empty — an
empty square and a striped square are indistinguishable at 26px, and the gap is
the thing you are looking for.

### Levels — 10 of them, and the curve is not the album

Tourist → Local Legend. 10 XP per stamp, 50 per cleared city, 15 per daily, plus
quest rewards. The curve tops out at 6000 XP — 600 stamps — and the album holds
890, so maxing the curve and finishing the album are two different achievements.

### No proof of presence

Stamping is self-reported. The button says **Stamp**, not "Check in", and the
place page says so outright. There is no GPS check, and adding one would make
this a different and worse product.

### Storage is allowed to fail

`localStorage` throws on the *read* in Safari private browsing, with site data
blocked, on a null origin, and at quota. Every access is wrapped, with an
in-memory fallback: a player with storage disabled still plays for the tab's
lifetime and is told once that progress will not persist. A save from a *future*
version is refused rather than reinterpreted — reading it as the old shape would
drop the newer build's fields on the next write.

---

## Rendering

**1099 static pages, zero dynamic rendering.** The two dynamic routes are server
components with `generateStaticParams` — 202 cities, 890 places — wrapped around
thin client views, because the stamp set lives in the save but the route still
has to be prerenderable. That is the same precondition the clone needs for
shipping its assets inside a native shell and swapping them over the air.

Hydration is split on purpose: the first paint is always the empty save, and
every progress element checks `hydrated`. Reading `localStorage` in a
`useState` initialiser would produce client markup that differs from what Next
sent, so React discards the server HTML and the XP bar visibly jumps a second
after load.

---

## Verifying

```bash
npm run check     # 97 assertions, game rules against the real dataset
npm run verify    # + build, + 48 browser assertions, + the 404 boundary
```

`scripts/check.ts` covers what a typechecker cannot see: DST day stepping, level
monotonicity across 7000 XP, that the XP the toast reports equals the XP the rail
derives, that no quest is unwinnable, that a one-place city pays no city bonus.

`scripts/smoke.mjs` drives Chromium: stamp, check the toast, the rail, the
streak, the ring, `localStorage`, a reload, unstamp, claim, search all 202
cities, clear Lisbon, reset, and assert **zero console errors**. `scripts/shots.mjs`
screenshots every screen at desktop and phone width.

### Bugs these caught

Worth recording, because every one of them compiled cleanly and looked right:

- **`runBackwards` walked the array forwards** while anchoring at its newest
  element, so it compared the oldest day against the anchor, saw it as "before",
  and returned 0. **Every streak in the game was permanently zero.**
- **The daily bonus was reported but not counted.** The toast itemised +10 and
  +15; the derived XP rose by 10. Fixed by storing `dailiesDone` and deriving
  from it, which is the only reason that field exists.
- **The unstamp guard checked the wrong thing.** It compared `dailiesDone` length
  before and after a function that never touches that list, so it was always
  true and the daily bonus could not be taken back — 15 XP per day, forever.
- **A 1-place city paid +50 XP silently.** The derivation and the toast disagreed
  about whether a one-place city is a clearance. Both now call `cityBonusFor`.
- **`dynamicParams = false` logged an internal `NoFallbackError`** per bad URL
  instead of rendering `app/not-found.tsx`, because Next rejects the slug during
  route resolution, before `notFound()` can run.
- **A duplicated claim entry would have paid a quest twice** — the reducer's
  guard is on the write path, the derivation on the read path.
- **Bullets leaked from two `<ul className="lq-grid">`**, because the list reset
  lived in inline styles on the other five.

---

## Layout

```
app/
  layout.tsx              provider + persistent shell
  page.tsx                today: daily, closest quests, cities to fill
  quests/page.tsx         222 quests, grouped by tier
  cities/page.tsx         202 cities, searchable
  cities/[slug]/          CityView.tsx (client) + page.tsx (static params)
  stamps/page.tsx         album, categories, badges, levels, reset
  place/[city]/[slug]/    PlaceView.tsx (client) + page.tsx (static params)
  not-found.tsx           the 404 the dynamic routes need
lib/
  content.ts              the place index, derived once, frozen
  game/
    types.ts              Save, Quest, Achievement, Level — and why
    storage.ts            read/write/migrate, never throws
    xp.ts                 XP constants and the level curve
    quests.ts             222 generated quests + evaluation
    achievements.ts       15 badges, split into "satisfied" and "render"
    daily.ts              day keys, streaks, the daily pick
    store.tsx             the one owner of progress
scripts/
  check.ts                97 rule assertions
  smoke.mjs               48 browser assertions
  shots.mjs               screenshots
  verify.sh               all of the above, self-contained
```

No framework. No state library. No Tailwind. The clone is plain CSS and so is
this, under an `lq-` prefix — two independent stylesheets in two independent
apps is cheaper than a design system neither was built for.
