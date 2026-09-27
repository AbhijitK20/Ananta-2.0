"use client";

/**
 * The daily challenge and the seven-day strip.
 *
 * The day's place is a pure function of the date, so it cannot be rerolled by
 * reloading — but it is saved too (see the note in lib/game/daily.ts), and this
 * card reads the save.
 *
 * The reward line is honest about what is left. When the nominated place is
 * already stamped, the card says so and offers no button, rather than
 * pretending there is still something to do today.
 */

import Link from "next/link";

import { formatDayLabel, type StreakState } from "../lib/game/daily";
import { useProgress } from "../lib/game/store";
import { XP_DAILY_BONUS } from "../lib/game/xp";
import { StampButton, TagRow } from "./primitives";

export function DailyCard() {
  const { daily, dailyDone, streak, hydrated, save } = useProgress();

  if (!daily) return null;

  const { place, day } = daily;
  const done = hydrated && dailyDone;

  return (
    <section className={`lq-daily ${done ? "lq-daily--done" : ""}`} aria-labelledby="lq-daily-h">
      <p className="lq-daily__eyebrow" id="lq-daily-h">
        {done ? "Daily challenge — done" : "Today's local"}
      </p>

      <h2 className="lq-daily__name">
        <Link href={`/place/${place.city}/${place.slug}`}>{place.name}</Link>
      </h2>
      <p className="lq-daily__where">
        {place.cityLabel}
        {place.hood ? ` · ${place.hood}` : ""} · {formatDayLabel(day)}
      </p>

      <p className="lq-daily__note">{place.snippet}</p>

      <div className="lq-daily__foot">
        <TagRow place={place} />

        {done ? (
          <span className="lq-daily__reward">+{XP_DAILY_BONUS} XP collected</span>
        ) : (
          <>
            <StampButton place={place} />
            <span className="lq-daily__reward">+{XP_DAILY_BONUS} XP</span>
          </>
        )}
      </div>

      <StreakWeek streak={streak} activeDays={save.activeDays} />
    </section>
  );
}

/**
 * The last seven days, oldest first.
 *
 * A missed day is drawn as a hatched pip rather than an empty one. An empty
 * square and a diagonal-striped square are not distinguishable at 26px in a
 * screenshot, and the whole point of the strip is that a gap is the thing you
 * are looking for.
 */
function StreakWeek({ streak, activeDays }: { streak: StreakState; activeDays: string[] }) {
  const active = new Set(activeDays);
  const today = streak.week[streak.week.length - 1];

  return (
    <div>
      <div className="lq-week" role="list" aria-label="Last seven days">
        {streak.week.map((day) => {
          const hit = active.has(day);
          const isToday = day === today;
          const label = formatDayLabel(day);

          return (
            <span key={day} className="lq-week__day" role="listitem">
              <span
                className={`lq-week__pip ${hit ? "lq-week__pip--hit" : "lq-week__pip--missed"} ${
                  isToday ? "lq-week__pip--today" : ""
                }`}
                aria-hidden="true"
              >
                {hit ? "✓" : ""}
              </span>
              <span className="lq-sr">
                {label}: {hit ? "collected" : "nothing collected"}
              </span>
              <span aria-hidden="true">{label.slice(0, 3)}</span>
            </span>
          );
        })}
      </div>

      <p className="lq-xp__note">
        {streak.current === 0
          ? "Stamp a place today to start a streak."
          : streak.atRisk
            ? `${streak.current}-day streak — stamp something today to keep it.`
            : `${streak.current}-day streak. Best so far: ${streak.best}.`}
      </p>
    </div>
  );
}
