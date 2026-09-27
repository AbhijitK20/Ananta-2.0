"use client";

/**
 * Today: today's place, the quests that are closest to done, and the cities
 * furthest along.
 *
 * Deliberately not a dashboard of every number the save holds. The four things
 * a player wants on opening the app are what today is, what is claimable now,
 * what is nearly finished, and where they are — so those are the four sections,
 * in that order.
 *
 * This lives at `/today` and not at `/` because the clone owns `/` and
 * `/` is the most pixel-locked page in the repository — 56 measured elements in
 * tools/pairs.json. A route group cannot take over a path its parent already
 * serves, so the game's front door has to be a path of its own. See
 * app/(game)/layout.tsx for the same reasoning behind the shell.
 */

import Link from "next/link";
import { useMemo } from "react";

import { DailyCard } from "../../../components/DailyCard";
import { CityRow, QuestCard } from "../../../components/QuestCard";
import { CITIES, COLLISIONS, PLACES, TOTALS } from "../../../lib/game/content";
import { sortForBoard } from "../../../lib/game/quests";
import { useProgress } from "../../../lib/game/store";
import { XP_PER_STAMP } from "../../../lib/game/xp";

/** The six largest cities, for this page's preview. */
const CITY_PREVIEW = CITIES.slice(0, 6);

/**
 * The gaps in the extraction, counted rather than written into the copy.
 *
 * These were literals once, and they were wrong: they were the counts from the
 * 892-record raw extraction, while the album holds 890 after the two id
 * collisions are dropped. Reading them off the data is the only version of this
 * sentence that cannot go stale.
 */
const UNFILED_COUNT = PLACES.filter((p) => p.categories.includes("unfiled")).length;
const UNKNOWN_BUDGET_COUNT = PLACES.filter((p) => p.budget === "unknown").length;

export default function TodayPage() {
  const { quests, stamps, hydrated, level, streak } = useProgress();

  const board = useMemo(() => sortForBoard(quests), [quests]);

  // The six quests nearest completion, claimables first. A quest at 0/5 and one
  // at 49/50 are both "not done", and only one of which is worth a tap.
  const focus = useMemo(
    () => board.filter((state) => !state.claimed).slice(0, 6),
    [board],
  );

  const claimableCount = quests.filter((q) => q.claimable).length;

  return (
    <div className="lq-page">
      <header className="lq-head">
        <p className="lq-head__eyebrow">
          {hydrated
            ? `${stamps.size.toLocaleString()} of ${TOTALS.places} stamped`
            : `${TOTALS.places} places · ${TOTALS.cities} cities`}
        </p>
        <h1 className="lq-head__title">
          {hydrated ? level.level.title : "Collect the places locals go to"}
        </h1>
        <p className="lq-head__sub">
          Every place in this album came from a local&rsquo;s own recommendation.
          Stamp them, clear the quests, and fill the book.
        </p>
      </header>

      <DailyCard />

      <section className="lq-section" aria-labelledby="lq-focus-h">
        <h2 className="lq-section__title" id="lq-focus-h">
          {claimableCount > 0
            ? `${claimableCount} quest${claimableCount === 1 ? "" : "s"} ready to claim`
            : "Closest to done"}
        </h2>
        <p className="lq-section__note">
          {claimableCount > 0
            ? "Finished quests pay out once. Claim them before you lose the tab."
            : `Each stamp is worth ${XP_PER_STAMP} XP. Finishing a city pays a bonus.`}
        </p>
        <ul className="lq-grid">
          {focus.map((state) => (
            <QuestCard key={state.quest.id} state={state} />
          ))}
        </ul>
        <p style={{ marginTop: 14 }}>
          <Link href="/quests" className="lq-btn lq-btn--ghost lq-btn--sm">
            All {quests.length} quests
          </Link>
        </p>
      </section>

      <section className="lq-section" aria-labelledby="lq-cities-h">
        <h2 className="lq-section__title" id="lq-cities-h">
          Cities to fill
        </h2>
        <p className="lq-section__note">
          Biggest first, so a new album opens on somewhere with enough places to
          make progress visible.
        </p>
        <div className="lq-grid">
          {CITY_PREVIEW.map((city) => (
            <CityRow
              key={city.slug}
              slug={city.slug}
              label={city.label}
              named={city.named}
              total={city.places.length}
            />
          ))}
        </div>
        <p style={{ marginTop: 14 }}>
          <Link href="/atlas" className="lq-btn lq-btn--ghost lq-btn--sm">
            All {CITIES.length} cities
          </Link>
        </p>
      </section>

      <section className="lq-section" aria-labelledby="lq-about-h">
        <h2 className="lq-section__title" id="lq-about-h">
          What this album is made of
        </h2>
        <p className="lq-section__note">
          {TOTALS.places} places across {TOTALS.cities} cities and{" "}
          {TOTALS.categories} categories, extracted from likealocalguide.com.
          Stamping is self-reported — there is no location check.
        </p>
        <p className="lq-section__note">
          The extraction is imperfect, and the album shows it rather than hiding
          it: {UNFILED_COUNT} places carry no category and {UNKNOWN_BUDGET_COUNT}{" "}
          no price band, both marked with a dashed outline.
          {COLLISIONS.length > 0
            ? ` ${COLLISIONS.length} records collided on their own identifier and were dropped — the album holds ${TOTALS.places} of the ${TOTALS.places + COLLISIONS.length} extracted.`
            : ""}
        </p>
      </section>

      <p className="lq-section__note" style={{ paddingBottom: 8 }}>
        {streak.best > 0 ? `Longest streak so far: ${streak.best} days.` : null}
      </p>
    </div>
  );
}
