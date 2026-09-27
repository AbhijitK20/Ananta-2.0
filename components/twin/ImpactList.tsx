"use client";

/**
 * What the weather does to the traveller's own stops, ranked.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY NUMBER IS SHOWN AS A RANGE
 * ---------------------------------------------------------------------------
 *
 * A point estimate on a cascade is a lie of a specific kind: it hides the fact
 * that the number is a compounding of a stated prior and a handful of reports.
 * So each row prints the central estimate *and* the width it could plausibly be
 * wrong by, and the width is visibly wider for a stop the effect reached through
 * a flooded road than for one sitting under its own sky.
 *
 * The width is a confidence-derived interval rather than a fitted distribution,
 * and it is labelled as such in the panel's provenance line. Calling it a
 * confidence interval would be a statistical claim this model has not earned.
 */

import { useState } from "react";

import { useTwin } from "../../lib/twin/store";
import { CHANNEL_KINDS, CHANNEL_LABELS, type ChannelKind, type NodeImpact } from "../../lib/twin/types";

/** Rows shown before the list is capped. A traveller has a dozen stops, not a
 *  hundred, and a list of everything is a list nobody reads. */
const MAX_ROWS = 12;

export function ImpactList() {
  const { result, live } = useTwin();

  if (!result || !result.nodes.length) {
    return (
      <p className="wt-note">
        Add stops and the twin will score each one against the weather where it sits.
      </p>
    );
  }

  const nodes = result.nodes.slice(0, MAX_ROWS);

  return (
    <>
      <ul className="wt-impacts">
        {nodes.map((node) => (
          <ImpactRow
            key={node.node.id}
            node={node}
            baseline={result.live ? null : live?.nodes.find((n) => n.node.id === node.node.id) ?? null}
          />
        ))}
      </ul>
      {result.nodes.length > MAX_ROWS ? (
        <p className="wt-note">
          Showing the {MAX_ROWS} most affected of {result.nodes.length} stops.
        </p>
      ) : null}
    </>
  );
}

function ImpactRow({ node, baseline }: { node: NodeImpact; baseline: NodeImpact | null }) {
  const [open, setOpen] = useState(false);

  const availability = node.channels.availability.multiplier;
  const delta = baseline ? round2(availability - baseline.channels.availability.multiplier) : null;

  return (
    <li className="wt-impact" data-severity={node.severity}>
      <button
        type="button"
        className="wt-impact__head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="wt-impact__name">{node.node.name}</span>
        <span className="wt-impact__where">
          {node.node.city || "pinned"} · {node.node.day >= 0 ? `day ${node.node.day + 1}` : "not routed"}
        </span>
        <span className="wt-impact__figure">
          <span className="wt-impact__value">
            {availability >= 0.999 ? "open" : `${Math.round(availability * 100)}%`}
          </span>
          {delta !== null && Math.abs(delta) >= 0.01 ? (
            <span className={`wt-impact__delta ${delta < 0 ? "is-worse" : "is-better"}`}>
              {delta > 0 ? "+" : ""}
              {Math.round(delta * 100)}
            </span>
          ) : null}
        </span>
      </button>

      <p className="wt-impact__range">
        {formatRange(availability, node.spread)}
        {node.driver ? <span className="wt-impact__driver"> · driven by {node.driver}</span> : null}
        {node.signals.length > 0 ? (
          <span className="wt-impact__evidence">
            {" "}
            · {node.signals.length} real signal{node.signals.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </p>

      {open ? (
        <div className="wt-impact__detail">
          <p className="wt-impact__reason">{node.node.classReason}</p>

          <table className="wt-channels">
            <tbody>
              {CHANNEL_KINDS.map((kind) => (
                <ChannelRow key={kind} kind={kind} node={node} />
              ))}
            </tbody>
          </table>

          {node.chain.length > 1 ? (
            <p className="wt-chain">
              <strong>How it got here:</strong>{" "}
              {node.chain
                .map((step) =>
                  step.via === "observed"
                    ? step.nodeName
                    : `${step.nodeName} (${step.via}, −${Math.round((1 - step.damp) * 100)}% of the effect)`,
                )
                .join(" → ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A row is hidden when the channel is untouched, so the table shows only what
 *  actually moved. A table of six "unchanged" rows teaches nothing. */
function ChannelRow({ kind, node }: { kind: ChannelKind; node: NodeImpact }) {
  const state = node.channels[kind];
  if (state.multiplier === 1 && state.confidence >= 0.99) return null;

  return (
    <tr className={state.multiplier >= 1 ? "is-good" : "is-bad"}>
      <th scope="row">{CHANNEL_LABELS[kind]}</th>
      <td>
        {formatMultiplier(kind, state.multiplier)}
        <span className="wt-channels__conf"> · {(state.confidence * 100).toFixed(0)}% confident</span>
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- *
 * Formatting
 * -------------------------------------------------------------------------- */

/**
 * A multiplier, phrased for the channel.
 *
 * `movement` above 1 is worse and `demand` above 1 is better, so a raw "0.8"
 * cannot be worded or coloured without knowing which channel it is. The type
 * records that asymmetry and this is where it becomes words.
 */
function formatMultiplier(kind: ChannelKind, multiplier: number): string {
  if (multiplier === 1) return "unchanged";

  switch (kind) {
    case "movement":
    case "duration": {
      const extra = multiplier - 1;
      return extra > 0
        ? `${Math.round(extra * 100)}% longer`
        : `${Math.round(-extra * 100)}% shorter`;
    }
    case "demand": {
      const delta = multiplier - 1;
      return delta > 0
        ? `${Math.round(delta * 100)}% busier`
        : `${Math.round(-delta * 100)}% quieter`;
    }
    default:
      return `${Math.round(multiplier * 100)}% of normal`;
  }
}

/** "62% (±8)". The ± is the confidence-derived width, not a measured error. */
function formatRange(multiplier: number, spread: number): string {
  if (multiplier >= 0.999) return "open as normal";
  return `${Math.round(multiplier * 100)}% (±${Math.round(spread * 100)})`;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
