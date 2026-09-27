"use client";

/**
 * GlobeExplorer — the whole-page globe, and the list that drives it.
 *
 * The globe is the primary object on /globe; the 100 places are listed beside
 * it rather than hidden in a filmstrip, because on a full page the list is what
 * makes the planet usable. Someone who cannot tell a pin from a coastline can
 * still search "Ushuaia" and press a button.
 *
 * Both the globe and the list read and write one `active` index, so they cannot
 * disagree. Selection is deliberately *not* written back to the URL on every
 * keystroke-driven change; `initialSlug` only seeds the first render. The page
 * is still linkable as /globe?place=taj-mahal, which is what the home page's
 * filmstrip links to.
 */
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";

import { buildPins, WorldGlobe, type Pin } from "./WorldGlobe";
import { placeSlug } from "../lib/places";

const slugOf = (s: string) => placeSlug(s);

/** The region rail, in the same order the filmstrip uses. */
const REGIONS = [
  "Europe",
  "Africa",
  "Middle East",
  "Asia",
  "Oceania",
  "Americas",
  "Polar",
] as const;

export function GlobeExplorer({ initialSlug }: { initialSlug?: string }) {
  const pins = useMemo(buildPins, []);

  /* Resolved once, outside the state initialiser, because both the opening
     selection and `focusOnMount` need the same answer -- and an unrecognised
     slug must behave exactly like no slug at all, not select the first place
     and then fly the camera there. */
  const deepLink = useMemo(
    () => (initialSlug ? (pins.find((p) => p.id === slugOf(initialSlug)) ?? null) : null),
    [initialSlug, pins],
  );

  const [active, setActive] = useState<number | null>(
    () => deepLink?.index ?? pins[0]?.index ?? null,
  );

  const [region, setRegion] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pins.filter((p) => {
      if (region && p.region !== region) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || p.country.toLowerCase().includes(q)
      );
    });
  }, [pins, query, region]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of pins) map.set(p.region, (map.get(p.region) ?? 0) + 1);
    return map;
  }, [pins]);

  const selected = active == null ? null : (pins.find((p) => p.index === active) ?? null);

  const onSelect = useCallback((index: number) => setActive(index), []);

  return (
    <div className="explorer">
      <div className="explorer__stage">
        <WorldGlobe active={active} onSelect={onSelect} focusOnMount={deepLink != null} />
      </div>

      <aside className="explorer__panel" aria-label="The 100 places">
        <div className="explorer__head">
          <label className="explorer__search">
            <span className="lal-sr">Search the 100 places</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search 100 places…"
              autoComplete="off"
            />
          </label>

          <div className="explorer__regions" role="group" aria-label="Filter by region">
            <button
              type="button"
              onClick={() => setRegion(null)}
              aria-pressed={region === null}
            >
              All <span>{pins.length}</span>
            </button>
            {REGIONS.filter((r) => counts.get(r)).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRegion(region === r ? null : r)}
                aria-pressed={region === r}
              >
                {r} <span>{counts.get(r)}</span>
              </button>
            ))}
          </div>
        </div>

        {/* aria-live: the globe flying somewhere is not otherwise perceivable
            to a screen reader, so the selection is announced from here. */}
        <p className="explorer__now" aria-live="polite">
          {selected ? (
            <>
              <strong>{selected.name}</strong>
              <span>{selected.country}</span>
            </>
          ) : (
            "Pick a place"
          )}
        </p>

        {/* The same destination the home filmstrip's tap panel links to, so a
            pin and a carousel card resolve to one place page rather than two
            descriptions of the same place. */}
        {selected && (
          <p className="explorer__more">
            <Link href={`/places/${selected.id}`}>
              Read more about {selected.name}
            </Link>
          </p>
        )}

        <ol className="explorer__list">
          {visible.map((p: Pin) => {
            const isActive = p.index === active;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(p.index)}
                  aria-current={isActive ? "true" : undefined}
                  className={isActive ? "is-active" : undefined}
                >
                  <span className="explorer__name">{p.name}</span>
                  <span className="explorer__country">{p.country}</span>
                </button>
              </li>
            );
          })}
        </ol>

        {visible.length === 0 && (
          <p className="explorer__empty">
            Nothing matches “{query}”. <Link href="/globe">Clear the search</Link>
          </p>
        )}

        <p className="explorer__credit">
          Earth texture: NASA Blue Marble, public domain. Photographs from
          Wikimedia Commons, credited on each place.{" "}
          <Link href="/">Back to the filmstrip</Link>
        </p>
      </aside>
    </div>
  );
}
