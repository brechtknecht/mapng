# 03 — Migration Plan

Ordered, shippable phases. Each phase ends green: `npm run test:geotiff`,
`test:weld`, `test:conform`, `test:route` all pass, plus a manual smoke of one
single-tile bake and one short route bake. Commit per phase; never mix a "move"
commit with a "split" commit.

**Sequencing principle:** scaffold → extract leaves → extract core (bottom-up) →
lift orchestrators → split god-files → enforce. Risk rises with depth, so the
risky god-file splits come *after* boundaries exist to catch regressions.

---

## Phase 0 — Scaffolding & guardrails  (low risk, no code moves)
1. Enable npm workspaces; create empty `packages/*` with a `package.json` +
   `index.js` barrel each.
2. Add Vite aliases + a matching alias map the `node --test` suite uses, so both
   resolve `@mapng/*`.
3. Add `dependency-cruiser` (or eslint `no-restricted-paths`) with the §3 rules,
   initially **warn-only**.
4. Baseline: capture a reference single-tile bake and route bake output
   (hashes of `.ter`, GLB, ZIP manifest) — `tools/testlab/captureRealBake.mjs`
   already exists; wire it as the regression oracle.

**Gate:** build + tests pass; capture oracle recorded.

---

## Phase 1 — `@mapng/geo`  (low risk, high payoff)
1. Move `geoUtils.js` → `packages/geo`.
2. Hunt and consolidate the duplicated helpers into `geo`: `clamp` (11 files),
   `bilinear` (8), `metersPerDegree` (4), `deg2rad`, `computeUnitsPerMeter` (9),
   stray `proj4` calls (9). Replace local copies with imports **one file at a
   time**, running tests between.
3. Add unit tests for each consolidated helper (most are trivially testable).

**Gate:** every former duplicate site imports `@mapng/geo`; `dependency-cruiser`
shows `geo` as a leaf.

---

## Phase 2 — `@mapng/fetching`  (low/medium risk)
1. Move loaders + sources: `osm`, `nominatim`, `googleRoutes`, `tilesAuth`,
   `elevationCache`, `ascLoader`, `lazLoader`, `tifLoader`, `gmlLoader`,
   `kron86`, `googleTilesPersistentCache`, `retryPolicy`.
2. Introduce `httpClient` (retry/backoff/headers) and migrate fetchers onto it
   incrementally — **after** the move, as a follow-up commit.
3. Define a `Cache` interface; back `elevationCache` +
   `googleTilesPersistentCache` with it (disk cache in `tools/` adopts the same
   interface).

**Gate:** loaders import `@mapng/geo`, expose unchanged signatures; loader tests
(`ascLoader`, `gmlLoader`) green.

---

## Phase 3 — `@mapng/workers`  (medium risk — worker URLs/HMR)
1. Move `resamplerWorker/Client`, `lazWorker/Client`, `taskQueues`.
2. Keep the existing message protocol initially; introduce `WorkerPool` +
   envelope as a follow-up, migrating one pair at a time.
3. Verify Vite `new Worker(new URL(...))` resolution and the
   `laz-perf/lib/worker` optimizeDeps include still work from the new path.

**Gate:** resample + laz load work in a real browser bake (worker smell is HMR
staleness — hard-refresh per the project memory note before verifying).

---

## Phase 4 — `@mapng/terrain`  (medium risk)
1. Move `terrainResampler`, `cropTerrain`, `scalarFieldGrid`, `surroundingTiles`.
2. Split `terrain.js` (1986 LOC) along its existing seams:
   - `sources/*` (DEM source routing, fetch) → depends on `@mapng/fetching`
   - `build` (assemble/resample to 1 m/px grid)
   - `texture` (satellite/OSM composite) → may call `@mapng/osm`
   Keep a `terrain/index.js` barrel re-exporting the old public functions so
   call sites don't churn yet.

**Gate:** `scalarFieldGrid`, `groundMask`, `tileGroundConform` tests green;
single-tile DEM matches the Phase-0 oracle.

---

## Phase 5 — `@mapng/tiles` and `@mapng/osm`  (medium risk)
1. `tiles`: move `googleBakeCore`, `google3dTiles`, `googleBakeSidecar`,
   `tileGroundConform`, `groundMask`. Preserve the sidecar fallback seam exactly.
2. `osm`: move `osmTexture`, `osmTerrainMaterials`, `roadNetwork`, `junction*`,
   `buildingFoundations`. Convert the large hard-coded tables in
   `osmTerrainMaterials` toward data, but defer if it perturbs the material map.

**Gate:** bake + ground-conform output matches oracle; `junctionGeometry` test
green; `route:` tests still green (route consumes tiles).

---

## Phase 6 — `@mapng/export`  (HIGH risk — the god-files)
Do this **after** boundaries exist so regressions surface fast.
1. Move the easy exporters first: `ColladaExporter`, `exportGeoTiff`,
   `exportTer`, `zipExportSidecar`, `uploadGeoMetadata`, `uploadBounds`,
   `export3d`.
2. Move `exportBeamNGLevel.js` **as-is** (no split) → green.
3. Then apply the god-file split playbook ([04](04-conventions.md)) to
   `exportBeamNGLevel` and `export3d`, one extracted unit per commit, hashing the
   ZIP/`.ter`/GLB against the oracle after each.
4. `beamngFlavorCatalog.js` → JSON/data module loaded by the exporter.

**Gate:** byte-stable BeamNG ZIP + `.ter` + GLB vs Phase-0 oracle, for both
single-tile and route-mode export. `test:geotiff` green.

---

## Phase 7 — `@mapng/route` and `@mapng/batch`  (low/medium risk)
1. `route`: move `routeCorridor`, `routeTerrainComposite`, `routeStitch`,
   `routeProgress`, `routeBake`, `exportRouteLevel`. These are already clean.
2. `batch`: move `batchJob`, `batchRuntime`, `batchExports`, `batchCache`,
   `jobData`, `runConfiguration`, `traceability`, `batchDebugHarness`.

**Gate:** `test:route` + all `route*`/`buildCorridorStations` tests green; full
route bake + export matches oracle.

---

## Phase 8 — `@mapng/pipelines` (lift orchestrators out of `App.vue`)  (HIGH risk)
1. Extract `handleGenerate` → `runSingleTileBake(opts, onProgress)`;
   `handleBakeRoute` → `runRouteBake`; `handleExportRouteBeamNG` →
   `exportRouteLevel` wrapper; batch entry → `runBatch`.
2. `App.vue` handlers become thin: gather opts from refs/stores, call the
   pipeline fn, pipe progress to the store, handle errors/UI.
3. Add the **first integration tests** for the pipelines (headless, mocked
   fetch) — previously impossible because logic lived in a component.

**Gate:** manual single-tile + batch + route runs identical to today; new
pipeline integration tests green.

---

## Phase 9 — `app/` tidy + enforce  (low risk)
1. Move `App.vue`, `components/`, `stores/` under `app/`. Consider splitting
   `App.vue` UI into `MapContainer` / `PanelHost` / `ModalHost`.
2. Flip `dependency-cruiser` from warn → **error** in CI.
3. Add file-size budget lint (see [04](04-conventions.md)); no new file > 500 LOC.
4. Delete dead code surfaced during moves; update `README`/`docs`.

**Gate:** boundary rules enforced in CI; full test suite + both manual bakes
green; no package leaks Vue except `app`.

---

## Risk register

| Risk | Where | Mitigation |
|---|---|---|
| Byte drift in exports | Phase 6 | Phase-0 hash oracle after every split commit |
| Worker URL / HMR breakage | Phase 3 | hard-refresh before verify; smoke a real bake |
| Sidecar fallback regresses | Phase 5 | test both with and without node sidecar running |
| Circular imports reintroduced | all | dependency-cruiser warn from Phase 0, error by Phase 9 |
| `App.vue` behaviour change | Phase 8 | extract function bodies verbatim first, refactor after green |

## Definition of done
- `services/` is empty; every module lives in a `@mapng/*` package or `tools/`.
- No file > 500 LOC (god-files decomposed).
- Geo/grid math has one home; no duplicated `clamp`/`bilinear`/`proj4`.
- Both pipelines run as testable `@mapng/pipelines` functions with integration
  tests; `App.vue` only wires UI.
- Boundary + size rules enforced in CI.
