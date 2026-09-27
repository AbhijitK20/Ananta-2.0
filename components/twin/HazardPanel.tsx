"use client";

/**
 * The live conditions readout, and the what-if controls, in one component.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONTROLS ARE RATIOS AND PRINT AN ABSOLUTE
 * ---------------------------------------------------------------------------
 *
 * A rainfall slider labelled "40 mm/h" is meaningless at the traveller's current
 * conditions: in clear air 40 is a catastrophe and in a downpour it is Tuesday.
 * So every control moves a *ratio* on the observed reading, and every control
 * prints the absolute value that ratio resolves to, right next to it. The
 * traveller never has to do the arithmetic to know whether the thing they are
 * imagining is a real change.
 *
 * Depth is the exception and carries its own unit: water accumulates, so it has
 * an origin that is not "clear skies" and a ratio would be meaningless. The same
 * goes for storm hours, which is a duration rather than an intensity.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CONTROL IS DISABLED WHEN THERE IS NO READING
 * ---------------------------------------------------------------------------
 *
 * A control that multiplies an absent number produces a confident answer from
 * nothing. If the weather service did not answer for a city, the sliders for that
 * city are disabled and say why, rather than silently treating the reading as
 * zero and offering to ×2.5 it.
 */

import { HAZARD_LABELS, type CityObservation, type HazardKind, type Scenario } from "../../lib/twin/types";
import { resolveIntensities } from "../../lib/twin/weather";
import { useTwin } from "../../lib/twin/store";

const HAZARDS: readonly HazardKind[] = ["rain", "heat", "wind", "flood", "storm"];

/* -------------------------------------------------------------------------- *
 * Live conditions
 * -------------------------------------------------------------------------- */

export function LiveConditions() {
  const { observations, loading, error } = useTwin();

  if (!observations.length) {
    return (
      <p className="wt-note">
        {loading
          ? "Reading the weather…"
          : error
            ? error
            : "Add a stop to the trip and the twin will start reading the weather where you are going."}
      </p>
    );
  }

  return (
    <ul className="wt-cities">
      {observations.map((observation) => (
        <CityConditions key={observation.city} observation={observation} />
      ))}
    </ul>
  );
}

function CityConditions({ observation }: { observation: CityObservation }) {
  const { observedAt } = useTwin();

  if (observation.error || !observation.hazards) {
    return (
      <li className="wt-city wt-city--failed">
        <span className="wt-city__name">{observation.cityLabel}</span>
        <span className="wt-city__error">
          {observation.error ?? "No reading."} The twin reports this city as unaffected rather than
          guessing.
        </span>
      </li>
    );
  }

  return (
    <li className="wt-city">
      <div className="wt-city__head">
        <span className="wt-city__name">{observation.cityLabel}</span>
        <span className="wt-city__cond">{observation.condition}</span>
        {observation.tempC !== null ? (
          <span className="wt-city__temp">{Math.round(observation.tempC)}°C</span>
        ) : null}
      </div>

      <dl className="wt-hazards">
        {observation.hazards.map((hazard) => (
          <div key={hazard.kind} className="wt-hazard" data-severity={hazard.severity}>
            <dt>
              {HAZARD_LABELS[hazard.kind]}
              {hazard.severity === 0 ? null : (
                <span className="wt-hazard__sev">
                  {"".padStart(hazard.severity, "■")}
                </span>
              )}
            </dt>
            <dd>
              {hazard.severity === 0 ? (
                <span className="wt-hazard__none">none</span>
              ) : (
                <>
                  {hazard.intensity} {hazard.unit}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>

      <p className="wt-city__meta">
        {observation.forecastHours > 0
          ? `${observation.forecastHours} h of forecast`
          : "current conditions only"}
        {observation.forecastRainMmH !== null
          ? ` · ${observation.forecastRainMmH} mm/h forecast over 12 h`
          : ""}
        {observedAt ? ` · read ${relativeTime(observedAt)}` : ""}
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------------- *
 * What-if
 * -------------------------------------------------------------------------- */

type Preset = { id: string; label: string; blurb: string; patch: Partial<Scenario> };

/**
 * The presets, and the reason there are exactly these four.
 *
 * Each is a named event a traveller actually plans around, expressed in the
 * ratios the controls move rather than in raw units — so a preset that doubles
 * rainfall in a downpour and one that doubles it in clear air are the same
 * gesture and mean the same thing relative to where the trip already is.
 */
const PRESETS: readonly Preset[] = [
  {
    id: "downpour",
    label: "Downpour",
    blurb: "Rain ×3, 15 cm of standing water, two days of storm.",
    patch: { rain: 3, floodCm: 15, stormHours: 48, wind: 1.4 },
  },
  {
    id: "heatwave",
    label: "Heatwave",
    blurb: "8 °C on top of what it is, winds dropping.",
    patch: { heatDeltaC: 8, wind: 0.6, rain: 0.4 },
  },
  {
    id: "gale",
    label: "Gale",
    blurb: "Winds ×2.5 and a day of storm.",
    patch: { wind: 2.5, stormHours: 24, rain: 1.6 },
  },
  {
    id: "flood",
    label: "Flood",
    blurb: "40 cm of standing water, rain ×2.",
    patch: { floodCm: 40, rain: 2 },
  },
];

export function ScenarioControls() {
  const { scenario, setScenario, resetScenario, observations, result, graphShape } = useTwin();

  const readable = observations.find((o) => o.hazards);
  const disabled = !readable;
  const moved = !result?.live;

  /* Multiplying zero by three is zero, and a ratio control sitting on a
     non-nothing value that is nonetheless zero implies a response the model does
     not have. Reading the observed value of each ratio-controlled hazard and
     naming the ones that are inert is the honest move — and it is exactly what
     the screenshot of a "Downpour" preset on a clear day exposed. */
  const deadControls = ["rain", "wind"]
    .filter((kind) => (scenario as unknown as Record<string, number>)[kind] !== 1)
    .filter((kind) => (readable?.hazards?.find((h) => h.kind === kind)?.intensity ?? 0) === 0)
    .map((kind) => HAZARD_LABELS[kind as HazardKind]);

  return (
    <div className="wt-scenario">
      <div className="wt-scenario__head">
        {/* No heading here: the page already prints one above this component, and
            two of them read as two different panels. Just the badge. */}
        <span className="wt-scenario__label">
          {moved ? "Applied on top of the reading" : "Showing the reading as observed"}
        </span>
        <span className={`wt-badge ${moved ? "wt-badge--counterfactual" : "wt-badge--live"}`}>
          {moved ? "Counterfactual" : "As observed"}
        </span>
      </div>

      {disabled ? (
        <p className="wt-note">
          The controls need a live reading first. Nothing is fabricated to fill the gap.
        </p>
      ) : (
        <>
          <ul className="wt-presets">
            {PRESETS.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  className="wt-preset"
                  onClick={() => setScenario(preset.patch)}
                  title={preset.blurb}
                >
                  {preset.label}
                </button>
              </li>
            ))}
          </ul>

          <ul className="wt-sliders">
            <RatioSlider
              hazard="rain"
              min={0}
              max={5}
              step={0.1}
              value={scenario.rain}
              format={(v) => `${v === 1 ? "unchanged" : `${v}× the observed rate`}`}
              absolute={(o, v) => `${round1((o?.hazards?.find((h) => h.kind === "rain")?.intensity ?? 0) * v)} mm/h`}
              onChange={(rain) => setScenario({ rain })}
            />
            <RatioSlider
              hazard="heat"
              min={-10}
              max={14}
              step={0.5}
              value={scenario.heatDeltaC}
              offset
              format={(v) => (v === 0 ? "unchanged" : `${v > 0 ? "+" : ""}${v} °C on top`)}
              absolute={(o, v) => {
                const base = o?.hazards?.find((h) => h.kind === "heat")?.intensity ?? 0;
                return `${round1(Math.max(0, base + v))} °C over 30`;
              }}
              onChange={(heatDeltaC) => setScenario({ heatDeltaC })}
            />
            <RatioSlider
              hazard="wind"
              min={0}
              max={4}
              step={0.1}
              value={scenario.wind}
              format={(v) => `${v === 1 ? "unchanged" : `${v}× the observed gust`}`}
              absolute={(o, v) => `${round1((o?.hazards?.find((h) => h.kind === "wind")?.intensity ?? 0) * v)} km/h`}
              onChange={(wind) => setScenario({ wind })}
            />
            <AdditiveSlider
              hazard="flood"
              min={0}
              max={80}
              step={1}
              unit="cm"
              value={scenario.floodCm}
              note="Not a ratio. Water accumulates, so depth has its own origin."
              absolute={(o, v) => `${round1((o?.hazards?.find((h) => h.kind === "flood")?.intensity ?? 0) + v)} cm standing`}
              onChange={(floodCm) => setScenario({ floodCm })}
            />
            <AdditiveSlider
              hazard="storm"
              min={0}
              max={96}
              step={1}
              unit="h"
              value={scenario.stormHours}
              note="Hours of storm still to come. The forecast's own horizon is five days."
              absolute={(o, v) => `${round1(Math.max(o?.hazards?.find((h) => h.kind === "storm")?.intensity ?? 0, v))} h remaining`}
              onChange={(stormHours) => setScenario({ stormHours })}
            />
          </ul>
        </>
      )}

      {deadControls.length > 0 ? (
        <p className="wt-scenario__note wt-scenario__note--dead">
          <strong>Nothing to scale.</strong> {deadControls.join(", ")}{" "}
          {deadControls.length === 1 ? "is" : "are"} at zero right now, so the{" "}
          {deadControls.length === 1 ? "multiplier does" : "multipliers do"} nothing until there is
          something to multiply. A control that cannot move the answer is disabled in
          spirit; this says so rather than letting the slider imply otherwise.
        </p>
      ) : null}

      {moved ? (
        <p className="wt-scenario__note">
          This is a simulation. Your itinerary has not changed —{" "}
          {graphShape.stops} stop{graphShape.stops === 1 ? "" : "s"} are being scored in a world
          that does not exist.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Sliders
 * -------------------------------------------------------------------------- */

function RatioSlider({
  hazard,
  min,
  max,
  step,
  value,
  format,
  absolute,
  onChange,
  offset = false,
}: {
  hazard: HazardKind;
  min: number;
  max: number;
  step: number;
  value: number;
  offset?: boolean;
  format: (value: number) => string;
  absolute: (observation: CityObservation | undefined, value: number) => string;
  onChange: (value: number) => void;
}) {
  const { observations } = useTwin();
  const reading = observations.find((o) => o.hazards);
  return (
    <li className="wt-slider">
      <label className="wt-slider__label" htmlFor={`wt-${hazard}`}>
        <span>{HAZARD_LABELS[hazard]}</span>
        <span className="wt-slider__now">{format(value)}</span>
      </label>
      <input
        id={`wt-${hazard}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="wt-slider__input"
      />
      <p className="wt-slider__abs">
        {absolute(reading, value)} {offset ? "" : ""}
        {offset ? <span className="wt-slider__offset">added to what is observed</span> : null}
      </p>
    </li>
  );
}

function AdditiveSlider({
  hazard,
  min,
  max,
  step,
  unit,
  value,
  note,
  absolute,
  onChange,
}: {
  hazard: HazardKind;
  min: number;
  max: number;
  step: number;
  unit: string;
  value: number;
  note: string;
  absolute: (observation: CityObservation | undefined, value: number) => string;
  onChange: (value: number) => void;
}) {
  const { observations } = useTwin();
  const reading = observations.find((o) => o.hazards);
  return (
    <li className="wt-slider">
      <label className="wt-slider__label" htmlFor={`wt-${hazard}`}>
        <span>{HAZARD_LABELS[hazard]}</span>
        <span className="wt-slider__now">
          {value === 0 ? "none" : `+${value} ${unit}`}
        </span>
      </label>
      <input
        id={`wt-${hazard}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="wt-slider__input"
      />
      <p className="wt-slider__abs">
        {absolute(reading, value)}
        <span className="wt-slider__offset">{note}</span>
      </p>
    </li>
  );
}

/* -------------------------------------------------------------------------- *
 * The resolved scenario, in units
 * -------------------------------------------------------------------------- */

/**
 * What the scenario resolves to, per city, in real units.
 *
 * This is the bridge the sliders promise: the ratio is the control and the unit
 * is the consequence, and both are on screen at once so neither has to be
 * inferred.
 */
export function ResolvedHazards() {
  const { scenario, observations, result } = useTwin();
  if (!result) return null;

  return (
    <ul className="wt-resolved">
      {observations
        .filter((o) => o.hazards)
        .map((observation) => (
          <li key={observation.city} className="wt-resolved__city">
            <span className="wt-resolved__name">{observation.cityLabel}</span>
            <ul className="wt-resolved__list">
              {resolveIntensities(observation.hazards!, scenario).map((hazard) => (
                <li key={hazard.kind} data-severity={hazard.severity}>
                  <span>{hazard.label}</span>
                  <span>
                    {hazard.intensity} {hazard.unit}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

const round1 = (value: number) => Math.round(value * 10) / 10;

/** "just now" / "12 min ago". Short, and never claims a precision it lacks. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} h ago`;
}
