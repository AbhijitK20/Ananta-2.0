"use client";

/**
 * Furkot's Find / Sleep / Eat drawers, and the filters over them.
 *
 * One panel with three modes rather than three panels, because Furkot's drawers
 * are three views of the same list and a traveller switching from "somewhere to
 * eat" to "somewhere to stay" is changing a filter, not a page.
 *
 * ---------------------------------------------------------------------------
 * THE TWO COUNTS THIS PANEL HAS TO SHOW
 * ---------------------------------------------------------------------------
 *
 * **The Sleep drawer holds 26 places.** The directory has 892 entries and 26 of
 * them are hotels, and they sit in 12 of its 202 cities — so 190 cities have an
 * empty Sleep tab, and the overnight suggestion on the itinerary has nothing to
 * point at. The count is printed on the tab and again in the empty state, because
 * a traveller who switches to Sleep and finds nothing will otherwise assume the
 * planner is broken.
 *
 * **578 of the 892 entries carry no category**, because the extractor reads a tag
 * from a node the site only renders on some cards. They are listed under Find — a
 * place with no category cannot be known to be a hotel or a restaurant, and filing
 * it under either would invent the one fact a traveller would act on — and each is
 * marked so the Find list is not mistaken for a curated set.
 *
 * The Spread control only starts filtering once there is a route to measure
 * against, and says so when there is not. A spread that silently returned nothing
 * before the second stop would read as an empty drawer rather than as a control
 * with nothing to measure.
 */

import { useMemo } from "react";

import {
  BUDGETS,
  PLACE_TOTALS,
  TAGS,
  citiesInDrawer,
  filterPlaces,
  tagLabel,
  type Place,
} from "../../lib/plan/places";
import { usePlan } from "../../lib/plan/store";
import { DRAWERS, DRAWER_BLURB, DRAWER_LABELS, SPREAD_STEPS } from "../../lib/plan/types";

export function PoiDrawer() {
  const { drawer, setDrawer, filters, setFilters, trip, routeLine, addPlace, setSpreadKm, totals } =
    usePlan();

  /** Places already in the itinerary, so their Add button reads "Added" and
   *  cannot be pressed. A second copy of one entry would duplicate its id. */
  const alreadyIn = useMemo(
    () => new Set(trip.stops.filter((s) => !s.skipped).map((s) => s.placeId).filter(Boolean)),
    [trip.stops],
  );

  const results = useMemo(
    () => filterPlaces(drawer, filters, trip.spreadKm, routeLine),
    [drawer, filters, trip.spreadKm, routeLine],
  );

  const cities = useMemo(() => citiesInDrawer(drawer), [drawer]);
  const drawerCount = PLACE_TOTALS[drawer];
  const isSleep = drawer === "sleep";

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  return (
    <section className="lp-panel lp-poi" aria-labelledby="lp-poi-h">
      <h2 className="lp-sr" id="lp-poi-h">
        Places
      </h2>

      <div className="lp-tabs" role="tablist" aria-label="Place drawers">
        {DRAWERS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            id={`lp-tab-${d}`}
            aria-selected={drawer === d}
            aria-controls="lp-poi-panel"
            className={`lp-tab ${drawer === d ? "lp-tab--on" : ""}`}
            onClick={() => setDrawer(d)}
          >
            {DRAWER_LABELS[d]}
            <span className="lp-tab__count">{PLACE_TOTALS[d]}</span>
          </button>
        ))}
      </div>

      <div
        className="lp-poi__panel"
        id="lp-poi-panel"
        role="tabpanel"
        aria-labelledby={`lp-tab-${drawer}`}
      >
        <p className="lp-poi__blurb">{DRAWER_BLURB[drawer]}</p>

        {/* The honest count, stated before the list rather than inferred from it. */}
        {isSleep ? (
          <p className="lp-note">
            The directory holds <strong>{PLACE_TOTALS.sleep} hotels</strong> across{" "}
            {PLACE_TOTALS.citiesWithHotels} of its {PLACE_TOTALS.cities} cities. Most
            destinations have none, and the planner will not invent one.
          </p>
        ) : null}

        <label className="lp-field">
          <span className="lp-sr">Search places</span>
          <input
            type="search"
            value={filters.query}
            placeholder="Search a name, city or neighbourhood"
            onChange={(e) => setFilters({ query: e.target.value })}
          />
        </label>

        <div className="lp-filters">
          <fieldset className="lp-chips">
            <legend>Category</legend>
            {TAGS.map((tag) => (
              <label key={tag} className="lp-chip">
                <input
                  type="checkbox"
                  checked={filters.categories.includes(tag)}
                  onChange={() => setFilters({ categories: toggleIn(filters.categories, tag) })}
                />
                <span>{tagLabel(tag)}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="lp-chips">
            <legend>Price</legend>
            {BUDGETS.map((budget) => (
              <label key={budget} className="lp-chip">
                <input
                  type="checkbox"
                  checked={filters.budgets.includes(budget)}
                  onChange={() => setFilters({ budgets: toggleIn(filters.budgets, budget) })}
                />
                <span>{budget}</span>
              </label>
            ))}
          </fieldset>

          <label className="lp-field lp-field--row">
            <span>City</span>
            <select
              value={filters.cities[0] ?? ""}
              onChange={(e) => setFilters({ cities: e.target.value ? [e.target.value] : [] })}
            >
              <option value="">All {cities.length} cities</option>
              {cities.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.label} ({c.count})
                </option>
              ))}
            </select>
          </label>

          <label
            className="lp-field lp-field--row"
            title="How far off your route a place may sit and still be offered"
          >
            <span>Spread</span>
            <select
              value={trip.spreadKm}
              onChange={(e) => setSpreadKm(Number(e.target.value))}
            >
              {SPREAD_STEPS.map((km) => (
                <option key={km} value={km}>
                  {km} km
                </option>
              ))}
            </select>
          </label>
        </div>

        {!routeLine ? (
          <p className="lp-note lp-note--quiet">
            Spread measures from your route, so it is not filtering yet — add a
            second stop.
          </p>
        ) : null}

        <p className="lp-count">
          {results.length} of {drawerCount} shown
          {drawer === "find" ? ` · ${PLACE_TOTALS.untagged} carry no category` : ""}
        </p>

        {results.length === 0 ? (
          <div className="lp-empty">
            <p>Nothing matches those filters.</p>
            {isSleep ? (
              <p className="lp-empty__note">
                There are only {PLACE_TOTALS.sleep} hotels in the whole directory, so
                this is often empty. Widen the filters, or pick a city that has one.
              </p>
            ) : (
              <p className="lp-empty__note">Widen the spread, or clear a filter.</p>
            )}
          </div>
        ) : (
          <ul className="lp-results">
            {results.slice(0, 120).map((place) => (
              <ResultRow
                key={place.id}
                place={place}
                added={alreadyIn.has(place.id)}
                onAdd={() =>
                  addPlace({
                    id: place.id,
                    name: place.name,
                    city: place.city,
                    hood: place.hood,
                    href: place.href,
                    cats: place.tags,
                    budget: place.budget,
                  })
                }
              />
            ))}
          </ul>
        )}

        {results.length > 120 ? (
          <p className="lp-note lp-note--quiet">
            Showing the first 120 of {results.length}. Narrow the search to see the
            rest.
          </p>
        ) : null}

        <p className="lp-note lp-note--quiet">
          {totals.stops} stop{totals.stops === 1 ? "" : "s"} in your trip.
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Rows
 * -------------------------------------------------------------------------- */

function ResultRow({
  place,
  added,
  onAdd,
}: {
  place: Place;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <li className="lp-result">
      <div className="lp-result__main">
        <p className="lp-result__name">
          {place.name}
          {place.untagged ? (
            <span
              className="lp-tag lp-tag--unfiled"
              title="The source carried no category for this place"
            >
              no category
            </span>
          ) : null}
        </p>
        <p className="lp-result__where">
          {place.cityLabel}
          {place.hood ? ` · ${place.hood}` : ""}
          {place.budget ? ` · ${place.budget}` : ""}
        </p>
        {place.snippet ? <p className="lp-result__snip">{place.snippet}</p> : null}
      </div>
      {added ? (
        <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" disabled>
          Added
        </button>
      ) : (
        <button type="button" className="lp-btn lp-btn--sm" onClick={onAdd}>
          Add<span className="lp-sr"> {place.name} to the trip</span>
        </button>
      )}
    </li>
  );
}
