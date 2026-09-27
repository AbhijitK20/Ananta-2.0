/**
 * Checks the game rules against the real dataset.
 *
 * Not a test framework — a script that asserts the things that would be
 * embarrassing to get wrong and that a typechecker cannot see. Run with
 * `npm run check`.
 *
 * The three that matter most:
 *
 *   1. **Streak arithmetic across a DST boundary.** Adding 86 400 000 ms to a
 *      local date lands on the wrong day twice a year in any timezone that
 *      observes DST. `daily.ts` parses to UTC noon precisely to avoid it, and
 *      this is the assertion that would fail if someone "simplified" it back to
 *      milliseconds.
 *   2. **Level monotonicity.** `levelState` walks the table backwards looking
 *      for the last threshold met; an off-by-one there silently caps a player.
 *   3. **XP agreement.** The number the toast reported and the number the rail
 *      derives have to be the same, which is the whole argument for deriving
 *      XP rather than storing it.
 */

import { CITIES, CATEGORY_TOTALS, COLLISIONS, PLACES, TOTALS } from "../lib/content";
import { selectAchievements, satisfiedAchievements } from "../lib/game/achievements";
import { dailyPickFor, daysAfter, daysBefore, streakState } from "../lib/game/daily";
import { evaluateQuests, QUESTS } from "../lib/game/quests";
import { reducer } from "../lib/game/store";
import { emptySave, type DayKey, type Save } from "../lib/game/types";
import { levelState, XP_PER_CITY, XP_PER_STAMP } from "../lib/game/xp";

let failures = 0;
let checks = 0;

function ok(condition: boolean, label: string, detail = "") {
  checks += 1;
  if (!condition) {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  ok(
    Object.is(actual, expected),
    label,
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

function section(name: string) {
  console.log(`\n${name}`);
}

/* -------------------------------------------------------------------------- *
 * The dataset
 * -------------------------------------------------------------------------- */

section("dataset");

eq(PLACES.length, 890, "890 unique places after dropping 2 collisions");
eq(TOTALS.places, PLACES.length, "TOTALS agrees with PLACES");
eq(COLLISIONS.length, 2, "both collisions were recorded rather than dropped silently");
eq(TOTALS.cities, CITIES.length, "TOTALS agrees with CITIES");
eq(CITIES.length, 202, "202 cities");
eq(TOTALS.categories, 8, "8 categories including unfiled");

{
  const ids = new Set(PLACES.map((p) => p.id));
  eq(ids.size, PLACES.length, "every place id is unique");

  // Every place must be reachable from the city index, or the album and the
  // city pages would disagree about what exists.
  const indexed = CITIES.reduce((n, city) => n + city.places.length, 0);
  eq(indexed, PLACES.length, "every place appears in exactly one city");

  // The source held 892 records; two collided on id and were dropped, so every
  // count below is two lower than the raw extraction. That is the honest
  // arithmetic — the album holds 890, not 892 — and asserting the raw numbers
  // here would mean asserting a dataset the app does not have.
  const noHood = PLACES.filter((p) => p.hood === null).length;
  eq(noHood, 202, "202 places have no neighbourhood, and none render an empty one");

  const unfiled = PLACES.filter((p) => p.categories.includes("unfiled")).length;
  eq(unfiled, 576, "576 of the 890 places are unfiled");
  eq(CATEGORY_TOTALS.unfiled, 576, "CATEGORY_TOTALS agrees on unfiled");
  ok(
    unfiled / PLACES.length > 0.6,
    "and unfiled is the majority of the album, which is why the UI marks it differently",
  );

  const unknownBudget = PLACES.filter((p) => p.budget === "unknown").length;
  eq(unknownBudget, 282, "282 places have no budget band");

  // The category rows overlap on purpose; anything that assumes they sum to the
  // total is wrong.
  const categorySum = PLACES.reduce((n, p) => n + p.categories.length, 0);
  ok(categorySum > PLACES.length, "category rows overlap (multi-tag places exist)");
}

{
  // The 13 cities with an authoritative name, and the fact that 189 do not.
  const named = CITIES.filter((c) => c.named);
  eq(named.length, 13, "13 cities carry an authoritative name");
  ok(
    CITIES.some((c) => c.label === "Lisbon"),
    "Lisbon resolves to its authoritative name",
  );
  ok(
    CITIES.every((c) => c.named || c.label.length > 0),
    "every city has a non-empty label",
  );
}

/* -------------------------------------------------------------------------- *
 * Levels
 * -------------------------------------------------------------------------- */

section("levels");

eq(levelState(0).level.index, 0, "0 XP is level 1");
eq(levelState(0).level.title, "Tourist", "level 1 is Tourist");
eq(levelState(39).level.index, 0, "39 XP is still level 1");
eq(levelState(40).level.index, 1, "40 XP is level 2");
eq(levelState(-100).level.index, 0, "negative XP clamps to level 1 rather than throwing");
eq(levelState(NaN).level.index, 0, "NaN XP clamps to level 1 rather than throwing");

{
  let monotonic = true;
  for (let xp = 0; xp <= 7000; xp += 1) {
    const state = levelState(xp);
    if (state.progress < 0 || state.progress > 1) monotonic = false;
    if (state.xpToNext < 0) monotonic = false;
    if (!state.maxed && state.next === null) monotonic = false;
  }
  ok(monotonic, "progress stays in 0..1 and xpToNext non-negative across 0..7000 XP");

  let nonDecreasing = true;
  let previous = -1;
  for (let xp = 0; xp <= 7000; xp += 1) {
    const index = levelState(xp).level.index;
    if (index < previous) nonDecreasing = false;
    previous = index;
  }
  ok(nonDecreasing, "level index never goes backwards as XP rises");

  eq(levelState(99999).maxed, true, "very high XP is maxed");
  eq(levelState(6000).level.title, "Local Legend", "6000 XP is the final level");
  // 6000 XP = 600 stamps, and the album holds 890 — maxing and finishing are
  // two different achievements, which is the stated design.
  ok(6000 / XP_PER_STAMP < TOTALS.places, "the level curve tops out before the album is full");
}

/* -------------------------------------------------------------------------- *
 * Streaks and days
 * -------------------------------------------------------------------------- */

section("days and streaks");

{
  // DST: US spring-forward is 2026-03-08. A local day either side of it is 23
  // hours long, so a millisecond-based day step skips or repeats a date. These
  // assertions walk *forwards*, which is the direction a millisecond
  // implementation gets wrong.
  const before = "2026-03-07" as DayKey;
  const after = daysAfter(before, 1);
  eq(after, "2026-03-08", "one day across the US spring-forward is one calendar day");
  eq(daysAfter(after, 1), "2026-03-09", "and the next one too");
  eq(daysAfter("2026-12-31", 1), "2027-01-01", "year boundary rolls over");
  eq(daysBefore("2027-01-01", 1), "2026-12-31", "and back again");
  eq(daysAfter("2028-02-28", 1), "2028-02-29", "leap day is stepped onto");
  eq(daysAfter("2026-03-01", 31), "2026-04-01", "a 31-day step lands correctly");
  // 180 days either side of a spring-forward and an autumn fall-back, to catch
  // a cumulative one-hour drift.
  eq(daysAfter("2026-01-01", 365), "2027-01-01", "a full year forward lands exactly");
}

{
  const today = "2026-09-27" as DayKey;

  eq(streakState([], today).current, 0, "no days means no streak");
  eq(streakState([], today).atRisk, false, "an empty album is not 'at risk'");

  const yesterday = daysBefore(today, 1);
  const s1 = streakState([yesterday], today);
  eq(s1.current, 1, "yesterday alone holds a 1-day streak");
  eq(s1.atRisk, true, "and that streak is at risk, because today is not done yet");

  const s2 = streakState([today, yesterday], today);
  eq(s2.current, 2, "today and yesterday is 2");
  eq(s2.atRisk, false, "and not at risk");

  const long = streakState(
    [today, daysBefore(today, 1), daysBefore(today, 2), daysBefore(today, 3)],
    today,
  );
  eq(long.current, 4, "four consecutive days is 4");
  eq(long.best, 4, "and the best matches");

  // A gap must break the run.
  const gapped = streakState([today, daysBefore(today, 2)], today);
  eq(gapped.current, 1, "a gap yesterday collapses the streak to today alone");

  // The best is the longest run *ever*, not the current one.
  const historic = streakState(
    [today, yesterday, "2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"],
    today,
  );
  eq(historic.current, 2, "current streak is today and yesterday");
  eq(historic.best, 4, "best remembers the January run of four");

  // Unsorted and duplicated input must not inflate the count.
  const messy = streakState([yesterday, today, yesterday, today, yesterday], today);
  eq(messy.current, 2, "duplicates do not inflate the streak");

  eq(streakState([yesterday, today], today).week.length, 7, "the week strip is seven days");
  eq(streakState([yesterday, today], today).week[6], today, "and ends on today");
}

{
  // The daily pick must be stable for a day and differ between days.
  const a = dailyPickFor("2026-09-27");
  const b = dailyPickFor("2026-09-27");
  eq(a.id, b.id, "the daily pick is deterministic within a day");
  ok(a.id !== dailyPickFor("2026-09-28").id, "and differs the next day");

  let allInRange = true;
  let sawRepeat = false;
  const seen = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    const place = dailyPickFor(daysBefore("2026-01-01", i));
    if (!PLACES.some((p) => p.id === place.id)) allInRange = false;
    if (seen.has(place.id)) sawRepeat = true;
    seen.add(place.id);
  }
  ok(allInRange, "every daily pick resolves to a real place");
  ok(sawRepeat, "400 consecutive days revisit places, as a flat hash should");
  ok(seen.size > 100, "and spread across a wide slice of the album rather than a few dozen");
}

/* -------------------------------------------------------------------------- *
 * Quests
 * -------------------------------------------------------------------------- */

section("quests");

{
  eq(QUESTS.length, new Set(QUESTS.map((q) => q.id)).size, "quest ids are unique");

  // Every city quest must be winnable: a target above the city's size is
  // impossible, and an impossible quest is worse than no quest.
  // `goal` is bound to a local before the `kind` check. Narrowing a property
  // access does not survive into a callback in TypeScript — the compiler has to
  // assume `q.goal` could be anything by then — so `q.goal.city` would be an
  // error even two lines after `q.goal.kind === "city"` passed.
  const impossible = QUESTS.filter((q) => {
    const goal = q.goal;
    if (goal.kind !== "city") return false;
    const city = CITIES.find((c) => c.slug === goal.city);
    return !city || goal.target > city.places.length;
  });
  eq(impossible.length, 0, "no city quest asks for more places than the city has");

  const singlePlaceCities = CITIES.filter((c) => c.places.length === 1).length;
  const cityQuests = QUESTS.filter((q) => q.tier === "city").length;
  eq(cityQuests, CITIES.length - singlePlaceCities, "one quest per city with 2+ places");

  const badCategory = QUESTS.filter((q) => {
    const goal = q.goal;
    return goal.kind === "category" && goal.target > CATEGORY_TOTALS[goal.category];
  });
  eq(badCategory.length, 0, "no category quest exceeds the number of places in it");

  const badVariety = QUESTS.filter((q) => {
    const goal = q.goal;
    return goal.kind === "variety" && goal.target > 8;
  });
  eq(badVariety.length, 0, "no variety quest asks for more than 8 categories");

  const badSpread = QUESTS.filter((q) => {
    const goal = q.goal;
    return goal.kind === "spread" && goal.target > goal.categories.length;
  });
  eq(badSpread.length, 0, "no spread quest asks for more categories than it lists");
}

{
  // Progress against a known set: stamp all of Lisbon (14 places) and nothing
  // else, then check the numbers the board would render.
  const lisbon = CITIES.find((c) => c.slug === "lisbon")!;
  const stamps = new Set(lisbon.places.map((p) => p.id));
  const states = evaluateQuests(stamps, new Set());

  const cityQuest = states.find((s) => s.quest.id === "city-lisbon")!;
  eq(cityQuest.progress, 14, "city-lisbon progress is the full city");
  eq(cityQuest.complete, true, "and is complete");
  eq(cityQuest.claimable, true, "and is claimable");

  const first = states.find((s) => s.quest.id === "warmup-first-stamp")!;
  eq(first.complete, true, "a non-empty album completes first-footfall");

  const grand = states.find((s) => s.quest.id === "grand-five-hundred")!;
  eq(grand.complete, false, "14 places does not complete a 500 quest");
  eq(grand.progress, 14, "and progress is capped at the stamped count");

  // Once claimed, it is no longer claimable — this is the one-shot guarantee.
  const claimed = evaluateQuests(stamps, new Set(["city-lisbon"]));
  const after = claimed.find((s) => s.quest.id === "city-lisbon")!;
  eq(after.claimable, false, "a claimed quest is no longer claimable");
  eq(after.claimed, true, "and reads as claimed");
  eq(after.complete, true, "while still reading as complete");
}

{
  // The spread goal: one place in each of five categories. A single place can
  // satisfy several, so this must count categories covered, not places.
  const all = new Set(PLACES.map((p) => p.id));
  const full = evaluateQuests(all, new Set());
  const every = full.find((s) => s.quest.id === "grand-all-categories")!;
  eq(every.complete, true, "the whole album completes every-category");

  const worst = full.find((s) => s.quest.id === "category-nightlife")!;
  eq(worst.complete, true, "and completes the smallest category");
  ok(
    CATEGORY_TOTALS.nightlife > 0 && CATEGORY_TOTALS.nightlife < 20,
    `nightlife really is the smallest tag (${CATEGORY_TOTALS.nightlife})`,
  );
}

/* -------------------------------------------------------------------------- *
 * Achievements
 * -------------------------------------------------------------------------- */

section("achievements");

{
  const empty = satisfiedAchievements({ stamps: new Set(), bestStreak: 0 });
  eq(empty.size, 0, "an empty album earns nothing");

  const lisbon = CITIES.find((c) => c.slug === "lisbon")!;
  const one = new Set([lisbon.places[0].id]);
  const firstState = satisfiedAchievements({ stamps: one, bestStreak: 0 });
  ok(firstState.has("ach-first"), "one place earns Doorway");
  ok(firstState.has("ach-first-city"), "and Somewhere to Start");
  ok(!firstState.has("ach-ten"), "but not ten places");

  const everything = satisfiedAchievements({
    stamps: new Set(PLACES.map((p) => p.id)),
    bestStreak: 30,
  });
  ok(everything.has("ach-two-hundred"), "the whole album earns Well Travelled");
  ok(everything.has("ach-every-category"), "and Full Inventory");
  ok(everything.has("ach-streak-thirty"), "and a 30-day streak earns Habit Formed");
  ok(everything.has("ach-high-end"), "and all 21 high-end places earns the badge");

  // "Earned but no date" is a real state and must render, not disappear.
  const rendered = selectAchievements({ stamps: one, bestStreak: 0 }, {});
  const doorway = rendered.find((a) => a.id === "ach-first")!;
  eq(doorway.earned, true, "an achievement satisfied with no recorded date is still earned");
  eq(doorway.unlockedAt, null, "and its date is honestly null");

  const withDate = selectAchievements(
    { stamps: one, bestStreak: 0 },
    { "ach-first": "2026-09-27T10:00:00.000Z" },
  );
  eq(
    withDate.find((a) => a.id === "ach-first")!.unlockedAt,
    "2026-09-27T10:00:00.000Z",
    "a recorded date is passed through",
  );
}

/* -------------------------------------------------------------------------- *
 * Reducer
 *
 * The reducer is a plain function of (save, action), so it is testable without a
 * DOM. These are the cases the browser smoke test cannot reach: a timezone
 * change between stamping and unstamping, and a double unstamp.
 * -------------------------------------------------------------------------- */

section("reducer");

{
  const place = PLACES[0];
  const today = "2026-09-27" as DayKey;
  const now = "2026-09-27T10:00:00.000Z";

  const stamped = reducer(
    emptySave(),
    { type: "stamp", place, day: today, daily: place.id },
  );
  eq(Object.keys(stamped.stamps).length, 1, "a stamp adds one entry");
  eq(stamped.activeDays.length, 1, "and one active day");
  eq(stamped.dailyCounts[today], 1, "and a count of one for the day");
  eq(stamped.dailiesDone.length, 1, "and records the day as a completed daily");

  // Stamping the same place twice is a no-op, not a double count.
  const twice = reducer(stamped, { type: "stamp", place, day: today, daily: place.id });
  eq(Object.keys(twice.stamps).length, 1, "re-stamping the same place changes nothing");
  eq(twice.dailyCounts[today], 1, "and does not inflate the day's count");
  eq(twice.dailiesDone.length, 1, "and does not duplicate the completed daily");

  // Unstamping rolls the day back and breaks the streak.
  const cleared = reducer(stamped, { type: "unstamp", placeId: place.id });
  eq(Object.keys(cleared.stamps).length, 0, "unstamping removes the entry");
  eq(cleared.activeDays.length, 0, "and takes the day out of activeDays");
  eq(cleared.dailiesDone.length, 0, "and un-completes the daily");
  eq(cleared.dailyCounts[today], undefined, "and deletes the day's count entirely");

  // Unstamping something that was never stamped must not touch the day tallies.
  const stranger = reducer(stamped, { type: "unstamp", placeId: "nowhere/nowhere" });
  eq(stranger.activeDays.length, 1, "unstamping an unstamped place leaves activeDays alone");
  eq(stranger.dailyCounts[today], 1, "and leaves the day's count alone");

  // The timezone case: the stamp's ISO timestamp resolves to a local day the
  // save does not record, which is what a player who flies before unstamping
  // produces. Built by hand rather than by fiddling with TZ, because the
  // assertion has to hold in whatever timezone the suite runs in.
  const travelled = reducer(
    { ...stamped, activeDays: ["2026-09-20"], dailyCounts: { "2026-09-20": 4 } },
    { type: "unstamp", placeId: place.id },
  );
  eq(
    Object.keys(travelled.stamps).length,
    0,
    "the stamp is still removed after a timezone change",
  );
  eq(
    travelled.activeDays.join(","),
    "2026-09-20",
    "and the recorded day is left alone rather than decremented by mistake",
  );
  eq(
    travelled.dailyCounts["2026-09-20"],
    4,
    "its count is untouched — the mismatch costs a stale count, not a wrong one",
  );
  ok(
    Object.values(travelled.dailyCounts).every((n) => n >= 0),
    "and no day count is ever driven negative",
  );

  // Claiming is one-shot, and records no timestamp nothing reads.
  const claimed = reducer(stamped, { type: "claim", questId: "warmup-first-stamp" });
  eq(
    claimed.claimedQuests.join(","),
    "warmup-first-stamp",
    "claiming records the quest",
  );
  eq(
    reducer(claimed, { type: "claim", questId: "warmup-first-stamp" }).claimedQuests.length,
    1,
    "claiming it twice records it once",
  );
  ok(
    !("claimedAt" in claimed),
    "and stores no claim timestamp, because the UI has no column for one",
  );
}

/* -------------------------------------------------------------------------- *
 * XP agreement — the toast and the rail must not disagree
 * -------------------------------------------------------------------------- */

section("xp");

{
  // This mirrors the derivation in store.tsx exactly. If the two ever drift,
  // this is the assertion that notices.
  const derive = (stamps: ReadonlySet<string>, claimed: readonly string[]): number => {
    let total = stamps.size * XP_PER_STAMP;
    // Deduplicated, matching store.tsx — see the note there.
    for (const questId of new Set(claimed)) {
      total += QUESTS.find((q) => q.id === questId)?.reward ?? 0;
    }
    for (const city of CITIES) {
      let have = 0;
      for (const place of city.places) if (stamps.has(place.id)) have += 1;
      if (city.places.length >= 2 && have >= city.places.length) total += XP_PER_CITY;
    }
    return total;
  };

  const empty = derive(new Set(), []);
  eq(empty, 0, "an empty album is 0 XP");
  eq(levelState(empty).level.index, 0, "and level 1");

  const lisbon = CITIES.find((c) => c.slug === "lisbon")!;
  const full = new Set(lisbon.places.map((p) => p.id));
  const expected = lisbon.places.length * XP_PER_STAMP + XP_PER_CITY;
  eq(derive(full, []), expected, "a cleared city pays base plus exactly one city bonus");

  // Read the reward off the quest rather than hard-coding it. It is generated
  // from the city's size, so a literal here would drift the moment the quest
  // formula changes — and the assertion would then be testing a stale number.
  const questReward = QUESTS.find((q) => q.id === "city-lisbon")!.reward;
  eq(questReward, 60 + lisbon.places.length * 10, "the city quest reward follows its formula");

  eq(
    derive(full, ["city-lisbon"]),
    expected + questReward,
    "claiming the quest adds its reward exactly once",
  );
  eq(
    derive(full, ["city-lisbon", "city-lisbon"]),
    expected + questReward,
    "a duplicated claim entry does not pay twice",
  );

  // A one-place city must not pay the bonus, in either direction.
  const tiny = CITIES.find((c) => c.places.length === 1)!;
  const tinyStamps = new Set(tiny.places.map((p) => p.id));
  eq(
    derive(tinyStamps, []),
    XP_PER_STAMP,
    "a one-place city pays the base stamp only, never the city bonus",
  );

  const half = new Set(lisbon.places.slice(0, 7).map((p) => p.id));
  eq(derive(half, []), 7 * XP_PER_STAMP, "a half-filled city pays no bonus");

  // And the total must land on a level, not fall off the end of the table.
  const allStamps = new Set(PLACES.map((p) => p.id));
  const everything = derive(allStamps, QUESTS.map((q) => q.id));
  const state = levelState(everything);
  eq(state.maxed, true, "a complete album with every quest claimed maxes the curve");
  ok(Number.isFinite(everything) && everything > 0, `total XP is a real number (${everything})`);
}

/* -------------------------------------------------------------------------- *
 * Save shape
 * -------------------------------------------------------------------------- */

section("save");

{
  const save: Save = emptySave();
  eq(save.version, 1, "the save carries a version");
  eq(Object.keys(save.stamps).length, 0, "and starts with no stamps");
  eq(save.dailyPick, null, "and no daily pick");
  // A fresh save must be a fresh object, or a reset would mutate the default.
  const other = emptySave();
  other.stamps["x"] = "2026-01-01T00:00:00.000Z";
  eq(Object.keys(emptySave().stamps).length, 0, "emptySave returns an unshared object");
}

/* -------------------------------------------------------------------------- */

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
