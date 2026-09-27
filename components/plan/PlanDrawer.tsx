"use client";

/**
 * Furkot's Plan drawer: the itinerary, day by day.
 *
 * Grouped by the derived day split rather than rendered as one flat list, because
 * the split is what the traveller is planning around — the number of nights is the
 * first question, and a flat list of eleven stops cannot answer it. Within a day,
 * each stop carries the leg that arrives at it, so the distance and duration sit
 * next to the place they belong to rather than in a separate totals strip.
 *
 * Reordering is up and down buttons rather than drag-and-drop. Furkot drags stops
 * around the map, and a pointer-driven drag is a genuinely different piece of
 * machinery — pointer capture, a threshold so a click is not a drag, and keyboard
 * equivalents to stay reachable. Buttons get reordering right for everyone on the
 * first pass, and the accessibility cost of drag is the part that cannot be
 * patched in later.
 */

import { coordsFor } from "../../lib/plan/geo";
import { PLACES } from "../../lib/plan/places";
import { formatHours, formatKm } from "../../lib/plan/schedule";
import { usePlan } from "../../lib/plan/store";
import type { Leg, Stop } from "../../lib/plan/types";

export function PlanDrawer() {
  const {
    trip,
    routed,
    legs,
    days,
    totals,
    routing,
    reverse,
    clearTrip,
    move,
    toggleSkipped,
    removeStop,
    select,
    selectedId,
    setDwell,
  } = usePlan();

  const byId = new Map(trip.stops.map((s) => [s.id, s]));
  const legInto = new Map<string, Leg>();
  legs.forEach((leg) => legInto.set(leg.toId, leg));
  /** Each routed stop's position, so the up/down buttons know their bounds. */
  const order = new Map(routed.map((s, i) => [s.id, i]));

  const skipped = trip.stops.filter((s) => s.skipped);

  /* "0 m" while the route request is still open is a claim, not a gap: there are
     two stops and no answer yet. An em dash says "not measured yet" and costs
     nothing once the numbers land. */
  const measured = legs.length > 0;

  if (!trip.stops.length) {
    return (
      <section className="lp-panel lp-plan" aria-labelledby="lp-plan-h">
        <h2 className="lp-panel__title" id="lp-plan-h">
          Your trip
        </h2>
        <div className="lp-empty">
          <p>No stops yet.</p>
          <p className="lp-empty__note">
            Add places from the <strong>Find</strong>, <strong>Sleep</strong> or{" "}
            <strong>Eat</strong> panel, or click the map to drop a pin.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="lp-panel lp-plan" aria-labelledby="lp-plan-h">
      <div className="lp-panel__head">
        <h2 className="lp-panel__title" id="lp-plan-h">
          Your trip
        </h2>
        <div className="lp-plan__tools">
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={reverse}>
            Reverse
          </button>
          <button type="button" className="lp-btn lp-btn--ghost lp-btn--sm" onClick={clearTrip}>
            Clear
          </button>
        </div>
      </div>

      <dl className="lp-totals">
        <div>
          <dt>Stops</dt>
          <dd>{totals.stops}</dd>
        </div>
        <div>
          <dt>Days</dt>
          <dd>{totals.days}</dd>
        </div>
        <div>
          <dt>Distance</dt>
          <dd>{measured ? formatKm(totals.km) : "\u2014"}</dd>
        </div>
        <div>
          <dt>Driving</dt>
          <dd>{measured ? formatHours(totals.driveHours) : "\u2014"}</dd>
        </div>
      </dl>

      {/* The one number a traveller plans around, and the one most likely to be
          wrong. Stated rather than footnoted. */}
      <p className={`lp-basis ${totals.routed ? "lp-basis--routed" : "lp-basis--estimated"}`}>
        {routing
          ? "Routing…"
          : totals.routed
            ? "Distances and times are routed road distances."
            : "Some legs are straight-line estimates — the routing service did not answer, or this is not a car itinerary."}
      </p>

      {totals.overCapDays > 0 ? (
        <p className="lp-warn">
          <strong>
            {totals.overCapDays} day{totals.overCapDays === 1 ? "" : "s"} over your{" "}
            {trip.dailyDriveHours} h limit.
          </strong>{" "}
          {trip.nonStop
            ? "Non-stop travel is on, so nothing was split."
            : "A leg longer than the limit cannot be split — it is one drive between two places you chose."}
        </p>
      ) : null}

      <ol className="lp-days">
        {days.map((day) => (
          <li key={day.index} className="lp-day">
            <div className="lp-day__head">
              <h3 className="lp-day__title">Day {day.index + 1}</h3>
              <span className="lp-day__meta">
                {measured
                  ? `${day.km > 0 ? `${formatKm(day.km)} · ` : ""}${formatHours(day.driveHours)}`
                  : "\u2014"}
              </span>
            </div>

            {day.overnight ? (
              <p className="lp-day__night">
                {day.overnight.available ? (
                  <>
                    Night in <strong>{cityName(day.overnight.city)}</strong> — the
                    directory has {hotelCount(day.overnight.city)} hotel
                    {hotelCount(day.overnight.city) === 1 ? "" : "s"} there.
                  </>
                ) : (
                  <>
                    Night in <strong>{cityName(day.overnight.city)}</strong> — the
                    directory has <em>no hotels for this city</em>, so there is
                    nothing to suggest.
                  </>
                )}
              </p>
            ) : null}

            <ol className="lp-stops">
              {day.stopIds.map((id) => {
                const stop = byId.get(id);
                if (!stop) return null;
                const leg = legInto.get(id);
                const position = order.get(id) ?? 0;
                return (
                  <li key={id}>
                    {leg ? <LegRow leg={leg} /> : null}
                    <StopRow
                      stop={stop}
                      selected={stop.id === selectedId}
                      canMoveUp={position > 0}
                      canMoveDown={position < routed.length - 1}
                      onSelect={() => select(stop.id)}
                      onUp={() => move(position, position - 1)}
                      onDown={() => move(position, position + 1)}
                      onSkip={() => toggleSkipped(stop.id)}
                      onRemove={() => removeStop(stop.id)}
                      onDwell={(hours) => setDwell(stop.id, hours)}
                    />
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>

      {skipped.length > 0 ? (
        <section className="lp-skipped" aria-labelledby="lp-skipped-h">
          <h3 className="lp-skipped__title" id="lp-skipped-h">
            Skipped — {skipped.length}
          </h3>
          <p className="lp-skipped__note">
            On the map in grey, not part of the route and not counted in the days.
          </p>
          <ul className="lp-skipped__list">
            {skipped.map((stop) => (
              <li key={stop.id}>
                <span>{stop.name}</span>
                <button
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  onClick={() => toggleSkipped(stop.id)}
                >
                  Add back
                </button>
                <button
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  onClick={() => removeStop(stop.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * Rows
 * -------------------------------------------------------------------------- */

function LegRow({ leg }: { leg: Leg }) {
  return (
    <p className={`lp-leg lp-leg--${leg.basis}`}>
      <span className="lp-leg__dist">{formatKm(leg.km)}</span>
      <span className="lp-leg__time">{formatHours(leg.hours)}</span>
      {leg.basis === "estimated" ? (
        <span
          className="lp-leg__basis"
          title="Straight-line estimate, not a routed road distance"
        >
          estimated
        </span>
      ) : null}
    </p>
  );
}

function StopRow({
  stop,
  selected,
  canMoveUp,
  canMoveDown,
  onSelect,
  onUp,
  onDown,
  onSkip,
  onRemove,
  onDwell,
}: {
  stop: Stop;
  selected: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: () => void;
  onUp: () => void;
  onDown: () => void;
  onSkip: () => void;
  onRemove: () => void;
  onDwell: (hours: number) => void;
}) {
  const city = stop.city ? cityName(stop.city) : null;

  return (
    <div className={`lp-stop ${selected ? "lp-stop--selected" : ""}`}>
      <button
        type="button"
        className="lp-stop__main"
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className="lp-stop__name">{stop.name}</span>
        <span className="lp-stop__where">
          {city ?? "Pinned on the map"}
          {stop.hood ? ` · ${stop.hood}` : ""}
        </span>
      </button>

      <div className="lp-stop__row">
        <label className="lp-stop__dwell">
          <span className="lp-sr">Hours at {stop.name}</span>
          <select
            value={stop.dwell}
            onChange={(e) => onDwell(Number(e.target.value))}
            aria-label={`Hours at ${stop.name}`}
          >
            <option value={0.5}>30 min</option>
            <option value={1}>1 h</option>
            <option value={2}>2 h</option>
            <option value={3}>3 h</option>
            <option value={6}>Half day</option>
            <option value={8}>Full day</option>
          </select>
        </label>

        <div className="lp-stop__btns">
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={onUp}
            disabled={!canMoveUp}
            aria-label={`Move ${stop.name} earlier`}
          >
            ↑
          </button>
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={onDown}
            disabled={!canMoveDown}
            aria-label={`Move ${stop.name} later`}
          >
            ↓
          </button>
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={onSkip}
            aria-label={`Skip ${stop.name}`}
          >
            Maybe
          </button>
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            onClick={onRemove}
            aria-label={`Remove ${stop.name}`}
          >
            ✕
          </button>
        </div>
      </div>

      {stop.source === "place" && stop.href ? (
        <a
          className="lp-stop__link"
          href={stop.href}
          target="_blank"
          rel="noreferrer noopener"
        >
          Read the local&apos;s note ↗
        </a>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Small lookups
 * -------------------------------------------------------------------------- */

const cityName = (slug: string) => coordsFor(slug)?.name ?? slug;

const hotelCount = (city: string) =>
  PLACES.filter((p) => p.city === city && p.tags.includes("hotels")).length;
