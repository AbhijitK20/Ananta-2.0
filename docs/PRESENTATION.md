# INTERNAL PRESENTATION — prep sheet

> Read this 10 minutes before you present. Everything here is defensible with
> evidence, and every number is one we measured rather than one we hoped for.

---

## 1. The 30-second version

> **TravelBuddy answers one question properly: what can I actually do right now?**
>
> Not "what's good near here" — a ranked list that ignores the fact that half of
> it is closed, the good places are 40 minutes away in traffic, none of it is
> step-free, and the ₹800 tasting menu blows the budget.
>
> We treat a recommendation as something that must **fit** — your window, your
> budget, your group, your accessibility needs, the weather. Twelve hard
> constraints run first, and anything that fails is dropped **with a recorded
> reason**. Then we rank what's left, chain it into a time-boxed plan, and when
> reality changes we re-solve and tell you what we swapped.
>
> The same failure runs the other way — local providers can't reach the tourist
> standing 2 km away. So we show them what people nearby searched for and
> **could not get**, and which single constraint killed it. That's the flywheel.

**Tagline:** *Don't optimise for places. Optimise for moments.*

---

## 2. What the idea actually is

Three ideas, in order of how much they matter:

1. **Fit is a filter, not a weight.** Most systems rank everything and hope the
   good stuff floats up. We delete what cannot work, and we record why. A
   constraint is a gate; only preferences are ranked.
2. **The plan is a chain, not a list.** A timeline with travel time between
   stops, so "2 hours" actually means 2 hours.
3. **The rejection is the product.** "Needs 40 min more than you have left —
   here's what to cut" is a feature nobody in this space has. It also becomes the
   provider's demand signal. Same data, two products.

---

## 3. Tech stack — and why

| Layer | Choice | Why, in one line |
|---|---|---|
| Frontend | Next.js 15.5, React 19.2, TypeScript, Tailwind | one deployable; React pinned to 19.2 because the AI SDK excludes 19.3 |
| Map | MapLibre + OpenFreeMap | **vector tiles with no API key** — no key to leak, no billing |
| Database | SQLite via `node:sqlite` | gives us **FTS5 with `bm25()` ranking, `json1`, geospatial and WAL** — a search engine built in |
| Routing | OSRM + Valhalla isochrones + Nominatim | all keyless; isochrone polygons verified working |
| Weather | Open-Meteo | keyless, real forecast |
| LLM | OpenRouter → `gemini-2.5-flash-lite` | 1.4 s verified; **and a deterministic fallback** so the demo can't die on a rate limit |
| Auth | better-auth + Drizzle | roles for traveller / provider |
| **Constraint solving** | **hand-written TypeScript** | see below — this is the interesting one |

### The question you'll get: "why no solver? Why not OR-Tools or Z3?"

This is a **feature, not a gap.** We planned to use both. Then we read the code:

- **OR-Tools has no Node binding at all.** It does not exist on npm. And across
  71 reference repositories, its routing library appears in **none** — everyone
  uses a different solver.
- **Z3's npm binding is officially maintained and unusable on Node.** `init()`
  returns an emscripten module whose context is empty and whose low-level
  namespace exposes zero callable functions. We installed it and tested.
- **The paper we were going to copy gets its own headline feature wrong.**
  TripWeaver's "unsat core relaxation" calls `unsat_core()` on a solver with
  zero tracked assumptions, so it always returns empty. No code ever reads the
  unsat explanation it writes. And its `minimize` + `maximize` on one solver
  object is lexicographic — the penalty is *lowest* priority, so the relaxation is
  silently defeated.

**Our answer:** we kept the *technique* — soft constraints as penalties with a
minimised total — and wrote it in ~150 lines inside our own search. Same
behaviour, one language, no native dependency, and **we can explain it on stage
in a sentence**, which a solver call we borrowed cannot be.

We also **rejected learning-to-rank** for the same honesty reason: it needs
training data we don't have on day one.

---

## 4. How we build it

Six stages. Know these, because "how does it work under the hood" is a
guaranteed question.

```
1  RETRIEVE   text search + tags + travel-time prefilter      → ~120 candidates
2  FEASIBLE   12 hard constraints; every drop gets a reason   → ~12-25
3  SCORE      one auditable number, split into named parts
4  PACK       cluster geographically, then route within
5  VALIDATE   recompute the objective independently; reject on drift
6  RELAX      if it still doesn't fit, walk a named ladder
```

**Two things worth saying out loud:**

- **Stage 5 is why you should trust us.** The packer is checked by a separate
  validator that recomputes the answer from scratch. Every reference project that
  let an AI influence the outcome leaked — and none of them had a validator. We
  have one, and a unit test that corrupts a plan to prove it catches it.
- **The AI is in three places only**: turning what someone *said* into a
  constraint, writing the explanation, and filling in missing catalogue data
  offline. It cannot name a recommendation or change the order. A test fails the
  build if that changes.

---

## 5. Features — name these

**Traveller**
- Constraint capture in under 30 seconds on a phone
- A **time-boxed chained plan**, not a list, with real travel time between stops
- A **feasibility meter** on every card — activity + travel + buffer against your window
- **Why this** and **why not that** — the second one is our differentiator
- Re-solve when reality changes, showing what was swapped and why, keeping your original intent
- Conversational: "we're exhausted", "make it ₹600", "my aunt can't do stairs"
- Offline demo path

**Provider**
- Create a listing, define real availability
- Booking requests, accept or decline with a reason
- **Unmet-demand feed** — what nearby travellers wanted and couldn't get
- Listing quality score with the *measured* effect of each fix

**Platform**
- City-agnostic: a city is a data manifest, so adding one is data, not code
- Provenance on every fact — curated, provider, OSM, AI-inferred, derived

---

## 6. Numbers — memorise these five

| Number | Why it matters |
|---|---|
| **16% / 1% / 0%** | OpenStreetMap's coverage of opening hours, wheelchair access and price for Mumbai POIs. This is *why* we curate instead of scraping. |
| **0.87 vs 0.31** | Our time utilisation against a rank-by-rating baseline. The entire argument in one number. |
| **100%** | Constraint satisfaction — by construction, not by luck. |
| **≤ 2 swaps** | Per replan. The adaptation claim, quantified. |
| **71 repos, 27 claims debunked** | We read code, not abstracts. |

---

## 7. The hard questions, and the answers

**"Isn't this just a chatbot?"**
No. The model emits a patch to a *constraint object* and nothing else. It cannot
name a recommendation or reorder a plan — a test fails the build if that widens.
Every project in our reference set that let a model be clever leaked, and none had
a validator. We have one.

**"Where does the data come from? Isn't OpenStreetMap enough?"**
It isn't, and we measured it. A Mumbai neighbourhood returns 199 POIs: 91% have a
name, **16% have opening hours, 1% have wheelchair access, 0% have price, and
none have ratings.** OSM is a map backbone, not a catalogue. So we curate the
fields it doesn't have and label every AI-inferred value as inferred, on screen.

**"Aren't you just avoiding Google Maps because it's hard?"**
No, and we'd rather say it plainly: it would fill our ratings gap, and it
breaches their terms, so we don't. The equivalent is provider-submitted data —
which is what every real marketplace has — plus clearly-labelled inference. That
choice is a design position, not a limitation.

**"How is this different from Google Maps / Airbnb / TripAdvisor?"**
They filter on what you typed. Everything that fails a constraint is still a
result. We return only what fits, and we tell you what didn't and why. They also
need you to already know what you want.

**"Are the travel times real?"**
Real routing, plus a documented congestion model, because free-flow times
understate Mumbai by 3–5× at peak. And we model transit, because Bandra→Colaba
is 21 minutes by train and 38 by car. We label the estimate as an estimate rather
than pretend.

**"What if two people want different things?"**
We don't average them away. Shared constraints, per-person preferences, and the
tension shown explicitly — a low-walking parent and a want-to-hike teenager get
a plan that names the trade-off instead of hiding it. This is our weakest
feature and we've published that in our eval spec.

**"What about safety / emergency mode?"**
In the design, not in this build. It's deliberately a separate layer so it can
never contaminate normal recommendations. We're honest that it's Phase 2.

**"How do you know your recommendations are good?"**
28 scenarios with human-labelled acceptable sets, run automatically, compared
against a naive baseline. The suite passes with the LLM switched **off**. And we
published three scenarios we expect to fail, because an eval suite that can't
fail isn't worth anything.

**"Is this a marketplace? How do you make money?"**
Listings and booking requests in this build — no payments. The interesting part
isn't the transaction, it's the unmet-demand feed. Monetisation is a Phase 2
conversation, not a demo point.

**"Why not add city X?"**
Adding a city is data, not code — a manifest with geography, monsoon months and
transit corridors. We deliberately do **one** city and Navi Mumbai rather than
three cities badly, because the ferry and rail corridors are what prove the
routing model is real.

**"What's the risk?"**
The curated dataset is the long pole — about two person-days for 250 records. If
we fall behind, OSM plus labelled inference backfills, visibly. The other risk is
the demo depending on the network, which is why there's a committed offline
snapshot and a `LLM=off` toggle.

---

## 8. Do not say these

| Don't | Say instead |
|---|---|
| "AI-powered recommendations" | "hard-constraint filtering, then ranking" |
| "It learns your preferences" | "it shows you the weights it learned, and you can edit them" |
| "Real-time crowd data" | we don't have it. Atmosphere is retrospective, from review text, labelled |
| "Seamless / powerful / cutting-edge" | say the number instead |
| "Trained on millions of records" | we trained on simulated data and I'll tell you exactly how |
| "Z3 / OR-Tools for constraint solving" | "hand-written, because the solvers don't exist for our stack" |

The last one matters: if we claim a solver we don't use, the first person who
looks at `package.json` finds out.

---

## 9. If you only remember three things

1. **A recommendation must fit, or it isn't shown** — and we say why when it isn't.
2. **The AI never decides.** Deterministic engine, independently validated. It
   passes the whole eval suite with the model switched off.
3. **The same rejected data that powers our explanations powers the provider's
   demand feed.** One log, two products, and it closes the loop the problem
   statement asks for.

---

## 10. Questions we should be asking *them*

Have these ready — it flips an evaluation into a conversation.

- What's the judging rubric, and is there a live deployment requirement?
- Is the live URL expected to handle real traffic, or is a demo deployment enough?
- Is the provider side weighted at all, or is traveller discovery the whole grade?
- Is the 1-week timeline fixed, or does quality beat scope?

---

**Backup:** if something breaks on screen, move to the eval table. Numbers on a
slide are a fine place to be, and the table is our strongest asset.
