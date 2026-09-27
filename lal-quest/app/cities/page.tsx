"use client";

/**
 * The city index — 202 of them, searchable.
 *
 * Search is client-side over an array that is already in memory, so there is no
 * debounce and no loading state. A 202-item filter is well under a frame, and
 * adding a debounce would make the list feel laggy for no reason.
 *
 * Ordered by size so the fullest cities are reachable first, with a toggle for
 * alphabetical because "find the city I am in" is a name lookup, not a size
 * lookup.
 */

import { useMemo, useState } from "react";

import { CityRow } from "../../components/QuestCard";
import { CITIES, COLLISIONS } from "../../lib/content";
import { useProgress } from "../../lib/game/store";

type Order = "size" | "alpha";

export default function CitiesPage() {
  const { hydrated, stamps } = useProgress();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<Order>("size");

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? CITIES.filter(
          (city) =>
            city.label.toLowerCase().includes(needle) ||
            city.places.some((place) => place.name.toLowerCase().includes(needle)),
        )
      : CITIES;

    // A copy, because `CITIES` is frozen and `sort` mutates in place.
    return [...filtered].sort((a, b) =>
      order === "size"
        ? b.places.length - a.places.length || a.label.localeCompare(b.label)
        : a.label.localeCompare(b.label),
    );
  }, [query, order]);

  // Cities with at least one stamp, for the summary line.
  const started = useMemo(
    () => CITIES.filter((city) => city.places.some((p) => stamps.has(p.id))).length,
    [stamps],
  );

  return (
    <div className="lq-page">
      <header className="lq-head">
        <p className="lq-head__eyebrow">
          {hydrated ? `${started} of ${CITIES.length} started` : `${CITIES.length} cities`}
        </p>
        <h1 className="lq-head__title">Cities</h1>
        <p className="lq-head__sub">
          {CITIES.length} cities, from four-place cities to Lisbon&rsquo;s
          fourteen. One quest exists per city with two or more places.
        </p>
      </header>

      <div className="lq-card" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div className="lq-xp" style={{ flex: "1 1 260px", maxWidth: "none" }}>
          <label htmlFor="lq-city-q" className="lq-sr">
            Search cities or places
          </label>
          <input
            id="lq-city-q"
            type="search"
            placeholder="Search a city, or any place inside it"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            style={{
              width: "100%",
              minHeight: 38,
              padding: "0 12px",
              border: "1px solid var(--lq-line)",
              borderRadius: 8,
              font: "inherit",
            }}
          />
        </div>

        <button
          type="button"
          className={`lq-btn lq-btn--sm ${order === "size" ? "" : "lq-btn--quiet"}`}
          aria-pressed={order === "size"}
          onClick={() => setOrder("size")}
        >
          Biggest
        </button>
        <button
          type="button"
          className={`lq-btn lq-btn--sm ${order === "alpha" ? "" : "lq-btn--quiet"}`}
          aria-pressed={order === "alpha"}
          onClick={() => setOrder("alpha")}
        >
          A–Z
        </button>
      </div>

      <p className="lq-section__note" style={{ marginTop: 12 }} aria-live="polite">
        {rows.length} {rows.length === 1 ? "city" : "cities"}
        {query.trim() ? ` matching “${query.trim()}”` : ""}
      </p>

      {rows.length === 0 ? (
        <div className="lq-out">Nothing matches that. Try a shorter search.</div>
      ) : (
        <div className="lq-grid">
          {rows.map((city) => (
            <CityRow
              key={city.slug}
              slug={city.slug}
              label={city.label}
              named={city.named}
              total={city.places.length}
            />
          ))}
        </div>
      )}

      {COLLISIONS.length ? (
        <p className="lq-section__note" style={{ paddingBottom: 10 }}>
          {COLLISIONS.length} extracted record
          {COLLISIONS.length === 1 ? "" : "s"} collided on an identifier shared
          with another and {COLLISIONS.length === 1 ? "is" : "are"} not in the
          album: {COLLISIONS.map((c) => c.id).join(", ")}.
        </p>
      ) : null}
    </div>
  );
}
