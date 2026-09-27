"use client";

/**
 * The traveller's situation: time, money, who they are, what they need, weather.
 *
 * Extracted from DiscoverySurface so it can live on its own route. It was the
 * left-hand column of a three-column home page that also held the results, the
 * plan, a map and four more panels, and having all of that on one screen meant
 * none of it read as the main thing. Now the home page states the situation in
 * one line and this is what "Change" opens.
 *
 * Every control here maps to exactly one field of the frozen `DiscoveryContext`
 * and nothing is derived or hidden. Access needs are discrete booleans, never a
 * score: "I need step-free" has to be satisfiable exactly or not all.
 *
 * `"use client"` was missing. This component has always used `useState`, and it is
 * imported by `ContextBar`, which is rendered by the server component at
 * `src/app/page.tsx` — so `next build` failed with "You're importing a component
 * that needs `useState`. This React Hook only works in a Client Component." The
 * dev server tolerates it; the production compiler does not.
 */

import { useState } from "react";

import { cn } from "@/components/cn";
import { Button } from "@/components/ui/Button";
import { SegmentedControl, Slider, Toggle } from "@/components/ui/Controls";
import { formatMinutes, toggleNeed } from "./situation";
import type { AccessNeed, DiscoveryContext, PartyType } from "@/contracts";
import type { PlaceOption } from "../_lib/place";

/**
 * `formatMinutes` and `toggleNeed` live in `./situation`, not in this file.
 *
 * This component is a Client Component because it uses `useState`, and
 * `ContextBar` is a *server* component that calls `formatMinutes`. Keeping the
 * helper here made that call "Attempted to call formatMinutes() from the server
 * but formatMinutes is on the client", and the home page 500'd.
 *
 * Re-exported so this component's own importers keep a single import path.
 */
export { formatMinutes, toggleNeed } from "./situation";

/**
 * The free-text vocabularies, offered as chips.
 *
 * `interests` and `avoid` are open strings in the contract on purpose — "quiet
 * courtyard", "no queue" — so this is a suggestion list, not an enum. A
 * traveller can still type their own; the chips exist because a bare text box
 * for a field the engine tokenises is a field nobody fills in.
 */
const INTEREST_CHIPS = ["local food", "craft", "history", "live music", "markets", "waterfront"];
const AVOID_CHIPS = ["crowds", "long queues", "steep stairs", "loud noise"];

export interface SituationEditorProps {
  context: DiscoveryContext;
  onChange: (patch: Partial<DiscoveryContext>) => void;
  /** Resolvable places, for the origin box. */
  places?: ReadonlyArray<PlaceOption>;
  onSubmit?: () => void;
  pending?: boolean;
  submitLabel?: string;
}

export function SituationEditor({
  context,
  onChange,
  places = [],
  onSubmit,
  pending = false,
  submitLabel = "Find what fits",
}: SituationEditorProps) {
  const [placeDraft, setPlaceDraft] = useState(context.origin.label);

  // The typed value and the applied value are allowed to disagree: the traveller
  // may be part-way through typing a place that does not exist, and rewriting
  // the box on every keystroke would make it impossible to type one.
  const commitPlace = () => {
    const label = placeDraft.trim();
    if (!label || label === context.origin.label) return;
    onChange({ origin: { label, point: null } });
  };

  return (
    <div className="space-y-5">
      {/*
        F1, "I am at ...". The datalist rather than a <select>: there are ~4,600
        resolvable places and 26 neighbourhoods, and a select with 4,600 options
        is a list nobody scrolls. `commitOnBlur` is a native input attribute, not
        a re-implemented key handler.
      */}
      <div>
        <label htmlFor="origin" className="text-meta block text-ink-muted">
          Where are you
        </label>
        <input
          id="origin"
          list="place-options"
          value={placeDraft}
          onChange={(event) => setPlaceDraft(event.target.value)}
          onBlur={commitPlace}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitPlace();
            }
          }}
          placeholder="Colaba, or a hotel or landmark"
          autoComplete="off"
          aria-describedby="origin-note"
          className="border-rule bg-canvas text-ink mt-1.5 w-full rounded-md border px-3 py-2 text-body outline-none focus-visible:border-accent"
        />
        <datalist id="place-options">
          {places.map((place) => (
            <option key={place.label} value={place.label} />
          ))}
        </datalist>
        <p id="origin-note" className="text-meta-sm mt-1 text-ink-muted">
          {context.origin.point
            ? `Distances are measured from ${context.origin.label}.`
            : "Distances are not being measured, because that place is not one we know."}
        </p>
      </div>

      <Slider
        label="How long have you got"
        value={context.availableMin}
        min={30}
        max={720}
        step={15}
        format={formatMinutes}
        minLabel="30 min"
        maxLabel="12 h"
        onChange={(availableMin) => onChange({ availableMin })}
      />

      <Slider
        label="Budget for the whole plan"
        value={context.budget ? Math.round(context.budget.minor / 100) : 5000}
        min={0}
        max={5000}
        step={50}
        format={(value) => (value >= 5000 ? "No limit" : `₹${value.toLocaleString("en-IN")}`)}
        minLabel="₹0"
        maxLabel="No limit"
        onChange={(rupees) =>
          onChange({ budget: rupees >= 5000 ? null : { minor: rupees * 100, currency: "INR" } })
        }
      />

      <div>
        <span className="text-meta text-ink-muted">How many of you</span>
        <Stepper
          value={context.partySize}
          onChange={(partySize) => onChange({ partySize })}
          label="People"
        />
      </div>

      <div>
        <span className="text-meta text-ink-muted">Who you are</span>
        <div className="mt-1.5">
          <SegmentedControl<PartyType>
            label="Party type"
            value={context.partyType}
            onChange={(partyType) => onChange({ partyType })}
            options={[
              { value: "solo", label: "Solo" },
              { value: "couple", label: "Two" },
              { value: "family_with_children", label: "Family" },
              { value: "friends", label: "Friends" },
            ]}
          />
        </div>
      </div>

      {context.partyType === "family_with_children" ? (
        <div>
          <span className="text-meta text-ink-muted">Ages</span>
          <Stepper
            value={context.childAges.length}
            onChange={(count) =>
              onChange({
                childAges: Array.from({ length: count }, (_, i) => context.childAges[i] ?? 5),
              })
            }
            label="Children"
          />
        </div>
      ) : null}

      <fieldset>
        <legend className="text-meta text-ink-muted">Anything you need</legend>
        <div className="mt-2 space-y-2.5">
          {(
            [
              ["wheelchair", "Step-free"],
              ["lowStairs", "Few stairs"],
              ["restroom", "Restroom on site"],
              ["stroller", "Stroller friendly"],
            ] as const satisfies ReadonlyArray<readonly [AccessNeed, string]>
          ).map(([need, label]) => (
            <Toggle
              key={need}
              label={label}
              checked={context.accessNeeds.includes(need)}
              onChange={(on) => onChange({ accessNeeds: toggleNeed(context.accessNeeds, need, on) })}
            />
          ))}
        </div>
      </fieldset>

      {/*
        F6, interests and things to avoid. Chips rather than a text box, because
        both feed a tokeniser and an empty text box for a field the engine reads
        is a field nobody fills in. Free text still works: the datalist pattern
        above is the same idea for a vocabulary that is not ours to enumerate.
      */}
      <fieldset>
        <legend className="text-meta text-ink-muted">What you are after</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {INTEREST_CHIPS.map((chip) => (
            <Chip
              key={chip}
              label={chip}
              on={context.interests.includes(chip)}
              onToggle={(on) => onChange({ interests: toggleNeed(context.interests, chip, on) })}
            />
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-meta text-ink-muted">What to keep away from</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {AVOID_CHIPS.map((chip) => (
            <Chip
              key={chip}
              label={chip}
              on={context.avoid.includes(chip)}
              onToggle={(on) => onChange({ avoid: toggleNeed(context.avoid, chip, on) })}
            />
          ))}
        </div>
      </fieldset>

      <div>
        <span className="text-meta text-ink-muted">Weather</span>
        <div className="mt-1.5">
          <SegmentedControl
            label="Weather"
            value={context.weather.condition}
            onChange={(condition) => onChange({ weather: { ...context.weather, condition } })}
            options={[
              { value: "clear", label: "Clear" },
              { value: "cloudy", label: "Cloud" },
              { value: "light_rain", label: "Light rain" },
              { value: "heavy_rain", label: "Heavy rain" },
            ]}
          />
        </div>
      </div>

      {onSubmit ? (
        <Button variant="primary" fullWidth onClick={onSubmit} loading={pending}>
          {submitLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** One selectable word. A real button, so it is in the tab order for free. */
function Chip({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onToggle(!on)}
      className={cn(
        "min-h-9 rounded-pill border px-3 text-meta",
        "transition-[background-color,border-color,color] duration-[var(--dur-fast)]",
        "ease-[var(--ease-out-soft)]",
        on
          ? "border-accent bg-accent-soft text-accent"
          : "border-rule bg-surface text-ink-muted hover:border-accent hover:text-ink",
      )}
    >
      {label}
    </button>
  );
}

function Stepper({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label: string;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <Button
        size="sm"
        onClick={() => onChange(Math.max(1, value - 1))}
        disabled={value <= 1}
        aria-label={`One fewer ${label.toLowerCase()}`}
      >
        −
      </Button>
      <output aria-live="polite" className="min-w-8 text-center text-num text-ink">
        {value}
      </output>
      <Button
        size="sm"
        onClick={() => onChange(value + 1)}
        disabled={value >= 12}
        aria-label={`One more ${label.toLowerCase()}`}
      >
        +
      </Button>
    </div>
  );
}
