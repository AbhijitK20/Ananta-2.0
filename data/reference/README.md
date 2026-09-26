# Harvested reference datasets

Real data pulled and derived on this machine, not copied from a blog post. Every
number here was measured, and every claim records how it was measured.

Regenerate anything in here with the commands in each section. **Two of these are
production inputs, not documentation** — see §3.

---

## 1. `osm-tagging-schema/` — the per-category tag checklist

**Closes the blocker named in `findings/04-data-retrieval.md` §2.**

That finding states the `data/presets/` tree "is NOT in the clone" and that a full
checkout is "the artefact to obtain before we finalise the enrichment prompt".
**That is now stale.** The sparse-checkout config really does omit `/data/presets/`,
but the directory is present and fully populated on disk: **1739 preset JSON files,
7.6 MB, tracked at HEAD (`ed5dab7`)**. No re-clone needed.

| File | What it is |
|---|---|
| `preset-checklists.json` | Per-preset `tags` (required to match), `addTags` (what iD's validator *recommends* adding), and the `fields` / `moreFields` union. Per SCHEMA.md §120-190 these two arrays **are** the per-category tag checklist expressed as a union. |
| `constraint-field-coverage.json` | The same data pivoted onto the tags the feasibility gate needs. |

Harvested shape: 1739 presets · 183 categories · 240 distinct `addTags` · 927 distinct fields.
Biggest categories: `shop` 175, `amenity` 149, `man_made` 71, `building` 64, `highway` 61.
Most-used fields: `name` 518, `operator` 373, `address` 237, `opening_hours` 154, `wheelchair` 108.

### The measured result that changes the gate design

| Gate field | Role | Presets | Coverage |
|---|---|---:|---:|
| `opening_hours` | time gate | 154 | **8.9%** |
| `wheelchair` | accessibility filter | 108 | **6.2%** |
| `fee` | budget filter | 71 | 4.1% |
| `smoking` | atmosphere | 47 | 2.7% |
| `capacity` | booking capacity | 36 | 2.1% |
| `outdoor_seating` | atmosphere | 11 | 0.6% |
| `cuisine` | cuisine filter | 6 | 0.3% |
| `internet_access` | workability | 5 | 0.3% |
| `check_date` | staleness | 5 | 0.3% |
| `diet:vegetarian` | dietary filter | 0 | **0.0%** |
| `wheelchair:description` | accessibility detail | 0 | **0.0%** |

**Only 43 presets (2.5%) carry three or more gate fields. 1468 of 1739 (84.4%) carry none.**

**Consequence — this is a design constraint, not a footnote.** The hard-filter stage
must treat *absent* as `unknown`, never as `fail`. A gate that vetoes on missing
`opening_hours` deletes 91% of the catalogue before ranking starts; a gate that
asserts an unverified `wheelchair=yes` is exactly the hallucination the provenance
layer exists to prevent. `diet:vegetarian` and `wheelchair:description` cannot be
hard filters at all — at 0% they can only be soft, relaxable, or LLM-inferred and
carrying a `provenance: inferred` label.

Coverage concentrates exactly where the MVP needs it: `opening_hours` is present on
70 `amenity` presets, 26 `leisure`, 9 `tourism`; `wheelchair` on 45 `amenity`, 9 `highway`,
6 `leisure`. A restaurant-and-park seeded dataset is the right shape; a
`shop`/`man_made`/`building` dataset would have almost no gate data.

```bash
# regenerate from the existing clone — no network needed
python3 - <<'EOF'
import json, collections, pathlib
root = pathlib.Path('research/data/id-tagging-schema/data/presets')
n = sum(1 for _ in root.rglob('*.json') if not _.name.startswith('@'))
print(n, 'presets')
EOF
```

---

## 2. `isochrones/` — live isochrones, Bandra West, Mumbai

20 real polygons + 2 real travel-time matrices from `valhalla1.openstreetmap.de`
(key-free, confirmed to advertise `isochrone` in `/status`). Two hubs — Pali Hill
and Land's End — deliberately chosen either side of the Bandra creek, which is the
specific geography the findings argue makes crow-flies radii wrong.
Costings `pedestrian` and `auto` × 5/10/15/20/30 minutes.

`isochrone-metrics.json` holds the derived area and crow-flies-reach table.
Areas are planar shoelace on lat/lon (~1% error at this scale), **not** true geodesic.

### The radius claim, measured

| Budget | Walking area | Walking reach | Auto area | Auto reach |
|---:|---:|---:|---:|---:|
| 10 min | 1.43 km² | 0.84 km | 6.05 km² | 2.45 km |
| 15 min | 3.00 km² | 1.25 km | 17.51 km² | 6.15 km |
| 20 min | 4.79 km² | 1.67 km | 39.63 km² | 9.16 km |
| 30 min | 8.85 km² | 2.47 km | 103.79 km² | 13.58 km |

**A 3 km radius is wrong in both directions at once, which is a sharper result than
the findings' one-directional claim.** A 3 km disc is 28.27 km²:

- **Too permissive on foot** — 3.2× the entire true 30-minute *walking* area. It admits
  plenty of ground you cannot walk to.
- **Too restrictive by car** — 3 km excludes 73% of the true 30-minute *driving* area
  (103.79 km²).

The two costings differ by **11.7× in area at the same 30-minute budget** (8.85 vs
103.79 km²), so no single radius can be correct for both. The contour is also strongly
non-circular: 30-minute walking reach covers 8.85 km² against 19.1 km² for a circle of
its own 2.47 km radius — **only 46% of the circumscribed disc** — the shape is
elongated along the coastline and road network.

This is the quantitative backing for the isochrone-over-radius decision in
`research/README.md`, and it is now reproducible rather than asserted.

```bash
curl -s -X POST https://valhalla1.openstreetmap.de/isochrone \
  -H 'Content-Type: application/json' \
  -d '{"locations":[{"lat":19.0596,"lon":72.8296}],"costing":"pedestrian",
       "contours":[{"time":15}],"polygons":true,"denoise":1.0}' > bandra-west-mumbai/pali_hill_pedestrian_15min.geojson
```

---

## 3. Which of this is production input

**`isochrones/` — yes, and it has to be.** `valhalla1.openstreetmap.de` is the
only free isochrone source we could reach, OSRM 404s entirely, and Overpass is
blocked from this host. The app reads these polygons at request time and does not
call Valhalla during the demo. Treat them as a data table with a regeneration
command, not as reference reading.

`osm-tagging-schema/` — design input. It fixes the gate's field semantics and
supplies the coverage table in §1, which is quoted throughout the docs. Nothing
reads it at runtime.

## Still outstanding

The seeded catalogue needs ~30 manually labelled places in one neighbourhood, and
Overpass is unreachable from this host, so it is being hand-authored. Routes to
unblock a live harvest: a different network, or a self-hosted Overpass. Either way
the hand-curation is not wasted — it is the layer that carries every field the
gate actually needs, per the coverage table in §1.

---

## Endpoint status checked on this host

Findings §0 rows 5 and the "routing providers" table are now partly stale:

| Endpoint | Status | Note |
|---|---|---|
| `valhalla1.openstreetmap.de` | **working** | `/status` advertises `isochrone`, `sources_to_targets`. The only free isochrone source confirmed live. |
| `routing.openstreetmap.de` | **404 on all OSRM paths** | `/` returns 200 but `/route/v1/…`, `/table/v1/…`, `/nearest/v1/…` all 404. The free-matrix claim no longer holds; `matrix_*.json` here came from Valhalla instead. |
| `overpass-api.de` + 3 mirrors | **unreachable** | TCP fails on both IPv4 and IPv6. Likely egress filtering on this host, not an Overpass outage. **Live POI harvest is blocked here.** |

Anything in the docs that describes a routing or harvest path as "live" is wrong
on this host. The demo path does not use one.
