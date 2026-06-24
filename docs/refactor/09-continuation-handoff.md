# 09 — Continuation Handoff (read this first)

Single entry point for a fresh thread continuing the `@mapng/*` refactor. Read
**this** + skim [06](06-internal-decomposition.md) (original plan),
[07](07-decomposition-handoff.md) (mid-progress + learnings), and
[08](08-package-architecture.md) (the decided package architecture). Everything
needed to pick up cold is below.

---

## 0. TL;DR — where you are, what's next

- **Branch:** `refactor/internal-decomposition` (off `feat/tile-ground-conform`).
  **Local only — NOT pushed.** Working tree clean, everything green.
- **Two-phase plan (decided with maintainer, see §6):**
  1. **Decompose** the remaining god-files in-place into `<500` modules
     (the proven recipe, §2). ✅ **ALL DONE** — `exportBeamNGLevel.js` (9a `4e76859`
     / 9b `b497038` / 9c `0f6d49e`, bake-verified) and `batchJob.js` (`9332706`,
     see **[11-batchjob-handoff.md](11-batchjob-handoff.md)**) are the last two.
     (`terrain.js` ✅ `8f14ff9`; `export3d.js` ✅ `636122c` — see §6a/§6b.)
     **The size ratchet is now empty of real work** (only vendored ColladaExporter
     remains). ← *you are here; next is phase 2.*
  2. **Lift** the clean module folders into new packages `@mapng/terrain` and
     `@mapng/export`, then re-architect `@mapng/batch` to run off-main-thread in
     a worker. **`processTile.js` is the worker seam** (08 §3) — already a clean
     function of explicit inputs.
     - **`@mapng/terrain` ✅ DONE (`72c798e`)** — lifted terrain.js + terrain/* +
       resampler* + resample/* + surroundingTiles **+ the OSM texture group**
       (osmTexture/osm/*/roadNetwork, which the closure dragged along — the
       single-quote-only scan had missed the double-quoted deps).
     - **`@mapng/export` ✅ DONE (`9853323`)** — lifted the 47 export-private files
       (the 4 format entries + scene3d/beamng/roads/junction*/osmTerrainMaterials/
       2 materials/buildingFoundations/ColladaExporter). bake keeps the 28-file
       compute core. Partitioned by import-closure (move = export-private, not in
       bake's public-compute down-closure); zero bake→export cycle edges. Layer is
       now `geo < fetching < terrain < bake < export < {route,batch} < pipelines`.
     - **batch-in-worker (08 §3) STARTED** — a batch encode Web Worker
       (`batchEncodeWorker.js` + `batchEncodeClient.js`, main-thread fallback)
       now runs the **heightmap PNG, .ter, GeoTIFF** encodes off-thread
       (`ff3f956`, `5321e9a`), byte-identical by construction, bundle
       renderer-free. Heavy work was already off-thread (resampling→worker;
       google-tiles bake + zip→node sidecar). ← *you are here. Remaining: roadmask
       (OffscreenCanvas, parity risk — deferred), zip assembly (low priority);
       canvas textures + GLB/DAE + download can't move. Needs an in-app grid
       verify of the offloaded encodes.*
- **Remaining offenders (0 real + 1 vendored)** in `tools/lint-size-allow.json`:
  | file | LOC | target | oracle? |
  |---|---|---|---|
  | ~~`exportBeamNGLevel.js`~~ | ~~5558~~ | ✅ `beamng/*` (18 modules, 162-LOC entry) | done — 3 golden oracles + real bake |
  | ~~`batchJob.js`~~ | ~~1561~~ | ✅ 65-LOC barrel + 13 layered modules (`9332706`) | pure core yes (`batchCoreHeadless`); runner = in-app grid run (outstanding) |
  | `packages/bake/src/ColladaExporter.js` | 697 | — | VENDORED, permanent exempt |
- **Recommended order:** ~~`terrain.js`~~ → ~~`export3d.js`~~ → ~~`exportBeamNGLevel.js`~~
  → ~~`batchJob.js`~~ → **package lifts → batch-in-worker** (next).

## 1. Resume gate (run before and after every change)

```
npm run check     # = boundaries + lint:size + test:all (102 tests)
npm run build     # vite build of the Vue app
node --check scripts/googleBakeWorker.mjs   # the node bake sidecar must parse
```
All three must be green. One god-file per commit; keep every commit green.
`npm run check` = `node tools/check-boundaries.mjs && node tools/check-filesize.mjs && npm run test:all`.

## 2. The recipe that works (followed for all 8 files done so far)

1. Start green.
2. **Read the whole god-file once.** Map its functions: pure compute (`core`)
   vs effects (`io`: fetch/canvas/IndexedDB/zip/THREE-renderer/localStorage) vs
   orchestration (`flow`).
3. **Write** new focused module(s) under a domain subfolder, each with a
   `/** @layer core|io|flow */` header. Copy bodies **VERBATIM** — this is a
   move, not a rewrite. No logic changes.
4. Turn the original file into either a thin **re-export barrel**
   (`export { x } from './new/path.js'`) or a slim accessor/entry file that
   imports the new modules. EITHER keeps every consumer + the node worker +
   `@mapng/<pkg>/<file>` subpath importers byte-for-byte unchanged.
5. Delete the file's `tools/lint-size-allow.json` entry once it's `<500`. (When
   you delete the LAST json entry, remove the trailing comma on the new last
   line — `check-filesize.mjs` JSON.parses the file.)
6. **Verify** the resume gate. Green → commit. Big excisions: **rewrite/Write
   the whole file, don't Edit a 200-line block** (Edit needs an exact match;
   long blocks break on trailing whitespace; `sed` range-delete is policy-blocked).

## 3. Headless render oracle — the key capability (USE IT for canvas giants)

A myth in earlier handoffs said the export/texture giants "need a browser." They
don't. `tools/testlab/canvasShim.mjs` backs `document.createElement('canvas')`,
`Image`, `URL.createObjectURL`, `canvas.toBlob` with `@napi-rs/canvas` (a devDep,
already installed). Pattern (see `tests/osmTextureHeadless.test.mjs`):

```js
import { installCanvasShim } from '../tools/testlab/canvasShim.mjs';
installCanvasShim();
const { fn } = await import('@mapng/bake/<module>');   // import AFTER the shim
// seed Math.random (most painters add noise) → render → sha256(canvas.toBuffer('image/png'))
```

**To de-risk a canvas-coupled split, capture a GOLDEN HASH against the monolith
BEFORE splitting, then assert it after.** Proven on osmTexture (06 step 6): I
rendered a 7-feature fixture through the new code AND the pre-split monolith via
`git stash` and got identical SHA-256 — the golden hash is now pinned in the
test. Do the same for `export3d` (GLTFExporter/ColladaExporter output is
hashable) and `exportBeamNGLevel` (the `.zip` bytes / per-entry hashes).

For the bake GEOMETRY oracle there's also `tools/testlab/` (a real headless bake:
`node tools/testlab/captureRealBake.mjs --lat .. --lng .. --size .. --name ..`
spawns `scripts/googleBakeWorker.mjs`; `fetchTerrainHeadless.mjs` supplies the
DEM). Use it if a geometry change needs a real-bake oracle.

## 4. Hard-won learnings (these actually bite)

- **Re-export barrel = zero churn.** Never update import sites across the repo
  during decomposition; the cross-PACKAGE move (phase 2) is the only place import
  paths change.
- **The node worker is the trap.** `scripts/googleBakeWorker.mjs` imports bake
  geometry (`@mapng/bake/tileGroundConform`, `groundMask`, `@mapng/geo`, etc.).
  Anything it touches must stay DOM/renderer-free (`@layer core`). The layer rule
  (`core` may not import `io`/`flow`) guards this — always `node --check` the
  worker after a bake-geometry move. (None of the 4 remaining giants are imported
  by the worker — verified — but re-check if you move shared helpers.)
- **`@layer` is per file, not per export.** A file doing any IO is `io` even if
  it also exports a pure helper. The only hard rule: a pure helper imported by a
  `core` module MUST live in a `core` file. `check-boundaries.mjs` only flags
  `core → io/flow`; untagged files are unchecked (legacy).
- **Watch for near-duplicate kernels — DON'T merge them.** `resamplerWorker` and
  `terrainResampler` each carry their own `pushPullInpaint`/`expandFill`/
  `relaxFilled` — they LOOK identical but are tuned differently (iters 200 vs
  120, different finite checks). With no tests, relocate each copy verbatim into
  its own module; a real dedup is a separate test-first task.
- **Stale function names in old docs.** 07 claimed a "1430-LOC getFeatureCategory
  needing a rewrite" — false; `getFeatureCategory` was a one-liner, the real
  classifier was `getFeatureColor` (208 lines, pure, moved verbatim). Verify
  against the actual file, never trust a doc's LOC/name claim.
- **Barrel↔module cycles.** If the original filename becomes a barrel that
  re-exports from module M, and M imports back from the original (for a shared
  symbol), you get a cycle. Fix: move the shared entry into its own module (done
  for `tiles/bakeGoogle3DTiles.js`). Likewise `@mapng/export` will need bake's
  `index.js` to STOP re-exporting `export3d`/`exportBeamNGLevel` (else
  bake→export→bake).
- **The size-lint is a ratchet.** Never ADD allowlist entries; new code is born
  small. The lint also errors on STALE entries (file dropped <500 but still
  listed) — so removing the entry is mandatory once you're under.
- **`tests/` is gitignored** but the test files are tracked. New tests need
  `git add -f tests/<name>.test.mjs`. Wire new tests into the `test:all` script
  in root `package.json`.

## 5. Map of what exists now (already-decomposed folders under packages/bake/src/)

- `scene/` — shared SCENE_SIZE / sampling / units math (step 1).
- `tiles/` — googleBakeCore drain (step 2) + `bakeCache`, `bakeFlags`,
  `bakeGoogle3DTiles`, `bakeSession` (google3dTiles decomposition, step 3).
- `materials/` — `groundCoverMaterials`, `forestAssetSets{,A,B}`, `waterProfiles`,
  `beamngFlavors` (beamngFlavorCatalog) + `terrainReferenceMaterials`,
  `osmLayerMap` (osmTerrainMaterials) (step 10).
- `resample/` — `resampleKernels` (terrainResampler) + `heightSampling`,
  `heightFinalize` (resamplerWorker) (step 7).
- `terrain/` — `surroundingTileMath`, `surroundingTilesZip` (surroundingTiles)
  + (terrain.js, step 7) `mercatorTiles`, `heightDecode`, `pMap` (core),
  `gpxzFetch`, `usgsFetch`, `tileLoaders`, `globalTiles`, `tifLoader`,
  `lazLoader` (io), `fetchTerrainData` (flow).
- `roads/` — `junctionConstants`, `geomPrimitives`, `junctionPolygons`,
  `polylineCleanup` (junctionGeometry, step 10).
- `osm/` — `osmColors`, `pathGeometry`, `laneInference`, `roadWidths`,
  `junctionCaps` (core) + `roadDraw`, `featureRender` (io) (osmTexture, step 6).

- `scene3d/` — (export3d.js, step 8) `sceneProjection` (SCENE_SIZE + the shared
  projection/height cache), `osmGeometry`, `osmFeatureConfig`, `osmFeatureCollect`,
  `osmMeshes` (createOSMGroup), `corridorMask`, `sceneUtils` (core) +
  `terrainMesh`, `surroundingMeshes` (io) + `glbExport`, `daeExport` (flow).

Done files (all verbatim, barrels/slim entries): beamngFlavorCatalog 1008→128,
osmTerrainMaterials 961→381, google3dTiles 862→30, resamplerWorker 828→188,
surroundingTiles 668→466, junctionGeometry 629→24, osmTexture 1886→146,
terrain 1986→10, export3d 2163→11.

## 6. Decompose the 3 remaining giants (concrete seams)

### 6a. `terrain.js` (1986) → `terrain/*`   ✅ DONE (commit `8f14ff9`)
Split exactly as proposed. terrain.js is now a 10-line re-export barrel; the
public surface (`TERRAIN_ZOOM`, `project`, `parseTifFile`, `parseLazFile`,
`probeGPXZLimits`, `getGPXZRateLimitInfo`, `fetchTerrainData`,
`loadTerrainFromTif`, `loadTerrainFromLaz`, `checkUSGSStatus`,
`addOSMToTerrain`) + the `@mapng/bake/terrain` subpath are byte-for-byte stable.
Modules under `terrain/`: `mercatorTiles`, `heightDecode`, `pMap` (core);
`gpxzFetch`, `usgsFetch`, `tileLoaders`, `globalTiles`, `tifLoader`, `lazLoader`
(io); `fetchTerrainData` (= fetchTerrainData + addOSMToTerrain, flow).
Two deviations from the proposed seam, both forced & verbatim:
- `fetchTerrainData`'s sampler-prep block (global-tile stitch, ~250 lines) was
  extracted to `terrain/globalTiles.js` (`fetchGlobalTileSamplers`) — the only
  non-pure-move; it returns `{heightSampler, colorSampler, fallbackSamplerData,
  imageSamplerData}` so the orchestrator stays <500.
- `tifLazLoaders` (proposed single file) was 548 LOC → split into `tifLoader.js`
  + `lazLoader.js` (kept separate per the "don't merge near-duplicate kernels"
  rule; the two sat-tile loops differ in progress payloads).
Phase-2 note still stands: `gpxzFetch`/`usgsFetch` are candidates to sink into
`@mapng/fetching/elevation/`.

### 6b. `export3d.js` (2163) → `scene3d/*`   ✅ DONE (commit `636122c`)
export3d.js is now an 11-line barrel; public surface (`SCENE_SIZE`,
`createOSMGroup`, `exportToGLB`, `exportToDAE`, `createSurroundingMeshes`) + the
`@mapng/bake/export3d` subpath are byte-for-byte stable. Modules: see §5
`scene3d/`. createOSMGroup (713 LOC) was split 3 ways — `osmFeatureConfig`
(tag→config), `osmFeatureCollect` (feature→list bucketing, owns the random
tree/bush placement), `osmMeshes` (setup + per-category assembly). The shared
projection/height cache lives in `sceneProjection` (single module instance =
single cache, exactly as before); `getCachedUnitsPerMeter()` exposes the one
private constant that createRoadGeometry + corridorMask read directly.
**Oracle (`tests/export3dHeadless.test.mjs`):** seeded Math.random, hash the
merged buffer attributes of every mesh createOSMGroup emits — pinned golden
captured against the monolith, byte-identical after the split.
**Two traps learned, write them down:**
1. **The export3d barrel is NOT headless-importable.** `glbExport`/`daeExport`
   import `google3dTiles` → `3d-tiles-renderer` instantiates a `WebGLRenderer`
   at module-eval (needs a GPU). So the oracle imports the *leaf* module
   `@mapng/bake/scene3d/osmMeshes` directly, not the barrel. To capture the
   monolith golden I had to temporarily stub the google3dTiles import line in
   export3d.js (createOSMGroup never uses it), capture, then revert.
2. Taught `tools/testlab/canvasShim.mjs` `document.createElementNS` (THREE uses
   it for its internal canvas/img) — needed for any headless THREE test now.
- Phase-2: when `@mapng/export` lands, `glbExport`/`daeExport` (the only
  google3dTiles importers) gate headless tests — keep leaf-module oracles.

### 6c. `exportBeamNGLevel.js` (5558) → `beamng/*`   ← DO THIS NEXT
**Dedicated cold-start handoff: [10-exportbeamng-handoff.md](10-exportbeamng-handoff.md)**
(concrete seams verified against the file + the .zip-oracle headless traps:
`.py?raw` import + the export3d→WebGLRenderer pull). Summary below; read 10 first.

One enormous `exportBeamNGLevel(terrainData, center, options)` entry at ~4216,
preceded by ~4200 lines of helpers; canvas=17; 13 local `./` imports
(osmTexture, junctionMesh, exportTer, google3dTiles, beamngFlavorCatalog…).
Sub-extract in order, each green (06 step 9 list): `terWriter` → `levelMaterials`
→ `forestItems` → `osmObjectBoxes` → `decalRoads`/`meshRoads` → `levelManifest`
→ `levelZip` → `googleTilePlacement`, leaving `beamngLevel.js` orchestrator-only.
Expect closure-shared state — thread an explicit context object instead of
relying on scope. **This is the one most worth a real oracle:** capture the `.zip`
output (per-entry sha256) via the canvas shim against the monolith before each
extraction. The handoff bake-oracle (`testlab:capture`) is the geometry backstop.

### 6d. `batchJob.js` (1561) → `batch/{grid,state,run}`   (06 step 4)
Already well-structured; clean seams:
- `batch/grid.js` (**core**): `computeGridTiles`, `normalizeTileOffsets`,
  `computeGridTilesWithOffsets`, `computeGridBounds`, `getDefaultTileLabel`,
  `normalizeTileNames` (~37-176). Pure — add unit tests.
- `batch/state.js` (**io**, localStorage): `createBatchJobState`,
  `migrateLoadedState`, `saveBatchState`, `loadBatchState`, `clearBatchState`,
  `clearBatchClientCache`, `resetFailedTiles`, the normalize/flag helpers,
  `STORAGE_KEY` (~177-525).
- `batch/run.js` (**flow**): the run loop `runBatchJob` (~1452), `checkpoint`,
  memory/timing helpers, composite (`COMPOSITE_MAX_PIXELS`), `estimateTimeRemaining`,
  `formatDuration`, reporting helpers (~526-1551).
- `batchJob.js` becomes a barrel re-exporting the public surface.

## 7. Phase 2 — lift folders into packages (after §6 is done)

See [08](08-package-architecture.md) for full rationale. Target graph:
```
geo < fetching < terrain < bake < export < { route, batch } < pipelines
```
1. **`@mapng/terrain`**: move `terrain/*` (+ `resample/*`, `terrainResampler.js`,
   `resamplerWorker.js`, `surroundingTiles.js`) into a new
   `packages/terrain/`. terrain imports only `@mapng/fetching` + `@mapng/geo`
   (verified) → no cycle. Repoint consumers `@mapng/bake/terrain` →
   `@mapng/terrain`. Consider sinking the raw GPXZ/USGS HTTP into
   `@mapng/fetching/elevation/`.
2. **`@mapng/export`**: move `export3d`/`exportBeamNGLevel`/`exportTer`/
   `exportGeoTiff` (+ their `scene3d/*`, `beamng/*`) into `packages/export/`.
   **Remove bake `index.js`'s re-exports** of export3d/exportBeamNGLevel (breaks
   the bake→export→bake cycle). Repoint route/batch/app to `@mapng/export/*`.
3. **Update `tools/check-boundaries.mjs`**: add `terrain` and `export` to the
   `ALLOWED` map with correct downward sets; add `terrain` to bake's set, `export`
   to route/batch/pipelines' sets. Update package.json `exports` maps
   (`"./*": "./src/*.js"` pattern) + workspace wiring.

## 8. Phase 3 — `@mapng/batch` runs in a worker (runtime change, last)

Decided: keep `@mapng/batch` a package, but re-architect `runBatchJob` to execute
off the main thread (Web Worker in-browser / Node worker thread headless) so grid
bakes don't block the UI. Do this AFTER 6d so the worker boundary lands on the
clean `grid`/`state`/`run` message-passing seam, not a 1561-LOC blob. This is a
behavioral change — needs a runtime bake to verify (browser or the headless
testlab), not just `npm run check`. Design the message protocol around
`createBatchJobState` (serializable) + progress callbacks.

## 9. Definition of done (from 06 §4)

No `packages/*/src` file >500 LOC except vendored `ColladaExporter.js`; every
module `@layer`-tagged; `core` imports no `io`/`flow`; package graph enforced;
`npm run check` + build + worker green; both bake paths and single-tile / route /
batch exports smoke-verified (browser or headless oracle). Nothing pushed yet —
the maintainer pushes / opens the PR.
