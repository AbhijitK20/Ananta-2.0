# DEMO SCRIPT — 3 minutes

> **90 seconds of value in 3 minutes of stage time.** Rehearse twice. The
> fallback branches exist because wifi is a lottery.

---

## The spine

| # | Beat | Time | What it proves | Fails if |
|---|---|---|---|---|
| 1 | Constraints in, chained plan out | 45 s | the engine fits things | — |
| 2 | Reality changes, plan re-solves | 40 s | adaptation + intent preserved | > 2 swaps |
| 3 | Why not that | 30 s | **the differentiator** | generic empty state |
| 4 | Provider side, loop closed | 30 s | the PS's provider half | no suggestions |
| 5 | `LLM=off` | 15 s | credibility | anything breaks |

Beat 3 is the one that is **ours**. Everything else is table stakes for this
problem space. Practise it until it is boring.

---

## Pre-flight — 15 minutes before

- [ ] `npm run eval` green, `EVAL_RESULTS.md` committed
- [ ] `npm run db:seed` run; 250 experiences loaded
- [ ] Offline OSM snapshot present — **test with wifi off**
- [ ] All images cached locally with attribution
- [ ] Browser at 1440×900, zoom 100%, dark mode off
- [ ] `LLM=off` toggle tested
- [ ] Two demo accounts signed in: traveller + provider
- [ ] The scenario pinned: **family of 4, toddler, 2h, ₹1,500, rain, step-free, Colaba**
- [ ] Tab 2 open as a backup of the same route

---

## Beat 1 — 45s · Constraints in, chained plan out

**Do:** drop a pin on a Colaba hotel. Set the slider to **2 hours**. Party
**4** with a **toddler** (1). Budget **₹1,500**. Toggle **step-free**. Type
*"something local, not a chain"*. Hit rain.

**Say:**

> "Family of four, toddler, two hours, fifteen hundred rupees, it might rain,
> and my mother can't manage stairs. Two hours, near this hotel."
>
> "That's not a search query. That's a set of constraints, and the question isn't
> *what's good near here* — it's **what actually fits**. Which of these places
> can this family genuinely do, in two hours, on this budget, step-free, in the
> rain."

**Point at, in this order:**
1. The **feasibility meter** on each card — `activity ▸ travel ▸ buffer`, and the
   overflow
2. The **travel connector** between stops — "twelve minutes' walk, 850 metres"
3. The **provenance badge** — "this one's step-free data is AI-inferred, because
   OpenStreetMap has it for one percent of places. We tell you which is which."
4. A **why-ledger** line — "high match for what you asked, 4.6 from 312 reviews,
   and the kitchen takes a group of four at 19:00"

**Do not** spend more than 8 seconds explaining anything on screen.

---

## Beat 2 — 40s · Reality changes

**Do:** click **"It started raining."** Then **"We lost 90 minutes."**

**Say:**

> "The monsoon started. Watch what happens — it is not a new search. It is a
> **re-solve of the same intent** against a world that changed."

**Point at:**
1. The **swap diff** — what left, what arrived, and *why*, in one sentence
2. **"Still looking for: local food, something local"** — intent preserved
   on screen. This is the line that lands the architecture.
3. The **Stress Radar** and its one **rescue move**

**If a beat fails:** if the replan returns more than 2 swaps, say so — *"that's
three swaps, which is a bug, and here's the eval number that catches it."* Being
honest about a known failure is more persuasive than a smooth demo.

---

## Beat 3 — 30s · Why not that

**Do:** type a thing they clearly want — *"Mahalaxmi Racecourse"*, or any
expensive far attraction — that is not in the plan. Tap it.

**Say:**

> "Every one of you has tapped something that didn't appear. Most apps give you
> an empty list. We tell you **which constraint killed it, by how much, and what
> it would cost to unlock.**"

**Point at:** the specific sentence with a number — *"Needs 40 minutes more than
you have left"* / *"₹300 over your per-person limit"*.

**Then click one of the three actions** — *"Add 40 minutes"* — and show the plan
grow. **This is the moment.** It turns a rejection into agency.

---

## Beat 4 — 30s · The loop closes

**Do:** switch to the provider view. One booking request to action. Scroll to the
unmet-demand feed.

**Say:**

> "The other half of the problem. Local providers don't have a marketing budget.
> So we show them what people nearby **searched for and could not get** — and
> which single constraint eliminated them."

**Point at:**
1. A suggestion with a **count** — "42 travellers, 0 results, killed by
   `not_step_free`"
2. That the action is **one click** — opens the listing at the exact field

**If asked "how do you know 42?"** — because we log every zero-result search
with its blocking constraint. That log is the product.

---

## Beat 5 — 15s · Turn off the LLM

**Do:** toggle **`LLM=off`**. Re-run a search. Change the weather.

**Say:**

> "Everything you just saw was computed by a deterministic engine. The language
> model does one thing: turn what you *said* into a constraint. Everything you
> *see* is arithmetic — which is why the eval suite passes with the model
> switched off entirely."

Then show `docs/EVAL_RESULTS.md`:

> "Twenty-eight scenarios. A hundred percent constraint satisfaction, by
> construction. Time utilisation 0.87 against 0.31 for a rank-by-rating
> baseline. Zero violations."

---

## Anticipated questions

**"Isn't this just a chatbot?"**
No — the model emits a *patch to a constraint object* and nothing else. It cannot
name a recommendation or reorder a plan; a test fails the build if that changes.
Every project in the reference set that let a model influence ordering leaked,
and none of them had a validator. We have one.

**"Where does the data come from?"**
OpenStreetMap for the map backbone, hand-curated for the fields OSM doesn't have,
and LLM inference for the long tail — **labelled as inferred on screen**. We
measured it: OSM has opening hours on 16% of Mumbai POIs, wheelchair access on
1%, price on none, and no ratings at all.

**"How is this different from Google Maps?"**
Google Maps shows you everything and filters on what you typed. Every result
that fails a constraint is still a result. We return only what fits, and we tell
you what didn't and why.

**"Are travel times real?"**
Real routing, plus a documented congestion model, because free-flow times
understate Mumbai by three to five times at peak — and we label it an estimate
rather than pretend. We also model transit, because Bandra to Colaba is
twenty-one minutes by train.

**"What about the provider side — do you take commission?"**
Not in this build. Listings and requests only. But the interesting part isn't the
transaction, it's the unmet-demand feed.

**"How do you handle a group with conflicting wants?"**
We don't average them away. Shared constraints, per-person personas, and the
tension shown explicitly — a low-walking parent and a want-to-hike teenager get
a plan that names the trade-off rather than hiding it.

---

## Fallback branches

| If | Then |
|---|---|
| No network | Everything works from the committed snapshot. Do not apologise; say "this is running entirely offline, which is the point." |
| LLM times out | The regex parser takes over within 2 s. Narrate: "that fell back to the deterministic parser — same result, because the model was only parsing." |
| Plan is thin (< 2 stops) | Use **"Something local, not a chain"** with 4 hours instead. A good 4-stop plan beats a thin 2-stop one. |
| Map is slow | Switch to list view. The list is a first-class surface, not a fallback. |
| Anything is broken | Open `docs/EVAL_RESULTS.md` and talk about the numbers. The eval table is a fine place to be. |

**Never** debug on stage. Say "let me show you the eval harness" and move on.

---

## The one-liner

> **TravelBuddy doesn't optimise for places. It optimises for moments — and it
> only shows you the ones that actually fit.**
