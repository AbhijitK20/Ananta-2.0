"use client";

/**
 * The weather digital twin, as a panel on the planner's left column.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PANEL AND NOT A PAGE
 * ---------------------------------------------------------------------------
 *
 * The brief is explicit that this must be an *enhancement* to the existing
 * solution rather than a standalone application, and a second page would fail
 * that on its own terms: a traveller planning a trip would have to leave the
 * planner to look at the weather, and the two would disagree the moment either
 * changed. So the twin lives inside `/plan`, reads the trip the traveller has
 * already built, and writes nothing back.
 *
 * It sits above the itinerary drawer rather than below it for one reason: the
 * drawer is the thing the twin is arguing about, so the argument comes first.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT CLAIMED
 * ---------------------------------------------------------------------------
 *
 * The provenance block at the foot is not a disclaimer. It is the only honest
 * description of the model: which service answered, for how many cities, how
 * many real records are correcting the prior, and how much of any given number is
 * judgement. A twin that hid that would be asking to be trusted on the strength
 * of its typography.
 *
 * The effect on the itinerary is computed by the planner's own day split, not by
 * this layer — see `lib/twin/itinerary.ts` — so the nights it reports are the
 * nights the planner would produce, under weather that has not happened.
 */

import { formatHours, formatKm } from "../../lib/plan/schedule";
import { usePlan } from "../../lib/plan/store";
import { useTwin } from "../../lib/twin/store";
import { HAZARD_LABELS, SEVERITY_WORDS } from "../../lib/twin/types";
import { ImpactList } from "./ImpactList";
import { LiveConditions, ResolvedHazards, ScenarioControls, relativeTime } from "./HazardPanel";
import { SignalFeed } from "./SignalFeed";

export function WeatherTwin() {
  const { totals } = usePlan();
  const { result, live, loading, error, stale, observedAt, refresh, weatherNote, graphShape } =
    useTwin();

  const empty = !graphShape.stops;

  return (
    <section className="lp-panel wt-panel" aria-labelledby="wt-title">
      <div className="lp-panel__head">
        <h2 className="lp-panel__title" id="wt-title">
          Weather twin
        </h2>
        <div className="wt-panel__tools">
          {result ? (
            <span className={`wt-badge ${result.live ? "wt-badge--live" : "wt-badge--counterfactual"}`}>
              {result.live ? "As observed" : "Counterfactual"}
            </span>
          ) : null}
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={refresh}
            disabled={loading || empty}
          >
            {loading ? "Reading…" : "Re-read"}
          </button>
        </div>
      </div>

      {empty ? (
        <p className="wt-note wt-note--lead">
          The twin models the stops you have added, and the weather where they sit. Add a place
          from the <strong>Find</strong>, <strong>Sleep</strong> or <strong>Eat</strong> panel and it
          starts reading. It will not invent a trip to have something to model.
        </p>
      ) : (
        <>
          <p className="wt-note wt-note--lead">
            A simulation layer over the {graphShape.stops} stop
            {graphShape.stops === 1 ? "" : "s"} you have added across{" "}
            {graphShape.cities} cit{graphShape.cities === 1 ? "y" : "ies"}, using live conditions as
            input. {result?.live
              ? "This is what is happening now."
              : "This is what would happen under the scenario below — your itinerary is untouched."}
          </p>

          {error ? <p className="wt-error">{error}</p> : null}

          <h3 className="wt-sub">Conditions</h3>
          <LiveConditions />

          <h3 className="wt-sub">Effect on the plan</h3>
          <ItineraryEffect />

          <h3 className="wt-sub">What-if</h3>
          <ScenarioControls />
          <ResolvedHazards />

          <h3 className="wt-sub">Every stop</h3>
          <ImpactList />

          <h3 className="wt-sub">Public signals</h3>
          <SignalFeed />

          <Provenance />
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * The itinerary consequence
 * -------------------------------------------------------------------------- */

function ItineraryEffect() {
  const { totals, legs, routing } = usePlan();
  const { result, live } = useTwin();

  if (!result) {
    return <p className="wt-note">Waiting for a first reading of the weather.</p>;
  }

  const { itinerary } = result;
  const base = live?.itinerary;
  const diffing = !result.live && base;

  /* No legs means no measurement, and the planner is careful about exactly this:
     it prints an em dash rather than a zero while OSRM is still answering. The
     twin inherits the same discipline, because "0 m" during a route request is a
     claim and "—" is not. What the twin *can* say without a route is its own
     straight-line estimate, and it says so in those words. */
  const measured = legs.length > 0;

  const extraHours = itinerary.driveHours - (base?.driveHours ?? totals.driveHours);
  const extraDays = itinerary.days - (base?.days ?? totals.days);

  return (
    <>
      {itinerary.headline ? <p className="wt-headline">{itinerary.headline}</p> : null}

      <dl className="wt-plan-delta">
        <div>
          <dt>Days</dt>
          <dd>
            {diffing ? (
              <>
                {base!.days} → <strong>{itinerary.days}</strong>
              </>
            ) : (
              itinerary.days
            )}
          </dd>
        </div>
        <div>
          <dt>Nights</dt>
          <dd>
            {diffing ? (
              <>
                {base!.nights} → <strong>{itinerary.nights}</strong>
              </>
            ) : (
              itinerary.nights
            )}
          </dd>
        </div>
        <div>
          <dt>Driving</dt>
          <dd>
            {diffing ? (
              <>
                {formatHours(base!.driveHours)} →{" "}
                <strong>{formatHours(itinerary.driveHours)}</strong>
              </>
            ) : (
              formatHours(itinerary.driveHours)
            )}
            {diffing && Math.abs(extraHours) >= 0.05 ? (
              <span className={`wt-delta ${extraHours > 0 ? "is-worse" : "is-better"}`}>
                {" "}
                ({extraHours > 0 ? "+" : "−"}
                {formatHours(Math.abs(extraHours))})
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>{measured ? formatKm(totals.km) : "\u2014"}</dd>
        </div>
      </dl>

      {!measured ? (
        <p className="wt-note">
          {routing
            ? "The routing service has not answered yet, so the distance above is a dash rather than a zero. The twin's driving figure is its own straight-line estimate until a real route lands."
            : "No route to measure. The twin's driving figure is a straight-line estimate, not a road distance."}
        </p>
      ) : null}

      {diffing && extraDays === 0 && Math.abs(extraHours) < 0.05 && !itinerary.closed.length ? (
        <p className="wt-note">
          The shape of the trip survives this. Same number of nights, same driving, nothing closed.
        </p>
      ) : null}

      {itinerary.closed.length ? (
        <p className="wt-warn">
          <strong>Would be shut:</strong> {itinerary.closed.join(", ")}.
        </p>
      ) : null}

      {itinerary.degraded.length && !itinerary.closed.length ? (
        <p className="wt-note">
          <strong>Degraded:</strong> {itinerary.degraded.join(", ")}.
        </p>
      ) : null}

      {diffing ? (
        <p className="wt-note">
          The days and nights above come from the planner&apos;s own split — the same rule that
          produced your current itinerary, run on weather that has not happened. Your trip is
          unchanged.
        </p>
      ) : null}
    </>
  );
}

/* -------------------------------------------------------------------------- *
 * Provenance
 * -------------------------------------------------------------------------- */

/**
 * The one sentence that says how much of the answer is measurement.
 *
 * It branches on zero because "0 real records are correcting a prior weighted 4
 * against them" is grammatical but says nothing — the case that matters most is
 * the one where nothing corroborated the model, and that deserves a sentence which
 * says so outright rather than a sentence with a zero in it.
 */
function calibrationSentence(observations: number, priorWeight: number, cells: number) {
  const cellText = ` across ${cells} ${plural(cells, "cell", "cells")}.`;

  if (observations === 0) {
    return (
      <>
        <strong>Nothing corroborated this reading.</strong> No alert and no public report landed on
        your cities, so every severity below is the prior at its full weight of{" "}
        <strong>{priorWeight}</strong> and nothing else — the thresholds in{" "}
        <code>lib/twin/hazard-scale.ts</code> and the table in <code>lib/twin/impact.ts</code>. Read
        the numbers as engineering judgement, not measurement{cellText}
      </>
    );
  }

  return (
    <>
      <strong>{observations}</strong> real {plural(observations, "record", "records")} correcting a
      prior weighted <strong>{priorWeight}</strong> against them{cellText} Below that weight the model
      is mostly judgement, and the ± on each stop is the size of the doubt. The thresholds are in{" "}
      <code>lib/twin/hazard-scale.ts</code> and the prior table in <code>lib/twin/impact.ts</code>.
    </>
  );
}

/** "1 leg" / "2 legs". Counts are read off the model, so this never has to guess. */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function Provenance() {
  const { weatherNote, result, observedAt, stale, graphShape, calibration } = useTwin();

  const worst = result?.peak;

  return (
    <footer className="wt-prov">
      <h3 className="wt-sub wt-sub--last">Where this came from</h3>

      <ul className="wt-prov__list">
        <li>
          <strong>{weatherNote.ok}</strong> of {weatherNote.ok + weatherNote.failed}{" "}
          {plural(weatherNote.ok + weatherNote.failed, "city", "cities")} answered from{" "}
          {weatherNote.source}. {weatherNote.note}
        </li>
        <li>
          <strong>{graphShape.legs}</strong> {plural(graphShape.legs, "routed leg", "routed legs")} and{" "}
          <strong>{graphShape.access}</strong> {plural(graphShape.access, "proximity edge", "proximity edges")}{" "}
          across {graphShape.nodes} {plural(graphShape.nodes, "node", "nodes")}.
          {graphShape.pins > 0
            ? ` ${graphShape.pins} ${plural(graphShape.pins, "pin has", "pins have")} no category, so the twin assumes neither shelter nor exposure.`
            : ""}
        </li>
        <li>{calibrationSentence(calibration.observations, calibration.priorWeight, calibration.cells)}</li>
        {worst?.driver && worst.severity > 0 ? (
          <li>
            The dominant hazard is <strong>{HAZARD_LABELS[worst.driver]}</strong> —{" "}
            {SEVERITY_WORDS[worst.severity]} at {worst.node.name}, at{" "}
            {Math.round(worst.confidence * 100)}% confidence.
          </li>
        ) : null}
      </ul>

      <p className="wt-prov__stamp">
        {observedAt ? `Read ${relativeTime(observedAt)}.` : "Not read yet."}
        {stale ? " That is old enough to re-read." : ""}
      </p>
    </footer>
  );
}
