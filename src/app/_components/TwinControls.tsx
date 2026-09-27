"use client";

/**
 * The what-if control panel: five sliders, and a real re-solve behind each one.
 *
 * The brief's fourth mandatory requirement is an interactive scenario where changing
 * a weather parameter produces a corresponding change in the existing system. This
 * is the control surface for it, and the one design decision that matters is that
 * **the sliders navigate**. Every settled change rewrites the URL and the server
 * re-solves, which means:
 *
 *   - the simulation state lives in the address bar, so a what-if is shareable and
 *     survives a refresh, exactly like every other view in this app
 *   - the browser's back button steps through the scenarios, which is the cheapest
 *     possible "undo" and the fastest possible demo
 *   - the thing being demonstrated is *the real planner re-solving*, not a
 *     client-side animation of one
 *
 * The cost is a server render per change, so a drag is debounced and the thumb
 * follows local state while the drag is in flight. The debounce is hand-rolled
 * rather than `useDeferredValue` because this needs to delay a *navigation*, not a
 * re-render, and those are different problems — a deferred value still commits on
 * every change, which is exactly the twelve plan solves a drag would otherwise fire.
 *
 * The shared `Slider` primitive is used as-is: `onChange`, `format`, `minLabel` and
 * `maxLabel` are its whole API, and it is owned by another stream. Rather than widen
 * it with an `onCommit` prop for one caller, the debounce lives here, which is also
 * the only place that knows a scenario change costs a plan solve.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Controls";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/cn";

/**
 * Imported from the module, not the `@/features/twin` barrel.
 *
 * This is a client component, and the barrel re-exports `observe.ts` (which
 * reads the alignment record with `node:fs/promises`) and `apply.ts` (which
 * reaches `src/engine/geo.ts` and its `node:fs`). Importing two pure symbols
 * through the barrel therefore pulled the whole server-only twin graph into the
 * browser bundle and `next build` failed with:
 *
 *   Reading from "node:fs" is not handled by plugins (Unhandled scheme).
 *
 * `scenario.ts` has no Node imports, so importing it directly gives the same two
 * symbols and keeps `fs` on the server where it belongs. The other three
 * importers of the barrel (`src/app/_lib/twin.ts`, `src/app/twin/page.tsx` and
 * `src/app/api/twin/route.ts`) are server-side and are correct as they are.
 */
import { SCENARIO_BOUNDS, type WeatherScenario } from "@/features/twin/scenario";

/** Long enough that a drag is one navigation, short enough to feel immediate. */
const COMMIT_MS = 260;

/** The URL key each scenario field travels under. Not the field name, on purpose. */
const PARAM_KEYS = {
  rainMmH: "rain",
  windKmh: "wind",
  tempC: "temp",
  floodCm: "flood",
  durationH: "hours",
  hour: "hour",
  date: "date",
} as const;

/**
 * The five numeric knobs.
 *
 * `date` is in `PARAM_KEYS` because a preset that sets the hour has to preserve the
 * date, and `hour` is in it because the heat preset is meaningless at 03:00. Neither
 * is a slider, so neither is in `KNOB_KEYS` — and keeping the two lists separate is
 * what stops a `number` from being widened to `string | number` by the `date`.
 */
type KnobKey = "rainMmH" | "windKmh" | "tempC" | "floodCm" | "durationH";

export interface TwinControlsProps {
  scenario: WeatherScenario;
  /** The traveller's own scenario params, so weather changes do not drop them. */
  baseParams: URLSearchParams;
  /** What the current simulation did, so the control can show the consequence. */
  headline: string;
  closedCount: number;
  stretchedCount: number;
  className?: string;
}

type Knob = {
  key: KnobKey;
  label: string;
  bound: { min: number; max: number; step: number };
  format: (value: number) => string;
  /** What the traveller should understand this knob does. */
  hint: string;
};

const KNOBS: readonly Knob[] = [
  {
    key: "rainMmH",
    label: "Rainfall (mm/h)",
    bound: SCENARIO_BOUNDS.rainMmH,
    format: (value) => `${value} mm/h`,
    hint: "Rate, not total. 40 is a cloudburst; 5 is a drizzle that changes nothing.",
  },
  {
    key: "durationH",
    label: "Duration (hours)",
    bound: SCENARIO_BOUNDS.durationH,
    format: (value) => `${value} h`,
    hint: "What turns rain into a flood. 2 mm/h for 72 h drowns what 120 mm/h for 20 min only wets.",
  },
  {
    key: "floodCm",
    label: "Standing water (cm)",
    bound: SCENARIO_BOUNDS.floodCm,
    format: (value) => `${value} cm`,
    hint: "Closes roads before it closes venues. This is the knob that moves the map.",
  },
  {
    key: "tempC",
    label: "Temperature (°C)",
    bound: SCENARIO_BOUNDS.tempC,
    format: (value) => `${value}°C`,
    hint: "Apparent temperature. Only bites with the sun up, so the hour matters too.",
  },
  {
    key: "windKmh",
    label: "Wind gusts (km/h)",
    bound: SCENARIO_BOUNDS.windKmh,
    format: (value) => `${value} km/h`,
    hint: "Gusts. Kites, sails and open-air umbrellas are the only things it closes.",
  },
] as const;

/** Presets, so a demo does not depend on someone finding a slider position. */
const PRESETS: readonly {
  id: string;
  label: string;
  patch: Partial<WeatherScenario>;
}[] = [
  { id: "normal", label: "Normal day", patch: { rainMmH: 0, floodCm: 0, windKmh: 12, tempC: 31 } },
  { id: "shower", label: "Shower", patch: { rainMmH: 4, floodCm: 0, windKmh: 14, tempC: 29 } },
  { id: "monsoon", label: "Monsoon burst", patch: { rainMmH: 35, durationH: 8, floodCm: 25, windKmh: 40, tempC: 28 } },
  { id: "flood", label: "Flooded streets", patch: { rainMmH: 12, durationH: 24, floodCm: 60, windKmh: 20, tempC: 27 } },
  { id: "heatwave", label: "Heatwave", patch: { rainMmH: 0, floodCm: 0, windKmh: 8, tempC: 42, hour: 13 } },
  { id: "storm", label: "Storm", patch: { rainMmH: 55, durationH: 5, floodCm: 15, windKmh: 95, tempC: 26 } },
] as const;

export function TwinControls({ scenario, baseParams, headline, closedCount, stretchedCount, className }: TwinControlsProps) {
  const router = useRouter();
  const [local, setLocal] = useState<WeatherScenario>(scenario);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Reset local state when the server answers with a new scenario.
   *
   * Without this the sliders keep showing the value the user was mid-way through
   * dragging when they pressed the browser's back button, which is a control that
   * lies about the state of the thing it controls.
   */
  useEffect(() => {
    setLocal(scenario);
    setPending(false);
  }, [scenario]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  /**
   * `baseParams` is captured once, on mount, and never re-read — so each navigation
   * starts from the traveller's original request and scenario params cannot
   * accumulate across presses of the back button.
   */
  const apply = useCallback(
    (next: WeatherScenario) => {
      const params = new URLSearchParams(baseParams.toString());
      for (const [field, param] of Object.entries(PARAM_KEYS)) {
        const value = next[field as keyof WeatherScenario];
        if (value === undefined) continue;
        if (field === "date") params.set(param, String(value));
        else params.set(param, String(value));
      }
      router.push(`/twin?${params.toString()}`);
    },
    [baseParams, router],
  );

  const commit = useCallback(
    (next: WeatherScenario) => {
      setPending(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => apply(next), COMMIT_MS);
    },
    [apply],
  );

  const update = useCallback(
    (key: Knob["key"], value: number) => {
      setLocal((current) => {
        const next = { ...current, [key]: value };
        commit(next);
        return next;
      });
    },
    [commit],
  );

  const changed = useMemo(
    () => KNOBS.filter((knob) => local[knob.key] !== scenario[knob.key]).length,
    [local, scenario],
  );

  return (
    <Card className={cn("space-y-5", className)}>
      <header>
        <h2 className="text-body text-ink">What if the weather changed?</h2>
        <p className="mt-1 text-meta text-ink-muted">
          Each change re-solves the real planner over the real catalogue. The live plan is never touched.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Weather presets">
        {PRESETS.map((preset) => (
          <Button
            key={preset.id}
            variant="secondary"
            size="sm"
            onClick={() => {
              setLocal({ ...local, ...preset.patch });
              commit({ ...local, ...preset.patch });
            }}
          >
            {preset.label}
          </Button>
        ))}
        {changed > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setLocal(scenario);
              apply(scenario);
            }}
          >
            Reset
          </Button>
        ) : null}
      </div>

      <div className="space-y-4">
        {KNOBS.map((knob) => (
          <Slider
            key={knob.key}
            label={knob.label}
            value={local[knob.key]}
            min={knob.bound.min}
            max={knob.bound.max}
            step={knob.bound.step}
            format={knob.format}
            onChange={(value) => update(knob.key, value)}
            minLabel={knob.hint}
          />
        ))}
      </div>

      <div className="rounded-sm bg-accent-soft p-3" aria-live="polite">
        <p className="text-meta-sm font-medium text-ink">{headline}</p>
        <p className="mt-1 text-meta-sm text-ink-muted">
          {closedCount} closed by the simulated sky
          {stretchedCount > 0 ? `, ${stretchedCount} visits stretched` : ""}
          {pending ? " · re-solving" : ""}
        </p>
      </div>
    </Card>
  );
}
