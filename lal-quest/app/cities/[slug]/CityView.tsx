"use client";

/**
 * One city: its places, its progress, and its clearance state.
 *
 * A client component because the stamp set lives in the save. It takes the slug
 * as a prop rather than reading it from `useParams`, because the route that
 * renders it is a server component that has already resolved and validated the
 * param — see page.tsx next to this file.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { PlaceCard, Ring } from "../../../components/primitives";
import { CATEGORY_LABELS, CATEGORY_ORDER, cityOf, type Category } from "../../../lib/content";
import { useProgress } from "../../../lib/game/store";
import { XP_PER_CITY } from "../../../lib/game/xp";

type Filter = "all" | Category;

export default function CityView({ slug }: { slug: string }) {
  const city = cityOf(slug);

  const { cityProgress, stamps, hydrated } = useProgress();
  const [filter, setFilter] = useState<Filter>("all");

  // Unreachable in practice: the route resolves the slug and calls notFound()
  // otherwise, so the city is known by the time this renders. Guarded anyway
  // because `city.places` is accessed below and an undefined city would take
  // the whole page down rather than this one section.
  if (!city) return null;

  const { have, total } = cityProgress(city.slug);

  // Only offer a category filter the city actually has, so the row is never a
  // row of zeroes.
  const present = useMemo(
    () => CATEGORY_ORDER.filter((category) => city.byCategory[category] > 0),
    [city],
  );

  const places = useMemo(
    () =>
      filter === "all"
        ? city.places
        : city.places.filter((place) => place.categories.includes(filter)),
    [city, filter],
  );

  const done = total >= 2 && have >= total;

  return (
    <div className="lq-page">
      <p className="lq-head__eyebrow">
        <Link href="/cities">Cities</Link> / {city.label}
      </p>

      <header className="lq-head" style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="lq-head__title">{city.label}</h1>
          <p className="lq-head__sub">
            {hydrated ? `${have} of ${total} stamped` : `${total} places`}
            {done ? ` · cleared for +${XP_PER_CITY} XP` : ""}
          </p>
          {/* Only worth saying when the name is a guess. 189 of the 202 city
              labels are prettified from a URL slug, and presenting those as
              authoritative would claim a precision the data does not carry. */}
          {city.named ? null : (
            <p className="lq-section__note">
              This city&rsquo;s name is reconstructed from the dataset&rsquo;s own
              URL slug, not from an authoritative list.
            </p>
          )}
        </div>
        <Ring have={have} total={total} label={`${city.label} completion`} />
      </header>

      {present.length > 1 ? (
        <div className="lq-card" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            className={`lq-btn lq-btn--sm ${filter === "all" ? "" : "lq-btn--quiet"}`}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All · {total}
          </button>
          {present.map((category) => (
            <button
              key={category}
              type="button"
              className={`lq-btn lq-btn--sm ${filter === category ? "" : "lq-btn--quiet"}`}
              aria-pressed={filter === category}
              onClick={() => setFilter(category)}
            >
              {CATEGORY_LABELS[category]}
              <span aria-hidden="true"> · {city.byCategory[category]}</span>
            </button>
          ))}
        </div>
      ) : null}

      {done ? (
        <p
          className="lq-daily__reward"
          style={{ marginTop: 16, display: "block" }}
        >
          ✓ Every place in {city.label} is stamped. The city bonus is already in
          your total.
        </p>
      ) : null}

      <ul className="lq-grid" style={{ marginTop: 20 }}>
        {places.map((place) => (
          <PlaceCard key={place.id} place={place} />
        ))}
      </ul>

      {/*
        Reachable only when a category filter is active — with `filter === "all"`
        `places` is the whole city and cannot be empty, since a city only exists
        in the index because it has at least one place. The narrowing is written
        out rather than assumed so the type and the runtime agree.
      */}
      {places.length === 0 && filter !== "all" ? (
        <div className="lq-out">
          No places in {city.label} carry the {CATEGORY_LABELS[filter]} tag.
        </div>
      ) : null}

      <p className="lq-section__note" style={{ padding: "26px 0 8px" }}>
        {hydrated && have === 0 && stamps.size > 0
          ? "Nothing from this city yet — it is a fresh stamp book page."
          : null}
      </p>
    </div>
  );
}
