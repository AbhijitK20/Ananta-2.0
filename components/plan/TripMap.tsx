"use client";

/**
 * The map: Furkot's centre panel.
 *
 * MapLibre GL over OpenFreeMap's Liberty style. Both were chosen for the same
 * reason: no API key and no usage cap, so the map is not something that stops
 * working when someone forgets to paste a token into an env file. There is no
 * `.env` in this project and adding one for a basemap would be the only such
 * dependency in it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRAWN, AND WHY NONE OF IT IS A REAL VENUE PIN
 * ---------------------------------------------------------------------------
 *
 * Stops sit at their city's centroid, because the directory holds no coordinates
 * for the 892 places themselves. See the note at the top of `lib/plan/geo.ts`. A
 * pin at a city centre is visibly a city rather than a confident marker on the
 * wrong rooftop, and the map says so in a caption over its own bottom edge.
 *
 * The route polyline is real road geometry from OSRM, drawn one feature per leg
 * so each day gets its own colour the way Furkot does. A leg that fell back to an
 * estimate has no geometry, so it is joined by a straight line and the `basis`
 * property routes it to a dashed layer — a visibly provisional route rather than a
 * smooth invented one.
 */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

import { useEffect, useRef } from "react";

import { CITY_COORD_COUNT, MANUAL_COORD_COUNT, boundsOf, type Bounds } from "../../lib/plan/geo";
import { PLACES } from "../../lib/plan/places";
import { usePlan } from "../../lib/plan/store";
import type { Leg, Stop } from "../../lib/plan/types";

const STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** Furkot colours a route per day. Kept in step with the `--lp-day-*` list in
 *  scripts/check.ts, which asserts the two never drift apart. */
const DAY_COLORS = [
  "#b833ab", "#1f6feb", "#0a7c5a", "#b8330a",
  "#7a3fb8", "#0f6f8f", "#8a6d00", "#5a3fbf",
] as const;

const dayColor = (i: number) => DAY_COLORS[i % DAY_COLORS.length];

export function TripMap({
  onPick,
}: {
  /** Called with the clicked coordinate, for dropping a pin. */
  onPick?: (at: { lat: number; lon: number }) => void;
}) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  /** The set of points last fitted to, so a re-render does not keep yanking the
   *  view out from under someone who has panned away. */
  const fitted = useRef<string>("");

  const { routed, trip, legs, days, selectedId, select } = usePlan();

  const skippedStops = trip.stops.filter((s) => s.skipped);
  const points = [...routed, ...skippedStops];

  /* ---- create once ------------------------------------------------------ */

  useEffect(() => {
    if (!container.current || map.current) return;

    const instance = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [12, 45],
      zoom: 3.2,
      attributionControl: false,
    });
    map.current = instance;

    instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    instance.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: "OpenFreeMap · OSRM",
      }),
      "bottom-right",
    );

    instance.on("load", () => {
      instance.addSource("route", { type: "geojson", data: emptyCollection() });
      // Two layers over one source. The filter reads a feature property rather
      // than needing a second source kept in sync by hand.
      instance.addLayer({
        id: "route-routed",
        type: "line",
        source: "route",
        filter: ["==", ["get", "basis"], "routed"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "colour"], "line-width": 4, "line-opacity": 0.85 },
      });
      instance.addLayer({
        id: "route-estimated",
        type: "line",
        source: "route",
        filter: ["==", ["get", "basis"], "estimated"],
        layout: { "line-cap": "butt" },
        paint: {
          "line-color": ["get", "colour"],
          "line-width": 2.5,
          "line-dasharray": [1, 2],
          "line-opacity": 0.7,
        },
      });
      ready.current = true;
    });

    return () => {
      ready.current = false;
      markers.current.forEach((m) => m.remove());
      markers.current = [];
      map.current = null;
      instance.remove();
    };
  }, []);

  /* ---- draw the route --------------------------------------------------- */

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready.current) return;
    const source = instance.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (!source) return;
    source.setData(buildRouteFeature(legs, days, new Map(trip.stops.map((s) => [s.id, s]))));
  }, [legs, days, trip.stops]);

  /* ---- draw the stops --------------------------------------------------- */

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    markers.current.forEach((m) => m.remove());
    markers.current = [];

    points.forEach((stop, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = stop.skipped ? "lp-pin lp-pin--skipped" : "lp-pin";
      el.textContent = String(i + 1);
      el.title = stop.name;
      el.setAttribute("aria-label", stop.name);
      if (stop.id === selectedId) el.classList.add("lp-pin--selected");
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        select(stop.id);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([stop.at.lon, stop.at.lat])
        .addTo(instance);
      markers.current.push(marker);
    });
  }, [points, selectedId, select]);

  /* ---- fit the view ----------------------------------------------------- */

  useEffect(() => {
    const instance = map.current;
    if (!instance || points.length === 0) return;

    const key = points.map((p) => `${p.at.lat},${p.at.lon}`).join("|");
    if (key === fitted.current) return;
    fitted.current = key;

    // One stop has no extent to fit, so it is centred instead. Two stops a few
    // hundred metres apart would otherwise fit to zoom 20 and show two
    // overlapping pins, which is why maxZoom is capped rather than left open.
    if (points.length === 1) {
      instance.flyTo({ center: [points[0].at.lon, points[0].at.lat], zoom: 9 });
      return;
    }

    const bounds = boundsOf(points.map((p) => p.at));
    if (!bounds) return;
    instance.fitBounds(toLngLatBounds(pad(bounds, 0.15)), {
      padding: 56,
      maxZoom: 11,
      duration: 600,
    });
  }, [points]);

  /* ---- click to drop a pin --------------------------------------------- */

  useEffect(() => {
    const instance = map.current;
    if (!instance || !onPick) return;

    const handler = (event: maplibregl.MapMouseEvent) => {
      onPick({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    };
    instance.on("click", handler);
    return () => {
      instance.off("click", handler);
    };
  }, [onPick]);

  const fitAll = () => {
    const instance = map.current;
    if (!instance || !points.length) return;
    const bounds = boundsOf(points.map((p) => p.at));
    if (!bounds) return;
    instance.fitBounds(toLngLatBounds(pad(bounds, 0.15)), { padding: 56, maxZoom: 11 });
  };

  return (
    <div className="lp-map">
      <div ref={container} className="lp-map__canvas" data-testid="map-canvas" />

      <div className="lp-map__bar">
        <button type="button" onClick={fitAll} disabled={!points.length}>
          Show the whole trip
        </button>
        <span className="lp-map__count">
          {points.length} stop{points.length === 1 ? "" : "s"}
          {skippedStops.length > 0 ? ` · ${skippedStops.length} skipped` : ""}
        </span>
      </div>

      {points.length > 0 ? (
        <p className="lp-map__caveat">
          Pins sit at each city&apos;s centre, not on the venue: the directory carries
          no coordinates for the {PLACES.length.toLocaleString()} places themselves.
          {MANUAL_COORD_COUNT} of the {CITY_COORD_COUNT} city centroids here are
          hand-entered.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Geometry assembly
 * -------------------------------------------------------------------------- */

type RouteCollection = GeoJSON.FeatureCollection<GeoJSON.LineString>;

const emptyCollection = (): RouteCollection => ({ type: "FeatureCollection", features: [] });

/**
 * One feature per leg, carrying the day index and whether it was routed.
 *
 * The day index is resolved here rather than in the store because it is a
 * function of the split, and the split is already derived — storing a day number
 * on a leg would create a second source of truth for something derivable.
 */
function buildRouteFeature(
  legs: readonly Leg[],
  days: readonly { stopIds: string[] }[],
  byId: ReadonlyMap<string, Stop>,
): RouteCollection {
  const dayOfStop = new Map<string, number>();
  days.forEach((day, i) => day.stopIds.forEach((id) => dayOfStop.set(id, i)));

  const features: RouteCollection["features"] = [];

  for (const leg of legs) {
    const from = byId.get(leg.fromId);
    const to = byId.get(leg.toId);
    if (!from || !to) continue;

    const coordinates: [number, number][] =
      leg.geometry && leg.geometry.length >= 2
        ? leg.geometry
        : [
            [from.at.lon, from.at.lat],
            [to.at.lon, to.at.lat],
          ];

    features.push({
      type: "Feature",
      properties: { basis: leg.basis, colour: dayColor(dayOfStop.get(leg.fromId) ?? 0) },
      geometry: { type: "LineString", coordinates },
    });
  }

  return { type: "FeatureCollection", features };
}

function toLngLatBounds(b: Bounds): [[number, number], [number, number]] {
  return [
    [b.minLon, b.minLat],
    [b.maxLon, b.maxLat],
  ];
}

/** Grow a box by a fraction of its own size, so pins are never on the edge.
 *  The `|| 0.5` is for a zero-extent box — a whole trip in one city — where
 *  multiplying zero by anything stays zero and fitBounds rejects it. */
function pad(b: Bounds, by: number): Bounds {
  const dLon = (b.maxLon - b.minLon) * by || 0.5;
  const dLat = (b.maxLat - b.minLat) * by || 0.5;
  return {
    minLon: b.minLon - dLon,
    maxLon: b.maxLon + dLon,
    minLat: b.minLat - dLat,
    maxLat: b.maxLat + dLat,
  };
}
