import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bboxContains,
  bboxExpand,
  bboxIntersects,
  bboxOf,
  buildRadiusGraph,
  connectedComponents,
  haversineMetres,
  isochroneAreaSqm,
  isochroneContains,
  isoArea,
  loadAllIsochrones,
  loadIsochrone,
  mercatorMetres,
  neighbourhood,
  parseIsochrone,
  pointInPolygon,
  pointInRing,
  polygonAreaSqm,
  ringAreaSqm,
  smallestContaining,
} from "../src/engine/geo";
import type { GeoPoint } from "@/contracts";

const BANDRA: GeoPoint = { lat: 19.0596, lon: 72.8296 };
const COLABA: GeoPoint = { lat: 18.9216, lon: 72.8382 };
const WORLI: GeoPoint = { lat: 19.0266, lon: 72.8447 };

function squareM(
  minLat: number,
  minLon: number,
  sizeDeg: number,
): GeoPoint[] {
  return [
    { lat: minLat, lon: minLon },
    { lat: minLat, lon: minLon + sizeDeg },
    { lat: minLat + sizeDeg, lon: minLon + sizeDeg },
    { lat: minLat + sizeDeg, lon: minLon },
  ];
}

describe("haversineMetres", () => {
  it("is zero for the same point", () => {
    expect(haversineMetres(BANDRA, BANDRA)).toBe(0);
  });

  it("matches the known Mumbai to Pune great-circle distance", () => {
    // Bandra West to Pune (18.5203, 73.8567) is ~123.6 km by great circle.
    const pune = { lat: 18.5203, lon: 73.8567 };
    const km = haversineMetres(BANDRA, pune) / 1000;
    expect(km).toBeGreaterThan(118);
    expect(km).toBeLessThan(128);
  });

  it("is symmetric", () => {
    expect(haversineMetres(BANDRA, COLABA)).toBeCloseTo(
      haversineMetres(COLABA, BANDRA),
      9,
    );
  });

  it("handles antimeridian adjacency without wrapping the long way", () => {
    const a = { lat: 0, lon: 179.9999 };
    const b = { lat: 0, lon: -179.9999 };
    expect(haversineMetres(a, b)).toBeLessThan(100);
  });
});

describe("mercatorMetres", () => {
  it("inflates north-south distance at Mumbai's latitude by 1/cos(lat)", () => {
    const north = { lat: 19.1, lon: 72.8296 };
    const ratio = mercatorMetres(BANDRA, north) / haversineMetres(BANDRA, north);
    // Mercator is a screen-space metric; the 5.8% is documented, not a bug.
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(1.07);
  });

  it("agrees with haversine along the equator", () => {
    const a = { lat: 0, lon: 0 };
    const b = { lat: 0, lon: 1 };
    expect(mercatorMetres(a, b)).toBeCloseTo(haversineMetres(a, b), 3);
  });
});

describe("bbox", () => {
  it("encloses every point", () => {
    const box = bboxOf([BANDRA, COLABA, WORLI]);
    expect(bboxContains(box, BANDRA)).toBe(true);
    expect(bboxContains(box, COLABA)).toBe(true);
    expect(bboxContains(box, WORLI)).toBe(true);
  });

  it("excludes a point outside", () => {
    const box = bboxOf([BANDRA, WORLI]);
    expect(bboxContains(box, COLABA)).toBe(false);
  });

  it("rejects an empty input rather than returning a nonsense box", () => {
    expect(() => bboxOf([])).toThrow(/at least one point/);
  });

  it("detects overlap and separation", () => {
    const a = bboxOf([BANDRA, WORLI]);
    const b = bboxOf([BANDRA, COLABA]);
    expect(bboxIntersects(a, b)).toBe(true);
    expect(bboxIntersects(a, { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 })).toBe(false);
  });

  it("expands by roughly the requested ground distance", () => {
    const box = bboxOf([BANDRA]);
    const grown = bboxExpand(box, 1000);
    const northEdge = haversineMetres(BANDRA, {
      lat: grown.maxLat,
      lon: BANDRA.lon,
    });
    expect(northEdge).toBeGreaterThan(950);
    expect(northEdge).toBeLessThan(1050);
  });
});

describe("pointInRing", () => {
  const square = squareM(19.0, 72.8, 0.01);

  it("accepts an interior point", () => {
    expect(pointInRing({ lat: 19.005, lon: 72.805 }, square)).toBe(true);
  });

  it("rejects an exterior point", () => {
    expect(pointInRing({ lat: 19.05, lon: 72.805 }, square)).toBe(false);
  });

  it("rejects a degenerate ring", () => {
    expect(pointInRing(BANDRA, [{ lat: 19, lon: 72.8 }, { lat: 19.01, lon: 72.81 }])).toBe(
      false,
    );
  });
});

describe("pointInPolygon", () => {
  const outer = squareM(19.0, 72.8, 0.02);
  const hole = squareM(19.005, 72.805, 0.005);

  it("accepts a point in the shell but outside the hole", () => {
    expect(pointInPolygon({ lat: 19.001, lon: 72.801 }, [outer])).toBe(true);
    expect(pointInPolygon({ lat: 19.001, lon: 72.801 }, [outer, hole])).toBe(true);
  });

  it("rejects a point inside a hole", () => {
    expect(pointInPolygon({ lat: 19.007, lon: 72.807 }, [outer, hole])).toBe(false);
  });

  it("rejects an empty polygon", () => {
    expect(pointInPolygon(BANDRA, [])).toBe(false);
  });
});

describe("areas", () => {
  it("computes a square's area to within 1%", () => {
    const side = 0.01;
    const actual = ringAreaSqm(squareM(19.0, 72.8, side));
    const northSouth = 0.01 * 111_320;
    const eastWest = 0.01 * 111_320 * Math.cos((19.005 * Math.PI) / 180);
    const expected = northSouth * eastWest;
    expect(Math.abs(actual - expected) / expected).toBeLessThan(0.01);
  });

  it("is zero for a degenerate ring", () => {
    expect(ringAreaSqm([])).toBe(0);
  });

  it("subtracts holes from the shell", () => {
    const solid = polygonAreaSqm([squareM(19.0, 72.8, 0.02)]);
    const holed = polygonAreaSqm([
      squareM(19.0, 72.8, 0.02),
      squareM(19.005, 72.805, 0.005),
    ]);
    expect(holed).toBeLessThan(solid);
  });

  it("reproduces the measured isochrone areas recorded in the repo", () => {
    const metrics = JSON.parse(
      readFileSync(`data/reference/isochrones/isochrone-metrics.json`, "utf8"),
    ) as { rows: { file: string; area_km2: number; vertices: number }[] };

    expect(metrics.rows.length).toBeGreaterThan(0);

    for (const row of metrics.rows) {
      const iso = parseIsochrone(
        JSON.parse(
          readFileSync(`data/reference/isochrones/${isoArea()}/${row.file}`, "utf8"),
        ) as unknown,
      );
      const oursKm2 = isochroneAreaSqm(iso) / 1_000_000;
      // The shipped figures are a ~1% planar approximation; we allow 3% for
      // the difference in mean-latitude handling.
      expect(
        Math.abs(oursKm2 - row.area_km2) / row.area_km2,
        `${row.file}: ours ${oursKm2.toFixed(4)} km2 vs recorded ${row.area_km2}`,
      ).toBeLessThan(0.03);
    }
  });
});

describe("parseIsochrone", () => {
  const raw = {
    features: [
      {
        properties: {
          hub: { lat: 19.0596, lon: 72.8296 },
          hub_name: "pali_hill",
          costing: "pedestrian",
          contour_minutes: 15,
          provider: "valhalla1.openstreetmap.de",
          bbox: [72.81, 19.04, 72.85, 19.07],
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [72.81, 19.04],
              [72.85, 19.04],
              [72.85, 19.07],
              [72.81, 19.07],
              [72.81, 19.04],
            ],
          ],
        },
      },
    ],
  };

  it("reads properties and swaps GeoJSON lon/lat order", () => {
    const iso = parseIsochrone(raw);
    expect(iso.hub).toEqual({ lat: 19.0596, lon: 72.8296 });
    expect(iso.hubName).toBe("pali_hill");
    expect(iso.contourMinutes).toBe(15);
    // First vertex was [72.81, 19.04] in lon,lat order.
    expect(iso.polygon[0]?.[0]).toEqual({ lat: 19.04, lon: 72.81 });
  });

  it("throws a named error on malformed input", () => {
    expect(() => parseIsochrone(null)).toThrow(/not an object/);
    expect(() => parseIsochrone({})).toThrow(/no features/);
    expect(() => parseIsochrone({ features: [{ properties: {} }] })).toThrow(/missing hub/);
  });
});

describe("the shipped isochrone set", () => {
  it("loads every cached polygon offline", () => {
    const isos = loadAllIsochrones();
    expect(isos.length).toBeGreaterThanOrEqual(20);
    for (const iso of isos) {
      expect(iso.contourMinutes).toBeGreaterThan(0);
      expect(iso.polygon.length).toBeGreaterThan(0);
      expect(isochroneAreaSqm(iso)).toBeGreaterThan(0);
    }
  });

  it("contains the hub it was built from", () => {
    const iso = loadIsochrone("lands_end", "pedestrian", 15);
    expect(isochroneContains(iso, iso.hub)).toBe(true);
  });

  it("reaches further as the budget grows", () => {
    const near = isochroneAreaSqm(loadIsochrone("lands_end", "pedestrian", 10));
    const mid = isochroneAreaSqm(loadIsochrone("lands_end", "pedestrian", 20));
    const far = isochroneAreaSqm(loadIsochrone("lands_end", "pedestrian", 30));
    expect(near).toBeLessThan(mid);
    expect(mid).toBeLessThan(far);
  });

  it("shows a driving budget covering far more ground than walking", () => {
    // The 11.7x figure from data/reference/README.md.
    const walk = isochroneAreaSqm(loadIsochrone("lands_end", "pedestrian", 30));
    const drive = isochroneAreaSqm(loadIsochrone("lands_end", "auto", 30));
    expect(drive / walk).toBeGreaterThan(8);
    expect(drive / walk).toBeLessThan(16);
  });

  it("returns the tightest budget that reaches a point, not the loosest", () => {
    const walk = [
      loadIsochrone("lands_end", "pedestrian", 30),
      loadIsochrone("lands_end", "pedestrian", 10),
      loadIsochrone("lands_end", "pedestrian", 20),
    ];
    const inside10 = loadIsochrone("lands_end", "pedestrian", 10);
    const found = smallestContaining(walk, inside10.hub);
    // Every polygon contains its own hub, so the answer is the 10-minute one.
    expect(found?.contourMinutes).toBe(10);
  });

  it("returns null for a point no polygon reaches", () => {
    expect(smallestContaining(loadAllIsochrones(), COLABA)).toBeNull();
  });
});

describe("radius graph", () => {
  // Two tight groups ~1.4 km apart, so a 1 km radius separates them cleanly.
  const points: GeoPoint[] = [
    { lat: 19.06, lon: 72.83 },
    { lat: 19.061, lon: 72.831 },
    { lat: 19.062, lon: 72.83 },
    { lat: 19.05, lon: 72.83 },
    { lat: 19.051, lon: 72.831 },
  ];

  it("links only points within the radius", () => {
    const graph = buildRadiusGraph(points, 1000);
    expect(graph.adjacency[0]).toEqual([1, 2]);
    expect(graph.adjacency[3]).toEqual([4]);
  });

  it("keeps the distance matrix symmetric", () => {
    const graph = buildRadiusGraph(points, 1000);
    for (let i = 0; i < points.length; i++) {
      for (let j = 0; j < points.length; j++) {
        expect(graph.distances[i]?.[j]).toBe(graph.distances[j]?.[i]);
      }
    }
    expect(graph.distances[0]?.[0]).toBe(0);
  });

  it("isolates the two clusters", () => {
    const graph = buildRadiusGraph(points, 1000);
    const components = connectedComponents(graph);
    expect(components).toHaveLength(2);
    expect(components).toContainEqual([0, 1, 2]);
    expect(components).toContainEqual([3, 4]);
  });

  it("is deterministic across runs", () => {
    const a = connectedComponents(buildRadiusGraph(points, 1000));
    const b = connectedComponents(buildRadiusGraph(points, 1000));
    expect(a).toEqual(b);
  });

  it("treats an empty point set as no components", () => {
    expect(connectedComponents(buildRadiusGraph([], 1000))).toEqual([]);
  });

  it("links everything when the radius is large enough", () => {
    const graph = buildRadiusGraph(points, 10_000_000);
    expect(connectedComponents(graph)).toHaveLength(1);
  });

  it("includes the point itself in its neighbourhood and rejects bad indices", () => {
    const graph = buildRadiusGraph(points, 1000);
    expect(neighbourhood(graph, 0).slice(0, 1)).toEqual([0]);
    expect(neighbourhood(graph, 0)).toContain(1);
    expect(neighbourhood(graph, -1)).toEqual([]);
    expect(neighbourhood(graph, 999)).toEqual([]);
  });
});
