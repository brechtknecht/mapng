# Route-bake performance optimization — implementation plan (handoff)

> Self-contained brief for a fresh thread. Goal: cut route-corridor bake time from
> ~2.5 min/chunk (≈40 min for a 15 km route) to single-digit minutes, without
> regressing the proven single-tile ("area") export pipeline.

---

## 0. Orient yourself first

- **Repo:** `/Users/f.tesche/Documents/dev/mapng` (Vue 3 + Three.js + TresJS; bakes Google
  Photorealistic 3D Tiles for BeamNG maps). **Branch:** `route-corridor-mode` (feature already
  committed, `025953f`).
- **Read** `docs/route-corridor-plan.md` (full feature design + phase log; §7.5 = this perf analysis).
- **Dev server:** `npm run dev` (Vite, :5173). **Build:** `npm run build`. **Tests:** `node --test tests/<file>`.
- **GOTCHA — stale HMR (cost a full debug cycle before):** editing deeply-imported service modules
  (`services/export3d.js`, `services/google3dTiles.js`, `services/googleBakeCore.js`, `services/routeBake.js`)
  does NOT hot-swap — the tab keeps old code. **Hard-refresh (⌘⇧R) before verifying any bake.** After a
  refresh, route mode's polyline is in-memory only (start/end + tier persist), so re-click **Fetch route**.
- **Tiles credential** = `VITE_GOOGLE_MAPS_API_KEY` (may be a Cesium ion token). **Routes API** uses a
  separate `VITE_GOOGLE_ROUTES_API_KEY` (real `AIza…` key). Both already set in `.env.local`.

## 1. How the route bake works today

`services/routeBake.js` → `bakeAndExportRoute(chunks, opts)` loops chunks **sequentially**. Per chunk:
1. `fetchTerrainData(chunk.center, tier.chunkSizeM, +OSM, …)` (`services/terrain.js`).
2. `exportToGLB(terrainData, { useGoogle3DTiles, googleQuality, corridorMask, returnBlob })`
   (`services/export3d.js`) — internally calls `getOrBakeGoogle3DTiles` (the bake), then
   `clipGroupToCorridorXZ` (corridor mask), then GLTFExporter encode.
3. Adds `chunk_NN/model.glb` to a zip; records placement in `manifest.json`.

`chunk.segment` = the route polyline points (lat/lng) inside that chunk's box. `tier` comes from
`services/routeCorridor.js` `CORRIDOR_TIERS` ({ id, halfWidthM, googleQuality, chunkSizeM }).

## 2. The problem (root cause)

Bake time ≈ `2 min + 25 s × stationCount`, and **station count scales with box AREA, not the road**.

`services/googleBakeCore.js` → `buildSweepStations(frame, {quality})` (~line 168) for `high`/`roads`/`max`:
`1 top-down + 8 perimeter obliques + a GRID×GRID grid` where `GRID = min(8, max(2, round(extentM/250)))`
(so 16 cells for a 1024 m box, 64 for 2048 m), `max` adds 2 low-oblique "deepen" stations per cell.
`roads`/`max` also append up to 40 road stations via `buildRoadStations` (~line 101) inside
`runStationSweep` (~line 341, `enableRoadPass`).

The 8 obliques + grid cover the **whole box**, pulling tiles everywhere. Then `clipGroupToCorridorXZ`
(`services/export3d.js`) **deletes ~65%** of them (everything >±halfWidth from the road). **We pay to
bake tiles we throw away.**

Bake entry points (note: TWO copies of the sweep — keep them in parity):
- In-browser: `services/google3dTiles.js` `bakeGoogle3DTiles(data, options)` (~line 74) →
  `buildSweepStations` + `runStationSweep`. Cached front-end `getOrBakeGoogle3DTiles` (~line 565):
  single in-memory slot + IndexedDB; routes to the sidecar worker in dev, else in-browser.
- Headless worker: `scripts/googleBakeWorker.mjs` (~line 715) — SAME `buildSweepStations`/`runStationSweep`.
  Job API `scripts/viteGoogleBakePlugin.mjs` (`/api/google-bake`) spawns **one child worker per cache key**
  (so different chunk bounds CAN bake concurrently).

---

## 3. Task A — corridor-only stations (the structural win)

**Idea:** in route mode, place stations ONLY along the route segment within the corridor; skip the
box-covering 8 obliques + GRID grid. You stop baking the tiles the mask deletes → ~2–3× fewer tile
downloads per chunk, and the mask becomes nearly free. (This is the `buildCorridorStations` deferred in
Phase 1b.)

**Approach:**
1. New builder in `services/googleBakeCore.js`: `buildCorridorStations(frame, segment, { halfWidthM, quality })`.
   Model it on `buildRoadStations` (same station shape `{ label, offset, target, viz }`, same `frame.horiz(e,n)` +
   `upDir` + `groundAltAt` contract). Steps:
   - Convert each `segment` point (lat/lng) → ENU metres `(e=east, n=north)` from the AOI centre. Use
     `frame.metersPerDegree` + `frame.centerLat/centerLng` (or `createMetricProjector` from `services/geoUtils.js`).
     Frame comes from `computeAoiFrame(data, ellipsoid)` (~line 54).
   - Resample the polyline every ~`spacingM` (≈80–120 m). At each sample place a low-altitude station
     (altitude ≈ `altitudeM` 25–40 m, aimed a few car-lengths ahead, like `buildRoadStations`). Optionally
     add a second offset perpendicular by `halfWidthM` for facade coverage on both sides.
   - Keep ONE top-down overview station (cheap, helps global LOD) but DROP the 8 obliques + grid.
2. Wire a `corridorSegment`/`corridorHalfWidthM` option through:
   `routeBake.js` → `exportToGLB` (add to its options, forward into the `getOrBakeGoogle3DTiles` call) →
   `bakeGoogle3DTiles` (when present, use `buildCorridorStations` instead of/in addition to `buildSweepStations`).
   `chunk.segment` is already available in `routeBake.js`.
3. **Cache key:** add the corridor segment (or a short hash of it + halfWidth) to `bakeCacheKey` in
   `services/google3dTiles.js`, so corridor bakes don't collide with full-box bakes of the same bounds.
4. **Worker parity:** mirror the same logic in `scripts/googleBakeWorker.mjs` (it builds stations independently
   ~line 715) and pass `corridorSegment` through the job body in `scripts/viteGoogleBakePlugin.mjs`
   (`POST /api/google-bake` `options`/`data`). In dev the route bake goes through the sidecar, so the worker
   path MUST get the corridor stations or the optimization won't take effect.
5. Keep `clipGroupToCorridorXZ` as a final safety trim (now removes little).

**Measure:** log `stations.length` + bake elapsed per chunk; expect station count and tile count to drop sharply.

**Effort:** medium-high. **This is the only change that removes the wasted work; do it first.**

## 4. Task C — pipeline + prefetch (cheap)

In `services/routeBake.js` `bakeAndExportRoute`, the loop is `await fetchTerrainData` then `await exportToGLB`.
- **Prefetch terrain:** start `fetchTerrainData` for chunk *i+1* (and a small look-ahead window) while chunk *i*
  bakes. Terrain/OSM fetch is independent network work → hide it entirely behind the bake.
- **Don't** bake two chunks at once here (that's Task B; the in-browser cache is single-slot). C keeps bakes
  sequential but overlaps the non-bake time (terrain fetch, and ideally the GLB encode of chunk *i* with the
  bake of *i+1* — only attempt encode-overlap after A/B, as it needs the bake and encode separated).
- Use a bounded prefetch (e.g. 1–2 ahead) to cap memory.

**Effort:** low. Safe, independent of A.

## 5. Task B — parallel chunks (scales the rest)

The sidecar spawns one worker per cache key, so different chunk bounds bake concurrently. Run **2–3** chunk
bakes at once instead of sequentially.
- In `routeBake.js`, replace the sequential loop with a bounded concurrency pool (limit 2–3).
- **Blocker:** `getOrBakeGoogle3DTiles`'s single in-memory cache slot is not concurrency-safe. Either bypass it
  for route bakes (call the sidecar per chunk directly via `services/googleBakeSidecar.js`) or make the cache
  keyed/multi-entry. Each chunk's group is cloned into its export scene, so once a chunk's GLB is encoded its
  cache slot is free.
- **Cap concurrency** to avoid Google tile-API rate limits + bandwidth saturation; watch memory (concurrent
  bakes + encodes hold more at once).

**Effort:** medium. Do after A (fewer tiles per bake makes parallelism cheaper) and C.

---

## 6. Cross-cutting: measure before/after

Add per-chunk instrumentation to `manifest.json` in `routeBake.js` (mirrors the existing `mask{}` block):
`bake: { stationCount, bakeMs, encodeMs, fetchMs, tilesLoaded }`. This makes every optimization measurable
from the downloaded manifest without watching logs. **Add this FIRST** so A/B/C gains are provable.

Baseline to beat (3-chunk / 1.65 km / Standard run): ~2.5 min/chunk; GLB 84/180/153 MiB; mask kept 33–42% verts.

## 7. Verify each step

- `npm run build` (must stay green).
- `node --test tests/routeCorridor.test.mjs tests/routeStitch.test.mjs` (13 tests; `tests/` is gitignored —
  `git add -f` any new test).
- Real bake: hard-refresh, route mode → Fetch route → Bake. Compare manifest `bake{}` stats + GLB sizes +
  wall-clock vs baseline. Confirm the in-app 3D preview (`components/three/RoutePreview.vue`) still stitches.
- Do NOT change the single-tile/area export path or its defaults — route options must stay opt-in
  (`corridorSegment`, like the existing opt-in `corridorMask`/`googleQuality`). The area export is the benchmark.

## 8. Suggested order

1. **Instrument** (§6) — measurable baseline.
2. **A** — corridor-only stations (biggest win; also realises the "true corridor" from the plan).
3. **C** — prefetch terrain (cheap, hides non-bake time).
4. **B** — parallel chunks (scales whatever's left), if still too slow.

Expected combined result: 40+ min → single-digit minutes for a 15 km route.
