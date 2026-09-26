"use client";

import { Clock, MapPin, Wallet, Star, Sparkles } from "lucide-react";

import type { Experience, Fit } from "@/contracts";

import { cn } from "../cn";
import { Badge, FactPill } from "../ui/Badge";
import { Button } from "../ui/Button";
import { categoryLabel, metresToDistance, minorToRupees, ratingToDisplay } from "./format";
import { FitMeter } from "./FitMeter";

/**
 * ResultCard — the order is the spec, and the order is the design.
 *
 * DESIGN_SYSTEM §3 fixes eight positions and they are load-bearing:
 *   1. Fit meter        the verdict, above everything
 *   2. Name + category  caps, mono metadata cluster
 *   3. Duration/price/distance   --font-data, tabular-nums
 *   4. Rating 4.6 (312) Bayesian-smoothed, raw count shown
 *   5. Blurb            two lines max
 *   6. Provenance badges  `inferred` gets a warn "AI-inferred" pill
 *   7. Accessibility   yes/no pills, glyph AND word
 *   8. Primary action
 *
 * The verdict is first because the product's entire claim is "this actually
 * fits", and a user who reads the name before the fit has not been given the
 * information they came for.
 *
 * A card that does NOT fit is rendered but DE-EMPHASISED, with the blocking
 * reason inline. Hiding it would waste the hardest-won information we have —
 * the near-miss is what tells the traveller what to change.
 */
export interface ResultCardProps {
  experience: Experience;
  fit: Fit;
  /** The blocking reason, when `fit.verdict` is `does_not_fit`. */
  blockingReason?: string;
  /** Straight-line or routed distance from the traveller. */
  distanceMetres?: number;
  onPrimaryAction?: (experience: Experience) => void;
  primaryActionLabel?: string;
  /** Card click. Drives the map coupling — see CardMapCoupling. */
  onSelect?: (experience: Experience) => void;
  /**
   * Select this place and bring it into view on the map.
   *
   * Separate from `onSelect` on purpose. `onSelect` is the "Why this, and why
   * not the others" ledger, and it is a button in the card's action row. This is
   * the card itself: clicking anywhere on the body, or the explicit "Show on
   * map" button, selects the place and reveals it. They were the same action
   * once, which meant selecting a place could not open the map, and the only way
   * to reveal anything was to also add it to the plan.
   */
  onReveal?: (experience: Experience) => void;
  /** Highlights the card because the map selection moved. */
  selected?: boolean;
  className?: string;
}

/** The accessibility fields worth a pill, in decision order. */
const ACCESS_ROWS = [
  { key: "stepFree", label: "Step-free", need: "wheelchair" },
  { key: "strollerOk", label: "Stroller ok", need: "stroller" },
  { key: "lowStairs", label: "Low stairs", need: "lowStairs" },
  { key: "hearingLoop", label: "Hearing loop", need: "hearingLoop" },
  { key: "restroomOnSite", label: "Restroom", need: "restroom" },
] as const;

export function ResultCard({
  experience,
  fit,
  blockingReason,
  distanceMetres,
  onPrimaryAction,
  primaryActionLabel = "Add to plan",
  onSelect,
  onReveal,
  selected = false,
  className,
}: ResultCardProps) {
  const doesNotFit = fit.verdict === "does_not_fit";
  const inferredFields = Object.entries(experience.provenance)
    .filter(([, provenance]) => provenance === "inferred")
    .map(([field]) => field);

  return (
    <article
      /*
        The whole card reveals on the map. The click lives on the <article>
        rather than on a wrapper <button> on purpose: a button wrapping these
        action-row buttons would nest interactive controls, which is invalid and
        breaks assistive tech. Keyboard and screen-reader users get the same
        action from the explicit "Show on map" button in the row below, so the
        convenience click on the container is never the only way to do it.
      */
      onClick={onReveal ? () => onReveal(experience) : undefined}
      className={cn(
        "rounded-md border bg-surface p-4",
        "transition-[border-color,box-shadow,opacity] duration-[var(--dur-fast)]",
        "ease-[var(--ease-out-soft)]",
        // Position 1's consequence: a card that does not fit stays legible
        // enough to act on, but recedes.
        doesNotFit ? "border-rule opacity-70" : "border-rule",
        selected && "border-accent shadow-raise-1",
        // A revealable card is a pointer target and has to say so. Selected or
        // not, though: the accent border already carries that state.
        onReveal && "cursor-pointer hover:border-accent/60",
        className,
      )}
      aria-label={experience.name}
      aria-current={selected ? "true" : undefined}
    >
      {/* 1. Fit meter — the verdict, above everything. */}
      <FitMeter fit={fit} compact={doesNotFit} />

      {/* The blocking reason, inline. Never hidden. */}
      {blockingReason ? (
        <p className="mt-2 rounded-sm bg-alarm-soft px-2 py-1 text-meta text-alarm">
          {blockingReason}
        </p>
      ) : null}

      {/* 2. Name + category in text-meta caps. */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-title text-ink">{experience.name}</h3>
        <span className="text-caps text-ink-muted">{categoryLabel(experience.category)}</span>
        {experience.neighbourhood ? (
          <span className="inline-flex items-center gap-1 text-meta-sm text-ink-muted">
            <MapPin aria-hidden className="size-3" strokeWidth={2} />
            {experience.neighbourhood}
          </span>
        ) : null}
      </div>

      {/* 3. Duration, price, distance. Mono, tabular. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-num-sm text-ink-muted">
        <span className="inline-flex items-center gap-1">
          <Clock aria-hidden className="size-3.5" strokeWidth={2} />
          {experience.durationMin} min
        </span>
        <span className="inline-flex items-center gap-1">
          <Wallet aria-hidden className="size-3.5" strokeWidth={2} />
          {experience.pricePerPerson ? minorToRupees(experience.pricePerPerson.minor) : "Free"}
          {experience.pricePerPerson ? (
            <span className="text-ink-muted">/person</span>
          ) : null}
        </span>
        {distanceMetres !== undefined ? (
          <span className="text-ink-muted">{metresToDistance(distanceMetres)} away</span>
        ) : null}
      </div>

      {/*
        4. Rating, Bayesian-smoothed, raw count shown.

        A count of zero renders as an explicit absence, never as a number. The
        catalogue's rating is a Bayesian prior — a regional average used to keep
        the ranking maths well-defined when no one has rated anything — and
        showing that prior as "3.8 (0)" puts an identical fabricated score on a
        bakery, a mosque and a co-working space, which reads as a real 3.8 from
        zero people. It was the first thing anyone saw on the page.

        So `ratingToDisplay` is not called at zero. The row still occupies its
        place, because a card that silently drops a line reflows the list, and it
        still says which fields are missing — see the inferred-fields note below.
      */}
      <div className="mt-1.5 flex items-center gap-1 text-num-sm">
        {experience.rating.count > 0 ? (
          <>
            <Star aria-hidden className="size-3.5 text-warn" strokeWidth={2} />
            <span className="font-medium text-ink">
              {ratingToDisplay(experience.rating.value, experience.rating.count)}
            </span>
            {experience.rating.count < 10 ? (
              <span className="text-warn">few reviews</span>
            ) : null}
          </>
        ) : (
          <span className="text-ink-muted">Not yet rated</span>
        )}
      </div>

      {/* 5. Blurb, two lines max. */}
      {experience.blurb ? (
        <p className="mt-2 line-clamp-2 text-body text-ink-muted">{experience.blurb}</p>
      ) : null}

      {/* 6. Provenance badges. `inferred` is always visible. */}
      {inferredFields.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Badge tone="warn" icon={<Sparkles aria-hidden className="size-3" strokeWidth={2} />}>
            AI-inferred
          </Badge>
          <span className="self-center text-meta-sm text-ink-muted">
            {inferredFields.length === 1
              ? `${inferredFields[0]} was inferred`
              : `${inferredFields.length} fields inferred`}
          </span>
        </div>
      ) : null}

      {/* 7. Accessibility. Yes/no/unknown with a glyph AND a word. */}
      <div className="mt-2.5">
        <AccessRow experience={experience} />
      </div>

      {/* 8. Primary action. */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {/*
          The keyboard-reachable route to the same place the card body click
          goes. It stops propagation because the card body is itself clickable,
          and without this the button's own activation would fire the handler
          twice — which is harmless here only by accident, and would not be
          harmless if revealing ever became expensive.
        */}
        {onReveal ? (
          <Button
            variant="ghost"
            className="px-2"
            onClick={(event) => {
              event.stopPropagation();
              onReveal(experience);
            }}
          >
            Show on map
          </Button>
        ) : null}
        <Button
          variant={doesNotFit ? "secondary" : "primary"}
          onClick={() => onPrimaryAction?.(experience)}
          disabled={!onPrimaryAction}
        >
          {primaryActionLabel}
        </Button>
        {/*
          A plain button, NOT a disclosure.

          This was previously a ControlledDisclosure with `open={false}`
          hardcoded, which is a real bug and not a style preference: the control
          rendered `aria-expanded="false"` and an `aria-controls` pointing at a
          panel, and clicking it could never change that state — the boolean
          `onOpenChange` received was discarded. A screen reader announced
          "collapsed" and activating it produced no expansion, and the panel's
          only content ("Open the full ledger…") was permanently inert and never
          visible. A control that claims to be expandable and is not is worse
          than no control, because it teaches the user that aria-expanded is
          noise.

          What it actually does is open the ledger in a sheet, owned by the
          parent, so it is a button that says so.
        */}
        {onSelect ? (
          <Button variant="ghost" onClick={() => onSelect(experience)} className="px-2">
            Why this, and why not the others
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * The accessibility pills, in one row that wraps.
 *
 * Every pill is `FactPill`, so each carries a glyph AND a word: the negatives
 * are the decision-grade information, and colour alone hides them from a
 * colourblind reader. `unknown` renders as "?" and is not styled as a failure,
 * because the contract models these as nullable precisely because OSM's
 * `wheelchair` tag is 3-state — a provider who has not been surveyed has not
 * said no.
 */
function AccessRow({ experience }: { experience: Experience }) {
  const rows = ACCESS_ROWS.map((row) => ({
    ...row,
    value: experience.accessibility[row.key],
  }));
  const known = rows.filter((row) => row.value !== null);
  const unknown = rows.filter((row) => row.value === null);
  const all = [...known, ...unknown];

  return (
    <ul className="flex flex-wrap gap-1.5">
      {all.map((row) => (
        <li key={row.key}>
          <FactPill value={row.value}>
            {row.value === null ? `${row.label} unknown` : row.value ? row.label : `Not ${row.label.toLowerCase()}`}
          </FactPill>
        </li>
      ))}
    </ul>
  );
}
