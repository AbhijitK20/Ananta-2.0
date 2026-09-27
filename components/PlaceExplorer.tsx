"use client";

/**
 * PlaceExplorer — the browse surface on /cities.
 *
 * ── Why the search filters in the browser ───────────────────────────────────
 * The old page posted a form to itself and the box did nothing, so anything
 * typed into it -- including `' OR 1=1 --` -- went nowhere at all. Rather than
 * wire that to a server query, the whole 100-place set is already in the
 * bundle, so the filter is a plain array reduce over it. There is no query to
 * inject into, which is the point: the box now works, and it works safely.
 *
 * The text is never interpolated into markup, only compared with
 * `toLowerCase().includes`, so the input cannot become a node.
 */
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { PLACES_DETAILED, regionCounts } from "../lib/places";

const total = PLACES_DETAILED.length;

export function PlaceExplorer() {
  const [query, setQuery] = useState("");
  const [region, setRegion] = useState<string | null>(null);
  const searchId = useId();

  const countries = useMemo(
    () => [...new Set(PLACES_DETAILED.map((p) => p.country))].sort(),
    [],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PLACES_DETAILED.filter((place) => {
      if (region && place.region !== region) return false;
      if (!q) return true;
      return (
        place.name.toLowerCase().includes(q) ||
        place.country.toLowerCase().includes(q) ||
        place.region.toLowerCase().includes(q) ||
        place.bestFor.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [query, region]);

  return (
    <div className="px">
      <div className="px__controls">
        <label className="px__search" htmlFor={searchId}>
          <span className="lal-sr">Search {total} places by name, country or region</span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${total} places…`}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="px__selects">
          <label className="px__select">
            <span>Region</span>
            <select value={region ?? ""} onChange={(e) => setRegion(e.target.value || null)}>
              <option value="">All regions</option>
              {regionCounts.map(({ region: name, count }) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </select>
          </label>

          <label className="px__select">
            <span>Country</span>
            <select
              value=""
              onChange={(event) => {
                const match = PLACES_DETAILED.find((p) => p.country === event.target.value);
                if (match) {
                  setRegion(null);
                  setQuery(match.country);
                }
              }}
            >
              <option value="">Jump to a country…</option>
              {countries.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <p className="px__count" aria-live="polite">
        {visible.length === total
          ? `All ${total} places`
          : `${visible.length} of ${total} places`}
        {region ? ` in ${region}` : ""}
        {query.trim() ? ` matching “${query.trim()}”` : ""}
      </p>

      {visible.length === 0 ? (
        <p className="px__empty">
          Nothing matches that.{" "}
          <button
            type="button"
            className="px__reset"
            onClick={() => {
              setQuery("");
              setRegion(null);
            }}
          >
            Clear the search
          </button>
        </p>
      ) : (
        <ul className="px__grid">
          {visible.map((place) => (
            <li key={place.id}>
              <Link href={`/places/${place.id}`} className="px-card">
                <span className="px-card__frame">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="px-card__img"
                    src={place.image}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                </span>
                <span className="px-card__body">
                  <span className="px-card__name">{place.name}</span>
                  <span className="px-card__where">
                    {place.country} · {place.region}
                  </span>
                  {place.bestFor[0] && (
                    <span className="px-card__tag">{place.bestFor[0]}</span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
