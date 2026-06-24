# 02 — Target Architecture

A package-based layout where each package owns one concern, leaf packages are
headless (no Vue/DOM), and the two pipelines become thin orchestrators over a
shared core.

## 1. Packaging mechanism

Use **npm workspaces** (already `"type": "module"`, single `package-lock.json`).
This gives real package boundaries, per-package `package.json`, per-package
tests, and explicit dependency declarations that make illegal imports visible.

```
package.json            // root: "workspaces": ["packages/*"]
packages/
  geo/                  @mapng/geo
  fetching/             @mapng/fetching
  workers/              @mapng/workers
  terrain/              @mapng/terrain
  tiles/                @mapng/tiles
  osm/                  @mapng/osm
  export/               @mapng/export
  batch/                @mapng/batch
  route/                @mapng/route
  pipelines/            @mapng/pipelines   (orchestrators lifted out of App.vue)
app/                    Vue app: App.vue, components/, stores/  (consumes @mapng/*)
tools/                  vite plugins + node sidecars (build/dev only)
```

Vite resolves `@mapng/*` via workspace symlinks; add matching aliases so the
browser build and the `node --test` suite resolve identically.

> Lighter interim if workspaces feel heavy mid-flight: keep one root
> `package.json` and create `src/packages/*` with **Vite path aliases**
> (`@mapng/geo` → `src/packages/geo`). Same import surface, same boundary
> discipline, less plumbing. Convert to real workspaces once boundaries settle.
> Recommendation: **workspaces** — you asked for packages, make them real.

## 2. The packages

### `@mapng/geo` — pure projection & grid math (leaf)
The single home for coordinate transforms and grid sampling. Absorbs the
duplicated helpers (`clamp`, `bilinear`, `metersPerDegree`, `deg2rad`,
`computeUnitsPerMeter`, raw `proj4` usage).
- Seed: `geoUtils.js` + extracted helpers.
- Deps: `proj4` only. No DOM, no fetch.

### `@mapng/fetching` — external data sources (leaf-ish)
Every network/disk source + one shared `httpClient` (retry/backoff/headers) and
a unified `Cache` interface backing the three current caches.
- Seed: `osm.js`, `nominatim.js`, `googleRoutes.js`, `tilesAuth.js`,
  `elevationCache.js`, `ascLoader.js`, `lazLoader.js`, `tifLoader.js`,
  `gmlLoader.js`, `kron86.js`, `googleTilesPersistentCache.js`.
- Deps: `@mapng/geo`, `retryPolicy`.

### `@mapng/workers` — worker spine
One `WorkerPool` + message envelope; the laz/resampler client/worker pairs ride
it.
- Seed: `resamplerWorker.js`, `resamplerClient.js`, `lazWorker.js`,
  `lazClient.js`, `taskQueues.js`.
- Deps: `@mapng/geo`.

### `@mapng/terrain` — DEM domain
DEM build, resample, crop, scalar fields, neighbour context. `terrain.js` splits
into `sources` (fetch routing, moves to fetching) + `build` + `texture`.
- Seed: `terrain.js` (split), `terrainResampler.js`, `cropTerrain.js`,
  `scalarFieldGrid.js`, `surroundingTiles.js`.
- Deps: `@mapng/geo`, `@mapng/fetching`, `@mapng/workers`.

### `@mapng/tiles` — Google 3D Tiles + ground conform
Bake orchestration, sidecar session, conform-to-DEM.
- Seed: `googleBakeCore.js`, `google3dTiles.js`, `googleBakeSidecar.js`,
  `tileGroundConform.js`, `groundMask.js`.
- Deps: `@mapng/geo`, `@mapng/terrain`, `@mapng/fetching`.

### `@mapng/osm` — OSM-derived geometry & materials
Feature → texture / material map / road network / junction geometry / building
foundations.
- Seed: `osmTexture.js`, `osmTerrainMaterials.js`, `roadNetwork.js`,
  `junctionGeometry.js`, `junctionRaster.js`, `junctionMesh.js`,
  `buildingFoundations.js`.
- Deps: `@mapng/geo`, `@mapng/fetching` (for `osm.js` fetch — or osm fetch
  stays in fetching and osm package consumes it).

### `@mapng/export` — serialization & IO (the big cleanup)
All output formats. `exportBeamNGLevel.js` is decomposed here (see
[04-conventions.md](04-conventions.md) §god-file playbook). `beamngFlavorCatalog`
becomes a data file loaded by the exporter.
- Seed: `export3d.js`, `ColladaExporter.js`, `exportGeoTiff.js`, `exportTer.js`,
  `exportBeamNGLevel.js`, `beamngFlavorCatalog.js` (→ data), `zipExportSidecar.js`,
  `uploadGeoMetadata.js`, `uploadBounds.js`.
- Deps: `@mapng/geo`, `@mapng/terrain`, `@mapng/osm`, `@mapng/tiles`.

### `@mapng/batch` — grid batch engine
- Seed: `batchJob.js`, `batchRuntime.js`, `batchExports.js`, `batchCache.js`,
  `jobData.js`, `runConfiguration.js`, `traceability.js`, `retryPolicy.js`,
  `batchDebugHarness.js`.
- Deps: `@mapng/pipelines` (it batches the single-tile pipeline).

### `@mapng/route` — route corridor domain
- Seed: `routeCorridor.js`, `routeTerrainComposite.js`, `routeStitch.js`,
  `routeProgress.js`, `routeBake.js`, `exportRouteLevel.js` (+ `googleRoutes`
  may live in fetching, consumed here).
- Deps: `@mapng/geo`, `@mapng/terrain`, `@mapng/tiles`, `@mapng/export`.

### `@mapng/pipelines` — orchestrators lifted out of `App.vue`
The control flow currently inside `handleGenerate` / `handleStartBatch` /
`handleBakeRoute` etc. becomes plain async functions here, returning
progress-emitting results. This is what makes both pipelines testable.
- Exports e.g. `runSingleTileBake(opts, onProgress)`,
  `runRouteBake(opts, onProgress)`, `exportSingleTileLevel(...)`.
- Deps: terrain, tiles, osm, export, route.

### `app/` — Vue shell
`App.vue` shrinks to UI + wiring: it calls `@mapng/pipelines`, binds progress to
stores, renders panels. Components and stores move under `app/`.

### `tools/` — build/dev only
The vite plugins and node sidecars. They may import leaf packages
(`@mapng/geo`, `@mapng/export`) but nothing imports *them*.

## 3. Dependency rule (enforced direction)

```
geo  ← fetching ← terrain ← tiles ← osm ← export ← route ← pipelines ← app
        ↑__________________ workers ______________↑
                                          batch ← pipelines
```

- **Leaf packages (`geo`, `workers`) import nothing from `@mapng/*`.**
- Lower layers never import higher layers. `terrain` must not import `export`;
  `export` must not import `pipelines`; nothing imports `app`.
- No package imports Vue except `app`. No leaf package touches the DOM/`window`
  except behind the `workers`/`fetching` boundary.
- Enforce with `eslint-plugin-import` `no-restricted-paths` (or
  `dependency-cruiser`) so a violating import fails CI.

## 4. The pipelines, re-drawn

Both become a sequence of package calls instead of inline handler code:

```
runSingleTileBake:  fetching → terrain → osm → tiles → export
runRouteBake:       fetching(routes) → route(corridor) → [terrain → tiles → export] per chunk → route(stitch)
exportRouteLevel:   route(composite) → tiles(conform) → export(beamng, route-mode)
runBatch:           batch → runSingleTileBake × grid
```

The shared core (`terrain`, `tiles`, `osm`, `export`) is consumed identically by
both — the route pipeline is just "chunk + per-chunk single-tile core + stitch".
