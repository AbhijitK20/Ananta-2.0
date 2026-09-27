"use client";

/**
 * The twin's state, and the one place a simulation is run.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWIN IS NOT IN `lib/plan/store.tsx`
 * ---------------------------------------------------------------------------
 *
 * The trip store's own note is that everything it holds is derived from `trip` on
 * read, because several representations of one fact that can disagree is a bug
 * factory. The twin follows the same rule, one level down: it holds the
 * *observation* and the *scenario*, and derives the graph, the impacts and the
 * itinerary consequence on every render.
 *
 * It is a separate provider rather than more fields on the plan store for a
 * concrete reason. The plan store is the traveller's trip, it persists, and it
 * survives a reload. The twin is a live read of the world plus an imagined
 * version of it, and persisting either would be a lie — a saved "what if it
 * rained all week" reads on Monday as though it were Monday's weather. So the
 * twin is deliberately not persisted, and `useTwin` is safe to call from anywhere
 * inside the plan page.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIMULATION RUNS HERE AND NOT ON THE SERVER
 * ---------------------------------------------------------------------------
 *
 * A what-if is a slider drag. Re-posting the trip to an API on every movement
 * would make the control feel broken, and the computation is a few hundred
 * multiplications over a graph of at most a few dozen nodes. The *observation* is
 * fetched, because that is where the key and the rate limits live; the *reasoning*
 * is local, which is also what makes the counterfactual free of any chance of
 * writing to the traveller's actual itinerary.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { coordsFor } from "../plan/geo";
import { usePlan } from "../plan/store";
import { buildTwinGraph, describeGraph } from "./graph";
import { itineraryEffect, type TwinNodeImpactLite } from "./itinerary";
import { simulate } from "./propagate";
import { bucketSignals, describeSources } from "./signals";
import { LIVE_SCENARIO, type CityObservation, type Scenario, type SocialSignal, type TwinGraph, type TwinResult } from "./types";

/** How stale an observation may get before the panel says so. Weather does not
 *  change by the minute, but a reading held for an hour is not "live" any more. */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** Never re-fetch faster than this, whatever the trigger. */
const MIN_REFETCH_MS = 60 * 1000;

export type TwinState = {
  /** Null before the first observation lands, and null when the trip has no city. */
  observations: readonly CityObservation[];
  signals: readonly SocialSignal[];
  graph: TwinGraph;
  /** The counterfactual. `live: true` means "report the weather as observed". */
  scenario: Scenario;
  setScenario: (patch: Partial<Scenario>) => void;
  resetScenario: () => void;
  /** The live result, always computed, so the panel can diff against it. */
  live: TwinResult | null;
  /** What the traveller is currently looking at: live, or the counterfactual. */
  result: TwinResult | null;
  loading: boolean;
  error: string | null;
  /** True when the last observation is old enough to be worth calling stale. */
  stale: boolean;
  observedAt: string | null;
  /** Per-source outcome, including the sources that failed. */
  sourceStatus: readonly { source: string; ok: boolean; count: number; note: string }[];
  weatherNote: { source: string; ok: number; failed: number; note: string };
  calibration: { observations: number; priorWeight: number; cells: number };
  /** Read off the graph, so the numbers in the UI cannot drift from the model. */
  graphShape: ReturnType<typeof describeGraph>;
  /** Re-read the world. Used by the refresh button. */
  refresh: () => void;
};

const TwinContext = createContext<TwinState | null>(null);

export function useTwin(): TwinState {
  const ctx = useContext(TwinContext);
  if (!ctx) throw new Error("useTwin must be used inside <TwinProvider>");
  return ctx;
}

/**
 * The twin, or null when there is no provider.
 *
 * The planner's map reads the twin's state to draw impact halos, and the map is
 * also rendered by the smoke-test harness and by any future route that wants it
 * without the panel. Throwing from a context read is right for the panel — it
 * means a wiring mistake is loud — and wrong for a consumer that genuinely can
 * do without it. So this is the optional read, and the map treats null as "draw
 * no halos", which is exactly what it did before the twin existed.
 */
export function useOptionalTwin(): TwinState | null {
  return useContext(TwinContext);
}

export function TwinProvider({ children }: { children: React.ReactNode }) {
  const { trip, routed, legs, days, hydrated } = usePlan();

  const [observations, setObservations] = useState<readonly CityObservation[]>([]);
  const [signals, setSignals] = useState<readonly SocialSignal[]>([]);
  const [sourceStatus, setSourceStatus] = useState<TwinState["sourceStatus"]>([]);
  const [weatherNote, setWeatherNote] = useState<TwinState["weatherNote"]>({
    source: "OpenWeather current conditions + 3-hour forecast",
    ok: 0,
    failed: 0,
    note: "",
  });
  const [calibration, setCalibration] = useState<TwinState["calibration"]>({
    observations: 0,
    priorWeight: 0,
    cells: 0,
  });
  const [scenario, setScenarioState] = useState<Scenario>(LIVE_SCENARIO);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /* ---- the graph, derived ---- */

  const graph = useMemo(
    () =>
      buildTwinGraph({
        stops: trip.stops,
        legs,
        days,
        coordFor: (city) => {
          const coord = coordsFor(city);
          return coord ? { name: coord.name, lat: coord.lat, lon: coord.lon } : null;
        },
      }),
    [trip.stops, legs, days],
  );

  const graphShape = useMemo(() => describeGraph(graph), [graph]);

  /* ---- which cities to observe ---- */

  const cities = useMemo(() => {
    const out: { slug: string; name: string; lat: number; lon: number }[] = [];
    for (const city of graph.cityNode.values()) {
      const node = graph.nodes.get(city);
      if (node) out.push({ slug: node.city, name: node.name, lat: node.at.lat, lon: node.at.lon });
    }
    return out;
  }, [graph]);

  /** A string of the city list, so the effect re-fires when the trip changes
   *  rather than on every new array identity a render hands it. */
  const cityKey = useMemo(() => cities.map((c) => c.slug).join(","), [cities]);

  /* ---- fetch ---- */

  const lastFetch = useMemo(() => ({ at: 0 }), []);

  useEffect(() => {
    if (!hydrated) return;
    if (!cities.length) {
      setObservations([]);
      setSignals([]);
      return;
    }

    const controller = new AbortController();
    const elapsed = Date.now() - lastFetch.at;
    // A re-render caused by the traveller adding a stop should refresh, but a
    // re-render caused by the scenario slider must not.
    if (elapsed < MIN_REFETCH_MS && nonce === 0) return;

    setLoading(true);
    setError(null);

    fetch("/api/twin/observe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cities }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The observation service replied ${res.status}.`);
        return (await res.json()) as {
          observedAt: string;
          observations: CityObservation[];
          signals: SocialSignal[];
          status: { source: string; ok: boolean; count: number; note: string }[];
          calibration: { observations: number; priorWeight: number; cells: number };
          weather: { source: string; ok: number; failed: number; note: string };
        };
      })
      .then((body) => {
        setObservations(body.observations);
        setSignals(body.signals);
        setSourceStatus(body.status);
        setCalibration(body.calibration);
        setWeatherNote(body.weather);
        setObservedAt(body.observedAt);
        lastFetch.at = Date.now();
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The observation service could not be reached.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
    // `lastFetch` is a stable object, deliberately not a dependency: it is a
    // throttle, not an input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, cityKey, nonce]);

  /* ---- the simulation ---- */

  const observationMap = useMemo(() => {
    const map = new Map<string, CityObservation>();
    for (const o of observations) map.set(o.city, o);
    return map;
  }, [observations]);

  const signalsByCity = useMemo(() => {
    const cityList = cities.map((c) => ({ slug: c.slug, name: c.name, at: { lat: c.lat, lon: c.lon } }));
    return bucketSignals(signals, cityList);
  }, [signals, cities]);

  const runScenario = useCallback(
    (which: Scenario): TwinResult | null => {
      if (!graph.stops.length) return null;

      const output = simulate({
        graph,
        observations: observationMap,
        scenario: which,
        signalsByCity,
        weatherNote,
        signalStatus: sourceStatus.map((s) => ({ ...s, source: s.source })),
        calibration,
        isLive: isLiveScenario(which),
      });

      const impacts: TwinNodeImpactLite[] = output.nodes.map((node) => ({
        stopId: node.node.id.slice(5),
        name: node.node.name,
        availability: node.channels.availability.multiplier,
        severity: node.severity,
        demand: node.channels.demand.multiplier,
      }));

      const ranked = [...output.nodes].sort(
        (a, b) => a.channels.availability.multiplier - b.channels.availability.multiplier,
      );

      return {
        live: isLiveScenario(which),
        nodes: ranked,
        peak: ranked[0] ?? null,
        itinerary: itineraryEffect({
          trip,
          routed,
          legs,
          adjustedLegHours: output.adjustedLegHours,
          impacts,
          live: isLiveScenario(which),
        }),
        provenance: {
          weather: weatherNote,
          signals: sourceStatus,
          calibration,
          driver: driverShare(ranked),
        },
      };
    },
    [graph, observationMap, signalsByCity, weatherNote, sourceStatus, calibration, trip, routed, legs],
  );

  const live = useMemo(() => runScenario(LIVE_SCENARIO), [runScenario]);
  const result = useMemo(() => runScenario(scenario), [runScenario, scenario]);

  const setScenario = useCallback((patch: Partial<Scenario>) => {
    setScenarioState((prev) => {
      const next = { ...prev, ...patch };
      // Any movement away from the observed reading means the traveller is now
      // imagining something, and the panel has to say so rather than labelling a
      // counterfactual "live".
      const moved =
        next.rain !== LIVE_SCENARIO.rain ||
        next.heatDeltaC !== LIVE_SCENARIO.heatDeltaC ||
        next.wind !== LIVE_SCENARIO.wind ||
        next.floodCm !== LIVE_SCENARIO.floodCm ||
        next.stormHours !== LIVE_SCENARIO.stormHours;
      return { ...next, live: !moved };
    });
  }, []);

  const resetScenario = useCallback(() => setScenarioState(LIVE_SCENARIO), []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  const stale = useMemo(() => {
    if (!observedAt) return false;
    return Date.now() - Date.parse(observedAt) > STALE_AFTER_MS;
  }, [observedAt]);

  const value = useMemo<TwinState>(
    () => ({
      observations,
      signals,
      graph,
      scenario,
      setScenario,
      resetScenario,
      live,
      result,
      loading,
      error,
      stale,
      observedAt,
      sourceStatus: sourceStatus.length ? sourceStatus : describeSources([]),
      weatherNote,
      calibration,
      graphShape,
      refresh,
    }),
    [
      observations, signals, graph, scenario, setScenario, resetScenario, live, result,
      loading, error, stale, observedAt, sourceStatus, weatherNote, calibration, graphShape, refresh,
    ],
  );

  return <TwinContext.Provider value={value}>{children}</TwinContext.Provider>;
}

function isLiveScenario(scenario: Scenario): boolean {
  return (
    scenario.rain === LIVE_SCENARIO.rain &&
    scenario.heatDeltaC === LIVE_SCENARIO.heatDeltaC &&
    scenario.wind === LIVE_SCENARIO.wind &&
    scenario.floodCm === LIVE_SCENARIO.floodCm &&
    scenario.stormHours === LIVE_SCENARIO.stormHours
  );
}

/**
 * How much of the answer the worst hazard is carrying.
 *
 * Reported because a twin that says "0.62 availability" without saying what is
 * doing it is asking to be believed on trust, and the traveller's next question
 * is always "which hazard do I get rid of first".
 */
function driverShare(
  nodes: readonly { severity: number; driver: string | null }[],
): { hazard: TwinResult["provenance"]["driver"]["hazard"]; share: number } {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    if (!node.driver || node.severity === 0) continue;
    counts.set(node.driver, (counts.get(node.driver) ?? 0) + node.severity);
  }
  let best: string | null = null;
  let bestCount = 0;
  let total = 0;
  for (const [hazard, count] of counts) {
    total += count;
    if (count > bestCount) {
      best = hazard;
      bestCount = count;
    }
  }
  return {
    hazard: best as TwinResult["provenance"]["driver"]["hazard"],
    share: total ? Math.round((bestCount / total) * 100) / 100 : 0,
  };
}

export { TwinContext };
export type { TwinGraph };
