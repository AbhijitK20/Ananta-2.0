/**
 * The home screen: a map, and the list of places that fit.
 *
 * That is the whole thing. The previous version of this component was 716 lines
 * with thirteen `useState` hooks and rendered seven panels across three columns
 * — situation editor, results, plan, map, reality, learned weights,
 * accessibility — plus an always-mounted chat sidecar and a ledger overlay. All
 * of it was reachable and none of it was the point.
 *
 * What is left is the two things a traveller actually looks at: where the
 * places are, and which ones work. The situation is one line above
 * (`ContextBar`), the plan is a link, and the tuning controls are behind
 * "Change".
 *
 * The state that survived here is only what this screen genuinely owns: which
 * card is selected, whether the map has caught up with it, and how much of the
 * list has been asked for.
 */

"use client";

import { useCallback, useMemo, useState } from "react";

import type {
  DiscoveryContext,
  Experience,
  Fit,
  Plan,
  Rejection,
  ScoreBreakdown,
} from "@/contracts";
import { ResultCard } from "@/components/fit";
import { Button } from "@/components/ui/Button";
import { MapPanel } from "./MapPanel";

/** Roughly two screens. The catalogue is ~4,600 rows, so this is not a taste knob. */
const VISIBLE_STEPS = 24;
const VISIBLE_INCREMENT = 48;

export interface ResultsSurfaceProps {
  context: DiscoveryContext;
  experiences: ReadonlyArray<Experience>;
  fits: Record<string, Fit>;
  scores: Record<string, ScoreBreakdown>;
  rejections: ReadonlyArray<Rejection>;
  plan: Plan;
  /** Link target carrying the current situation, for the "see the plan" link. */
  query: string;
}

export function ResultsSurface({
  context,
  experiences,
  fits,
  scores,
  rejections,
  plan,
  query,
}: ResultsSurfaceProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(VISIBLE_STEPS);

  const experienceById = useMemo(
    () => new Map(experiences.map((item) => [item.id, item])),
    [experiences],
  );
  const plannedIds = useMemo(() => new Set(plan.stops.map((stop) => stop.experienceId)), [plan.stops]);
  const rejectedById = useMemo(
    () => new Map(rejections.map((item) => [item.experienceId, item])),
    [rejections],
  );

  const candidates = useMemo(
    () =>
      experiences
        .filter((item) => !plannedIds.has(item.id) || item.id === selectedId)
        .filter((item) => !rejectedById.has(item.id) || item.id === selectedId),
    [experiences, plannedIds, rejectedById, selectedId],
  );

  /*
    Fit first, score second — not the other way round.

    `score` measures how good a place is for this traveller; it does not measure
    whether the place is reachable in the time available. Sorting on score alone
    put "does not fit" cards at the top, because scores across thousands of rows
    are near-tied (3.566 vs 3.564) and a fit-aware tiebreaker almost never fires.
    That is the exact behaviour the product says it refuses, so the gate's verdict
    is the primary key and score only orders within each group.

    The does-not-fit rows stay, ranked last and still de-emphasised by the card,
    because the near-miss is what tells the traveller what to change.
  */
  const ranked = useMemo(
    () =>
      [...candidates].sort((a, b) => {
        const aFit = fits[a.id]?.verdict === "does_not_fit" ? 1 : 0;
        const bFit = fits[b.id]?.verdict === "does_not_fit" ? 1 : 0;
        if (aFit !== bFit) return aFit - bFit;
        const byScore = (scores[b.id]?.total ?? 0) - (scores[a.id]?.total ?? 0);
        if (byScore !== 0) return byScore;
        return a.name.localeCompare(b.name);
      }),
    [candidates, scores, fits],
  );

  const visible = useMemo(
    () =>
      ranked
        .slice(0, visibleCount)
        .concat(selectedId ? ranked.filter((row) => row.id === selectedId) : []),
    [ranked, visibleCount, selectedId],
  );
  const remaining = Math.max(0, ranked.length - visibleCount);

  /**
   * Select a place and bring it into view on the map.
   *
   * Setting only one of these was the bug behind "I select something and nothing
   * happens on the other side": `selectedId` marks the card, `revealedId` is what
   * the map watches to fly, expand the containing cluster and spiderfy. The
   * highlight set below includes the selection, because it used to be the plan's
   * stops only, so a selected place could never light up its own marker.
   */
  const reveal = useCallback((id: string) => {
    setSelectedId(id);
    setRevealedId(id);
  }, []);

  const mapHighlights = useMemo(
    () => (selectedId ? [...new Set([...plannedIds, selectedId])] : [...plannedIds]),
    [plannedIds, selectedId],
  );

  return (
    <div className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_26rem]">
      {/* The map leads. It is the page; the list is beside it. */}
      <div className="order-1 min-h-[22rem] lg:order-1">
        <MapPanel
          experiences={experiences}
          plan={plan}
          experienceById={experienceById}
          revealedId={revealedId}
          selectedIds={mapHighlights}
          onSelect={reveal}
          className="h-full min-h-[22rem]"
        />
      </div>

      <section aria-label="Places that fit" className="order-2 flex min-h-0 flex-col">
        <header className="flex items-baseline justify-between gap-2 pb-2">
          <h2 className="text-caps text-ink-muted">What fits</h2>
          <p className="text-xs text-ink-muted">
            {Math.min(visibleCount, ranked.length)} of {ranked.length.toLocaleString("en-IN")}
          </p>
        </header>

        <ul className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {visible.map((experience) => {
            const fit = fits[experience.id];
            if (!fit) return null;
            const rejection = rejectedById.get(experience.id);
            const isPlanned = plannedIds.has(experience.id);
            return (
              <li key={experience.id}>
                <ResultCard
                  experience={experience}
                  fit={fit}
                  accessNeeds={context.accessNeeds}
                  blockingReason={rejection?.message}
                  selected={selectedId === experience.id}
                  primaryActionLabel={isPlanned ? "In the plan" : "Add to plan"}
                  onPrimaryAction={isPlanned ? undefined : () => reveal(experience.id)}
                  onReveal={(item) => reveal(item.id)}
                  onSelect={(item) => {
                    reveal(item.id);
                    window.location.href = `/why?${query}&id=${encodeURIComponent(item.id)}`;
                  }}
                />
              </li>
            );
          })}
        </ul>

        {remaining > 0 ? (
          <div className="border-t border-rule pt-3">
            <Button
              variant="secondary"
              fullWidth
              onClick={() => setVisibleCount((n) => n + VISIBLE_INCREMENT)}
            >
              Show {Math.min(VISIBLE_INCREMENT, remaining)} more
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
