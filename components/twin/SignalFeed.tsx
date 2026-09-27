"use client";

/**
 * The social and public signal feed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FAILED SOURCES ARE LISTED ALONGSIDE THE LIVE ONES
 * ---------------------------------------------------------------------------
 *
 * Reddit rate-limits hard from a shared address and will answer 429 for minutes at
 * a time. A feed that simply went quiet would be indistinguishable from "nothing
 * is happening in Mumbai", which is the exact reading a traveller would be most
 * harmed by getting wrong. So every source appears with either its count or its
 * reason for having none, and the panel never says "no signals" when the truth is
 * "no source available".
 *
 * ---------------------------------------------------------------------------
 * WHY POLARITY IS NOT SHOWN AS A SCORE
 * ---------------------------------------------------------------------------
 *
 * `polarityOf` is a word list. It does not handle negation and it will misread a
 * sarcastic post, so a number like "−0.8" next to a headline would be a piece of
 * false precision with a decimal point on it. What is shown instead is the *kind*
 * of signal and, for alerts, the one figure the source actually measured: how many
 * people it says are affected. A red alert over 170,000 people needs no sentiment
 * score to be persuasive.
 */

import { useTwin } from "../../lib/twin/store";
import { SIGNAL_SOURCE_LABELS, type SocialSignal } from "../../lib/twin/types";
import { relativeTime } from "./HazardPanel";

/** Posts shown. Past about eight, a feed stops being read and starts being
 *  scrolled, and the ones that matter are the alerts. */
const MAX_SIGNALS = 8;

export function SignalFeed() {
  const { signals, sourceStatus, calibration, loading, graphShape } = useTwin();

  const ordered = [...signals].sort(byImportance).slice(0, MAX_SIGNALS);

  return (
    <>
      <ul className="wt-sources">
        {sourceStatus.map((source) => (
          <li
            key={source.source}
            className={source.ok ? "is-ok" : "is-down"}
            title={source.note}
          >
            <span className="wt-sources__name">
              {SIGNAL_SOURCE_LABELS[source.source as never] ?? source.source}
            </span>
            <span className="wt-sources__count">
              {/* Three states, not two. A source that answered, a source that
                  answered with nothing near this trip, and a source that did not
                  answer at all are three different facts, and only the first and
                  last are about the feed's health. */}
              {!source.ok
                ? "no answer"
                : source.count > 0
                  ? String(source.count)
                  : "nothing near"}
            </span>
          </li>
        ))}
      </ul>

      {loading && !signals.length ? (
        <p className="wt-note">Reading the public feeds…</p>
      ) : ordered.length ? (
        <ul className="wt-signals">
          {ordered.map((signal) => (
            <SignalRow key={signal.id} signal={signal} />
          ))}
        </ul>
      ) : (
        <p className="wt-note">
          No public signal came back for the {graphShape.cities} cit
          {graphShape.cities === 1 ? "y" : "ies"} on this trip. The model then runs on its prior
          alone and says so on every severity.
        </p>
      )}

      <p className="wt-calib">
        <strong>{calibration.observations}</strong> real record
        {calibration.observations === 1 ? "" : "s"} are correcting a prior weighted{" "}
        <strong>{calibration.priorWeight}</strong> against them, across{" "}
        {calibration.cells} cells. Below that weight the model is mostly judgement, and the
        ± on each stop is the size of the doubt.
      </p>
    </>
  );
}

function SignalRow({ signal }: { signal: SocialSignal }) {
  const isAlert = signal.alertLevel !== null && signal.alertLevel > 0;

  return (
    <li className={`wt-signal ${isAlert ? "is-alert" : ""}`}>
      <span className="wt-signal__source">{SIGNAL_SOURCE_LABELS[signal.source]}</span>
      {isAlert ? (
        <span className={`wt-signal__level wt-signal__level--${signal.alertLevel}`}>
          {signal.alertLevel === 2 ? "Red alert" : "Orange alert"}
        </span>
      ) : null}
      <span className="wt-signal__title">
        {signal.url ? (
          <a href={signal.url} target="_blank" rel="noreferrer noopener">
            {signal.title}
          </a>
        ) : (
          signal.title
        )}
      </span>
      <span className="wt-signal__meta">
        {signal.population ? `${formatPopulation(signal.population)} affected · ` : ""}
        {signal.publishedAt ? relativeTime(signal.publishedAt) : "undated"}
      </span>
    </li>
  );
}

/**
 * Alerts first, then by how many people they say are affected, then by recency.
 *
 * Weighting by population before recency is the choice worth arguing about: a
 * month-old red alert over 200,000 people probably still matters more to a
 * traveller than an hour-old complaint about a café, because the alert describes
 * a condition rather than an experience. It is a judgement, and it is the sort
 * that belongs in one function where it can be argued with.
 */
function byImportance(a: SocialSignal, b: SocialSignal): number {
  const alertA = a.alertLevel ?? 0;
  const alertB = b.alertLevel ?? 0;
  if (alertA !== alertB) return alertB - alertA;
  if (a.population !== b.population) return (b.population ?? 0) - (a.population ?? 0);
  return timeOf(b) - timeOf(a);
}

const timeOf = (signal: SocialSignal) =>
  signal.publishedAt ? Date.parse(signal.publishedAt) || 0 : 0;

function formatPopulation(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M people`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k people`;
  return `${value} people`;
}
