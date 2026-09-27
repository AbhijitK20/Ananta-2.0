"use client";

/**
 * The pieces every page builds from: the stamp button, the completion ring, and
 * the tag row.
 *
 * All client components. `StampButton` in particular has to be — it is the only
 * thing in the app that writes to the save.
 */

import Link from "next/link";

import {
  BUDGET_LABELS,
  CATEGORY_LABELS,
  type Place,
} from "../lib/game/content";
import { useProgress } from "../lib/game/store";

/* -------------------------------------------------------------------------- *
 * Tags
 * -------------------------------------------------------------------------- */

/**
 * The category and budget row under a place's name.
 *
 * `unfiled` and `unknown` get deliberately different, dashed treatments from
 * every other tag. 576 of the 890 places have no category and 282 have no
 * budget, and rendering those in the same pill as real data would overstate
 * what the dataset knows — the collector would be claiming coverage the source
 * does not support.
 */
export function TagRow({ place }: { place: Place }) {
  return (
    <span className="lq-stamp__meta">
      {place.categories.map((category) => (
        <span
          key={category}
          className={`lq-tag ${category === "unfiled" ? "lq-tag--unfiled" : "lq-tag--cat"}`}
        >
          {CATEGORY_LABELS[category]}
        </span>
      ))}
      <span
        className={`lq-tag ${place.budget === "unknown" ? "lq-tag--unknown" : "lq-tag--budget"}`}
      >
        {BUDGET_LABELS[place.budget]}
      </span>
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Ring
 * -------------------------------------------------------------------------- */

/**
 * A completion ring.
 *
 * `conic-gradient` rather than SVG: one element, no viewBox, and it inherits
 * the current text colour so the numeral inside needs no separate fill.
 * `aria-hidden` because every caller that shows a ring also shows the counts as
 * text, and a screen reader hearing "80%" twice is worse than hearing it once.
 */
export function Ring({ have, total, label }: { have: number; total: number; label: string }) {
  const pct = total > 0 ? Math.round((have / total) * 100) : 0;
  return (
    <span
      className="lq-ring"
      style={{ "--pct": pct } as React.CSSProperties}
      aria-hidden="true"
      title={label}
    >
      <span className="lq-ring__n">{pct}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- *
 * Stamp button
 * -------------------------------------------------------------------------- */

/**
 * The write control.
 *
 * Stamping is self-reported: there is no GPS check and no proof of presence.
 * The button says "Stamp" rather than "Check in" for that reason, and
 * unstamping is offered on the same control so a mis-tap is one tap to undo
 * rather than a purge of the whole save.
 */
export function StampButton({ place, size = "md" }: { place: Place; size?: "md" | "sm" }) {
  const { stamps, stamp, unstamp, hydrated } = useProgress();
  const on = hydrated && stamps.has(place.id);

  const small = size === "sm";

  return (
    <button
      type="button"
      className={`lq-btn ${small ? "lq-btn--sm" : ""} ${on ? "lq-btn--ghost" : ""}`}
      onClick={() => (on ? unstamp(place.id) : stamp(place))}
      aria-pressed={on}
    >
      <span aria-hidden="true">{on ? "✓" : "＋"}</span>
      <span>{on ? "Stamped" : "Stamp"}</span>
      <span className="lq-sr">
        {on ? ` — remove the stamp from ${place.name}` : ` ${place.name}`}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- *
 * Place card
 * -------------------------------------------------------------------------- */

/**
 * A collectable place.
 *
 * The whole card is not a link: the stamp button sits inside it, and nesting a
 * button inside an anchor is invalid and breaks keyboard traversal. The name is
 * the link, which is the largest single target on the card anyway.
 */
export function PlaceCard({ place }: { place: Place }) {
  const { stamps, hydrated, save } = useProgress();
  const on = hydrated && stamps.has(place.id);
  const at = save.stamps[place.id];

  return (
    <li className={`lq-stamp ${on ? "lq-stamp--on" : ""}`}>
      {on ? (
        <span className="lq-stamp__mark" aria-hidden="true">
          ✓
        </span>
      ) : null}

      <Link href={`/place/${place.city}/${place.slug}`} className="lq-stamp__name">
        {place.name}
      </Link>

      {place.hood ? <span className="lq-stamp__hood">{place.hood}</span> : null}

      <TagRow place={place} />

      <div className="lq-stamp__foot">
        <StampButton place={place} size="sm" />
        {on && at ? (
          <span className="lq-stamp__when">
            {new Date(at).toLocaleDateString(undefined, {
              day: "numeric",
              month: "short",
            })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

