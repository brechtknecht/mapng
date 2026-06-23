# 01 — Current Architecture (verified)

Snapshot of the repo as it stands on branch `feat/tile-ground-conform`. Line
counts are real (`wc -l`), not estimates. This is the "before" map the refactor
works against.

## 1. Top-level shape

```
App.vue            1205 LOC   god component: single + batch + route modes, all handlers inline
worker.js           135 LOC   Cloudflare Pages Function entry
main.js / i18n.js             bootstrap
stores/             2 files   mainStore.js (289), googleTilesStore.js (192)  — most state actually lives in App.vue
components/          ~30 .vue  base/ batch/ controls/ layout/ map/ modals/ panels/ three/ ui/
services/           60 files   THE JUNK DRAWER — fetching + compute + IO + orchestration mixed
scripts/            13 .mjs    vite plugins + node sidecars (bake worker, zip writer, blender bridge)
tests/              17 .mjs    headless tests for the pure compute modules
docs/                          existing per-feature plan docs
```

There is **no module boundary** today. Everything in `services/` can import
everything else; `App.vue` reaches directly into ~20 services.

## 2. The `services/` heavyweights (where the debt is)

| File | LOC | What it really is |
|---|---|---|
| `exportBeamNGLevel.js` | 5558 | God-file. Fetch + bake + material painting + JSON assembly + ZIP. The single biggest target. |
| `export3d.js` | 2164 | GLB/scene assembly, mesh merge, coordinate transforms. |
| `terrain.js` | 1986 | DEM fetch routing (USGS/GPXZ/Terrarium/Kron) + resample + satellite/OSM texture + cache. Mixed concerns. |
| `osmTexture.js` | 1886 | OSM feature classification + canvas rasterization + road overlay. |
| `batchJob.js` | 1561 | Batch lifecycle + scheduling + per-tile export. |
| `googleBakeCore.js` | 1218 | Google 3D Tiles bake orchestration, quality tiers, `computeUnitsPerMeter`. |
| `beamngFlavorCatalog.js` | 1008 | Hard-coded BeamNG asset/material catalog (data masquerading as code). |
| `osmTerrainMaterials.js` | 960 | OSM tags → BeamNG material index → layer `Uint8Array`. |
| `google3dTiles.js` | 862 | Sidecar session mgmt, z-offset, cache purge. |
| `resamplerWorker.js` | 850 | DEM resampling in a Web Worker. |
| `surroundingTiles.js` | 668 | 8-neighbour context tile fetch. |
| `osm.js` | 658 | Overpass fetch + parse. |
| `junctionGeometry.js` | 629 | Road junction smoothing geometry. |

Everything below ~500 LOC is comparatively healthy and mostly already
single-purpose (loaders, `routeCorridor`, `scalarFieldGrid`, `groundMask`,
`tileGroundConform`, the `route*` modules).

## 3. The two pipelines

### A. Single-tile (+ batch) pipeline
Orchestrated **inline in `App.vue`** (`handleGenerate`, `handleStartBatch`,
`handleSingleExportSuccess`, …) and in `batchJob.js` / `batchRuntime.js` for the
grid case.

```
App.vue handleGenerate / batchJob
  → terrain.js            fetch DEM + textures (USGS/GPXZ/Terrarium/Kron)
  → terrainResampler/resamplerWorker   resample to 1 m/px grid
  → scalarFieldGrid       relief / texture fields
  → osm.js / osmTexture / osmTerrainMaterials   OSM features + textures + material map
  → surroundingTiles      neighbour context
  → google3dTiles + googleBakeCore + googleBakeSidecar   photogrammetry bake
  → tileGroundConform + groundMask     conform tiles to DEM
  → export3d              GLB / scene
  → exportBeamNGLevel     .ter + materials + statics + ZIP   ← terminal
```

### B. Route pipeline
Orchestrated in `App.vue` (`handleFetchRoute`, `handleBakeRoute`,
`handleExportRouteBeamNG`) over dedicated `route*` modules.

```
App.vue handleFetchRoute
  → googleRoutes          polyline from Google Routes API
  → routeCorridor         tiers, chunk the polyline into AOI boxes
handleBakeRoute → routeBake (orchestrator)
  → terrain.js            per-chunk DEM + textures        [SHARED]
  → googleBakeCore / google3dTiles   per-chunk bake        [SHARED]
  → export3d              per-chunk GLB                     [SHARED]
  → routeStitch           place chunks in metric world frame
  → routeProgress         progress snapshots
handleExportRouteBeamNG → exportRouteLevel
  → routeTerrainComposite combine chunk DEMs into one grid
  → tileGroundConform     conform to combined grid          [SHARED]
  → exportBeamNGLevel     reused in "route mode"            [SHARED]
```

## 4. Shared surface (the seam between the pipelines)

Modules consumed by **both** pipelines — these are the core that must be
extracted first and kept stable:

- `terrain.js` — DEM + texture fetch (imported by `routeBake`, `surroundingTiles`, `exportRouteLevel`, `App.vue`)
- `geoUtils.js` — projections; **already a real shared util**, imported by 10 modules incl. `googleBakeWorker.mjs`
- `scalarFieldGrid.js` — scalar/texture field grids
- `googleBakeCore.js` / `google3dTiles.js` / `googleBakeSidecar.js` — tile bake
- `tileGroundConform.js` / `groundMask.js` — ground conform
- `export3d.js` — GLB assembly
- `exportBeamNGLevel.js` — terminal exporter (run in single **and** route mode)
- `osmTexture.js` / `osmTerrainMaterials.js` / `roadNetwork.js` / `junction*.js` — OSM-derived geometry/materials

Route-only: `routeBake`, `routeCorridor`, `routeTerrainComposite`,
`routeStitch`, `routeProgress`, `exportRouteLevel`, `googleRoutes`.
Single/batch-only: `batchJob`, `batchRuntime`, `batchExports`, `batchCache`,
`jobData`, `runConfiguration`, `traceability`.

## 5. Concrete, verified smells (the work list)

1. **`App.vue` is the real orchestrator** (1205 LOC). Both pipelines' control
   flow lives in component event handlers, not in testable modules. State is
   split between local refs and two thin Pinia stores.
2. **God-files.** `exportBeamNGLevel.js` (5558) and `export3d.js` (2164) mix
   fetch + compute + serialization + ZIP in single files.
3. **`terrain.js` mixes three concerns** — source routing (fetch), resampling
   (compute), and texture generation (compute) — in one 1986-LOC file.
4. **Duplicated geo/grid math** despite `geoUtils.js` existing:
   `clamp` defined/used across **11** files, `bilinear` across **8**,
   `metersPerDegree` across **4**, `computeUnitsPerMeter` referenced in **9**,
   raw `proj4` calls in **9** (should route through `geoUtils`).
5. **Three parallel caches** with no shared interface: `elevationCache.js`
   (memory), `googleTilesPersistentCache.js` (IndexedDB),
   `scripts/googleTileDiskCache.mjs` (node disk).
6. **Per-pair worker protocols.** `resamplerClient`/`resamplerWorker` and
   `lazClient`/`lazWorker` each reinvent the postMessage envelope;
   `taskQueues.js` exists but is not the shared spine.
7. **Vite plugins as backend.** `viteGoogleBakePlugin`, `viteZipExportPlugin`,
   `viteBlenderDaePlugin` carry real bake/export logic in build tooling.
8. **Data-as-code.** `beamngFlavorCatalog.js` (1008) and large hard-coded tables
   in `osmTerrainMaterials.js` should be data files.
9. **No package boundaries / no path aliases** — every cross-cutting import is a
   deep relative path, so nothing is enforceable and circular imports are easy.

## 6. What's already good (don't break it)

- The pure compute modules have **headless `node --test` coverage**
  (`scalarFieldGrid`, `tileGroundConform`, `groundMask`, `weldSeams`,
  `routeConform`, `routeStitch`, `routeCorridor`, `buildCorridorStations`,
  loaders). This is the safety net the whole refactor leans on.
- `geoUtils.js` is already a clean, documented shared projection util — the
  template for what every other extracted util should look like.
- The `route*` modules are already small and single-purpose.
- The sidecar pattern (browser falls back to in-tab when the node sidecar is
  absent) is a deliberate, working design — preserve its seam.
