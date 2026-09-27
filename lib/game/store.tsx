/**
 * The single client-side owner of player progress.
 *
 * ---------------------------------------------------------------------------
 * WHY HYDRATION IS SPLIT
 * ---------------------------------------------------------------------------
 *
 * The save lives in `localStorage`, so it cannot be read during the server
 * render. Reading it in a `useState` initialiser would produce markup on the
 * client that differs from the markup Next sent — a hydration mismatch, which
 * React resolves by throwing away the server HTML and re-rendering. On this app
 * that would also mean the XP bar and the stamp book visibly jumping a second
 * after load.
 *
 * So the first paint is always the empty save, and `hydrated` is false. Every
 * piece of progress UI checks it. The alternative — rendering nothing until
 * hydrated — makes the whole app flash, which is worse than a zeroed XP bar for
 * the one frame it takes.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY WRITE GOES THROUGH ONE REDUCER
 * ---------------------------------------------------------------------------
 *
 * XP, quest progress, collection counts and achievement unlocks are all derived
 * from `stamps` (see types.ts), so the only writes are: add a stamp, remove a
 * stamp, mark a quest claimed, record an achievement date, reset. Routing all
 * five through one reducer means the `dailyCounts`/`activeDays` bookkeeping for
 * a stamp happens in exactly one place — getting that wrong in two call sites is
 * how a streak silently stops counting.
 */

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CITY_BY_SLUG, PLACES, type Place } from "./content";
import {
  newlySatisfied,
  selectAchievements,
  type AchievementInputs,
} from "./achievements";
import { dailyPickFor, streakState, todayKey } from "./daily";
import { evaluateQuests, questById } from "./quests";
import { clear, isStorageAvailable, load, persist } from "./storage";
import { emptySave, type AchievementState, type DayKey, type QuestState, type Save } from "./types";
import { levelState, XP_DAILY_BONUS, XP_PER_CITY, XP_PER_STAMP } from "./xp";

/* -------------------------------------------------------------------------- *
 * Actions and rewards
 * -------------------------------------------------------------------------- */

export type Reward = {
  /** What the player did, for the toast's headline. */
  headline: string;
  /** Itemised XP. Rendered as a list, never summed silently. */
  lines: { label: string; xp: number }[];
  achievements: AchievementState[];
  /** Set when the stamp completed a city outright. */
  cityCleared: string | null;
};

type Action =
  | { type: "stamp"; place: Place; day: DayKey; daily: string | null }
  | { type: "unstamp"; placeId: string }
  | { type: "claim"; questId: string }
  | { type: "recordAchievements"; ids: string[]; at: string }
  | { type: "hydrate"; save: Save }
  | { type: "reset" };

function withStamped(save: Save, id: string, at: string, day: DayKey): Save {
  const stamps = { ...save.stamps, [id]: at };
  const activeDays = save.activeDays.includes(day) ? save.activeDays : [...save.activeDays, day];
  const dailyCounts = { ...save.dailyCounts, [day]: (save.dailyCounts[day] ?? 0) + 1 };
  return { ...save, stamps, activeDays, dailyCounts };
}

function withoutStamped(save: Save, id: string): Save {
  if (!(id in save.stamps)) return save;

  const stamps = { ...save.stamps };
  const at = stamps[id];
  delete stamps[id];

  // The day a stamp belongs to is derived from its ISO timestamp, in the
  // *reader's current* timezone. That is right for the common case and wrong
  // for one: a player who stamps in Lisbon, flies to Chicago and then unstamps
  // that place gets a different day key, and the decrement would land on a day
  // they never played — inventing a day, or silently leaving the real one
  // over-counted.
  //
  // Rather than store a day key per stamp (a new persisted field, a migration,
  // and a second source of truth against `stamps`), the decrement is skipped
  // unless the derived day is one the save already recorded. A mismatch then
  // costs a stale count, which only ever over-reports; it can never fabricate a
  // day. Over-counting keeps a streak alive one day longer, which is the
  // harmless direction to be wrong in.
  const day = at ? dayKeyOf(at) : null;
  if (!day || !save.activeDays.includes(day)) {
    return { ...save, stamps };
  }

  // The removal is a correction, not a play: it must not create or extend a
  // streak. It only rolls the count back, and a day that reaches zero leaves
  // `activeDays` entirely.
  const dailyCounts = { ...save.dailyCounts };
  const remaining = (dailyCounts[day] ?? 0) - 1;

  if (remaining > 0) {
    dailyCounts[day] = remaining;
    return { ...save, stamps, dailyCounts };
  }

  delete dailyCounts[day];
  return {
    ...save,
    stamps,
    dailyCounts,
    activeDays: save.activeDays.filter((d) => d !== day),
  };
}

/** `YYYY-MM-DD` from an ISO timestamp, in local time. See daily.ts on why local. */
function dayKeyOf(iso: string): DayKey | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * The city-clearing bonus for `have` stamped places in `city`, or 0.
 *
 * One function because the XP derivation and the reward toast both need this
 * answer and they were giving it differently: the derivation paid 50 XP for
 * clearing a one-place city while the toast stayed silent about it, so a player
 * stamping Tunis's single entry watched the total jump with no explanation.
 *
 * A city of one is not a city cleared — it is a place stamped, which the base
 * 10 XP already pays for. The floor is 2.
 */
function cityBonusFor(total: number, have: number): number {
  if (total < 2) return 0;
  return have >= total ? XP_PER_CITY : 0;
}

/**
 * The single write path for player progress.
 *
 * Exported so `scripts/check.ts` can drive it directly. It is a pure function of
 * (save, action) with no DOM access, so the cases that matter — a double stamp,
 * an unstamp after a timezone change, a double claim — are testable without a
 * browser, which is where they were not being reached before.
 */
export function reducer(save: Save, action: Action): Save {
  switch (action.type) {
    case "stamp": {
      const { place, day, daily } = action;
      if (place.id in save.stamps) return save;
      const at = new Date().toISOString();

      // The daily nomination is re-drawn if the day's pick is missing, so that
      // stamping a place never loses the day's target. `dailyPickFor` is
      // deterministic on the day key, so this is idempotent.
      const pick = save.dailyPick?.day === day ? save.dailyPick : { day, placeId: daily ?? dailyPickFor(day).id };

      // Record the day only when the place actually stamped IS the nominated
      // one, and only once. This is the fact the XP derivation reads to pay the
      // daily bonus, so it has to be written on exactly the write path that
      // granted it.
      const isDaily = pick.placeId === place.id;
      const dailiesDone =
        isDaily && !save.dailiesDone.includes(day)
          ? [...save.dailiesDone, day]
          : save.dailiesDone;

      return withStamped({ ...save, dailyPick: pick, dailiesDone }, place.id, at, day);
    }

    case "unstamp": {
      const next = withoutStamped(save, action.placeId);

      // Undoing the day's nominated place un-completes the daily — but only if
      // that day recorded nothing else. A player who stamped the daily and two
      // other places and then removed the daily has not un-earned the bonus,
      // and `dailyCounts` is what knows the difference.
      //
      // No early return on "dailiesDone was unchanged": `withoutStamped` never
      // touches that list, so such a guard is always true and silently skipped
      // the whole filter. Filtering unconditionally is both correct and
      // idempotent, since a day with a count still passes.
      return {
        ...next,
        dailiesDone: next.dailiesDone.filter((day) => (next.dailyCounts[day] ?? 0) > 0),
      };
    }

    case "claim": {
      if (save.claimedQuests.includes(action.questId)) return save;
      // No timestamp is stored for a claim. There is no "claimed at" column in
      // the UI, so a date here would be a field nothing reads — and the one-shot
      // guarantee is carried by membership of the list, not by when it happened.
      return { ...save, claimedQuests: [...save.claimedQuests, action.questId] };
    }

    case "recordAchievements": {
      if (!action.ids.length) return save;
      const unlocked = { ...save.unlocked };
      for (const id of action.ids) {
        if (!(id in unlocked)) unlocked[id] = action.at;
      }
      return { ...save, unlocked };
    }

    case "hydrate":
      return action.save;

    case "reset":
      return emptySave();
  }
}

/* -------------------------------------------------------------------------- *
 * Context
 * -------------------------------------------------------------------------- */

export type Progress = {
  save: Save;
  /** False until the save has been read from storage. */
  hydrated: boolean;
  /** False once storage has thrown; drives the one-time warning. */
  storageWorks: boolean;
  /** True when a stored save was found but could not be used. */
  discarded: boolean;

  stamps: ReadonlySet<string>;
  xp: number;
  level: ReturnType<typeof levelState>;
  streak: ReturnType<typeof streakState>;
  quests: QuestState[];
  achievements: AchievementState[];

  /** The day's nominated place, from the save with a deterministic fallback. */
  daily: { day: DayKey; place: Place } | null;
  dailyDone: boolean;

  cityProgress: (citySlug: string) => { have: number; total: number };

  stamp: (place: Place) => Reward | null;
  unstamp: (placeId: string) => void;
  claim: (questId: string) => number;
  reset: () => void;
};

const ProgressContext = createContext<Progress | null>(null);

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [save, dispatch] = useReducer(reducer, undefined, emptySave);
  const [hydrated, setHydrated] = useState(false);
  const [storageWorks, setStorageWorks] = useState(true);
  const [discarded, setDiscarded] = useState(false);

  // The reward a stamp produced, held in state so the toast can render it.
  // A ref would survive re-render but not a second stamp in the same tick, and
  // two stamps in one tick is exactly what a double-tap is.
  const [reward, setReward] = useState<Reward | null>(null);

  /**
   * `today` is state, not a `new Date()` at render.
   *
   * The shell's streak chip depends on it, and reading the clock during render
   * makes a long-lived tab stale at midnight without any event firing. An
   * interval re-reads it and the minute is generous because nothing in the UI
   * cares about seconds.
   */
  const [today, setToday] = useState<DayKey>(() => todayKey());

  useEffect(() => {
    const tick = () => setToday((prev) => (prev === todayKey() ? prev : todayKey()));
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const result = load();
    dispatch({ type: "hydrate", save: result.save });
    setHydrated(true);
    setStorageWorks(isStorageAvailable());
    setDiscarded(result.discarded);
    if (result.discarded) {
      console.warn("[lal-quest] stored save discarded:", result.reason);
    }
  }, []);

  // Persist on every change *after* hydration. Guarding on `hydrated` is what
  // stops the first effect — which dispatches the loaded save — from writing an
  // empty save back over it before it has been read.
  useEffect(() => {
    if (!hydrated) return;
    persist(save);
  }, [save, hydrated]);

  const stamps = useMemo(() => new Set(Object.keys(save.stamps)), [save.stamps]);

  const streak = useMemo(() => streakState(save.activeDays, today), [save.activeDays, today]);

  const claimed = useMemo(() => new Set(save.claimedQuests), [save.claimedQuests]);

  const quests = useMemo(
    () => evaluateQuests(stamps, claimed),
    [stamps, claimed],
  );

  const achievementInputs: AchievementInputs = useMemo(
    () => ({ stamps, bestStreak: streak.best }),
    [stamps, streak.best],
  );

  const achievements = useMemo(
    () => selectAchievements(achievementInputs, save.unlocked),
    [achievementInputs, save.unlocked],
  );

  // XP is derived, never stored. Four sources, and only two of them need
  // anything remembered beyond the stamps themselves:
  //
  //   base         stamps × 10                    from the stamp set
  //   quests       reward of each claimed quest    from claimedQuests
  //   cities       50 per cleared city             from the stamp set
  //   dailies      15 per completed daily          from dailiesDone
  //
  // The daily bonus is the awkward one: it depends on *which* place was
  // nominated that day, and only the current nomination is kept, so it cannot
  // be re-derived and has to be recorded. It is recorded on the same write path
  // that grants it, in the reducer, so the toast and this total cannot drift.
  const xp = useMemo(() => {
    let total = stamps.size * XP_PER_STAMP;

    // Deduplicated even though the reducer already prevents a double claim.
    // The reducer's guard lives on the write path and this is the read path;
    // if they ever disagreed, a duplicated entry in the array would pay a
    // quest's reward twice and nothing in the UI would look wrong. One set
    // here costs nothing and makes the derivation total on its own terms.
    for (const questId of new Set(save.claimedQuests)) {
      total += questById(questId)?.reward ?? 0;
    }

    // Cities where the stamped count reaches the city's total are complete by
    // definition, so this bonus is re-derivable after all — which is why it is
    // computed here rather than banked at stamp time. `cityBonusFor` keeps the
    // floor at two places so it agrees with what the toast reported.
    for (const city of CITY_BY_SLUG.values()) {
      let have = 0;
      for (const place of city.places) {
        if (stamps.has(place.id)) have += 1;
      }
      total += cityBonusFor(city.places.length, have);
    }

    total += new Set(save.dailiesDone).size * XP_DAILY_BONUS;

    return total;
  }, [stamps, save.claimedQuests, save.dailiesDone]);

  const daily = useMemo(() => {
    const stored = save.dailyPick?.day === today ? save.dailyPick : null;
    const placeId = stored?.placeId ?? dailyPickFor(today).id;
    const place = PLACES.find((p) => p.id === placeId);
    if (!place) return null;
    return { day: today, place };
  }, [save.dailyPick, today]);

  // Any condition satisfied by the current save that was never recorded gets its
  // date written once, on the next effect pass. This is what makes "already
  // earned before the achievement existed" show up as earned rather than
  // silently never firing.
  const recordedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!hydrated) return;
    const ids = newlySatisfied(achievementInputs, save.unlocked).filter(
      (id) => !recordedRef.current.has(id),
    );
    if (!ids.length) return;
    for (const id of ids) recordedRef.current.add(id);
    dispatch({ type: "recordAchievements", ids, at: new Date().toISOString() });
  }, [hydrated, achievementInputs, save.unlocked]);

  const cityProgress = useCallback(
    (citySlug: string) => {
      const city = CITY_BY_SLUG.get(citySlug);
      if (!city) return { have: 0, total: 0 };
      let have = 0;
      for (const place of city.places) {
        if (stamps.has(place.id)) have += 1;
      }
      return { have, total: city.places.length };
    },
    [stamps],
  );

  const stamp = useCallback(
    (place: Place): Reward | null => {
      if (stamps.has(place.id)) return null;

      const day = todayKey();
      const lines: Reward["lines"] = [{ label: "Stamp", xp: XP_PER_STAMP }];

      // The city bonus is computed against the set *including* this stamp, which
      // is why it is checked before dispatch rather than after.
      const city = CITY_BY_SLUG.get(place.city);
      let cityCleared: string | null = null;
      if (city) {
        let have = 0;
        for (const candidate of city.places) {
          if (stamps.has(candidate.id) || candidate.id === place.id) have += 1;
        }
        if (cityBonusFor(city.places.length, have) > 0) {
          cityCleared = city.label;
          lines.push({ label: `${city.label} complete`, xp: XP_PER_CITY });
        }
      }

      const isDaily = daily?.place.id === place.id;
      if (isDaily) lines.push({ label: "Daily challenge", xp: XP_DAILY_BONUS });

      dispatch({ type: "stamp", place, day, daily: daily?.place.id ?? null });

      // Achievements are evaluated against the post-stamp set so the toast can
      // show what this stamp just earned rather than what the player already had.
      const nextStamps = new Set(stamps);
      nextStamps.add(place.id);
      const inputs: AchievementInputs = { stamps: nextStamps, bestStreak: streak.best };
      const newlyEarned = newlySatisfied(inputs, save.unlocked);
      const earnedStates = selectAchievements(inputs, save.unlocked).filter((a) =>
        newlyEarned.includes(a.id),
      );

      const headline = cityCleared
        ? `${cityCleared} cleared`
        : isDaily
          ? "Daily challenge complete"
          : `${place.name} stamped`;

      const reward: Reward = { headline, lines, achievements: earnedStates, cityCleared };

      // The toast is raised here rather than by the calling button. A button
      // that forgot to call `setReward` would silently drop the reward, and
      // there are going to be more stamp buttons than there are call sites
      // today — the quest board, the city page and the daily card all stamp.
      setReward(reward);

      return reward;
    },
    [stamps, daily, streak.best, save.unlocked],
  );

  const unstamp = useCallback((placeId: string) => {
    dispatch({ type: "unstamp", placeId });
  }, []);

  const claim = useCallback(
    (questId: string): number => {
      const rewardFor = questById(questId)?.reward ?? 0;
      if (!rewardFor) return 0;
      dispatch({ type: "claim", questId });
      return rewardFor;
    },
    [],
  );

  const reset = useCallback(() => {
    recordedRef.current = new Set();
    clear();
    dispatch({ type: "reset" });
  }, []);

  const value: Progress = useMemo(
    () => ({
      save,
      hydrated,
      storageWorks,
      discarded,
      stamps,
      xp,
      level: levelState(xp),
      streak,
      quests,
      achievements,
      daily,
      dailyDone: daily ? stamps.has(daily.place.id) : false,
      cityProgress,
      stamp,
      unstamp,
      claim,
      reset,
    }),
    [
      save,
      hydrated,
      storageWorks,
      discarded,
      stamps,
      xp,
      streak,
      quests,
      achievements,
      daily,
      cityProgress,
      stamp,
      unstamp,
      claim,
      reset,
    ],
  );

  return (
    <ProgressContext.Provider value={value}>
      {children}
      <RewardToast reward={reward} onDone={() => setReward(null)} />
    </ProgressContext.Provider>
  );
}

export function useProgress(): Progress {
  const context = useContext(ProgressContext);
  if (!context) {
    throw new Error("useProgress must be used inside <ProgressProvider>");
  }
  return context;
}

/* -------------------------------------------------------------------------- *
 * Toast
 * -------------------------------------------------------------------------- */

/**
 * The reward toast.
 *
 * Lives inside the provider so it is mounted once for the whole app rather than
 * per-stamp-button, which is what lets two stamps in the same tick each raise
 * their own toast instead of overwriting one another.
 *
 * It is a `role="status"` live region: a stamp is a reward the player should
 * hear about, and this is the only place the app speaks unprompted.
 */
function RewardToast({ reward, onDone }: { reward: Reward | null; onDone: () => void }) {
  return (
    <div className="lq-toast-rail" role="status" aria-live="polite">
      {reward ? <RewardToastCard reward={reward} onDone={onDone} /> : null}
    </div>
  );
}

function RewardToastCard({ reward, onDone }: { reward: Reward; onDone: () => void }) {
  useEffect(() => {
    // Long enough to read an achievement name, short enough not to stack up
    // when a player taps through a list quickly.
    const timer = window.setTimeout(onDone, 4200);
    return () => window.clearTimeout(timer);
  }, [reward, onDone]);

  return (
    <div className="lq-toast">
      <p className="lq-toast__head">{reward.headline}</p>
      <ul className="lq-toast__lines">
        {reward.lines.map((line) => (
          <li key={line.label}>
            <span>{line.label}</span>
            <span className="lq-toast__xp">+{line.xp}</span>
          </li>
        ))}
      </ul>
      {reward.achievements.length ? (
        <p className="lq-toast__ach">
          {reward.achievements.length === 1
            ? `Achievement: ${reward.achievements[0].title}`
            : `${reward.achievements.length} achievements`}
        </p>
      ) : null}
    </div>
  );
}
