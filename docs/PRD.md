# PRD — TravelBuddy (Ananta)

> Don't optimise for places. **Optimise for moments.**

Research codename ATHITI · Masterplan: [`MASTERPLAN.md`](MASTERPLAN.md) ·
Decisions: [`DECISIONS.md`](DECISIONS.md) · Contracts: `src/contracts/index.ts`

| | |
|---|---|
| **Problem** | PS ID 6 — Local & Experiences: Intelligent Local Discovery & Experience Platform |
| **Status** | Week 1 of 1 · 3 people |
| **Surface** | Responsive web app, traveller + provider |
| **Stack** | TypeScript only. Next.js 15.5.26, React 19.2, `node:sqlite`, MapLibre |
| **North-star metric** | % of sessions where the traveller completes a plan they say fits |

---

## 1. Problem statement, in our words

A traveller in a new city has a **window** (three hours), a **budget** (₹1,500),
a **party** (four people, one a toddler), a **set of needs** (step-free, local
food, something cultural), a **position** (a hotel in Colaba) and a **condition**
(monsoon). Every discovery tool returns a ranked list that ignores at least one
of those. Simultaneously, the local potter and the Koli community have no channel
to the traveller standing 2 km away who would love what they do.

These are one problem. Both sides fail because there is no shared, structured,
timely representation of **what fits whom, where, and when**.

## 2. Who it is for

### Primary — the time-constrained traveller
On the ground, between commitments, with a hard stop time. Not planning a
two-week trip; trying to answer *"what can I actually do right now?"* Open to
one tap, closed to a 20-minute form. Reachable on a phone, on a bad connection,
possibly while standing in the rain.

### Secondary — the group co-decider
In the group chat, trying to reconcile a low-walking parent with a
want-to-hike teenager. Needs to see the **tension**, not a silent average.

### Tertiary — the local provider
A potter, guide, musician, food-stall owner, festival organiser or small
operator. Has **no marketing budget** and no time for a marketplace. Wants to
know what people nearby are looking for and cannot get.

### Explicitly not
The itinerary-optimizer tourist planning a whole trip in advance. The
"hidden gem" collector. The day-trip package buyer. We optimise for a window
measured in hours.

## 3. Product principles

1. **Fit before appeal.** A recommendation that does not fit is not a
   recommendation. Hard constraints gate, then we rank what survives.
2. **Show the reasoning.** Why this, and why not that. Always both.
3. **The engine decides; the language model explains.** Proposing and disposing
   are separate jobs.
4. **Say where every fact came from.** Curated, provider, OSM, inferred, derived.
5. **Never replace the traveler's intent.** Adapt the plan; preserve the goal.
6. **The provider side is an acquisition channel, not a storefront.**

## 4. The core loop

```
     traveller                        engine                        provider
  ┌──────────────┐            ┌──────────────────┐            ┌──────────────┐
  │ where        │            │  retrieve        │            │  listing     │
  │ when         │───────────▶│  feasibility     │───────────▶│  availability│
  │ budget       │  context   │  score           │  plan      │              │
  │ party        │            │  cluster → route │            │  request     │
  │ needs        │            │  validate        │            │  inbox       │
  │ interests    │◀───────────│  relax           │            │              │
  └──────────────┘  plan +    └──────────────────┘            └──────┬───────┘
       │          why-this /        │                                  │
       │          why-not-that      │      unmet demand               │
       └──── reality changed ──────▶└──────────────────────────────────┘
                     replan, minimal swaps, intent preserved
```

The loop closes at the bottom right: a search that returns nothing usable is
logged with **which constraint killed the most candidates**, and that becomes a
concrete suggestion for the nearest matching provider. That is the flywheel, and
it is the part the PS means by "reach the right customers".

## 5. Functional requirements

Priority: **M** = must ship · **S** = should · **N** = nice

### Discovery

| # | Requirement | Pri | Owner |
|---|---|:--:|---|
| F1 | Resolve a location by pin, free text, or "I am at <hotel/landmark>" | M | V |
| F2 | Capture the window: available minutes + wall-clock now | M | A |
| F3 | Capture budget as a total, optionally a per-person ceiling | M | A |
| F4 | Capture party: size, type, child ages | M | V |
| F5 | Capture accessibility needs as discrete booleans, never a score | M | A |
| F6 | Capture interests, and things to avoid | M | V |
| F7 | Detect weather from a real forecast, with a manual override | S | V |
| F8 | Return a **chained, time-boxed plan**, not a list | M | A |
| F9 | Every stop carries a `Fit` with per-constraint pass/fail | M | A |
| F10 | Every stop carries a `ScoreBreakdown` in plain sentences | M | A |
| F11 | Report **why a specific thing the traveller asked about is missing** | M | A |
| F12 | Suggest alternatives when the first choice is infeasible | M | A |

### Adaptation

| # | Requirement | Pri | Owner |
|---|---|:--:|---|
| F13 | Re-solve on a context change and emit a **minimal swap set** | M | A |
| F14 | Every swap carries a written reason and a score delta | M | A |
| F15 | Preserve intent: diff against `original`, never the last mutation | M | A |
| F16 | One-click triggers for rain, lost time, sold out, budget cut | M | K |
| F17 | A named relaxation ladder that always says what it gave up | M | A |

### Trust and learning

| # | Requirement | Pri | Owner |
|---|---|:--:|---|
| F18 | Provenance badge on every inferred field | M | K |
| F19 | "What I learned about you" — weights visible and editable | S | K |
| F20 | Learn from interactions, shown to the user, deletable | S | A |
| F21 | Report incorrect information, and act on it | S | V |
| F22 | Stress score with one concrete rescue move | S | A |

### Provider

| # | Requirement | Pri | Owner |
|---|---|:--:|---|
| F23 | Create and edit a listing with duration, price, capacity, accessibility | S | V |
| F24 | Define availability slots with capacity | S | V |
| F25 | Receive, accept or decline booking requests, with a reason | S | V |
| F26 | Impressions, requests, acceptance rate | S | V |
| F27 | **Unmet-demand feed** — what nearby travellers wanted and could not get | S | V |
| F28 | Listing-quality score with the measured effect on match rate | N | V |

### Scale

| # | Requirement | Pri | Owner |
|---|---|:--:|---|
| F29 | Engine is city-agnostic; a city is a manifest | M | A |
| F30 | Navi Mumbai supported, including ferry corridors | S | A |
| F31 | Runs fully offline for the demo path | M | A |

## 6. Non-functional requirements

| Requirement | Target | Why |
|---|---|---|
| Plan generated | < 400 ms for 250 records | Feels instant or feels broken |
| Retrieval with FTS5 | < 80 ms | Same |
| LLM parse of a chat message | < 2 s, streamed | Perceived speed |
| **Degrades with no LLM** | full discovery still works | Cannot afford a model outage in a live demo |
| Degrades with no network | full demo works from the committed snapshot | Judges' wifi is a lottery |
| First contentful paint | < 1.5 s on 4G | Travellers are often on mobile data |
| Keyboard navigable | every flow | Non-negotiable, and it is free |
| `prefers-reduced-motion` | honoured everywhere | Non-negotiable |
| Eval suite green | with `LLM=off` | The credibility anchor |
| No hex literals outside tokens | enforced by `theme:lint` in CI | Tokens decay otherwise — TREK proved it |

## 7. Data requirements

| Layer | Volume | Owner | Notes |
|---|---|---|---|
| Curated experiences | ~250 | A + V | 3 fields that only a local knows: `durationMin`, true `pricePerPerson`, real `capacity` |
| OSM spine | ~2–4k | A | Real coordinates and names. Sparse on hours/price/accessibility — by design |
| Reviews | ~1.5k | V | Author, date, party type, party size, spend. Powers Bayesian ratings |
| Events / festivals | 30–50 | V | Ganesh Chaturthi, monsoon-season events, weekly markets |
| Transit corridors | 40–60 | A | Station pairs with real in-vehicle + wait times |
| Congestion model | per corridor × time band | A | Documented **estimate**, labelled as such |
| Unmet demand | generated live | V | The most valuable dataset in the product |

## 8. Out of scope

Stated so it does not creep back: payments, commission, payouts, refunds,
disputes · multi-day itineraries · real-time crowd or "vibe" sensing ·
multi-agent group negotiation · learning-to-rank · any second city beyond
Navi Mumbai · native mobile apps · offline sync.

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Curated dataset is the long pole (~2 person-days) | High | Start Day 2, 60/day, and let OSM+inference backfill if we fall behind — visibly labelled |
| Live LLM fails or rate-limits mid-demo | Medium | Deterministic regex NLU + template narration; eval passes with `LLM=off`; `LLM=off` toggle in the UI |
| Overpass or OSRM is down or blocked | Medium | 3 mirrors with failover, aggressive caching, **committed offline snapshot** |
| Travel times look wrong for Mumbai | High | Congestion multiplier + transit corridors, and the estimate is labelled. Better to show a reasoned estimate than free-flow lie |
| OSM attributes too sparse | Certain | Measured and designed around — hence the curated layer |
| Three people conflict | Medium | This file. Zero file overlap, frozen contracts, daily merges |
| Scope creep into the marketplace | Medium | D4 caps it at listings + requests, no payments |
| Nobody owns deployment | Medium | O4 on Day 4 standup. No CLI and no creds on this machine |

## 10. Acceptance

We are done when a judge can watch this, unaided:

1. Drop a pin, say *"family of four, toddler, two hours, ₹1,500, it might rain,
   need step-free"* → get a **2–3 stop chained plan** with a feasibility meter on
   every card and a visible reason for every choice.
2. Hit **"it started raining"** → the plan re-solves and shows what it swapped and
   why, in ≤ 2 swaps, without losing the original intent.
3. Tap something they asked for that is missing → get a specific reason, not an
   empty list.
4. Switch to the provider view → see a request to action, and three concrete
   suggestions built from what travellers nearby could not get.
5. Turn on **`LLM=off`** → all of the above still works.

Points 1–4 are the demo. Point 5 is what makes it credible.
