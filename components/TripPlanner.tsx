"use client";

/**
 * TripPlanner — a rebuild of Furkot's planner: a full-bleed map, a toolbar, edge
 * tabs, a "Plan new trip" dialog, and a stop list you can drag into order.
 *
 * The dialog is measured against the live site with tools/capture.mjs and
 * tools/capture-click.mjs; the toolbar, the edge tabs and the map furniture come
 * from a screenshot, because trips.furkot.com/trip answers an anonymous request
 * with the same 43KB shell as /ui and the planner map is behind a login. Which
 * half is which is marked throughout, and app/planner.css says the same thing at
 * the top. Do not treat the two halves as equally trustworthy.
 *
 * All the decisions live in lib/trip.ts, which imports nothing, so the parts that
 * are easy to get wrong -- the loop swap and the drag reorder -- are checkable
 * with tools/check-trip.mjs and no browser.
 *
 * The map is raw maplibre-gl rather than a wrapper: this needs a basemap, two
 * GeoJSON layers, some markers and a click handler, and a wrapper for that is
 * more code than the wrapper saves. It is loaded through a dynamic import in an
 * effect because maplibre reaches for `window` and a worker at module scope, and
 * a static import puts it in the server bundle and fails the build.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// maplibre-gl is a plain-CSS package, not a CSS-in-JS one: nothing positions its
// markers or sizes its canvas container unless you import this file yourself.
// Leave it out and the basemap tiles still draw -- the canvas is sized in script
// -- but every Marker renders at position:static and lands wherever the document
// flow puts it, hundreds of pixels below the map. That is a silent failure: no
// error, no warning, just pins in the wrong place.
//
// planner.css then overrides the few maplibre rules that clash with the measured
// Furkot values.
import "maplibre-gl/dist/maplibre-gl.css";

import { PLOTTABLE, REGION_ORDER } from "../data/places";
import {
  EMPTY_ENDPOINTS,
  EMPTY_FILTERS,
  NO_LIMIT,
  addStop,
  boundsOf,
  codeForCountry,
  countriesIn,
  dayCount,
  endpointFieldFor,
  endpointHintFor,
  endpointPlaceholderFor,
  filterPlaces,
  formatDms,
  moveStop,
  nudgeStop,
  orderPlaces,
  planDays,
  removeStop,
  routeCoordinates,
  routeLength,
  scaleBarFor,
  stopAt,
  stopFrom,
  trimToDays,
  tripReadiness,
  updateStop,
  type Endpoints,
  type FinderOrder,
  type Filters,
  type MappablePlace,
  type Stop,
  type Tab,
} from "../lib/trip";

/**
 * A LineString needs two positions, and one stop gives one. Two identical
 * positions is a valid zero-length line: it draws nothing, throws nothing, and
 * leaves the source in a state that is honest rather than an exception.
 */
const EMPTY_LINE = {
  type: "Feature" as const,
  geometry: { type: "LineString" as const, coordinates: [[0, 0], [0, 0]] },
  properties: {},
};

const EMPTY_POINTS = { type: "FeatureCollection" as const, features: [] };

/**
 * A keyless raster basemap, owned as a style object rather than fetched as a URL.
 *
 * Two dead ends are worth recording, because both look fine until you look at the
 * tiles. OpenFreeMap's `liberty` style 404s a glyph range and names fourteen
 * sprite images that do not exist, which produces around thirty console errors
 * that cannot be fixed from here. And CARTO Positron answers every request with a
 * 2KB grey PNG reading "API KEY REQUIRED": the endpoint still returns 200 with
 * `image/png`, so nothing fails and nothing is logged, and the map is simply
 * blank. Checked by fetching a tile and looking at the bytes, not the status code.
 *
 * OpenStreetMap's own tiles are the keyless option that actually serves pixels.
 * The raster-* paint properties then pull the saturation down, because OSM's
 * standard style is far more colourful than the flat beige of the reference
 * screenshot and the orange route line disappears into it otherwise. That is a
 * rendering choice on our side, not a different basemap: the data underneath is
 * unchanged.
 *
 * The route and the finder dots are declared HERE rather than in a map.on("load")
 * handler, and that is not tidiness. A load handler is the usual way to add a
 * source, but it only makes the source exist once, and every later update has to
 * be gated on isStyleLoaded() or queued with map.once("load") -- and "load" fires
 * exactly once, so a queue registered after that point never runs and the source
 * silently keeps the first geometry it was given. Declaring the sources in the
 * style means setData works from the very first render and there is no ordering
 * to get wrong.
 */
const BASEMAP_STYLE = {
  version: 8 as const,
  sources: {
    basemap: {
      type: "raster" as const,
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
    route: { type: "geojson" as const, data: EMPTY_LINE },
    results: { type: "geojson" as const, data: EMPTY_POINTS },
  },
  layers: [
    {
      id: "basemap",
      type: "raster" as const,
      source: "basemap",
      minzoom: 0,
      maxzoom: 22,
      paint: {
        "raster-saturation": -0.72,
        "raster-contrast": 0.06,
        "raster-brightness-min": 0.06,
        "raster-brightness-max": 0.97,
      },
    },
    {
      id: "route-line",
      type: "line" as const,
      source: "route",
      layout: { "line-cap": "round" as const, "line-join": "round" as const },
      paint: { "line-color": "#f2680c", "line-width": 3, "line-opacity": 0.85 },
    },
    {
      id: "result-dots",
      type: "circle" as const,
      source: "results",
      paint: {
        "circle-radius": 4,
        "circle-color": "#615f5c",
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1,
      },
    },
  ],
};

/** The world at zoom 1.4, which is the frame the reference screenshot sits at. */
const HOME_VIEW = { center: [-20, 25] as [number, number], zoom: 1.4 };

type MapLibre = typeof import("maplibre-gl");

/* ============================================================== the map ===== */

type PlannerMapProps = {
  stops: readonly Stop[];
  results: readonly MappablePlace[];
  loop: boolean;
  /** Fires when the traveller clicks bare map coordinates. */
  onPick: (lat: number, lng: number) => void;
  onCursor: (lat: number, lng: number) => void;
  onViewChange: (zoom: number) => void;
  /**
   * What the map should frame. This is the route when a finder tab is shut and
   * the filtered places when one is open, so filtering to Europe moves the map
   * to Europe instead of leaving it over a route in Labrador with the results
   * invisibly off screen.
   */
  fitTo: readonly { lat: number; lng: number }[];
  /** Bumped by the parent to ask for a refit on demand. */
  fitNonce: number;
};

function PlannerMap({
  stops,
  results,
  loop,
  onPick,
  onCursor,
  onViewChange,
  fitTo,
  fitNonce,
}: PlannerMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const mlRef = useRef<MapLibre | null>(null);
  const markersRef = useRef<import("maplibre-gl").Marker[]>([]);
  const [lib, setLib] = useState<MapLibre | null>(null);
  const [failed, setFailed] = useState(false);

  // The callbacks change on every render of the parent, so they are held in a ref
  // rather than listed as effect dependencies. Re-registering the map's click
  // handler on each keystroke in the filter box would be absurd.
  const pickRef = useRef(onPick);
  const cursorRef = useRef(onCursor);
  const viewRef = useRef(onViewChange);
  pickRef.current = onPick;
  cursorRef.current = onCursor;
  viewRef.current = onViewChange;

  useEffect(() => {
    let cancelled = false;
    void import("maplibre-gl")
      .then((mod) => {
        if (cancelled) return;
        mlRef.current = mod;
        setLib(() => mod);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!lib || !hostRef.current || mapRef.current) return;
    const map = new lib.Map({
      container: hostRef.current,
      style: BASEMAP_STYLE,
      ...HOME_VIEW,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new lib.NavigationControl({ showCompass: true }), "bottom-right");

    map.on("click", (e) => {
      // Only bare map counts, because maplibre also fires this for the canvas
      // under a stop marker. The layer guard matters on the very first click
      // after load: queryRenderedFeatures throws on a layer name the style has
      // not parsed yet, and an uncaught throw here kills the click handler for
      // the rest of the session.
      if (!map.getLayer("result-dots")) return;
      const hits = map.queryRenderedFeatures(e.point, { layers: ["result-dots"] });
      if (hits.length > 0) return;
      pickRef.current(e.lngLat.lat, e.lngLat.lng);
    });

    map.on("mousemove", (e) => cursorRef.current(e.lngLat.lat, e.lngLat.lng));
    map.on("move", () => viewRef.current(map.getZoom()));

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [lib]);

  // Route line. The source is in the style object, so this is a plain setData
  // with no load-ordering to get wrong.
  useEffect(() => {
    const src = mapRef.current?.getSource("route") as
      | import("maplibre-gl").GeoJSONSource
      | undefined;
    if (!src) return;
    const coordinates = routeCoordinates(stops, loop);
    src.setData({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: coordinates.length > 1 ? coordinates : [[0, 0], [0, 0]],
      },
      properties: {},
    });
  }, [stops, loop, lib]);

  // Finder dots for whatever survived the filters.
  useEffect(() => {
    const src = mapRef.current?.getSource("results") as
      | import("maplibre-gl").GeoJSONSource
      | undefined;
    if (!src) return;
    src.setData({
      type: "FeatureCollection",
      features: results
        .filter((p) => p.lat != null && p.lng != null)
        .map((p) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: [p.lng!, p.lat!] },
          properties: { name: p.name },
        })),
    });
  }, [results, lib]);

  // Numbered markers, rebuilt from scratch. Ten stops does not justify diffing,
  // and maplibre's Marker has no update method worth using.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !lib) return;
    for (const m of markersRef.current) m.remove();
    markersRef.current = stops.map((stop, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "fk-pin";
      el.textContent = String(i + 1);
      el.title = stop.name;
      el.setAttribute("aria-label", `Stop ${i + 1}, ${stop.name}`);
      return new lib.Marker({ element: el }).setLngLat([stop.lng, stop.lat]).addTo(map);
    });
  }, [stops, lib]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !lib) return;
    const box = boundsOf(fitTo);
    if (!box) return;
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      { padding: 80, duration: 600, maxZoom: 9 },
    );
  }, [fitNonce, fitTo, lib]);

  if (failed) {
    return (
      <div className="fk-canvas fk-mapfail">
        The basemap could not load. The trip list on the right still works, and
        every stop keeps its coordinates.
      </div>
    );
  }

  return (
    <>
      <div ref={hostRef} className="fk-canvas" aria-hidden="true" />
      {!lib && <div className="fk-canvas fk-mapload" aria-hidden="true" />}
    </>
  );
}

/* ============================================================== dialog ====== */

/**
 * The "Plan new trip" dialog, rebuilt from the measured capture.
 *
 * The markup order and every dimension in here come from the probe, not from
 * the picture. Two things are worth knowing because they are not guessable from
 * a screenshot:
 *
 *   1. Ticking "Loop back to the starting point" swaps the End point input for a
 *      Mid point one *in the same 730x28 box* and rewrites the sentence above it,
 *      so the dialog does not grow. Both states were captured; the two inputs
 *      never coexist on screen. See tools/capture-click.mjs.
 *   2. The .wide-screen-only paragraphs are display:none below 780px, which is
 *      why the mobile dialog is 327px tall against 509px on the desktop.
 */
function PlanTripDialog({
  endpoints,
  onChange,
  onClose,
  onPlan,
}: {
  endpoints: Endpoints;
  onChange: (patch: Partial<Endpoints>) => void;
  onClose: () => void;
  onPlan: () => void;
}) {
  const { canDraw, missing } = tripReadiness(endpoints, []);
  const hint = endpointHintFor(endpoints.loop);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /**
   * aria-modal="true" is a promise, and this dialog was not keeping it: opening
   * it left focus on the toolbar button behind, so the first Tab went to
   * something invisible under the dialog, and Tab walked straight out into the
   * map. Three things fix it and all three are here: move focus in, keep it in,
   * and hand it back on the way out.
   *
   * The effect is mount-only, and onClose is read through a ref rather than
   * listed as a dependency. The parent passes an inline arrow, so it is a new
   * function on every keystroke; with it in the dependency list this effect
   * re-ran per character, and its cleanup sent focus back to the toolbar button
   * before the effect moved it into the first field again. You could not type
   * two letters into anything but the first input.
   */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>("input, button")?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Wrap at both ends rather than relying on `inert`, which would need the
      // whole page behind the dialog marked and re-marked on every open.
      const focusables = boxRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const firstEl = focusables[0]!;
      const lastEl = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Returning focus to whatever opened the dialog is what stops the keyboard
      // position jumping back to the top of the document on close.
      opener?.focus?.();
    };
  }, []);

  return (
    <>
      <div className="fk-scrim" onClick={onClose} />
      <div
        ref={boxRef}
        className="fk-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fk-dialog-title"
      >
        <h2 className="fk-dialog__title" id="fk-dialog-title">
          Plan new trip
        </h2>
        <button type="button" className="fk-dialog__close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="fk-dialog__body">
          <div className="fk-wizard">
            <p className="fk-wizard__lede fk-wide">
              Tell us something about your trip. Don&apos;t worry, everything here is
              optional and you can change it later. Furkot will display the map of your
              trip and let you add stops, find attractions and book hotels.
            </p>

            <div className="fk-wizard__spacer" />

            <p className="fk-wizard__lede">
              Are you starting from home? Let Furkot figure out where you are. Or just
              type a name of a city, a landmark or an address.
            </p>

            <div className="fk-locate">
              <input
                className="fk-input"
                value={endpoints.start}
                placeholder="Start point"
                aria-label="Start point"
                onChange={(e) => onChange({ start: e.target.value })}
              />
              <button
                type="button"
                className="fk-locate__home"
                title="Starting from home"
                aria-label="Use my current location as the start point"
                onClick={() =>
                  // Not a geolocation call. A real fix needs permission, a
                  // reverse geocode and a country to search within, and the
                  // capture shows a house button that is simply a mode toggle.
                  onChange({ start: "Home" })
                }
              >
                ⌂
              </button>
            </div>

            <p className="fk-wizard__lede fk-wide">
              Do you plan to end back where you started? Or is it a one-way trip?
            </p>

            <label className="fk-check">
              <input
                type="checkbox"
                checked={endpoints.loop}
                onChange={(e) => onChange({ loop: e.target.checked })}
              />
              <span className="fk-check__box" aria-hidden="true" />
              <span>Loop back to the starting point</span>
            </label>

            <div className="fk-wizard__spacer" />

            <p className="fk-wizard__lede fk-wide">{hint}</p>

            {/* One input, not two. Which placeholder it carries is the whole of
                the loop behaviour. */}
            <input
              className="fk-input"
              value={endpoints[endpointFieldFor(endpoints.loop)]}
              placeholder={endpointPlaceholderFor(endpoints.loop)}
              aria-label={endpointPlaceholderFor(endpoints.loop)}
              onChange={(e) =>
                onChange(endpoints.loop ? { mid: e.target.value } : { end: e.target.value })
              }
            />

            <div className="fk-wizard__spacer" />

            <p className="fk-wizard__lede fk-wide">
              Not sure where you want to go or what to see? Check out our folio of
              ready-made trips. Click INSPIRE ME now or look for it later.
            </p>

            <p className="fk-wizard__lede">Give your trip a name.</p>

            <div className="fk-dialog__name">
              <input
                className="fk-input"
                value={endpoints.name}
                placeholder="Trip name"
                aria-label="Trip name"
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </div>

            <p className="fk-wizard__lede fk-wide">
              You can configure your trip dates and travel preferences on the NEXT page.
            </p>
          </div>

          {/* Furkot shows NEXT and DONE disabled and says nothing about why. The
              note earns its place: DONE being dead with no explanation is the
              single most confusing thing about the real dialog. */}
          {!canDraw && (
            <p className="fk-note" role="status">
              Still needed: {missing.join(", ")}.
            </p>
          )}

          <div className="fk-dialog__actions">
            <button type="button" className="fk-link">
              ⓘ Learn more
            </button>
            <button type="button" className="fk-btn" onClick={onPlan} disabled={!canDraw}>
              Done
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================== panel ======= */

function Itinerary({
  stops,
  plans,
  legs,
  drag,
  onDragStart,
  onDragOver,
  onDrop,
  onNudge,
  onRemove,
  onStay,
}: {
  stops: readonly Stop[];
  plans: ReturnType<typeof planDays>;
  /** Per-leg distance, from routeLength. Not the cumulative day total. */
  legs: ReturnType<typeof routeLength>["legs"];
  drag: { from: number; to: number } | null;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDrop: () => void;
  onNudge: (index: number, delta: -1 | 1) => void;
  onRemove: (id: string) => void;
  onStay: (id: string, minutes: number) => void;
}) {
  if (stops.length === 0) {
    return (
      <p className="fk-empty">
        No stops yet. Click the map to drop one, or pick a place from Find.
      </p>
    );
  }

  return (
    <ol className="fk-stops">
      {stops.map((stop, i) => {
        // legs[i - 1] is the hop INTO this stop. Two traps here: plans[i].km is
        // the running total for the day, not this hop's distance, and plans is
        // indexed by leg while the list is indexed by stop.
        const hop = i > 0 ? legs[i - 1] : undefined;
        const day = i > 0 ? plans[i - 1] : undefined;
        return (
          <li key={stop.id}>
            <div
              className={[
                "fk-stop",
                drag?.from === i ? "fk-stop--dragging" : "",
                drag && drag.to === i ? "fk-stop--target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              draggable
              onDragStart={() => onDragStart(i)}
              onDragOver={(e) => {
                e.preventDefault();
                onDragOver(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                onDrop();
              }}
            >
              <span className="fk-stop__grip" aria-hidden="true">
                ⠿
              </span>
              <span className="fk-stop__ord">{i + 1}</span>
              <span className="fk-stop__name">
                {stop.name}
                {hop && <span>{hop.km} km from previous · day {day?.day}</span>}
              </span>
              <input
                className="fk-stop__stay"
                type="number"
                min={0}
                step={15}
                value={stop.minutes}
                aria-label={`Minutes at ${stop.name}`}
                onChange={(e) => onStay(stop.id, Math.max(0, Number(e.target.value) || 0))}
              />
              {/* The keyboard and touch path beside the drag. HTML5 drag and drop
                  is not reachable from a keyboard and does not fire on touch at
                  all, so these two buttons are what make reordering usable
                  rather than a mouse-only extra. */}
              <button
                type="button"
                className="fk-stop__del"
                onClick={() => onNudge(i, -1)}
                disabled={i === 0}
                aria-label={`Move ${stop.name} earlier`}
              >
                ↑
              </button>
              <button
                type="button"
                className="fk-stop__del"
                onClick={() => onNudge(i, 1)}
                disabled={i === stops.length - 1}
                aria-label={`Move ${stop.name} later`}
              >
                ↓
              </button>
              <button
                type="button"
                className="fk-stop__del"
                onClick={() => onRemove(stop.id)}
                aria-label={`Remove ${stop.name}`}
              >
                ✕
              </button>
            </div>
            {day && (day.breachesKm || day.breachesHours) && (
              <p className="fk-leg">Over your daily limit — split this leg.</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ============================================================== planner ===== */

const TABS_IN_UI = ["trips", "plan", "sleep", "eat", "find"] as const;

const PANEL_TITLE: Record<Tab, string> = {
  none: "",
  trips: "My trips",
  plan: "Plan",
  sleep: "Where you sleep",
  eat: "Where you eat",
  find: "Find places",
};

export function TripPlanner() {
  const [endpoints, setEndpoints] = useState<Endpoints>(EMPTY_ENDPOINTS);
  const [stops, setStops] = useState<Stop[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [maxDailyKm, setMaxDailyKm] = useState(NO_LIMIT);
  const [maxDrivingHours, setMaxDrivingHours] = useState(NO_LIMIT);
  const [maxDays, setMaxDays] = useState(NO_LIMIT);
  const [dialog, setDialog] = useState(false);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [cursor, setCursor] = useState<{ lat: number; lng: number } | null>(null);
  const [zoom, setZoom] = useState(HOME_VIEW.zoom);
  const [fitNonce, setFitNonce] = useState(0);

  const openDialog = useCallback(() => setDialog(true), []);
  const closeDialog = useCallback(() => setDialog(false), []);
  const plan = useCallback(() => setDialog(false), []);

  const patchEndpoints = useCallback(
    (patch: Partial<Endpoints>) => setEndpoints((e) => ({ ...e, ...patch })),
    [],
  );

  const results = useMemo(() => filterPlaces(PLOTTABLE, filters), [filters]);

  /**
   * The three finder tabs read the same 100 places, because this clone has no
   * hotel or restaurant database to narrow them with. What separates them is the
   * ordering, and the copy in the panel names it. Nearest is measured from the
   * first stop, since that is where the trip starts.
   */
  const finderOrder: FinderOrder =
    filters.tab === "eat" ? "country" : filters.tab === "sleep" ? "nearest" : "catalogue";

  const origin = stops[0];
  const listed = useMemo(
    () => orderPlaces(results, finderOrder, origin ? { lat: origin.lat, lng: origin.lng } : undefined),
    [results, finderOrder, origin],
  );

  const { totalKm, legs } = useMemo(() => routeLength(stops), [stops]);
  const plans = useMemo(
    () => planDays(stops, maxDailyKm, maxDrivingHours),
    [stops, maxDailyKm, maxDrivingHours],
  );
  const days = dayCount(plans);
  const totalStay = stops.reduce((n, s) => n + s.minutes, 0);
  const scale = scaleBarFor(zoom);
  const countries = useMemo(() => countriesIn(PLOTTABLE, filters.region), [filters.region]);

  /** The daily caps can shorten the route, so the line and length follow them. */
  const shownStops = useMemo(
    () => (maxDays > 0 ? trimToDays(stops, plans, maxDays) : stops),
    [stops, plans, maxDays],
  );
  const shownTotal = useMemo(() => routeLength(shownStops).totalKm, [shownStops]);

  const isFinder = filters.tab === "find" || filters.tab === "eat" || filters.tab === "sleep";

  /** What the map frames: the filtered places while a finder is open, else the route. */
  const fitTo = useMemo(
    () =>
      isFinder
        ? results.flatMap((p) => (p.lat != null && p.lng != null ? [{ lat: p.lat, lng: p.lng }] : []))
        : shownStops.map((s) => ({ lat: s.lat, lng: s.lng })),
    [isFinder, results, shownStops],
  );

  const addByPlace = useCallback((place: MappablePlace) => {
    if (place.lat == null || place.lng == null) return;
    setStops((s) => addStop(s, stopFrom(place)));
    setFilters((f) => ({ ...f, tab: "trips" }));
  }, []);

  const addByCoords = useCallback((lat: number, lng: number) => {
    setStops((s) =>
      addStop(s, stopAt(`${formatDms(lat, "lat")} ${formatDms(lng, "lng")}`, lat, lng)),
    );
  }, []);

  /**
   * The map fires mousemove continuously. Storing a fresh {lat, lng} object each
   * time re-rendered the whole planner -- toolbar, panel, itinerary and the map
   * component itself -- on every pointer move, to redraw a readout that changes
   * in its last decimal place. Returning the previous object when the value
   * rounds to the same four decimal places, about 11m, lets React bail out of
   * the update entirely.
   */
  const onCursor = useCallback((lat: number, lng: number) => {
    setCursor((prev) =>
      prev && prev.lat.toFixed(4) === lat.toFixed(4) && prev.lng.toFixed(4) === lng.toFixed(4)
        ? prev
        : { lat, lng },
    );
  }, []);

  const onDrop = useCallback(() => {
    // Read drag from the closure rather than reaching into it from inside a
    // setState updater. An updater that calls another setState is a side effect
    // during the render phase, which React is entitled to run twice.
    if (!drag) return;
    setStops((s) => moveStop(s, drag.from, drag.to).items);
    setDrag(null);
  }, [drag]);

  const onNudge = useCallback((index: number, delta: -1 | 1) => {
    setStops((s) => nudgeStop(s, index, delta));
  }, []);

  return (
    <div className="fk-page">
      {/* Measured: header.page-header is 34px tall, display flex, on #615f5c. */}
      <header className="fk-bar">
        <span className="fk-bar__logo">FURKOT</span>
        <div className="fk-bar__group">
          <button type="button" className="fk-ibtn" title="New trip" aria-label="New trip" onClick={openDialog}>
            ⊕
          </button>
          <span className="fk-bar__divider" />
          <button type="button" className="fk-ibtn" title="Fullscreen" aria-label="Fullscreen">
            ⛶
          </button>
        </div>
        <div className="fk-bar__spacer" />
        {/* A button, not a link to nowhere. The reference's SIGN UP goes to an
            account page this clone does not have, and an anchor to a missing id
            that silently does nothing is worse than a control that says why. */}
        <button type="button" className="fk-cta" title="Accounts are not part of this clone">
          Sign up
        </button>
        <button type="button" className="fk-ibtn" title="Menu" aria-label="Menu">
          ☰
        </button>
      </header>

      <div className="fk-stage">
        <PlannerMap
          stops={shownStops}
          results={isFinder ? results : []}
          loop={endpoints.loop}
          onPick={addByCoords}
          onCursor={onCursor}
          onViewChange={setZoom}
          fitTo={fitTo}
          fitNonce={fitNonce}
        />

        {/* Screenshot, not measured. The right-hand stack reads TRIPS, PLAN,
            SLEEP, EAT, FIND downwards, each a rotated orange tab. */}
        <nav className="fk-tabs" aria-label="Planner sections">
          {TABS_IN_UI.map((t) => (
            <button
              key={t}
              type="button"
              className="fk-tab"
              aria-pressed={filters.tab === t}
              onClick={() => setFilters((f) => ({ ...f, tab: f.tab === t ? "none" : t }))}
            >
              {t}
            </button>
          ))}
        </nav>

        <nav className="fk-tabs--left-wrap" aria-label="Trip list">
          <button
            type="button"
            className="fk-tab"
            aria-pressed={filters.tab === "trips"}
            onClick={() => setFilters((f) => ({ ...f, tab: f.tab === "trips" ? "none" : "trips" }))}
          >
            My trips
          </button>
        </nav>

        <div className="fk-scalebar" aria-hidden="true">
          <div className="fk-scalebar__rule" style={{ width: `${scale.px}px` }} />
          {scale.label}
        </div>

        {cursor && (
          <p className="fk-coords" aria-hidden="true">
            {formatDms(cursor.lat, "lat")}, {formatDms(cursor.lng, "lng")}
          </p>
        )}

        {/* Shown only once the pointer has actually been over the map. It used to
            fall back to 0,0, which is a real place in the Gulf of Guinea: click
            the bubble before moving the mouse and the trip acquired a stop in
            the Atlantic. */}
        {filters.tab === "none" && cursor && (
          <button type="button" className="fk-hint" onClick={() => addByCoords(cursor.lat, cursor.lng)}>
            Click to add a new stop here
          </button>
        )}

        {filters.tab !== "none" && (
          <aside className="fk-panel" aria-label={PANEL_TITLE[filters.tab]}>
            <div className="fk-panel__head">
              {PANEL_TITLE[filters.tab]}
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="fk-ibtn"
                onClick={() => setFilters((f) => ({ ...f, tab: "none" }))}
                aria-label="Close panel"
              >
                ✕
              </button>
            </div>

            <div className="fk-panel__body">
              {filters.tab === "trips" && (
                <>
                  <div className="fk-stats">
                    <div className="fk-stat">
                      <b>{stops.length}</b>
                      <span>Stops</span>
                    </div>
                    <div className="fk-stat">
                      <b>{shownTotal.toLocaleString()} km</b>
                      <span>Distance</span>
                    </div>
                    <div className="fk-stat">
                      <b>{days || "—"}</b>
                      <span>Days</span>
                    </div>
                    <div className="fk-stat">
                      <b>{Math.round(totalStay / 60)} h</b>
                      <span>On site</span>
                    </div>
                  </div>
                  <p className="fk-note">
                    Drag a row to reorder, or use the arrows. The route and the
                    distances update as you go.
                  </p>
                  <Itinerary
                    stops={stops}
                    plans={plans}
                    legs={legs}
                    drag={drag}
                    onDragStart={(i) => setDrag({ from: i, to: i })}
                    onDragOver={(i) => setDrag((d) => (d ? { ...d, to: i } : d))}
                    onDrop={onDrop}
                    onNudge={onNudge}
                    onRemove={(id) => setStops((s) => removeStop(s, id))}
                    onStay={(id, minutes) => setStops((s) => updateStop(s, id, { minutes }))}
                  />
                  <div className="fk-panel__foot">
                    <button type="button" className="fk-btn" onClick={openDialog}>
                      Edit trip
                    </button>
                    <button type="button" className="fk-btn fk-btn--ghost" onClick={() => setStops([])}>
                      Clear
                    </button>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="fk-btn fk-btn--ghost"
                      onClick={() => setFitNonce((n) => n + 1)}
                    >
                      Fit map
                    </button>
                  </div>
                </>
              )}

              {filters.tab === "plan" && (
                <>
                  <p className="fk-note">
                    Furkot&apos;s daily limits, in kilometres and hours. Leave one at
                    0 for no limit.
                  </p>
                  <label className="fk-field">
                    <span className="fk-field__label">Start point</span>
                    <input
                      className="fk-input"
                      value={endpoints.start}
                      onChange={(e) => patchEndpoints({ start: e.target.value })}
                    />
                  </label>
                  <label className="fk-check">
                    <input
                      type="checkbox"
                      checked={endpoints.loop}
                      onChange={(e) => patchEndpoints({ loop: e.target.checked })}
                    />
                    <span className="fk-check__box" aria-hidden="true" />
                    <span>Loop back to the start</span>
                  </label>
                  <label className="fk-field">
                    <span className="fk-field__label">
                      {endpointPlaceholderFor(endpoints.loop)}
                    </span>
                    <input
                      className="fk-input"
                      value={endpoints[endpointFieldFor(endpoints.loop)]}
                      placeholder={endpointPlaceholderFor(endpoints.loop)}
                      onChange={(e) =>
                        patchEndpoints(
                          endpoints.loop ? { mid: e.target.value } : { end: e.target.value },
                        )
                      }
                    />
                  </label>
                  <p className="fk-note">{endpointHintFor(endpoints.loop)}</p>

                  <hr style={{ border: 0, borderTop: "1px solid #e2e2e2", margin: "12px 0" }} />

                  <label className="fk-field">
                    <span className="fk-field__label">Max km per day (0 = no limit)</span>
                    <input
                      className="fk-input"
                      type="number"
                      min={0}
                      step={50}
                      value={maxDailyKm}
                      onChange={(e) => setMaxDailyKm(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </label>
                  <label className="fk-field">
                    <span className="fk-field__label">Max driving hours per day</span>
                    <input
                      className="fk-input"
                      type="number"
                      min={0}
                      step={1}
                      value={maxDrivingHours}
                      onChange={(e) => setMaxDrivingHours(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </label>
                  <label className="fk-field">
                    <span className="fk-field__label">Max days (0 = keep all)</span>
                    <input
                      className="fk-input"
                      type="number"
                      min={0}
                      step={1}
                      value={maxDays}
                      onChange={(e) => setMaxDays(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </label>
                  <p className="fk-note">
                    {maxDays > 0 && shownStops.length < stops.length
                      ? `Trimmed to ${shownStops.length} of ${stops.length} stops: ${shownTotal} km instead of ${totalKm} km.`
                      : `${shownStops.length} stops, ${shownTotal} km over ${days || 0} day${days === 1 ? "" : "s"}.`}
                  </p>
                </>
              )}

              {isFinder && (
                <>
                  <div className="fk-filters">
                    <label className="fk-field">
                      <span className="fk-field__label">Search</span>
                      <input
                        className="fk-input"
                        value={filters.query}
                        placeholder="City, country or place"
                        onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
                      />
                    </label>
                    <label className="fk-field">
                      <span className="fk-field__label">Region</span>
                      <select
                        className="fk-select"
                        value={filters.region}
                        onChange={(e) =>
                          // Changing the region invalidates the country, so it is
                          // cleared rather than left pointing at a country that is
                          // no longer in the list.
                          setFilters((f) => ({ ...f, region: e.target.value, country: "" }))
                        }
                      >
                        <option value="">All</option>
                        {REGION_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="fk-field">
                      <span className="fk-field__label">Country</span>
                      <select
                        className="fk-select"
                        value={filters.country}
                        onChange={(e) =>
                          setFilters((f) => ({
                            ...f,
                            country: codeForCountry(PLOTTABLE, e.target.value),
                          }))
                        }
                      >
                        <option value="">All</option>
                        {countries.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <p className="fk-count" role="status">
                    {results.length} of {PLOTTABLE.length} places
                    {finderOrder === "country" && " · by country"}
                    {finderOrder === "nearest" &&
                      (origin
                        ? " · nearest to your first stop"
                        : " · add a stop to sort by distance")}
                  </p>

                  {results.length === 0 ? (
                    <p className="fk-empty">
                      Nothing matches. Widen the region or clear the search.
                    </p>
                  ) : (
                    <ul className="fk-results">
                      {listed.map((p) => {
                        const inTrip = stops.some((s) => s.name === p.name);
                        return (
                          <li key={p.name}>
                            <button
                              type="button"
                              className="fk-result"
                              onClick={() => addByPlace(p)}
                              aria-label={`Add ${p.name} to the trip`}
                            >
                              <span>
                                <span className="fk-result__name">{p.name}</span>
                                <br />
                                <span className="fk-result__meta">
                                  {p.country} · {p.region}
                                </span>
                              </span>
                              <span className="fk-result__add" aria-hidden="true">
                                {inTrip ? "✓" : "+"}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </div>
          </aside>
        )}
      </div>

      {dialog && (
        <PlanTripDialog
          endpoints={endpoints}
          onChange={patchEndpoints}
          onClose={closeDialog}
          onPlan={plan}
        />
      )}
    </div>
  );
}
