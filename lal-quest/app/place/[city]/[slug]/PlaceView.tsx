"use client";

/**
 * One place.
 *
 * The stamp control lives here rather than only on the card, because a player
 * who has just read a recommendation wants to act on it without going back to
 * the list — and this is the page where they are most likely to.
 *
 * The note field is the dataset's own "why it matters" text, verbatim, and the
 * link out goes to the source. The game does not editorialise: it presents what a
 * local said and lets the player decide.
 *
 * Takes the resolved `id` as a prop rather than reading params — the route that
 * renders this is a server component which has already validated them.
 */

import Link from "next/link";

import { StampButton, TagRow } from "../../../../components/primitives";
import { CITY_BY_SLUG, placeOf } from "../../../../lib/content";
import { useProgress } from "../../../../lib/game/store";

export default function PlaceView({ id }: { id: string }) {
  const place = placeOf(id);

  const { save, stamps, hydrated, cityProgress } = useProgress();

  // Same guard as the city view: the route guarantees this resolves, but the
  // fields below are all non-optional accesses on it.
  if (!place) return null;

  const at = save.stamps[place.id];
  const on = hydrated && stamps.has(place.id);
  const city = CITY_BY_SLUG.get(place.city);
  const progress = cityProgress(place.city);

  return (
    <div className="lq-place">
      <p className="lq-place__crumb">
        <Link href="/cities">Cities</Link> /{" "}
        <Link href={`/cities/${place.city}`}>{place.cityLabel}</Link>
      </p>

      <h1 className="lq-place__name">{place.name}</h1>

      {place.hood ? (
        <p className="lq-place__hood">
          {place.hood}, {place.cityLabel}
        </p>
      ) : (
        <p className="lq-place__hood">{place.cityLabel}</p>
      )}

      <div className="lq-place__meta">
        <TagRow place={place} />
      </div>

      <p className="lq-place__note">{place.snippet}</p>

      <div className="lq-place__actions">
        <StampButton place={place} />

        {on && at ? (
          <span className="lq-place__stampDate">
            Stamped{" "}
            {new Date(at).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </span>
        ) : (
          <span className="lq-place__stampDate">
            Self-reported — there is no location check.
          </span>
        )}

        {progress.total > 1 ? (
          <span className="lq-place__stampDate" style={{ marginLeft: "auto" }}>
            <Link href={`/cities/${place.city}`} style={{ textDecoration: "underline" }}>
              {place.cityLabel}: {progress.have} of {progress.total}
            </Link>
          </span>
        ) : null}
      </div>

      {city ? (
        <p className="lq-section__note" style={{ paddingTop: 22 }}>
          One of {city.places.length} places in {city.label}
          {city.named ? "" : " (name from the dataset's URL slug)"}.
        </p>
      ) : null}

      <p className="lq-section__note" style={{ paddingTop: 10 }}>
        <a href={place.href} rel="noopener noreferrer" target="_blank">
          Read the original recommendation on likealocalguide.com ↗
        </a>
      </p>
    </div>
  );
}
