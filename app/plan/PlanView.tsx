"use client";

/**
 * The planner: Furkot's three panels, in Furkot's arrangement.
 *
 *   Weather twin (left, above) · Plan drawer (left) · Map (centre) · Find/Sleep/Eat (right)
 *
 * The weather twin sits at the top of the left column rather than on a page of its
 * own, because the brief is explicit that this is an enhancement to the existing
 * solution rather than a standalone application — and a traveller would have to
 * leave the planner to look at the weather, at which point the two would disagree
 * the moment either changed. It reads the trip below it and writes nothing back.
 *
 * On a narrow screen the panels stack under the map, because a 320px map with a
 * drawer either side of it is three unusable columns rather than a responsive
 * layout.
 *
 * The whole page is a client component because all of it is derived from the saved
 * trip: legs come from a network call, days from the split, the map from the two,
 * and the twin's simulation from the trip plus a weather reading. There is nothing
 * here worth prerendering — the first paint is an empty itinerary either way, and
 * a map cannot exist without a window.
 */

import { PoiDrawer } from "../../components/plan/PoiDrawer";
import { PlanDrawer } from "../../components/plan/PlanDrawer";
import { TripMap } from "../../components/plan/TripMap";
import { TripSettings } from "../../components/plan/TripSettings";
import { WeatherTwin } from "../../components/twin/WeatherTwin";
import { PLACE_TOTALS } from "../../lib/plan/places";
import { PlanProvider, usePlan } from "../../lib/plan/store";
import { TwinProvider } from "../../lib/twin/store";

export function PlanView() {
  return (
    <PlanProvider>
      <TwinProvider>
        <PlanShell />
      </TwinProvider>
    </PlanProvider>
  );
}

function PlanShell() {
  const { addPin, hydrated, storageWorks, discarded } = usePlan();

  return (
    <div className="lp-page">
      <header className="lp-head">
        <h1 className="g-h1">Plan the trip</h1>
        <p className="g-lede">
          Add places from the directory, drop pins on the map, and let the daily
          driving limit decide how many nights you need. Every distance is either a
          routed road distance or is labelled an estimate — nothing here is a
          straight line wearing a road&apos;s name.
        </p>
      </header>

      {!storageWorks ? (
        <p className="lal-alert">
          <strong>This plan is not being saved.</strong> Your browser is blocking
          site data, so it lasts until you close the tab.
        </p>
      ) : null}

      {discarded ? (
        <p className="lal-alert">
          <strong>A saved plan could not be read</strong> and the itinerary has
          started fresh. Nothing was overwritten.
        </p>
      ) : null}

      <div className="lp-grid">
        <div className="lp-col lp-col--left">
          <WeatherTwin />
          <PlanDrawer />
        </div>

        <div className="lp-col lp-col--map">
          <TripMap onPick={(at) => addPin(at)} />
          <TripSettings />
        </div>

        <div className="lp-col lp-col--right">
          <PoiDrawer />
          <Provenance />
        </div>
      </div>

      {/* Before hydration the save has not been read, so the honest thing to show
          is the empty state rather than a spinner that resolves to "nothing". */}
      {!hydrated ? <p className="lp-sr">Loading your saved plan…</p> : null}
    </div>
  );
}

/** The counts, read off the data rather than written into the copy. These were
 *  literals once and they were wrong the moment a place was added. */
function Provenance() {
  return (
    <section className="lp-panel lp-prov" aria-labelledby="lp-prov-h">
      <h2 className="lp-panel__title" id="lp-prov-h">
        What is in here
      </h2>
      <ul className="lp-prov__list">
        <li>
          <strong>{PLACE_TOTALS.all.toLocaleString()}</strong> places across{" "}
          {PLACE_TOTALS.cities} cities.
        </li>
        <li>
          <strong>{PLACE_TOTALS.sleep}</strong> hotels, in{" "}
          {PLACE_TOTALS.citiesWithHotels} cities.
        </li>
        <li>
          <strong>{PLACE_TOTALS.eat}</strong> restaurants, in{" "}
          {PLACE_TOTALS.citiesWithEat} cities.
        </li>
        <li>
          <strong>{PLACE_TOTALS.untagged.toLocaleString()}</strong> carry no category
          in the source, and are listed under Find rather than filed under a guess.
        </li>
        {PLACE_TOTALS.unplaced > 0 ? (
          <li>
            <strong>{PLACE_TOTALS.unplaced}</strong> could not be placed at all,
            because their city is missing from the coordinates file.
          </li>
        ) : null}
      </ul>
    </section>
  );
}
