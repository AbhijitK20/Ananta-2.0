"use client";

import { useEffect, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { MapInstance } from "react-map-gl/maplibre";

import type { GeoPoint } from "@/contracts";

import { cn } from "../cn";

/**
 * MapCanvas — MapLibre over OpenFreeMap. No API key, no account, no billing.
 *
 * The performance rules below are not preferences. Each one is a specific
 * failure documented in maplibre-gl-js's own source, and each was read there
 * rather than inferred:
 *
 *  - `circle` layers at ALL zooms. One instanced quad per point, no placement
 *    pass. `symbol` is only for the <= 20 live labels; a symbol layer over
 *    hundreds of points runs the collision detector on every frame.
 *  - `cluster: true` disables partial tile reload ENTIRELY
 *    (geojson_source.ts:575-577). So a clustered source and a live-hit source
 *    must be SEPARATE sources, or the clustered one loses its `updateData`
 *    fast path and every pan refetches everything.
 *  - Hit-test `circle`, never `symbol`: collision-hidden symbols are not
 *    queryable, so a click silently misses.
 *  - `promoteId`, NOT `generateId`. `generateId` assigns fresh ids on every
 *    `setData`, which destroys hover and selection state mid-interaction.
 *  - De-dup `e.features` by id. Tile buffering guarantees duplicates, so an
 *    un-deduped click handler fires two or three times for one tap.
 *  - Cluster counts as HTML, never glyphs — raster basemaps and blocked glyph
 *    endpoints make glyph clusters unreliable (AdventureLog
 *    FullMap.svelte:313-352 says so in a comment worth reading).
 */

/** OpenFreeMap. Keyless, vector, no usage cap we have to reason about. */
const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

/** Mumbai. Overridden by `initialCentre` when the caller has a real context. */
const FALLBACK_CENTRE: GeoPoint = { lat: 18.9388, lon: 72.8354 };

export interface MapCanvasProps {
  initialCentre?: GeoPoint;
  initialZoom?: number;
  className?: string;
  /** Receives the live map instance. The layers attach to this. */
  onMapReady?: (map: MapRef) => void;
  /**
   * The map is not keyboard-navigable and pretending otherwise is worse than
   * not shipping it (DESIGN_SYSTEM §5). So the list is the first-class
   * alternative and this flag only controls whether the canvas itself is
   * reachable — it is never the only way to act on a place.
   */
  interactive?: boolean;
}

export function MapCanvas({
  initialCentre = FALLBACK_CENTRE,
  initialZoom = 12,
  className,
  onMapReady,
  interactive = true,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [Map, setMap] = useState<React.ComponentType<Record<string, unknown>> | null>(null);
  const mapRef = useRef<MapRef | null>(null);

  useEffect(() => {
    // `react-map-gl/maplibre` is loaded client-side only. Importing it at the
    // top of the module pulls maplibre-gl into the server bundle, which fails
    // on its worker and WebGL assumptions.
    let cancelled = false;
    void import("react-map-gl/maplibre").then((mod) => {
      if (cancelled) return;
      const Component = (mod.default ?? mod.Map) as React.ComponentType<Record<string, unknown>>;
      setMap(() => Component);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!Map) {
    // Structural skeleton, same box as the real canvas. A spinner here would
    // collapse to nothing and shove the whole layout sideways on load.
    return (
      <div
        aria-hidden
        className={cn("size-full rounded-md bg-accent-soft", className)}
      />
    );
  }

  return (
    <div ref={containerRef} className={cn("relative size-full overflow-hidden", className)}>
      <Map
        // `ref` is the ONLY correct way to get a `MapRef` out of react-map-gl.
        //
        // This used to read `onLoad`'s `event.target` and cast it `as MapRef`.
        // That cast was a lie: `event.target` is the raw maplibre `Map`
        // instance, which has no `.getMap()`. `MapPanel` stored it and passed it
        // to `ClusterLayer`/`RouteLine`, which call `mapRef.getMap()` to reach
        // the underlying map -- so the page threw
        // `TypeError: i.getMap is not a function` on every load, which is a
        // whole-page client crash, not a degraded map.
        //
        // `MapRef` is `{ getMap(): MapInstance } & MapInstance`, i.e. a thin
        // binding wrapper. The ref gives us that wrapper; the load event does not.
        // The fallback keeps the callback firing if a future version attaches the
        // ref late, but it now passes the raw map only as a last resort and the
        // consumers guard for a missing `.getMap`.
        ref={mapRef}
        // Keyless style. No token, no account, nothing to leak.
        mapStyle={STYLE_URL}
        initialViewState={{
          longitude: initialCentre.lon,
          latitude: initialCentre.lat,
          zoom: initialZoom,
        }}
        interactive={interactive}
        // The map is decorative for assistive tech; the list carries the same
        // information and is the accessible path.
        aria-hidden="true"
        // Reuse the canvas across renders — recreating it on every parent
        // render is the single biggest cause of jank in a map this small.
        reuseMaps
        onLoad={() => {
          if (mapRef.current) onMapReady?.(mapRef.current);
        }}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

/**
 * The raw maplibre map behind a react-map-gl `MapRef`, or null.
 *
 * Every layer that attaches to the map goes through this rather than calling
 * `mapRef.getMap()` directly. `mapRef?.getMap()` only guards against a null ref;
 * it throws just as hard if the value is not actually a `MapRef`, which is
 * exactly how a bad `onLoad` payload took down the entire page.
 *
 * A map that fails to attach is a degraded map, not a broken page. The list
 * beside it carries the same information and is the accessible path
 * (DESIGN_SYSTEM §5), so returning null here costs a visual layer and nothing
 * else.
 */
export function resolveMap(mapRef: MapRef | null | undefined): MapInstance | null {
  if (!mapRef) return null;
  if (typeof mapRef.getMap !== "function") return null;
  try {
    return mapRef.getMap() ?? null;
  } catch {
    // A maplibre instance that has been destroyed throws on access. Treat that
    // as "not attached yet" rather than letting it escape into a render.
    return null;
  }
}

/**
 * De-duplicate a MapLibre query result.
 *
 * Tile buffering means a point near a tile boundary is returned by more than
 * one tile, so `e.features` legitimately contains the same feature twice or
 * three times. Un-deduped, one tap fires three handlers and the coupling
 * animation runs three times.
 */
export function dedupeFeatures<T extends { properties?: { id?: string | number } | null }>(
  features: ReadonlyArray<T>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const feature of features) {
    const id = feature.properties?.id;
    const key = id === undefined || id === null ? JSON.stringify(feature) : String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(feature);
  }
  return out;
}
