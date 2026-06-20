# Route Corridor Mode — Design Plan

Status: **draft for review** · Author session: 2026-06-20

A third map mode. Instead of a square AOI around a center, the user picks a
**start + end** (plus optional waypoints), we fetch the driving **route polyline**
from the Google Routes API, then pull map data only for a **corridor** of N metres
around that route.

---

## 1. Locked decisions

| Decision | Choice |
| --- | --- |
| Route length target | **Long road-trips (15 km+)** → must chunk, can't be one AOI |
| Routing provider | **Google Routes API** (same Google project as 3D Tiles) |
| "Surroundings metres" control | **Single quality dial**: tier sets both corridor width *and* LOD (`width + LOD coupling`) |
| Data pulled | **Full stack**: terrain + Google 3D tiles + OSM, per chunk |
| Output shape | **Chunked now, stitch-ready** (recommended; user was unsure — see §6) |

---

## 2. Current architecture (what we build on)

Two **disjoint** pipelines today:

1. **Batch grid** — [`services/batchJob.js`](../services/batchJob.js)
   - `computeGridTiles(center, resolution, cols, rows)` → list of axis-aligned
     tiles `{row,col,index,center{lat,lng},bounds{n,s,e,w}}`. Cell size = `resolution` (metres, 1px=1m).
   - `processTile()` bakes **terrain + satellite + OSM** per tile → one zip each.
   - **Does NOT bake Google 3D tiles.** Optional composite heightmap just lays tiles side by side (no seam fix).
   - Per-tile quality is **not** supported — `resolution`/quality is global.

2. **Google 3D tiles bake** — [`services/google3dTiles.js`](../services/google3dTiles.js) + [`services/googleBakeCore.js`](../services/googleBakeCore.js)
   - Single AOI. Tiles are selected by **virtual camera "stations"** sweeping the
     AOI, not by bbox culling — `buildSweepStations(frame, {quality})` → `runStationSweep()`.
   - **`roads` quality already places street-level cameras along OSM roads**
     (`buildRoadStations`, ~40/km, ~25 m above the road). The corridor-stations idea is a near-clone.
   - AOI reference frame: `computeAoiFrame(data, ellipsoid)` (ECEF center + ENU basis + metric extent), local per-AOI.
   - Seam welding (`weldSeams`) runs **within** one AOI bake.
   - Runs **in-browser** OR **headless** via a job API: [`scripts/googleBakeWorker.mjs`](../scripts/googleBakeWorker.mjs) behind `/api/google-bake` ([`scripts/viteGoogleBakePlugin.mjs`](../scripts/viteGoogleBakePlugin.mjs)), driven from [`services/googleBakeSidecar.js`](../services/googleBakeSidecar.js). **The worker already does per-AOI jobs** — this is our chunk executor.

3. **Geometry / projection** — [`services/geoUtils.js`](../services/geoUtils.js): proj4 local
   transverse-mercator per AOI (`createWGS84ToLocal` / `createLocalToWGS84` / `createMetricProjector`).

4. **Mode switch** — currently a binary `batchMode` boolean in [`stores/mainStore.js`](../stores/mainStore.js) + [`components/ui/ModeToggle.vue`](../components/ui/ModeToggle.vue).

5. **Quality ladder** (the LOD half of the dial):

| Tier | Stations | errorTarget | sensor | Notes |
| --- | --- | --- | --- | --- |
| `standard` | 5 (top + 4 oblique) | 5 | 1024 | |
| `high` | +8 obliques + 4×4 low grid | 5 | 1536 | |
| `roads` | high + street-level along OSM roads | 5 | 1536 | **template for corridor stations** |
| `max` | roads + facade ring + saturation | 3 | 1536 | fly-mode, finest LOD everywhere |

---

## 3. Core design

```
start + end (+ waypoints)
        │  Google Routes API
        ▼
   encoded polyline ──decode──► [{lat,lng}, …]  (route centerline)
        │
        │  chunk along cumulative distance
        ▼
   chain of AOI boxes following the road
   (axis-aligned squares, ~10–15% overlap so neighbours weld)
        │
        │  per chunk:
        ▼
   ┌─────────────────────────────────────────────┐
   │ 1. clip route segment into the chunk's frame │
   │ 2. buildCorridorStations(frame, segment, w)  │  ← new, modeled on buildRoadStations
   │ 3. bake Google 3D tiles  (worker job)        │  ← reuse runStationSweep
   │ 4. fetch terrain + OSM for chunk bounds      │  ← reuse fetchTerrainData / osm.js
   │ 5. (phase 2) mask everything outside buffer  │
   │ 6. export zip + record global anchor + edges │
   └─────────────────────────────────────────────┘
        ▼
   N chunk zips + manifest.json (global frame, neighbour edges)
        ▼
   (phase 3) optional stitch pass → continuous level
```

### The single "corridor quality" dial (width + LOD coupling)

One tier sets **both** how wide a band we pull **and** how detailed it is. Detail
always concentrates on the centerline (road); the buffer edges fall off.

| Dial tier | Corridor half-width | Baseline Google quality | Chunk box |
| --- | --- | --- | --- |
| Draft | 50 m | `high` | 1024 m |
| Standard | 150 m | `roads` | 1024 m |
| Fine | 300 m | `roads` | 2048 m |
| Ultra | 500 m | `max` | 2048 m |

(Exact numbers are tuning — see open questions §7. Centerline always baked at road/max-level stations regardless of tier; tier raises the *baseline* and the *width*.)

---

## 4. Data model changes — [`stores/mainStore.js`](../stores/mainStore.js)

Generalize `batchMode: bool` → `mapMode: 'single' | 'batch' | 'route'` (keep a
computed `batchMode` shim for existing call sites to minimize churn).

New route state:

```js
mapMode           : 'single' | 'batch' | 'route'
routeStart        : { lat, lng } | null
routeEnd          : { lat, lng } | null
routeWaypoints    : [{ lat, lng }]            // optional intermediate
routePolyline     : [{ lat, lng }]            // decoded centerline (from Routes API)
routeDistanceM    : number                    // total length, for cost estimate
corridorTier      : 'draft'|'standard'|'fine'|'ultra'
routeChunks       : computed → [{ id, center, bounds, frameAnchor, segment, quality, neighbours }]
```

---

## 5. New / changed files

| File | Change |
| --- | --- |
| `services/googleRoutes.js` | **new** — `fetchRoute(start, end, waypoints, key)` → POST Routes API `computeRoutes`, decode `encodedPolyline` → `[{lat,lng}]`. Add a polyline decoder (`@googlemaps/polyline-codec`, ~3 KB, or ~20-line inline). |
| `services/routeCorridor.js` | **new** — `chunkRoute(polyline, tier)` → AOI chain; `routeSegmentInChunk(chunk, polyline)`; `pointInCorridor(pt, polyline, width)` (for masking). |
| `services/googleBakeCore.js` | **add** `buildCorridorStations(frame, segment, {width, quality})` — clone of `buildRoadStations` but driven by the route segment, not OSM roads. |
| `services/google3dTiles.js` / `googleBakeWorker.mjs` | accept a `corridorSegment` so the bake places corridor stations instead of (or in addition to) the sweep grid. |
| `services/batchJob.js` | reuse `processTile()` per chunk for **terrain + OSM**; feed it the chunk list from `routeChunks` instead of `computeGridTiles`. Add per-tile quality + a `corridorMask` hook. |
| `services/routeExport.js` | **new** — assemble chunk zips + `manifest.json` (global anchors, neighbour edges) for stitch-readiness. |
| `stores/mainStore.js` | `mapMode` + route state (§4). |
| `components/ui/ModeToggle.vue` | 2-way → 3-way (Single / Batch / Route). |
| `components/map/RoutePanel.vue` | **new** — start/end/waypoint pickers, corridor-tier dial, distance + cost estimate, "fetch route" + "bake" actions. |
| `components/map/MapSelector.vue` | draw the polyline + buffer overlay; click-to-set start/end/waypoints in route mode. |
| `App.vue` | route-mode branch in the generate/bake orchestration. |
| `.env.example` / docs | document the Routes API key + required API enablement. |

---

## 6. Output shape — recommendation (user was unsure)

**Chunked now, stitch-ready.** Reasons:

- A single continuous 15 km+ level is impractical: memory, cross-chunk photoreal
  seam welding, and one local TM projection distorts badly over tens of km.
- The headless worker already runs **per-AOI** jobs — chunk = AOI = one job.
- Independent chunks = trivially parallel + resumable (a failed chunk re-bakes alone).

But bake **every chunk in a recorded global frame** (store each chunk's ECEF/lat-lng
origin + heading + shared-edge ids in `manifest.json`) so a **stitch pass (phase 3)**
— or in-engine placement — can assemble a continuous map *without re-baking*.

---

## 7. Phasing

- **Phase 0 — Route front-end (no baking). ✅ BUILT.** 3-way mode toggle, Routes API
  service, polyline preview + start/end pins on the map, corridor-tier dial, distance readout.
  Files: `stores/mainStore.js` (`mapMode` + route state), `services/googleRoutes.js`,
  `services/routeCorridor.js` (tiers), `components/ui/ModeToggle.vue` (3-way),
  `components/panels/RouteControlPanel.vue`, `components/map/RoutePointRow.vue`,
  `components/map/MapSelector.vue` (polyline/pins/click), `App.vue` (wiring), `locales/en.json`.
  *Builds clean. Live route fetch needs Routes API enabled on the Google key.*
- **Phase 1a — Route chunking + preview. ✅ BUILT.** `chunkRoute(polyline, tier)` in
  `services/routeCorridor.js` (overlapping axis-aligned AOI boxes following the road,
  tier→chunkSize, 15% overlap) + AOI boxes drawn on the map + chunk count in the panel.
  Pure geometry, unit-tested (`tests/routeCorridor.test.mjs`, 6 passing). Lets us tune
  size/overlap visually before paying for bakes.
- **Phase 1b — Bake + export corridor. ✅ BUILT + RUNTIME-VERIFIED.** (3-chunk / 1.65 km
  Standard-tier run produced a valid combined .zip + manifest.) `services/routeBake.js`
  `bakeAndExportRoute()` loops chunks → `fetchTerrainData(chunk, chunkSizeM, +OSM)` →
  `exportToGLB(.., {returnBlob, useGoogle3DTiles, googleQuality})` (reuses the existing bake;
  its **road pass** concentrates detail along the route — no custom station builder needed for MVP) →
  bundles `chunk_NN/model.glb` + `manifest.json` (per-chunk geo-reference: bounds, center,
  unitsPerMeter, neighbours) into one combined .zip. Tier→quality (`high`/`roads`/`max`).
  Added opt-in `googleQuality` passthrough to `exportToGLB`. UI: "Bake & export corridor" button +
  per-chunk progress + cancel in `RouteControlPanel.vue`, orchestration in `App.vue`.
  Each GLB already contains terrain + OSM + Google tiles, so this also covers most of the
  "full stack" goal. *Builds clean; the bake itself needs a live run to verify.*

  **NOTE — `buildCorridorStations` deferred:** the road pass covers road-following routes.
  A dedicated corridor-station builder (off-road routes, tighter perpendicular control) moves to Phase 2.
- **Phase 2a — Corridor masking of Google tiles. ✅ BUILT + VERIFIED.** (3-chunk Standard run:
  700 → 417 MiB, −40%; kept 33–42% of verts, 195–498 fully-outside tiles dropped per chunk;
  `routeBBox ⊂ geomBBox` in `[-50,50]` confirms frame alignment.) Per-chunk `mask{}` stats now
  recorded in `manifest.json`. `clipGroupToCorridorXZ` in
  `services/export3d.js` drops baked-tile triangles whose XZ centroid is >halfWidthM from
  the route polyline (shared `latLngToScene` frame), then COMPACTS geometry so dropped
  verts leave the file. Opt-in `corridorMask:{segment,halfWidthM}` option (route-only;
  single/batch unaffected). `routeBake.js` passes each chunk's segment + tier halfWidth.
  Clips clones, never the shared bake cache. *Re-bake the same route to compare size —
  tiles are cache-hit, only the clip re-runs.*
- **Phase 2b — Mask terrain + OSM.** Same idea for the terrain mesh (note: its geometry is
  in the PRE-rotation X/Y axis, not world XZ) and OSM group. Smaller byte win than tiles.
- **Phase 3a — Stitch frame (placement). ✅ BUILT + VERIFIED.** `services/routeStitch.js`
  `computeRouteFrame()` → shared metric world (anchor = chunk 0 centre; +X=east, +Z=south, +Y=up).
  Each chunk GLB carries `placement{scale=1/unitsPerMeter, translationM}` in `manifest.json` so the
  separate pieces tile into one continuous, georeferenced world. Unit-tested
  (`tests/routeStitch.test.mjs`, 6/6) + verified on real manifest data (placed center gaps < route-arc
  gaps, as expected for a curving road). This is the SCALABLE stitch — game engines stream tiles,
  not one mega-mesh.
- **Phase 3b — In-app stitched 3D preview. ✅ BUILT + VERIFIED.** `components/three/RoutePreview.vue` (TresJS,
  mirrors Preview3D's canvas/CSMLight/Environment/OrbitControls) loads the per-chunk GLBs kept in
  memory from the bake and places each via its `placement` (uniform scale `1/upm` + `translationM`
  incl. a per-chunk Y datum offset from `minHeight`), centred at the origin. After a route bake, the
  3D tab shows the whole stitched route — same content as the export, no singleton-store conflict
  (clones via GLB reload). `routeStitch.computeRouteFrame` now also emits the Y/elevation offset.

- **BeamNG compatibility (researched):** chunked/multiple meshes is the CORRECT BeamNG approach —
  the World Editor places many static meshes (TSStatic) at world coords (exactly the manifest
  `placement`s); one mega-mesh is discouraged. Native mesh format is **`.dae` (COLLADA)** → `.cdae`,
  not GLB. The app already has `exportToDAE` (same options incl. `corridorMask`) + a `beamng_glb_to_dae`
  Blender path. Per user direction ("the area export is the benchmark — no shortcuts"), keep the route
  export mirroring the area pipeline rather than inventing a DAE-only route path.

- **Phase 3c — (optional) single merged file / overlap weld.** Only for short routes; needs overlap
  trimming at chunk midlines to avoid z-fighting in the 15% overlap.

---

## 8. Risks & open questions

**Risks**
- **Full-stack-per-chunk is net-new integration** — batch never calls the Google bake today; the per-chunk loop must drive both.
- **Cross-chunk seam welding** — `weldSeams` is within-AOI only; continuous stitching (phase 3) is genuinely hard.
- **Cost / time / quota** — long full-stack routes = hundreds of chunks × Google 3D Tiles + Routes calls; bakes could run minutes→hours. **Mandatory: show a chunk-count + tile-estimate guardrail before baking.**
- **Routes API key** — may need separate API enablement on the same Google project as 3D Tiles; confirm billing.

**Open questions**
1. Chunk box size + overlap % defaults (table in §3 is a guess)?
2. ~~Add `turf` for buffer/point-in-corridor math, or keep the hand-rolled helper?~~ **DECIDED: hand-rolled.** We only need point-in-corridor (point-to-segment distance in local metres, ~15 lines, reuses proj4 from `geoUtils.js`); map preview is a thick Leaflet polyline (no geometry); chunk bounds are axis-aligned boxes. The only hard part — a true buffer polygon — isn't needed. Revisit `@turf/buffer` only if we later export a precise GeoJSON clip mask or want variable-width rounded buffers.
3. ~~Waypoint support in v1, or just start+end?~~ **DECIDED: start + end only.** No waypoints in v1.
4. ~~Cost guardrail: hard cap on route length per tier, or just warn?~~ **DECIDED: no guardrail.** No cap, no estimate gate. (Distance may still be shown as plain info.)
5. ~~Phase 0 alone shippable as a preview-only feature first?~~ **DECIDED: yes — build Phase 0 first.**
