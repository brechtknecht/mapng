# 10 — exportBeamNGLevel.js Decomposition (cold-start handoff)

Single entry point for a fresh thread decomposing the **last and largest**
god-file, `packages/bake/src/exportBeamNGLevel.js` (**5558 LOC**) → `beamng/*`.
Read **this** first; it is self-contained. For the general refactor context skim
[09](09-continuation-handoff.md) (§2 recipe, §3 oracle, §4 learnings) — this doc
repeats the parts that matter and adds everything specific to this file.

---

## 0. Where you are

- **Branch:** `refactor/internal-decomposition` (local, NOT pushed). Tree clean,
  all green.
- **Done this far (verbatim, behind barrels):** 10 god-files incl. `terrain.js`
  1986→10 (`8f14ff9`) and `export3d.js` 2163→11 (`636122c`, → `scene3d/*`).
- **Remaining offenders** in `tools/lint-size-allow.json`:
  `exportBeamNGLevel.js` (5558, **this task**), `batchJob.js` (1561),
  `ColladaExporter.js` (697, VENDORED — permanent exempt).
- **After this:** `batchJob.js` (09 §6d), then the package lifts (08), then
  batch-in-worker.

## 1. Resume gate (run before AND after every commit)

```
npm run check     # = boundaries + lint:size + test:all (93 tests)
npm run build     # vite build of the Vue app
node --check scripts/googleBakeWorker.mjs   # node bake sidecar must parse
```
All three green. **One coherent step per commit, keep every commit green.**

## 2. The recipe (proven on terrain + export3d this session)

1. Start green.
2. **Write** focused module(s) under `packages/bake/src/beamng/`, each with a
   `/** @layer core|io|flow */` header. Copy bodies **VERBATIM** — a move, not a
   rewrite. `io` = canvas/fetch/zip/THREE-renderer; `core` = pure compute;
   `flow` = the orchestrator.
3. Turn `exportBeamNGLevel.js` into a **re-export barrel** (it has exactly ONE
   export — `exportBeamNGLevel` — so the barrel is one line:
   `export { exportBeamNGLevel } from './beamng/exportBeamNGLevel.js';`). This
   keeps both consumers (`components/panels/ExportPanel.vue`,
   `packages/route/src/exportRouteLevel.js`) and the `@mapng/bake/exportBeamNGLevel`
   subpath byte-for-byte unchanged.
4. Drop the `tools/lint-size-allow.json` entry once <500. (Removing the LAST
   entry: delete the trailing comma on the new last line — `check-filesize.mjs`
   JSON.parses it.)
5. Verify the gate. Green → commit.
6. **Big excisions: Write whole files, don't Edit 200-line blocks** (Edit needs
   an exact match; trailing whitespace breaks it; `sed` is policy-blocked).
7. **The size-lint is a ratchet** — never ADD allowlist entries; new code is
   born small. It also errors on a STALE entry, so dropping it is mandatory.

## 3. Build the .zip oracle FIRST — but mind THREE headless traps

This is the one most worth a real oracle (09 §6c). `exportBeamNGLevel` returns a
`.zip` Blob; hash each entry's bytes and pin a golden against the monolith, then
assert after each extraction. **But importing this file headlessly hits THREE
blockers — solve them up front:**

1. **`.py?raw` Vite import (line 16):**
   `import beamngGlbToDaeScript from '../../../scripts/beamng_glb_to_dae.py?raw';`
   Node can't resolve `.py?raw`. Fix for the test: a tiny node loader hook
   (`--import`) that maps `*?raw` → `fs.readFileSync` of the path. (It's just a
   string the entry writes into the zip twice — see lines 4977, 5170.)
2. **export3d barrel → WebGLRenderer (the export3d trap, see 09 §6b):** line 7
   `import { createOSMGroup, createSurroundingMeshes, SCENE_SIZE } from './export3d.js'`.
   The export3d barrel re-exports `glbExport`/`daeExport` → `google3dTiles` →
   `3d-tiles-renderer` builds a `WebGLRenderer` at module-eval (needs a GPU).
   **Cleanest fix (do it as part of the decomposition):** repoint those three
   to the leaf modules — `createOSMGroup` from `./scene3d/osmMeshes.js`,
   `createSurroundingMeshes` from `./scene3d/surroundingMeshes.js`, `SCENE_SIZE`
   from `./scene3d/sceneProjection.js`. exportBeamNGLevel has **no direct
   google3dTiles import** (verified — its only `./` imports are exportTer,
   osmTerrainMaterials, export3d, cropTerrain, buildingFoundations,
   ColladaExporter, roadNetwork, junctionMesh, junctionRaster, zipExportSidecar),
   so this severs the WebGLRenderer dependency entirely. (Confirm the google-
   tiles path `generateGoogleTilesGLB` @576 doesn't reach google3dTiles; if it
   does, fall back to the WebGLRenderer Proxy-stub from the 09 §6b probe.)
3. **canvasShim already handles DOM canvas + `createElementNS`** (added this
   session for THREE). `installCanvasShim()` before importing. The file has **7
   `document.createElement('canvas')`** sites (heightmap/preview/texture PNGs).

**Determinism for the golden hash** (only 4 volatile sites — easy):
- `Math.random` — **1 site**. Seed it (mulberry32, copy from
  `tests/export3dHeadless.test.mjs`).
- `new Date`/`toISOString` — **3 sites** (timestamps in `info.json`, the export
  report, maybe a lua header). Either stub `Date`, OR **exclude the timestamped
  entries** from the per-entry hash (hash all entries except those known to carry
  a timestamp — log which you skip; see 09 §4 "no silent caps").

**Fixture:** reuse the `makeTerrainData()` shape from
`tests/export3dHeadless.test.mjs` (heightMap + bounds + minHeight + osmFeatures),
add `satelliteTextureUrl`/`hybridTextureUrl` (blob: handles from the shim) so the
texture path runs. Call `exportBeamNGLevel(data, center, { returnBlob/return the
zip, onProgress: ()=>{} })`, unzip, sha256 each entry. Wire into `test:all` in
root `package.json` and `git add -f tests/<name>.test.mjs` (`tests/` is
gitignored, files tracked).

**If the oracle proves too costly to stand up** (e.g. the google-tiles path drags
in the renderer): capture the golden per-CLUSTER instead — most helpers below are
pure and produce plain JS objects/strings; import the **leaf** beamng module and
hash its output directly (cheap, like export3d's `osmMeshes`). Reserve a real
in-browser smoke (or `testlab:capture`) for the orchestrator. **Do not guess on
the two untested giants — capture or stop and report** (09 §3).

## 4. Concrete seams — `beamng/*` (verified against the file 2026-06-24)

The file is ~4200 lines of **already-separated top-level helpers** + ONE 1340-line
entry `exportBeamNGLevel` (@4216). Decomposition is mostly *grouping helpers into
themed modules* + slimming the entry. Proposed modules (line ranges approximate;
**verify names against the file, never trust this list blindly** — 09 §4):

| module | layer | contents (line range) |
|---|---|---|
| `beamng/worldMath.js` | core | sanitizeLevelName, generatePersistentId, pointInBounds, filterOSMFeaturesToBounds, computeSquareSize, geoToWorld, computeSpawnRotationMatrix, findSpawnPosition (56-235) + getTerrainHeightWorld, geoToWorldPoint, rotationMatrixFromYaw, findHighestTerrainPoint, isClosedRing, pointInPolygonLatLng/World, normalize2D, hashString, seededRandom, simplifyPolyline (3049-3608) |
| `beamng/format.js` | core | roundTo, formatNumber, formatBool, formatIsoTimestamp, formatDurationMs, metersToKm2, clamp (2726-2780) |
| `beamng/textures.js` | io | urlToPngBlob, resizePngBlob, getTerrainTextureBlob, generatePreviewBlob, generateHeightmapPng, generateRoadArchitectHeightmapPng (235-460) — canvas |
| `beamng/meshAssets.js` | io | generateOSMObjectsDAE, generateGoogleTilesGLB, generateGoogleDebugCubeDAE, generateOSMBuildingsCollisionDAE, generateTerrainBackdropDAE (460-1064) — ColladaExporter/THREE/createOSMGroup |
| `beamng/decalRoads.js` | core | ROAD_EDGE_MARGIN…generateDecalRoads — all the decal-road consts + helpers (1064-1688) |
| `beamng/roadArchitect.js` | core | createRoadArchitect* + makeRoadArchitect* + enrichRoadArchitectCrossroads + generateRoadArchitectSession (1688-2359, ~670 LOC — **may need a 2-way split**, e.g. profiles vs session) |
| `beamng/meshRoads.js` | core | buildSegmentWorldInfo, buildMeshRoadAnalysis, generateMeshRoads (2359-2558) |
| `beamng/water.js` | core | WATERWAY_*/WATER_*/RIVER_TEMPLATE, isExcludedWaterFeature, percentileValue, computeBestFitWaterBlock, buildWaterBlockObjects, buildSeaLevelWaterPlane, smoothHeights, parseNumericWidth, buildRiverObjects (2586-3818, interleaved — pull carefully) |
| `beamng/barriers.js` | core | NATIVE_BARRIER_ASSETS, EAST_COAST_FENCE_MATERIAL_DEFS, MAX_NATIVE_BARRIER_OBJECTS, resolveNativeBarrierAsset, buildNativeBarrierObjects, buildBarrierFolderItems (3130-3489) |
| `beamng/forest.js` | core | cloneManagedItemData, makeForestPlacement, BEAMNG_*_DENSITY/MAX, jitterLatLngByMeters, sampleAreaPlacements, buildForestPlacements, serializeForestFiles, buildGroundCoverObjects (3818-4216) |
| `beamng/report.js` | core | summarizeOsmFeatures, resolveElevationSourceLabel, summarizeTerrainSamples, buildBeamNGExportReport (2781-3031) — uses format.js |
| `beamng/levelZip.js` | core | toNDJSON, writeSimGroupTree, sanitizeRoadFolderName, buildRoadFolderGroups (2558-2586, 3489-3537) |
| `beamng/exportBeamNGLevel.js` | flow | the entry @4216 + the zip-assembly. Keeps the `?raw` import + onProgress + the virtual-zip writing. |

**`loadMapngFlagAsset` (@3031)** — fetches an asset; put in `beamng/textures.js`
or its own tiny io module.

## 5. The entry function — the hard part

`exportBeamNGLevel` (@4216, ~1340 LOC) is: **(a)** preamble that computes every
sub-result (levelName, materials, decal/architect/mesh roads, barriers, water,
forest, google tiles, report) by calling the helpers above; **(b)** a **virtual
zip** accumulator —
```js
const zipDirs = [];
const zipEntries = new Map();           // path → string | Blob | TypedArray
const zip = { folder: p => zipDirs.push(p), file: (p,c) => zipEntries.set(p,c) };
```
(@4703) populated by **~73 `zip.file()`/`zip.folder()`** calls; **(c)** packaging
— `compressZipViaSidecar` (server) or `new JSZip()` + `generateAsync` (@5538,
prod fallback).

Even after pulling helpers, the entry's own body (the ~73 zip writes) is large.
To get it <500, **extract the zip-assembly into `beamng/levelManifest.js`** as a
function `writeLevelEntries(zip, ctx)` where `ctx` is an **explicit context
object** carrying every computed piece (levelName, base, size, lat/lng,
materials, roadFolderGroups, meshRoads, forestFiles, barrierObjects, googleTile
pieces, report, …). **Thread the context object — do NOT rely on closure scope**
(09 §6c). The entry then: compute → build ctx → `writeLevelEntries(zip, ctx)` →
package. Expect the ctx to be wide (~30 fields); that's fine — it's the seam.

Suggested commit order (each green, oracle-checked): worldMath+format →
textures → decalRoads → roadArchitect → meshRoads → water → barriers → forest →
report+levelZip → meshAssets → levelManifest (zip-assembly) → entry barrel. Pure
clusters first (cheap leaf oracles), the renderer/zip-coupled ones last.

## 6. Definition of done

`exportBeamNGLevel.js` <500 (a one-line barrel); every new module `@layer`-tagged;
`core` imports no `io`/`flow`; allowlist entry dropped; gate green (check + build
+ worker); the `.zip` (or per-cluster) oracle pins byte-stability. Then update
[09](09-continuation-handoff.md) §0/§5/§6c + the `refactor-plan` memory, and move
on to `batchJob.js` (09 §6d). Nothing pushed — the maintainer pushes/opens the PR.
