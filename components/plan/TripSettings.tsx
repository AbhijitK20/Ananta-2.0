"use client";

/**
 * Trip settings: the controls that change how the itinerary is built rather than
 * what is in it.
 *
 * Furkot's day settings, route settings and travel mode, in one panel. The daily
 * driving limit gets the most room because it is the control that decides how
 * many nights the trip has — put it behind a menu and nobody finds it.
 *
 * The non-stop toggle is stated in full rather than labelled "non-stop", because
 * "non-stop" reads as "skip the stops" and it does the opposite: it stops the
 * planner inserting overnight stops, leaving a 14-hour day as a 14-hour day.
 */

import { CITY_COORD_COUNT, MANUAL_COORD_COUNT } from "../../lib/plan/geo";
import { PLACES } from "../../lib/plan/places";
import { NAV_APPS, toGpx, waypointString } from "../../lib/plan/route";
import { usePlan } from "../../lib/plan/store";
import { TRAVEL_MODES, TRAVEL_MODE_LABELS } from "../../lib/plan/types";

const DAILY_LIMITS = [2, 3, 4, 5, 6, 7, 8, 10, 12];

export function TripSettings() {
  const { trip, legs, routed, totals, setDailyDriveHours, setNonStop, setMode, setStartDate, setTripName } =
    usePlan();

  const gpx = toGpx(legs, trip.name);
  const waypoints = waypointString(routed);

  return (
    <section className="lp-panel lp-settings" aria-labelledby="lp-settings-h">
      <h2 className="lp-panel__title" id="lp-settings-h">
        Trip settings
      </h2>

      <label className="lp-field lp-field--row">
        <span>Trip name</span>
        <input
          type="text"
          value={trip.name}
          onChange={(e) => setTripName(e.target.value)}
          maxLength={60}
        />
      </label>

      <label className="lp-field lp-field--row">
        <span>Start date</span>
        <input
          type="date"
          value={trip.startDate ?? ""}
          onChange={(e) => setStartDate(e.target.value || null)}
        />
      </label>

      <fieldset className="lp-radio">
        <legend>Travel mode</legend>
        {TRAVEL_MODES.map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="lp-mode"
              value={mode}
              checked={trip.mode === mode}
              onChange={() => setMode(mode)}
            />
            <span>{TRAVEL_MODE_LABELS[mode]}</span>
          </label>
        ))}
      </fieldset>

      {trip.mode !== "car" ? (
        <p className="lp-note">
          The public routing service only computes car routes — it answers bicycle
          and walking requests with driving times — so a{" "}
          {TRAVEL_MODE_LABELS[trip.mode].toLowerCase()} itinerary is measured with
          straight-line estimates. The map draws those legs dashed.
        </p>
      ) : null}

      <fieldset className="lp-limits">
        <legend>Driving per day</legend>
        <div className="lp-limits__row">
          {DAILY_LIMITS.map((hours) => (
            <label
              key={hours}
              className={`lp-limit ${trip.dailyDriveHours === hours ? "lp-limit--on" : ""}`}
            >
              <input
                type="radio"
                name="lp-daily"
                value={hours}
                checked={trip.dailyDriveHours === hours}
                onChange={() => setDailyDriveHours(hours)}
              />
              <span>{hours} h</span>
            </label>
          ))}
        </div>
        <p className="lp-note lp-note--quiet">
          {totals.days} day{totals.days === 1 ? "" : "s"} at this limit.
        </p>
      </fieldset>

      <label className="lp-switch">
        <input
          type="checkbox"
          checked={trip.nonStop}
          onChange={(e) => setNonStop(e.target.checked)}
        />
        <span>
          <strong>Non-stop travel</strong> — never split the itinerary, however long
          a day gets. Use it when you would rather arrive exhausted than stop
          somewhere you did not choose.
        </span>
      </label>

      <div className="lp-nav-apps">
        <h3 className="lp-sub">Navigate</h3>
        {routed.length < 2 ? (
          <p className="lp-note lp-note--quiet">Add two stops to get a route to hand off.</p>
        ) : (
          <>
            <ul className="lp-links">
              {NAV_APPS.map((app) => (
                <li key={app.id}>
                  <a href={app.href(waypoints)} target="_blank" rel="noreferrer noopener">
                    {app.label} ↗
                  </a>
                </li>
              ))}
            </ul>
            <a
              className="lp-btn lp-btn--ghost lp-btn--sm"
              href={`data:application/gpx+xml;charset=utf-8,${encodeURIComponent(gpx)}`}
              download={`${trip.name.replace(/[^\w-]+/g, "-").toLowerCase() || "trip"}.gpx`}
            >
              Download GPX
            </a>
            {trip.mode === "car" && legs.length > 0 && !totals.routed ? (
              <p className="lp-note lp-note--quiet">
                The GPX holds the straight lines drawn on the map. Re-open the plan
                once the routing service answers and it will hold the real road
                geometry.
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="lp-provenance">
        <h3 className="lp-sub">What this planner works from</h3>
        <ul className="lp-provenance__list">
          <li>
            <strong>{PLACES.length.toLocaleString()}</strong> places in the directory,
            across <strong>{CITY_COORD_COUNT}</strong> cities.
          </li>
          <li>
            Pinned at each city&apos;s centre. The directory carries no coordinates
            for the places themselves — {MANUAL_COORD_COUNT} of the{" "}
            {CITY_COORD_COUNT} city centroids are hand-entered and{" "}
            {CITY_COORD_COUNT - MANUAL_COORD_COUNT} were looked up from GeoNames.
          </li>
          <li>
            Road distances and times from the OSRM demo server. It is a shared free
            service and it rate-limits; legs it cannot route fall back to
            straight-line estimates, marked as such on every leg.
          </li>
        </ul>
      </div>
    </section>
  );
}
