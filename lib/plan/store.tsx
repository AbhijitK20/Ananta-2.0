"use client";

/**
 * The one owner of the trip.
 *
 * Everything the planner shows is derived from `trip` on read: the legs come
 * from a route request, the days from the split, the totals from the legs. None
 * of it is stored, for the reason `lib/game/store.tsx` gives at length — several
 * representations of the same fact that can disagree with each other is a bug
 * factory, and every one of them needs a migration when the rules change.
 *
 * ---------------------------------------------------------------------------
 * ROUTING IS A DERIVATION, NOT STATE
 * ---------------------------------------------------------------------------
 *
 * Legs are held in React state and refetched whenever the stop list or the mode
 * changes, because they are a function of both and of a network resource. They
 * are deliberately not persisted: a saved itinerary whose distances were measured
 * by a demo server on a particular afternoon is a number that will silently rot,
 * and re-deriving on load means it is either right now or visibly an estimate.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { pointForStop } from "./geo";
import { moveStop, reverseStops, splitIntoDays, totalsFor, type TripTotals } from "./schedule";
import { routeTrip } from "./route";
import { queuePush, syncOnLoad } from "../auth/sync";
import { clear, isStorageAvailable, load, persist } from "./storage";
import { emptyFilters, emptyTrip } from "./types";
import type { Day, Drawer, Filters, Leg, Stop, Trip } from "./types";

/** A monotonic counter, not `Math.random`: ids only have to be unique within one
 *  session, and a counter cannot collide after a re-render storm. */
let pinSeq = 0;
const nextId = () => `pin-${++pinSeq}`;

export type PlanState = {
  trip: Trip;
  /** The stops that take part in routing and in the day split. */
  routed: Stop[];
  legs: Leg[];
  days: Day[];
  totals: TripTotals;
  /** The `[lon, lat]` line the spread is measured against. Null until a route
   *  exists, which is why the spread does not filter before the second stop. */
  routeLine: [number, number][] | null;
  /** True while a route request is in flight. The itinerary is usable without it. */
  routing: boolean;
  hydrated: boolean;
  storageWorks: boolean;
  discarded: boolean;

  /* drawer state */
  drawer: Drawer;
  filters: Filters;
  /** The stop the map is centred on, or null for "fit the whole trip". */
  selectedId: string | null;

  /* actions */
  addPlace: (input: {
    id: string;
    name: string;
    city: string;
    hood?: string;
    href?: string;
    cats?: string[];
    budget?: string;
  }) => void;
  addPin: (at: { lat: number; lon: number }, name?: string) => void;
  removeStop: (id: string) => void;
  toggleSkipped: (id: string) => void;
  move: (from: number, to: number) => void;
  reverse: () => void;
  setDwell: (id: string, dwell: number) => void;
  setNotes: (id: string, notes: string) => void;
  clearTrip: () => void;

  setMode: (mode: Trip["mode"]) => void;
  setDailyDriveHours: (hours: number) => void;
  setNonStop: (nonStop: boolean) => void;
  setSpreadKm: (km: number) => void;
  setStartDate: (date: string | null) => void;
  setTripName: (name: string) => void;

  setDrawer: (drawer: Drawer) => void;
  setFilters: (patch: Partial<Filters>) => void;
  select: (id: string | null) => void;
};

const PlanContext = createContext<PlanState | null>(null);

export function usePlan(): PlanState {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error("usePlan must be used inside <PlanProvider>");
  return ctx;
}

export function PlanProvider({ children }: { children: React.ReactNode }) {
  const [trip, setTrip] = useState<Trip>(emptyTrip);
  const [legs, setLegs] = useState<Leg[]>([]);
  const [routing, setRouting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [drawer, setDrawer] = useState<Drawer>("find");
  const [filters, setFiltersState] = useState<Filters>(emptyFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // The first paint is always the empty trip, for the reason the game store gives:
  // reading localStorage in a useState initialiser produces client markup that
  // differs from what the server sent, so React discards the server HTML and the
  // itinerary visibly appears a second after load.
  useEffect(() => {
    const result = load();
    setTrip(result.trip);
    setDiscarded(result.discarded);
    setHydrated(true);
    void syncOnLoad("trip", result.trip, (data) => setTrip(data as Trip));
  }, []);

  // Persist on every change, but never before the save has been read — writing
  // the empty trip over a stored one on first mount would wipe the itinerary.
  // The same effect feeds the cloud, and is inert while signed out.
  useEffect(() => {
    if (!hydrated) return;
    persist(trip);
    queuePush("trip", trip);
  }, [trip, hydrated]);

  const routed = useMemo(() => trip.stops.filter((s) => !s.skipped), [trip.stops]);

  const routeLine = useMemo(() => {
    const points: [number, number][] = [];
    for (const leg of legs) {
      for (const point of leg.geometry ?? []) {
        const last = points[points.length - 1];
        if (last && last[0] === point[0] && last[1] === point[1]) continue;
        points.push(point);
      }
    }
    return points.length >= 2 ? points : null;
  }, [legs]);

  /* ---- routing ---------------------------------------------------------- */

  /** The stop list collapsed to a string, so the effect does not re-fire on
   *  every identical array identity a re-render hands it. */
  const routedKey = useMemo(
    () => routed.map((s) => `${s.id}@${s.at.lat.toFixed(5)},${s.at.lon.toFixed(5)}`).join("|"),
    [routed],
  );

  const requestSeq = useRef(0);

  useEffect(() => {
    if (!hydrated) return;

    const stops = routed.filter((s) => pointForStop(s) !== null);
    if (stops.length < 2) {
      setLegs([]);
      return;
    }

    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setRouting(true);

    routeTrip(stops, trip.mode, controller.signal)
      .then((next) => {
        // A slow request for an itinerary the traveller has already edited must
        // not overwrite the newer one. Only the latest request may write.
        if (seq !== requestSeq.current) return;
        setLegs(next);
      })
      .finally(() => {
        if (seq === requestSeq.current) setRouting(false);
      });

    return () => controller.abort();
  }, [routedKey, trip.mode, hydrated]);

  const days = useMemo(
    () => splitIntoDays(routed, legs, trip.dailyDriveHours, trip.nonStop),
    [routed, legs, trip.dailyDriveHours, trip.nonStop],
  );

  const totals = useMemo(
    () => totalsFor(trip.stops, legs, days, trip.dailyDriveHours),
    [trip.stops, legs, days, trip.dailyDriveHours],
  );

  /* ---- mutations -------------------------------------------------------- */

  const mutate = useCallback((fn: (draft: Trip) => Trip) => {
    setTrip((prev) => fn(prev));
  }, []);

  const addPlace = useCallback<PlanState["addPlace"]>(
    (input) => {
      const at = pointForStop({ city: input.city });
      if (!at) return;
      mutate((prev) => {
        // Already in the itinerary, and not merely marked Maybe. A second copy of
        // the same entry would duplicate its id, and the drawer disables its own
        // button for this case, so reaching here means a race — dropping it is
        // the same answer either way.
        if (prev.stops.some((s) => s.placeId === input.id && !s.skipped)) return prev;
        return {
        ...prev,
        stops: [
          ...prev.stops,
          {
            // Unique per stop, so the same entry can appear twice without
            // colliding. The place keeps its own id in `placeId`.
            id: nextId(),
            placeId: input.id,
            name: input.name,
            city: input.city,
            hood: input.hood ?? "",
            at,
            dwell: 1,
            notes: "",
            source: "place",
            href: input.href,
            cats: input.cats ?? [],
            budget: input.budget ?? "",
            skipped: false,
          },
        ],
        };
      });
    },
    [mutate],
  );

  const addPin = useCallback<PlanState["addPin"]>(
    (at, name) => {
      mutate((prev) => ({
        ...prev,
        stops: [
          ...prev.stops,
          {
            id: nextId(),
            name: name ?? "Dropped pin",
            city: "",
            hood: "",
            at,
            dwell: 1,
            notes: "",
            source: "pin",
            cats: [],
            budget: "",
            skipped: false,
          },
        ],
      }));
    },
    [mutate],
  );

  const removeStop = useCallback<PlanState["removeStop"]>(
    (id) => {
      mutate((prev) => ({ ...prev, stops: prev.stops.filter((s) => s.id !== id) }));
      setSelectedId((cur) => (cur === id ? null : cur));
    },
    [mutate],
  );

  const toggleSkipped = useCallback<PlanState["toggleSkipped"]>(
    (id) => {
      mutate((prev) => ({
        ...prev,
        stops: prev.stops.map((s) => (s.id === id ? { ...s, skipped: !s.skipped } : s)),
      }));
    },
    [mutate],
  );

  const move = useCallback<PlanState["move"]>(
    (from, to) => {
      mutate((prev) => ({ ...prev, stops: moveStop(prev.stops, from, to) }));
    },
    [mutate],
  );

  const reverse = useCallback(() => {
    mutate((prev) => ({ ...prev, stops: reverseStops(prev.stops) }));
  }, [mutate]);

  const setDwell = useCallback<PlanState["setDwell"]>(
    (id, dwell) => {
      mutate((prev) => ({
        ...prev,
        stops: prev.stops.map((s) => (s.id === id ? { ...s, dwell } : s)),
      }));
    },
    [mutate],
  );

  const setNotes = useCallback<PlanState["setNotes"]>(
    (id, notes) => {
      mutate((prev) => ({
        ...prev,
        stops: prev.stops.map((s) => (s.id === id ? { ...s, notes } : s)),
      }));
    },
    [mutate],
  );

  const clearTrip = useCallback(() => {
    setTrip(clear());
    setLegs([]);
    setSelectedId(null);
  }, []);

  const setFilters = useCallback((patch: Partial<Filters>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
  }, []);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  const value = useMemo<PlanState>(
    () => ({
      trip,
      routed,
      legs,
      days,
      totals,
      routeLine,
      routing,
      hydrated,
      storageWorks: isStorageAvailable(),
      discarded,
      drawer,
      filters,
      selectedId,
      addPlace,
      addPin,
      removeStop,
      toggleSkipped,
      move,
      reverse,
      setDwell,
      setNotes,
      clearTrip,
      setMode: (mode) => mutate((prev) => ({ ...prev, mode })),
      setDailyDriveHours: (hours) => mutate((prev) => ({ ...prev, dailyDriveHours: hours })),
      setNonStop: (nonStop) => mutate((prev) => ({ ...prev, nonStop })),
      setSpreadKm: (spreadKm) => mutate((prev) => ({ ...prev, spreadKm })),
      setStartDate: (startDate) => mutate((prev) => ({ ...prev, startDate })),
      setTripName: (name) => mutate((prev) => ({ ...prev, name })),
      setDrawer,
      setFilters,
      select,
    }),
    [
      trip, routed, legs, days, totals, routeLine, routing, hydrated, discarded, drawer,
      filters, selectedId, addPlace, addPin, removeStop, toggleSkipped, move, reverse,
      setDwell, setNotes, clearTrip, mutate, setFilters, select,
    ],
  );

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export { PlanContext };
