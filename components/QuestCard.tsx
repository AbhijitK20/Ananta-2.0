"use client";

/**
 * A quest row, and the board that groups them.
 *
 * Claiming is the one irreversible-feeling action in the game — there is no
 * "un-claim" — so the button only enables on a quest that is genuinely
 * complete and genuinely unpaid, and the reward is stated next to it rather
 * than revealed on click.
 */

import Link from "next/link";

import type { QuestState } from "../lib/game/types";
import { useProgress } from "../lib/game/store";
import { Ring } from "./primitives";

export function QuestCard({ state }: { state: QuestState }) {
  const { claim, hydrated } = useProgress();
  const { quest, progress, target, complete, claimable, claimed } = state;

  const pct = target > 0 ? Math.round((progress / target) * 100) : 0;

  const tone = claimable ? "lq-quest--claimable" : claimed ? "lq-quest--claimed" : "";

  return (
    <li className={`lq-quest ${tone}`}>
      <div className="lq-quest__top">
        <div>
          <h3 className="lq-quest__title">{quest.title}</h3>
          <p className="lq-quest__blurb">{quest.blurb}</p>
        </div>
        <span className="lq-quest__reward">
          {claimed ? "Claimed" : `+${quest.reward} XP`}
        </span>
      </div>

      <div
        className="lq-quest__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={progress}
        aria-label={`${quest.title} progress`}
      >
        <div className="lq-quest__fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="lq-quest__foot">
        <span className="lq-quest__count">
          {progress} / {target}
        </span>

        {claimable && hydrated ? (
          <button
            type="button"
            className="lq-btn lq-btn--sm"
            onClick={() => claim(quest.id)}
          >
            Claim {quest.reward} XP
          </button>
        ) : complete ? (
          <span className="lq-tag">Claimed</span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * A city row on the cities page and the stamps page.
 *
 * `done` drives the green treatment. A city with a single place is never
 * marked done even when that place is stamped — see `cityBonusFor` in store.tsx
 * for why a one-place city is not a clearance, and this is the same rule
 * applied to the colour.
 */
export function CityRow({
  slug,
  label,
  named,
  total,
}: {
  slug: string;
  label: string;
  named: boolean;
  total: number;
}) {
  const { cityProgress, hydrated } = useProgress();
  const { have } = cityProgress(slug);
  const done = total >= 2 && have >= total;

  return (
    <Link className={`lq-city ${done ? "lq-city--done" : ""}`} href={`/cities/${slug}`}>
      <Ring have={have} total={total} label={`${label}: ${have} of ${total}`} />

      <span>
        <span className="lq-city__name">{label}</span>
        <span className="lq-city__meta">
          {hydrated ? `${have} of ${total} stamped` : `${total} places`}
          {/* Only say so when the name is a guess. 189 of the 202 city labels
              are prettified from a slug, and a page that presented those as
              authoritative names would be claiming a precision it does not
              have. */}
          {named ? "" : " · name from the dataset's own URL slug"}
        </span>
      </span>

      <span className="lq-city__bar">
        <span className="lq-city__barTrack">
          <span
            className="lq-city__barFill"
            style={{ width: `${total > 0 ? (have / total) * 100 : 0}%` }}
          />
        </span>
        {done ? <span className="lq-city__count">Complete</span> : null}
      </span>
    </Link>
  );
}
