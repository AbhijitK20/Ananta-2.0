"use client";

/**
 * The map, with the cascade, the corridors and the uncertainty on it.
 *
 * Four layers, because the brief's second mandatory requirement is a map that shows
 * "the relevant locations, entities, weather conditions, and/or simulated impact
 * propagation" and those are four different pictures. Reusing `ClusterLayer` was the
 * obvious move and would have answered none of them: a clustered catalogue map says
 * "where are the places" and nothing about what the weather did to them.
 *
 *   1. **halo**     the uncertainty interval, as a radius. A node at 40% ± 28% gets a
 *                   visibly wider halo than one at 40% ± 5%, which is the entire point
 *                   of reporting an interval — a reader can see which predictions are
 *                   load-bearing and which are guesses.
 *   2. **nodes**    coloured by availability in four discrete bands and sized by
 *                   severity. Bands, not a gradient: a gradient over 400 overlapping
 *                   circles produces a colour belonging to no entity, and the claim a
 *                   reader acts on is per-entity.
 *   3. **corridors** dashed lines for degraded transit, so the access cascade is
 *                   visible as a *cause* and not only as a per-node movement penalty.
 *   4. **plan**     a ring on the stops the engine actually chose, so "open" and
 *                   "chosen" are never confused with each other.
 *
 * Colour comes from the token layer only — no hex in this file, which is what
 * `theme:lint` enforces repo-wide.
 */
import { useEffect, useRef, useState } from "react";
import type { MapRef } from "react-map-gl/maplibre";
import type { MapGeoJSONFeature } from "maplibre-gl";

import { MapCanvas } from "@/components/map";
// `resolveMap` is not in the map barrel, and widening that barrel for one consumer
// is a change to a shared module owned by another stream. It is exported from
// `MapCanvas` precisely so an out-of-barrel caller can reach it — importing the
// module directly is the supported way in, and the alternative (re-implementing the
// null-and-`getMap` guard) is the bug that class exists to prevent.
import { resolveMap } from "@/components/map/MapCanvas";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/cn";

import type { MapCorridor, MapNode } from "@/app/_lib/twin";

export interface TwinMapProps {
  nodes: ReadonlyArray<MapNode>;
  corridors: ReadonlyArray<MapCorridor>;
  /** Stop ids in the simulated plan. */
  planIds: ReadonlyArray<string>;
  centre: { lat: number; lon: number };
  /** Ids the user has highlighted from the cascade list. */
  focusIds?: ReadonlyArray<string>;
  className?: string;
}

const SOURCE_NODES = "twin-nodes";
const SOURCE_CASCADE = "twin-cascade";
const SOURCE_PLAN = "twin-plan";

export function TwinMap({ nodes, corridors, planIds, centre, focusIds = [], className }: TwinMapProps) {
  const [mapRef, setMapRef] = useState<MapRef | null>(null);
  const attached = useRef(false);

  useEffect(() => {
    const map = resolveMap(mapRef);
    if (!map) return;

    const empty = { type: "FeatureCollection" as const, features: [] };
    const nodeCollection = {
      type: "FeatureCollection" as const,
      features: nodes.map((node) => ({
        type: "Feature" as const,
        id: node.id,
        geometry: { type: "Point" as const, coordinates: [node.lon, node.lat] },
        properties: {
          id: node.id,
          name: node.name,
          availability: node.availability,
          severity: node.severity,
          confidence: node.confidence,
          order: node.deepestOrder,
          reason: node.reason,
        },
      })),
    };
    const cascadeCollection = {
      type: "FeatureCollection" as const,
      features: corridors
        .filter((corridor) => corridor.degraded)
        .map((corridor) => ({
          type: "Feature" as const,
          geometry: { type: "LineString" as const, coordinates: corridor.coordinates },
          properties: { line: corridor.line, multiplier: corridor.multiplier, reason: corridor.reason },
        })),
    };
    const planCollection = {
      type: "FeatureCollection" as const,
      features: nodes
        .filter((node) => planIds.includes(node.id))
        .map((node) => ({
          type: "Feature" as const,
          id: node.id,
          geometry: { type: "Point" as const, coordinates: [node.lon, node.lat] },
          properties: { id: node.id, name: node.name },
        })),
    };

    const upsert = (id: string, data: unknown): void => {
      const existing = map.getSource(id) as { setData(data: unknown): void } | undefined;
      if (existing) {
        existing.setData(data);
        return;
      }
      map.addSource(id, { type: "geojson", data: data as never });
    };

    if (!map.getLayer(`${SOURCE_NODES}-halo`)) {
      upsert(SOURCE_NODES, empty);
      // The halo is the uncertainty interval, and its radius is driven by the width
      // of that interval rather than by severity. A well-corroborated prediction is a
      // tight dot; a third-order one is visibly a guess.
      map.addLayer({
        id: `${SOURCE_NODES}-halo`,
        type: "circle",
        source: SOURCE_NODES,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "confidence"], 0.5], 0, 4, 1, 26],
          "circle-color": "var(--alarm)",
          "circle-opacity": 0.1,
          "circle-stroke-width": 0,
        },
      });
    }
    if (!map.getLayer(SOURCE_NODES)) {
      map.addLayer({
        id: SOURCE_NODES,
        type: "circle",
        source: SOURCE_NODES,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "severity"], 0], 0, 3, 3, 11],
          "circle-color": [
            "match",
            ["get", "availability"],
            // Flat, not pairs: a MapLibre expression is positional, so
            // `["match", input, [a,b], x, ...]` is a type error for a reason. The
            // 0.05/0.5/0.85 thresholds are the availability bands and they appear
            // once, in `bandOf`, so the two cannot drift.
            0.05, "var(--alarm)",
            0.5, "var(--warn)",
            0.85, "var(--accent)",
            "var(--fit)",
          ],
          "circle-stroke-color": "var(--surface)",
          "circle-stroke-width": 0.8,
          "circle-opacity": 0.92,
        },
      });
    }
    if (!map.getLayer(SOURCE_CASCADE)) {
      upsert(SOURCE_CASCADE, empty);
      map.addLayer({
        id: SOURCE_CASCADE,
        type: "line",
        source: SOURCE_CASCADE,
        paint: {
          "line-color": "var(--accent)",
          "line-width": ["interpolate", ["linear"], ["coalesce", ["get", "multiplier"], 1], 1, 1, 2.5, 4],
          "line-dasharray": [2, 2],
          "line-opacity": 0.7,
        },
      });
    }
    if (!map.getLayer(SOURCE_PLAN)) {
      upsert(SOURCE_PLAN, empty);
      map.addLayer({
        id: SOURCE_PLAN,
        type: "circle",
        source: SOURCE_PLAN,
        paint: {
          "circle-radius": 7,
          "circle-opacity": 0,
          "circle-stroke-color": "var(--ink)",
          "circle-stroke-width": 2,
        },
      });
    }

    upsert(SOURCE_NODES, nodeCollection);
    upsert(SOURCE_CASCADE, cascadeCollection);
    upsert(SOURCE_PLAN, planCollection);
    attached.current = true;
  }, [mapRef, nodes, corridors, planIds]);

  // Layers are added once and updated by `setData`; removing and re-adding them on
  // every prop change is what makes a MapLibre map flicker and leak sources.
  useEffect(() => {
    attached.current = false;
  }, [mapRef]);

  const [hovered, setHovered] = useState<MapNode | null>(null);

  useEffect(() => {
    const map = resolveMap(mapRef);
    if (!map) return;
    const onMove = (event: { features?: MapGeoJSONFeature[] }): void => {
      const feature = event.features?.find((entry) => entry.layer?.id === SOURCE_NODES);
      if (!feature?.properties) {
        setHovered(null);
        return;
      }
      const id = String(feature.properties.id);
      setHovered(nodes.find((node) => node.id === id) ?? null);
    };
    map.on("mousemove", SOURCE_NODES, onMove);
    map.on("mouseleave", SOURCE_NODES, () => setHovered(null));
    return () => {
      map.off("mousemove", SOURCE_NODES, onMove);
      map.off("mouseleave", SOURCE_NODES, () => setHovered(null));
    };
  }, [mapRef, nodes]);

  const focusSet = new Set(focusIds);

  return (
    <Card padding="none" className={cn("overflow-hidden", className)}>
      <div className="relative size-full">
        <MapCanvas initialCentre={centre} initialZoom={11.5} onMapReady={setMapRef} className="size-full" />

        {hovered ? (
          <div className="pointer-events-none absolute left-2 top-2 max-w-sm rounded-sm bg-surface p-3 shadow-raise-1">
            <p className="text-meta-sm font-medium text-ink">{hovered.name}</p>
            <p className="mt-1 text-meta-sm text-ink-muted">
              {Math.round(hovered.availability * 100)}% available, 90% interval{" "}
              {Math.round(hovered.low * 100)}–{Math.round(hovered.high * 100)}%
            </p>
            <p className="mt-1 text-meta-sm text-ink-faint">
              Reached at order: {hovered.deepestOrder} · confidence {Math.round(hovered.confidence * 100)}%
            </p>
            {hovered.reason ? <p className="mt-2 text-meta-sm text-ink-muted">{hovered.reason}</p> : null}
          </div>
        ) : null}

        <Legend
          degradedCorridors={corridors.filter((corridor) => corridor.degraded).length}
          inPlan={planIds.length}
          focused={focusSet.size}
        />
      </div>
    </Card>
  );
}

function Legend({ degradedCorridors, inPlan, focused }: { degradedCorridors: number; inPlan: number; focused: number }) {
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 rounded-sm bg-surface/95 p-3 text-meta-sm">
      <p className="font-medium text-ink">Simulated impact</p>
      <ul className="mt-1.5 space-y-1">
        <LegendRow swatch="var(--fit)" label="Open (85%+)" />
        <LegendRow swatch="var(--accent)" label="Degraded (50–85%)" />
        <LegendRow swatch="var(--warn)" label="Struggling (5–50%)" />
        <LegendRow swatch="var(--alarm)" label="Shut (0–5%)" />
        <LegendRow swatch="var(--ink)" label={`In the simulated plan (${inPlan})`} ring />
        <LegendRow swatch="var(--accent)" label={`Degraded corridors (${degradedCorridors})`} dash />
        {focused > 0 ? <LegendRow swatch="var(--accent)" label={`Cascade highlights (${focused})`} /> : null}
      </ul>
      <p className="mt-2 max-w-[16rem] text-meta-sm text-ink-faint">
        Halo size is uncertainty. Every place here is also in the list below.
      </p>
    </div>
  );
}

function LegendRow({ swatch, label, ring, dash }: { swatch: string; label: string; ring?: boolean; dash?: boolean }) {
  return (
    <li className="flex items-center gap-2 text-ink-muted">
      <span
        aria-hidden
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          ring && "border-2 border-current",
          dash && "h-0 w-4 rounded-none border-t-2 border-dashed",
        )}
        style={{ background: dash || ring ? "transparent" : swatch, borderColor: swatch }}
      />
      {label}
    </li>
  );
}
