# EVAL SCENARIOS

**31 scenarios**, one per JSONL line, in the shape `docs/EVAL_SPEC.md` §3
specifies. `notes` and `replan.expectKeptIntentTerms` are the only additions and
both are optional.

## Coverage

| # | id | what it breaks |
|--:|---|---|
| 1 | `family-2h-rain-stepfree` | the PS's own example. The whole pipeline at once |
| 2 | `solo-6h-open` | cold start, and the six-restaurants failure mode |
| 3 | `window-45min` | a tiny window that must still return something |
| 4 | `zero-budget-walk` | genuinely zero money, not nearly zero |
| 5 | `long-window-8h` | over-planning: 480 minutes must not become an 11-stop day |
| 6 | `couple-wants-alone` | negative-only, no `pos` at all |
| 7 | `wheelchair-90min-monsoon` | `not_step_free` plus the weather gate, composed |
| 8 | `stroller-3h-uneven` | `strollerOk` as a field distinct from `stepFree` |
| 9 | `elder-hearing-loop-2h` | the rare compound need. Exact-match or nothing |
| 10 | `restroom-60min` | the single most common hidden constraint |
| 11 | `jain-lunch-window` | open-vocabulary diet filter against a narrow window |
| 12 | `teen-and-grandparent-3h` | group tension. Predicted weak, in advance |
| 13 | `party-of-3-jain-tight-budget` | party size × diet × budget together |
| 14 | `business-40min` | extreme tightness at an awkward hour |
| 15 | `night-23h-two-hours` | the 1440 midnight boundary |
| 16 | `early-0600` | early morning, when nearly everything is shut |
| 17 | `lunch-window-exact` | opening-hours window precision and meal placement |
| 18 | `hours-unparsable-record` | must-see with messy hours: no 500, no silent pass |
| 19 | `heavy-rain-3h-1200` | `weather_unsafe`; the `covered` records must survive |
| 20 | `heat-11-to-16` | `weatherSensitive: heat`, the half of the gate engines forget |
| 21 | `transit-only-navi-to-south` | `expectCoverage: false`. The documented gap |
| 22 | `two-islands-peak-1h` | the congestion multiplier, Bandra to Colaba at peak |
| 23 | `origin-residential-lane` | `origin.point` is null and the label is an address |
| 24 | `no-tourists` | negative channel as a signal, not a synonym for quiet |
| 25 | `not-a-chain` | the demo script's typed line, so it has to work |
| 26 | `replan-time-shrank` | 180 to 90 minutes, ≤2 swaps, intent preserved |
| 27 | `replan-heavy-rain` | outdoor → covered, ≤2 swaps, intent preserved |
| 28 | `replan-sold-out` | pin the rest, one swap, no duplicate |
| 29 | `malformed-input` | vague, hedged, self-contradicting text |
| 30 | `llm-unavailable` | the credibility anchor |
| 31 | `hidden-local-2h` | authenticity with a real constraint attached |

All 31 must pass with `LLM=off`. Scenarios 29 and 30 exist to prove it: 29 is
the case that justifies the model at all, and 30 is the case that proves the
model is not load-bearing. Their outputs belong side by side in
`docs/EVAL_RESULTS.md` as a cost-quality table.

## Predicted failures, recorded before running

`docs/EVAL_SPEC.md` §9 asks for known-risky scenarios to be named in advance.
Three more, from writing the data:

| # | id | why we expect it to be weak |
|--:|---|---|
| 8 | `stroller-3h-uneven` | `md-riverfront-evening` is `strollerOk: true` in the data and one review says the paving has washed out. The curated field and the review signal disagree and we left them disagreeing. Expect the engine to pass the record and for a human to call that wrong |
| 9 | `elder-hearing-loop-2h` | only 7 records claim a hearing loop and 5 of those are usable. Two are explicitly `false` because they are unamplified organs. The answer set is five records wide, which is thin enough that any bug in the access gate shows up as a coverage failure rather than a quality miss |
| 12 | `teen-and-grandparent-3h` | already predicted upstream. Shared constraints and per-person personas exist; negotiation does not. Expect an average and expect the tension axis to be thin |

## Assertions beyond the universal ones

Beyond `docs/EVAL_SPEC.md` §7, these appear in the files and need implementing
in the harness:

| assertion | appears in | what it must do |
|---|---|---|
| `requireCalmStop` | 6 | at least one stop whose `perception.atmosphere` contains a solitude-ish term |
| `requireStepFree` / `requireStrollerOk` / `requireLowStairs` / `requireHearingLoop` / `requireRestroom` | 7, 8, 9, 10 | every stop satisfies the named field, and `null` is not a pass |
| `requireDietMatch` | 11 | every stop's `diets` intersects the requirement |
| `visitWindowInsideOpeningHours` | 11, 17 | the visit interval sits entirely inside the open interval. Catches the 12:30 boundary off-by-one |
| `requireSharedStop` / `expectTensionSurfaced` | 12 | at least one stop genuinely serves both halves of a split party |
| `requireTotalUnderBudget` | 13 | plan cost within budget for the whole party |
| `preferNightRecords` | 15 | at least one stop with `night` in `bestTimeOfDay` |
| `mustShowHoursUnverifiedBadge` | 18 | the badge appears, and no 500 |
| `noOutdoorStopWithoutJustification` | 19 | no rain-sensitive outdoor stop without a written reason |
| `noHeatSensitiveOutdoorStop` | 20 | as above for `weatherSensitive: heat` |
| `everyLegIsTransitOrEstimated` | 21 | every leg is `transit` or carries `estimated: true` |
| `minReportedTravelRatio` | 22 | any reported car travel time is ≥2× straight-line at peak. The cheapest guard against a hardcoded free-flow number |
| `mustNotCrashOnNullOrigin` | 23 | a null `origin.point` must not become a valid GeoPoint |
| `notInTopTenTouristList` | 24, 31 | **needs a concrete list.** Until someone writes it down this assertion is decorative. Flagged, not papered over |
| `maxSameCategory` | 2 | at most 2 stops share a category |
| `mustNotInventConstraints` | 29 | the NLU may not add `accessNeeds` or `diets` nobody stated. It may propose; it may not apply |
| `mustNotBlockOnModel` / `hardConstraintsStillHold` / `allRejectionsHaveFinishedMessages` | 30 | constraint satisfaction and rejection copy must be identical with the model down |
| `expectKeptIntentTerms` | 26, 27 | terms that must survive a replan. This is what makes `preservedIntent` mean something instead of being a boolean the replanner sets to itself |

## Three things the data exposes that the engine has to decide

These are not assertions, they are open questions the scenarios raise. All three
are recorded here rather than answered in a scenario, because answering them
silently would be the wrong call.

1. **The midnight boundary.** `Minutes` is 0..1440 and a plan starting at 23:30
   and ending at 00:30 has to go somewhere. Either the clock is local-day
   relative and end-minutes wrap, or the context needs a date. The contract
   allows neither today. Scenario 15 is where it surfaces.
2. **`diet_mismatch` conflates two failures.** A bar that does not serve
   vegetarian food and a cafe that simply does not declare a jain option are
   both `diet_mismatch` today, and they are different problems: the first is a
   cuisine fact, the second is a missing field. They should be distinguishable
   in the unmet-demand feed. A v2 refinement, not a v1 bug.
3. **Negative-channel hits are scored, not rejected.** "Chains" and "tourists"
   produce a penalty, so the correct enforcement is *not in the top three*, not
   a hard rejection. `forbiddenIds` in scenarios 6, 24, 25 and 31 carry
   `excluded_by_traveller` for the cases where a hard exclusion is genuinely
   right — the traveller put it in `avoid`, and `avoid` is an explicit
   traveller-supplied exclusion — but a soft negative should not be able to
   produce a `Rejection` at all.
