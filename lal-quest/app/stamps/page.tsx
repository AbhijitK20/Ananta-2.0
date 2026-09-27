"use client";

/**
 * The album: what you have collected, what you have not, and the badges.
 *
 * The reset control is here rather than buried in a settings page, and it asks
 * first. A collection with 400 stamps in it is the only thing this app holds,
 * there is no server copy, and "Reset" on a button next to "Stamps" with no
 * confirmation is a genuinely destructive default.
 */

import { useMemo, useState } from "react";

import { PlaceCard, Ring } from "../../components/primitives";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CATEGORY_TOTALS,
  PLACE_BY_ID,
  PLACES,
  TOTALS,
} from "../../lib/content";
import { useProgress } from "../../lib/game/store";
import { LEVELS } from "../../lib/game/xp";

type View = "stamps" | "categories" | "badges" | "levels";

const VIEWS: { id: View; label: string }[] = [
  { id: "stamps", label: "Places" },
  { id: "categories", label: "Categories" },
  { id: "badges", label: "Badges" },
  { id: "levels", label: "Levels" },
];

export default function StampsPage() {
  const { stamps, save, achievements, level, xp, hydrated, reset } = useProgress();
  const [view, setView] = useState<View>("stamps");
  const [confirming, setConfirming] = useState(false);

  // Category counts are recomputed from the place records on every change
  // rather than kept in a counter. A counter would have to be incremented on
  // every write path, and this is 890 records filtered against a set — cheap,
  // and structurally unable to drift from the stamps.
  const categoryProgress = useMemo(() => {
    const have = Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as Record<
      (typeof CATEGORY_ORDER)[number],
      number
    >;

    for (const place of PLACES) {
      if (!stamps.has(place.id)) continue;
      for (const category of place.categories) have[category] += 1;
    }

    return CATEGORY_ORDER.map((category) => ({
      category,
      have: have[category],
      total: CATEGORY_TOTALS[category],
    }));
  }, [stamps]);

  const earned = achievements.filter((a) => a.earned);
  const sortedStamps = useMemo(
    () =>
      [...stamps].sort((a, b) => {
        const at = save.stamps[a] ?? "";
        const bt = save.stamps[b] ?? "";
        return bt.localeCompare(at);
      }),
    [stamps, save.stamps],
  );

  return (
    <div className="lq-page">
      <header className="lq-head" style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="lq-head__eyebrow">The album</p>
          <h1 className="lq-head__title">
            {hydrated ? `${stamps.size} stamped` : "Your collection"}
          </h1>
          <p className="lq-head__sub">
            {hydrated
              ? `${stamps.size} of ${TOTALS.places} places · ${xp.toLocaleString()} XP · ${level.level.title}`
              : `An album of ${TOTALS.places} places across ${TOTALS.cities} cities.`}
          </p>
        </div>
        <Ring
          have={stamps.size}
          total={TOTALS.places}
          label="Album completion"
        />
      </header>

      <div className="lq-card" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`lq-btn lq-btn--sm ${view === option.id ? "" : "lq-btn--quiet"}`}
            aria-pressed={view === option.id}
            onClick={() => setView(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {view === "stamps" ? (
        <section className="lq-section" aria-labelledby="lq-stamps-h">
          <h2 className="lq-sr" id="lq-stamps-h">
            Stamped places
          </h2>

          {sortedStamps.length === 0 ? (
            <div className="lq-out" style={{ marginTop: 20 }}>
              Nothing stamped yet. Start with{" "}
              <a href="/cities/lisbon" style={{ textDecoration: "underline" }}>
                Lisbon
              </a>{" "}
              — it has the most places in the dataset.
            </div>
          ) : (
            <ul className="lq-grid" style={{ marginTop: 20 }}>
              {sortedStamps.map((id) => {
                const place = PLACE_BY_ID.get(id);
                // A stamp id that no longer resolves is possible after a data
                // change, and rendering an empty card would be worse than
                // saying so.
                return place ? (
                  <PlaceCard key={id} place={place} />
                ) : (
                  <li className="lq-stamp" key={id}>
                    <span className="lq-stamp__name">Unknown place</span>
                    <span className="lq-stamp__hood">
                      Stamped as <code>{id}</code>, which is not in the current
                      dataset.
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {view === "categories" ? (
        <section className="lq-section" aria-labelledby="lq-cats-h">
          <h2 className="lq-section__title" id="lq-cats-h">
            By category
          </h2>
          <p className="lq-section__note">
            A place can carry two tags, so these rows overlap and do not sum to
            the album total. 576 places carry no tag at all — that row is the
            largest single bucket in the data.
          </p>

          <ul className="lq-grid">
            {categoryProgress.map(({ category, have, total }) => (
              <li className="lq-card" key={category} style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <Ring have={have} total={total} label={CATEGORY_LABELS[category]} />
                <div style={{ minWidth: 0 }}>
                  <p className="lq-stamp__name">{CATEGORY_LABELS[category]}</p>
                  <p className="lq-stamp__hood">
                    {hydrated ? `${have} of ${total}` : `${total} places`}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view === "badges" ? (
        <section className="lq-section" aria-labelledby="lq-badges-h">
          <h2 className="lq-section__title" id="lq-badges-h">
            Badges
          </h2>
          <p className="lq-section__note">
            {earned.length} of {achievements.length} earned. A badge with no date
            was earned before the album started recording one.
          </p>

          <ul className="lq-grid">
            {achievements.map((achievement) => (
              <li
                key={achievement.id}
                className={`lq-ach lq-ach--${achievement.tier} ${achievement.earned ? "lq-ach--on" : "lq-ach--off"}`}
              >
                <span className="lq-ach__badge" aria-hidden="true">
                  {achievement.earned ? achievement.glyph : "·"}
                </span>
                <div style={{ minWidth: 0 }}>
                  <p className="lq-ach__title">{achievement.title}</p>
                  <p className="lq-ach__blurb">{achievement.blurb}</p>
                  <p className="lq-ach__date">
                    {achievement.earned
                      ? achievement.unlockedAt
                        ? `Earned ${new Date(achievement.unlockedAt).toLocaleDateString()}`
                        : "Earned — no date recorded"
                      : "Not yet earned"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view === "levels" ? (
        <section className="lq-section" aria-labelledby="lq-levels-h">
          <h2 className="lq-section__title" id="lq-levels-h">
            Levels
          </h2>
          <p className="lq-section__note">
            The curve tops out at 6000 XP — 600 stamps — and the album holds{" "}
            {TOTALS.places}. Maxing the levels and finishing the album are two
            different things.
          </p>

          <ul className="lq-grid">
            {LEVELS.map((candidate) => {
              const reached = hydrated && xp >= candidate.at;
              return (
                <li
                  key={candidate.index}
                  className="lq-card"
                  style={{
                    opacity: reached ? 1 : 0.6,
                    borderColor: candidate.index === level.level.index ? "var(--lq-accent)" : undefined,
                  }}
                >
                  <p className="lq-stamp__name">
                    {candidate.index + 1}. {candidate.title}
                  </p>
                  <p className="lq-stamp__hood">
                    {candidate.at.toLocaleString()} XP
                    {candidate.index === level.level.index ? " · you are here" : ""}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="lq-section" style={{ paddingBottom: 24 }}>
        <h2 className="lq-section__title">Start again</h2>
        <p className="lq-section__note">
          This clears every stamp, claim, badge and streak. There is no server
          copy, so it cannot be undone.
        </p>

        {confirming ? (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              type="button"
              className="lq-btn lq-btn--sm"
              onClick={() => {
                reset();
                setConfirming(false);
              }}
            >
              Yes, erase {stamps.size} stamps
            </button>
            <button
              type="button"
              className="lq-btn lq-btn--quiet lq-btn--sm"
              onClick={() => setConfirming(false)}
            >
              Keep my album
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="lq-btn lq-btn--quiet lq-btn--sm"
            onClick={() => setConfirming(true)}
          >
            Reset the album
          </button>
        )}
      </section>
    </div>
  );
}

