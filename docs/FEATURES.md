# FEATURES — for Vishwesh

> Your files. `src/features/**`, `src/llm/**`, `content/**`,
> `docs/EVAL_SPEC.md`, `docs/DEMO_SCRIPT.md`.
>
> You own two things nobody else can do: **the loop that closes** (traveller
> intent → provider), and **the measurement that proves it works**.

---

## Your lane in one line

You turn what Abhijit's engine produces into something a person can act on, and
you write the scenarios that prove it worked.

---

## 1. Discovery context editor

The first screen. It has to be usable in **under 30 seconds on a phone**, because
the traveller is standing on a street.

### Fields, in priority order

| Field | Control | Default | Why this order |
|---|---|---|---|
| Where | pin on map, or free text, or "I'm at <landmark>" | map centre | position is the one thing you always know |
| **How long** | slider, 30 min – 12 h, with 15-min steps | 180 min | the primary constraint; biggest lever on results |
| Now | wall clock, editable | actual | peak-hour and hours checks depend on it |
| Who | party size stepper + type selector + child ages | solo, 1 | drives group fit |
| **Budget** | slider, ₹ increments, + "no limit" | ₹1,500 | second-biggest lever |
| Needs | discrete toggle pills: step-free, stroller, low stairs, hearing loop, restroom | none | never a score, always booleans |
| Interests | chips, multi-select, free text adds | none | multi-tag |
| Avoid | chips | none | the negative channel; the research shows it is load-bearing |
| Weather | auto-detected, manual override | auto | monsoon demo hook |
| **Run** | one big button | | |

**Budget must be a real slider with rupee stops.** 0 / 250 / 500 / 1,000 / 1,500 /
2,500 / 5,000 / no limit. Free-text budgets ("about a thousand") get parsed
into a number and the slider **snaps to it** so the state is visible.

**Child ages as a stepper, not a dropdown.** "Toddler" versus "teen" changes
almost every recommendation, and the PS's own example is a family with a toddler.

### Non-negotiable

- Every control writes straight into a `DiscoveryContext`. No local shadow state,
  no "apply" button. The plan updates live.
- The slider bounds are **derived from the city manifest**, not hardcoded.
- Deep-linkable. A `context` query param means a shared URL reproduces the exact
  plan. Steal the permalink trick from `trip-planner/`: FNV-32a hash the query →
  seeded PRNG → alliterative slug. Same context, same URL, cacheable, **no
  database**.

## 2. Discovery result surface

Abhijit gives you `Plan`. Karan renders it. You decide what the user *does*.

| Element | Source | Your call |
|---|---|---|
| Plan timeline | `Plan.stops` + `Plan.legs` | ordering, emphasis, what is pinned |
| Feasibility meter | `Fit` | Karan's component; you decide the copy |
| Why this | `ScoreBreakdown.components` | which components are worth showing first |
| Why not that | `Rejection` | **your highest-value feature** — see below |
| Unmet demand banner | `UnmetDemand` | when the plan is thin, say why and offer the fix |
| Stress | `Plan.stressScore` | the one rescue move |
| Alternatives | `Plan.rejected` | surface near-misses with the single blocking constraint |

### "Why not that" — the feature nobody else will have

Tapping anything that did not appear returns a **specific** answer, not an empty
list:

> **Jalsa Baag** — 1.2 km from you
> ✗ Needs 40 min more than you have left
> *You have 2h. This needs 2h 40m including travel.*
>
> → *Add 40 minutes* · *Show things that fit 2h* · *See what to cut*

Three responses, each a real mutation of the context. The "show what to cut"
option is the good one: it inverts into a plan where the current first stop is
pinned and the alternatives are re-packed around it.

### Empty and thin states

Per Karan's copy rules, but you decide *which* state:

| Situation | Action |
|---|---|
| Zero results | Cause-branch. Offer the cheapest constraint to relax. |
| 1 result, tight | Offer to extend by 15 min, and say what that unlocks |
| Only 1 category survived | Say so. "Everything that fits is a restaurant. Want indoor shopping instead?" |
| Blocked by hours | "Everything nearby is closed. Next opening 09:00." |
| Blocked by weather | "All of these are outdoor and it's raining. Show the 3 indoor options within 2 km." |

## 3. "Reality changed" panel

The PS asks for adaptation explicitly. Six one-click triggers, each a real
`ContextChange` with a written `narrative`:

| Trigger | Context patch | Expected |
|---|---|---|
| It started raining | `weather.condition = 'heavy_rain'` | outdoor loses, indoor wins, beach drops |
| We lost 90 minutes | `availableMin -= 90` | fewer stops, closer, one swap |
| This one's sold out | `excludedIds += [id]` | minimal replacement |
| Budget is now ₹600 | `budget.minor = 60000` | prune, show what was cut |
| Need a bathroom | `accessNeeds += ['restroom']` | filter to on-site |
| We're exhausted | mood → low energy | raise Stress penalty, longer dwell, fewer transfers |

The panel shows the **swap diff**: removed, added, why, score delta. And it
asserts `preservedIntent: true` visibly — *"still looking for: street food,
something local"* — because principle 3 is that we never silently replace what
they wanted.

**Metric: ≤ 2 swaps per trigger.** If a replan returns 5 swaps, the engine is
wrong and that is a finding, not a state to ship.

## 4. Chat sidecar

```ts
parseIntent(text, ctx): Promise<DialogueDecision>
narrate(plan, ctx): Promise<string>
```

`DialogueDecision` is the **only** model output that can affect anything:

```ts
{ contextPatch: {...}, reply: string, confidence: number, suggestions: string[] }
```

It cannot name a recommendation, reorder a plan, or edit a feasibility result.
Enforced by a test that fails the build if it widens. **Do not try to be clever
here** — every repo that let the model be clever leaked.

### What it must handle

| Utterance | Expected patch |
|---|---|
| "we're exhausted" | mood low, nothing else |
| "actually make it ₹600" | `budgetMinor: 60000` |
| "my aunt can't do stairs" | `accessNeeds += ['wheelchair']` |
| "something for a 6 year old" | `interests += ['family','kid_friendly']` |
| "nothing too crowded" | `avoid += ['crowded']` |
| "is it far?" | **no patch** — answer from `Plan` |

That last row matters. A question is not a mutation, and the model must be able
to answer without changing anything.

### UX

- Streaming. Suggestion chips for the common cases, so people do not have to
  type. Clicking a chip is faster than typing and demos better.
- `confidence >= 0.5` to act; below that, ask. Show the clarification as a
  chip, not a paragraph.
- **Never let chat edit the plan.** It edits the context, and the engine
  re-derives the plan. If the user wants to swap a specific stop, that is a
  direct action on the plan, not a chat message.
- The reply must state what changed: *"Cut 2 stops, kept step-free. Here's why."*

## 5. Provider side — listings and requests

Scope is capped: **listings + requests, no payments** (`DECISIONS.md` D4).

### Listing editor

A subset of `Experience`, plus provider-owned fields:

| Field | Notes |
|---|---|
| Name, category, description | free text, blurb capped |
| Neighbourhood, location | pin, snapped to the map |
| **Duration** | minutes. The most important field in the form. |
| **Price per person** | integer paise. A stepper, not a text box. |
| **Capacity** | max group per booking |
| **Accessibility** | the six booleans, each `true` / `false` / **`unknown`** |
| Kid-friendly, min age | |
| Indoors / outdoors / covered | segmented control |
| Diets, cuisines | multi-select chips, open vocabulary |
| Best time of day | |
| **Availability** | recurring weekly slots + capacity each + one-off overrides |
| Booking | walk-in? lead time? |

**"Unknown" is a first-class option** on accessibility. A provider who does not
know must be able to say so — otherwise we either misrepresent them or silently
drop them from every accessible search.

### Availability

Reuse `Slot` exactly as contracted: `capacity` is the only number, availability
is **derived** by subtracting confirmed, pending, then carts. No `remaining`
column anywhere in the UI or the DB.

Show the provider their derived availability, and the calendar that produced it.
That transparency is the feature.

### Request inbox

The state machine is `BOOKING_TRANSITIONS` in the contracts, enforced in the UI:

```
requested ──► confirmed ──► completed
    │             │
    ├──► declined └──► cancelled
    └──► cancelled
```

- Illegal transitions are **not offered**, and if one is attempted the API throws.
- **Declining requires a reason.** The traveller is told, and the reason feeds
  provider reliability. Ask for it; it is our reputation play.
- Every transition shows in a history with actor and timestamp.
- Double-clicking confirm must be safe: idempotency by deterministic
  transaction id, so capacity cannot decrement twice.

## 6. Unmet-demand feed — the flywheel

This is the answer to the PS's provider half, and the cheapest high-value thing
you will build.

From `UnmetDemand`, aggregated per provider per neighbourhood per week:

> **Unmet: step-free craft workshops under ₹500**
> 42 travellers searched here in the last 7 days. You are the only match in
> 2 km. The binding constraint was `not_step_free` (31 of 34 candidates).
> **Suggested action:** confirm step-free access, or add a Thursday 17:00 slot.
> *Evidence:* 12 searches, 0 results, 09:00–19:00 preferred, 4 with toddlers.

Rules for it to be worth building:

- **Every suggestion carries a count.** A suggestion without evidence is
  marketing copy, and we would be lying.
- The action must be one click: open the listing at the field in question, or
  open the availability grid with the suggested window pre-selected.
- **Estimate the impact, and then measure it.** Track whether the suggestion was
  taken and whether match rate moved. If it never moves, say so and cut the
  suggestion. A dashboard of suggestions nobody acts on is worse than none.
- Never suggest something already offered. Cheap check, permanent credibility.

## 7. Provider analytics

Deliberately small. Impressions, fit-views, requests, acceptance rate, and
**rejection reasons** (which is the actionable one — if 12 people declined
because of capacity, that is a business insight).

Plus a **listing quality score** with the *measured* effect of each fix, not a
vague grade:

> Listing quality 62/100.
> Adding a photo → 3× more fit-views *(measured across 40 listings)*
> Setting `durationMin` → 2.1× more plan inclusions
> Confirming step-free → unlocks 14 unmatched travellers near you

Every claim needs a measured number. If we cannot measure it, we do not print
it.

## 8. Eval scenarios — your highest-leverage task

**25–30 scenarios**, authored with expected-acceptable sets, in
`docs/EVAL_SPEC.md`. This is the artifact a judge reads, and it is what stops
us from *believing* our own numbers.

Write them from the traveller's voice, not the schema's:

> *"Family of four, toddler, two hours near our Colaba hotel, ₹1,500, it might
> rain, my mother can't manage stairs. We want something local, not a chain."*

Each scenario gets:

| Field | Meaning |
|---|---|
| `context` | a full `DiscoveryContext` |
| `acceptableIds` | the set a competent human curator would accept |
| `forbiddenIds` | must never appear, and **why** |
| `expectCoverage` | whether a plan must exist at all |
| `assertions` | utilisation > 0.85, ≤ 2 swaps, no violation, etc. |
| `why` | one line — what this scenario is testing |

**Cover the awkward cases.** They are where we will find bugs:

- 45 minutes, nothing booked
- ₹0, "just a walk"
- 8 hours, no constraints at all
- wheelchair user, monsoon, 90 minutes
- Jain/veg-only, lunch, near a temple
- a 16-year-old and a 70-year-old, 3 hours, one wants to hike
- festival day, everything crowded
- Navi Mumbai → South Mumbai, 2 hours, transit only
- shift worker at 06:00
- 2 adults, wants to be alone
- last-minute 30 min before a train
- "I don't want tourists" — a negative-only query

**Every scenario must pass with `LLM=off`.** If one needs a model, it is
testing the wrong thing.

## 9. Demo script

`docs/DEMO_SCRIPT.md`, 90 seconds of value in 3 minutes of stage time.

**The 90-second spine:**

1. Drop a pin, say *"family of four, toddler, two hours, ₹1,500, it might rain,
   need step-free"*. Get a 2–3 stop chained plan.
2. **"It started raining."** Watch it re-solve and show the swap. ≤ 2 swaps.
3. Tap something missing → get a *specific* reason and three ways out.
4. Provider view → one request to action, three unmet-demand suggestions.
5. **`LLM=off`** → it all still works.

Which demo moment is *ours* rather than table stakes: step 3. Every project can
show a list. "Here is exactly why the thing you wanted is not in the list, here
is what it would cost to unlock it" is a product decision nobody else has made.

## 10. Content and copy

`content/` — all seed copy, so it is reviewable in a PR.

Seed: provider bios and blurbs, event descriptions, festival notes, the
explanation strings for every `RejectionCode`, the narration templates for
`LLM=off`, and the empty/zero-result states.

**Rejection copy is the highest-value content in the product.** 25 codes, each a
finished sentence with a number in it. Write them with the numbers as real
interpolation, not as placeholders. Banned: emoji, `...`, "Simply", "seamless",
"unlock", "elevate", colon reveals, fake-profound kickers.

## Definition of done

- [ ] Context editor usable in < 30 s on a phone, live-updating, deep-linkable
- [ ] All 6 "reality changed" triggers wired to real patches, ≤ 2 swaps each
- [ ] "Why not that" returns a specific reason **and** three actions
- [ ] Chat only ever emits a `contextPatch`; a test enforces it
- [ ] `confidence < 0.5` asks a clarifying question instead of acting
- [ ] Provider can create a listing, set availability, and receive/answer requests
- [ ] Declining requires a reason; illegal transitions are impossible in the UI
- [ ] Unmet-demand feed gives ≥ 3 actionable suggestions per seeded provider, each with a count
- [ ] Every quality-score claim carries a measured number
- [ ] 25–30 eval scenarios authored, all passing with `LLM=off`
- [ ] 25 `RejectionCode` messages written with real numbers
- [ ] Demo script dry-runs end to end twice

## Reading

- `research/findings/05-llm-integration.md` — the LLM boundary, `DialogueDecision`, and
  exactly where the reference repos leak. Read §2 before writing `nlu.ts`.
- `research/findings/03-marketplace-booking.md` — pretix's capacity model and
  oversell ordering, Medusa's four workflow primitives, the trust mechanics.
- `research/findings/04-data-retrieval.md` §3 — the Overpass client contract, and
  the OSM tag semantics your listing forms must match.
- The `no-ai-slop` and `web-design-guidelines` skills, both now installed, for
  the copy pass.
