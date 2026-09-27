/**
 * SwapDiff — what changed, why, and what it cost.
 *
 * This is the second half of the product's signature, and the half nobody else
 * has. A traveller who cannot see what was removed, what replaced it and why
 * cannot tell a repair from a replacement, so every number here comes from the
 * engine: the reasons are `Rejection.message` and `PlanStop.why` verbatim, and
 * the deltas are the engine's own score arithmetic.
 *
 * Nothing in this file computes anything. It renders `RealityChanged`, which
 * `buildRealityChanged` assembled from two engine plans and one engine diff.
 *
 * Three things are deliberately loud:
 *
 *  - the swap count against the ceiling of two, and over the ceiling it says so
 *    rather than showing a tidy number;
 *  - `preservedIntent` as a visible fact, because a guarantee the traveller
 *    cannot see is a claim rather than a guarantee;
 *  - the relaxation ladder, with the `gaveUp` sentence, when the packer had to
 *    climb one. Empty means nothing was given up, and it says that too.
 */

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SWAP_BUDGET, hm, money, plural } from "@/features/discovery";
import type { StopDiff } from "@/features/discovery/diff";
import type { RealityChanged } from "@/features/discovery/reality";

export interface SwapDiffProps {
  reality: RealityChanged;
  className?: string;
}

export function SwapDiff({ reality, className }: SwapDiffProps) {
  const { change, removed, added, swapCount, warnings } = reality;
  const overCeiling = swapCount > SWAP_BUDGET;

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-caps text-ink-muted">What changed</h2>
        <Badge tone={swapCount === 0 ? "neutral" : overCeiling ? "alarm" : "info"}>
          {swapCount === 0
            ? "Nothing swapped"
            : `${plural(swapCount, "swap", "swaps")}, ceiling ${SWAP_BUDGET}`}
        </Badge>
      </div>

      <p className="mt-2 text-body text-ink">{change.narrative}</p>

      {/*
        The before/after pair. Utilisation and cost are the two numbers a
        traveller actually feels, and showing them side by side is what makes
        "this got worse" checkable rather than asserted.
      */}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-meta">
        <Measure label="Stops" before={String(reality.before.stops)} after={String(reality.after.stops)} />
        <Measure
          label="Time in the plan"
          before={hm(reality.before.totalMin)}
          after={hm(reality.after.totalMin)}
        />
        <Measure
          label="Cost"
          before={money(reality.before.cost)}
          after={money(reality.after.cost)}
        />
        <Measure
          label="Window used"
          before={pct(reality.before.utilisation)}
          after={pct(reality.after.utilisation)}
        />
      </dl>

      {removed.length > 0 || added.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {removed.map((row) => (
            <Row key={`r-${row.id}`} row={row} />
          ))}
          {added.map((row) => (
            <Row key={`a-${row.id}`} row={row} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-meta text-ink-muted">
          Every stop you had still fits, so nothing was taken out and nothing put in.
        </p>
      )}

      {/*
        The relaxation ladder. `Plan.relaxations` is only non-empty when the
        packer had to climb a rung, so the empty case is a real statement — the
        plan is strict, nothing was traded away — rather than a missing section.
      */}
      {reality.relaxations.length > 0 ? (
        <section className="mt-4 border-t border-rule pt-3">
          <h3 className="text-caps text-ink-muted">What the plan gave up</h3>
          <ul className="mt-2 space-y-1.5">
            {reality.relaxations.map((step) => (
              <li key={step.rung} className="text-meta text-ink-muted">
                <span className="text-ink">{step.label}.</span> {step.gaveUp}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="mt-4 border-t border-rule pt-3 text-meta text-ink-muted">
          Nothing was relaxed. Every stop here passes your constraints on its own terms.
        </p>
      )}

      {/*
        Principle 3, made visible. `intent` is rebuilt from the situation the
        traveller started with, so this list cannot drift with the plan the way a
        restatement of the current context would.
      */}
      <section className="mt-4 border-t border-rule pt-3">
        <h3 className="text-caps text-ink-muted">
          {reality.intentPreserved
            ? "Still looking for what you asked for at the start"
            : "Check this, the original ask moved"}
        </h3>
        <ul className="mt-1.5 space-y-0.5 text-meta text-ink-muted">
          {reality.intent.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {warnings.length > 0 ? (
        <ul className="mt-3 space-y-1 text-meta text-alarm">
          {warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Row({ row }: { row: StopDiff }) {
  const dropped = row.status === "removed";
  return (
    <li className="rounded-md border border-rule bg-canvas p-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block truncate text-body text-ink">{row.name}</span>
          <span className="block text-meta-sm text-ink-muted">
            {dropped ? "Left the plan" : "Took its place"}
            {row.indoorOutdoor ? ` · ${row.indoorOutdoor}` : ""}
          </span>
        </span>
        {row.scoreDelta !== 0 ? (
          <Badge tone={row.scoreDelta > 0 ? "fit" : "warn"}>
            {row.scoreDelta > 0 ? "+" : "−"}
            {Math.abs(row.scoreDelta).toFixed(2)} score
          </Badge>
        ) : null}
      </div>
      <p className="mt-1.5 text-meta-sm text-ink-muted">{row.reason}</p>
      {row.travelSavedMin !== null && row.travelSavedMin > 0 ? (
        <p className="mt-1 text-meta-sm text-ink-muted">
          Saves about {hm(row.travelSavedMin)} of travel.
        </p>
      ) : null}
    </li>
  );
}

function Measure({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-data text-ink">
        {before} <span aria-hidden>→</span>{" "}
        <span className="text-ink-muted">{after}</span>
      </dd>
    </div>
  );
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
