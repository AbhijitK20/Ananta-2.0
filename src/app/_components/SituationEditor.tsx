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
 * score: "I need step-free" has to be satisfiable exactly or not at all.
 */

import { Button } from "@/components/ui/Button";
import { SegmentedControl, Slider, Toggle } from "@/components/ui/Controls";
import type { AccessNeed, DiscoveryContext, PartyType } from "@/contracts";

export interface SituationEditorProps {
  context: DiscoveryContext;
  onChange: (patch: Partial<DiscoveryContext>) => void;
  onSubmit?: () => void;
  pending?: boolean;
  submitLabel?: string;
}

export function SituationEditor({
  context,
  onChange,
  onSubmit,
  pending = false,
  submitLabel = "Find what fits",
}: SituationEditorProps) {
  return (
    <div className="space-y-5">
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

export function toggleNeed<T extends string>(
  current: ReadonlyArray<T>,
  need: T,
  on: boolean,
): T[] {
  return on ? [...new Set([...current, need])] : current.filter((item) => item !== need);
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} min`;
  return mins === 0 ? `${hours} h` : `${hours} h ${String(mins).padStart(2, "0")} m`;
}
