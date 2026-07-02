# Plan: `.ter` ↔ Google-tiles vertical alignment gap (sandbox vs production)

## Problem statement

The drivable ground (`.ter`) is extracted from the baked Google 3D tiles (rasterise
→ per-cell min → bare-earth filter; see `packages/bake/src/ground/`). The **exact same
code** runs in two places:

- **Terrain sandbox** (`components/terrain-sandbox/`, route `/terrain-sandbox`): the
  extracted ground overlaps the tiles to **centimetres** — there's even faint
  z-fighting, which is the *good* sign (we're sub-decimetre accurate).
- **Production** (main app 3D preview via `Preview3D.vue`, and the BeamNG export):
  the ground is off the tiles by **up to several metres**, and the gap is not
  constant.

Same extraction code → the discrepancy must be in the **inputs / coordinate frames /
datums** that production feeds the shared code, not in the algorithm. The sandbox is the
**reference implementation that works**; the goal is to make production reproduce its
single-terrain / single-bake / single-datum invariant.

## Why "same code" can still diverge (the core invariant)

The tiles and the `.ter` must share **one vertical frame**. Three things define it:

1. **The tile geometry's vertical anchor**, baked into the mesh at bake time
   (`createTileMeshTransformer`, `packages/bake/src/tiles/tileMeshTransform.js:87`):
   ```
   beamZMeters = (groundOffset - minH) + cart.height
   groundOffset = mapngGroundY - googleGroundAlt
   mapngGroundY  = sampleHeightAtScene(data, 0, 0)   // DEM height at AOI centre
   minH          = data.minHeight
   ```
   So the anchor depends on **`data.heightMap` (its centre value)** and **`data.minHeight`**
   of whatever terrain was passed to the bake.

2. **The `.ter` datum**: the heightmap is encoded relative to `terrainData.minHeight`
   (`packages/export/src/exportTer.js`), and the preview's `TerrainMesh` renders
   `Y = (h - minHeight) * upm`.

3. **Any vertical offset applied to one but not the other**: the preview lifts tiles by
   `offsetY = (zOffset + TILE_RENDER_BIAS_M) * upm` (`components/three/GoogleTiles3D.vue:60`),
   and the **export paths also apply `getGoogleTilesZOffset()`** to tile placements
   (per `bakeFlags.js` doc + memory note). The `.ter` ground gets **no** such offset.

**Invariant that must hold:** the terrain used to *bake the tiles* and the terrain used
to *set the `.ter` datum / extract the ground* must be the **same `heightMap` + same
`minHeight`**, and any `zOffset` applied to the tiles must also be applied to the ground
(or to neither). The sandbox satisfies this trivially (one `terrain` object, one bake,
no zOffset). Production has several bakes and a crop step, so it can break.

## Suspects (ranked)

### 1. zOffset applied to tiles but NOT to the extracted `.ter` ground  ⟵ check first
`getGoogleTilesZOffset()` (localStorage `mapng_google_bake_zoffset`, the preview's z-offset
slider) is applied to the placed tile meshes in the export and to the preview tiles
(`offsetY`). The extracted ground has **no** zOffset. If the user nudged the slider by N
metres to line tiles up against the *old DEM* terrain, production tiles are lifted N m but
the `.ter` ground isn't → **gap = N metres**. The sandbox has no z-offset → cm alignment.
- Verify: `localStorage.getItem('mapng_google_bake_zoffset')` in the production app. If
  non-zero, that's at least part of it.
- Decide: with tile-derived ground, the zOffset should be **0** (the ground already
  matches the tiles), OR the same offset must be applied to the extracted ground.

### 2. Multiple bakes with inconsistent vertical anchor
Production bakes tiles in several places, each with a *different terrain object*:
- `Preview3D` → `googleTilesStore.bakeForPreview(props.terrainData)` (uncropped).
- Export `buildLevelArtifacts` injection (`packages/export/src/beamng/levelArtifacts.js`,
  ~line 135): `getOrBakeGoogle3DTiles(td, …)` where `td` is the **cropped square** terrain.
- Export mesh assets: `exportGoogleTilesForLevel(exportTerrainData, …)`
  (`levelArtifacts.js:309` → `googleTilesAssets.js:37`) where `exportTerrainData` is
  **post-foundation AND has `td.heightMap` already replaced by the extracted ground**
  (we overwrite `td.heightMap` before this runs).

The bake is cached by **bounds + resolved options**. Risks:
- **Anchor drift on cache miss**: if the mesh-asset bake is a cache *miss* (different
  options — quality/stripGround/corridorMask/errorTarget — than our extraction bake), it
  **re-bakes using `exportTerrainData.heightMap` = the EXTRACTED ground**, so
  `mapngGroundY = sampleHeightAtScene(extracted, 0,0)` ≠ the original DEM centre the `.ter`
  datum assumes. → tiles placed on a different anchor than the `.ter`.
- **Crop centre mismatch**: `prepareCroppedTerrainData` changes width/height/bounds and
  recomputes `minHeight`; the cropped centre DEM value (`mapngGroundY`) and `minHeight`
  can differ from the uncropped terrain the preview baked with.

Action: **log the anchor triple `{mapngGroundY, googleGroundAlt, minHeight}` at every
bake call** (preview, extraction, mesh-assets) and assert they're identical for one AOI.
The bake already logs `[google3dTiles] vertical anchor: …` — capture it from each call.

### 3. Datum terrain ≠ bake terrain in `buildLevelArtifacts`
We extract with `td` and keep `td.minHeight` as the `.ter` datum (fixed in commit
`30037b9`). But the **tiles placed in the level** come from the mesh-asset bake which may
have re-anchored (suspect 2). Confirm the placed-tile world Z and the `.ter` datum both
resolve to the **same `minHeight`** and the **same `mapngGroundY`**.

### 4. `TILE_RENDER_BIAS_M` (0.15 m)
Intentional 0.15 m lift of tiles above the `.ter` to avoid z-fighting
(`bakeFlags.js:75`). Not the metres-scale culprit, but it explains a residual ~0.15 m and
should be accounted for when measuring "the gap".

### 5. Preview vs export divergence
The user may be comparing the **3D preview** (live `.ter` overlay on the terrain mesh) OR
the **BeamNG** output. They can differ:
- Preview live extraction uses `maxSeg: 192` (coarse, resampled);
  export uses full res. Shape differs slightly, not metres.
- Preview extraction terrain = `props.terrainData`; export terrain = cropped `td`.
  Confirm which surface the user is measuring against in each.

## Investigation procedure (do in order)

1. **Reproduce + isolate.** Same AOI (Berlin Olympischer Platz, the default sandbox
   preset) in: (a) `/terrain-sandbox`, (b) main-app 3D preview with "preview .ter from
   tiles" on, (c) a BeamNG single-tile export. Record the measured gap in each.

2. **Check zOffset (suspect 1).** Read `localStorage mapng_google_bake_zoffset`. Set to 0,
   re-test (b) and (c). If the gap collapses to ~0.15 m, that's the primary cause →
   decide policy (zero it for tile-ground, or apply it to the ground too).

3. **Instrument the anchor (suspect 2/3).** Add temporary `console.info` of
   `{mapngGroundY, googleGroundAlt, minHeight, bounds, width}` at:
   - `googleTilesStore.bakeForPreview` call,
   - `buildLevelArtifacts` extraction bake (`getOrBakeGoogle3DTiles(td, …)`),
   - `exportGoogleTilesForLevel` → `getOrBakeGoogle3DTiles` (mesh assets),
   - the `extractTileGround` call (log the `terrain.minHeight` it used + the returned
     `minHeight`/`maxHeight`/`coverage`).
   For one AOI these must match. Any divergence in `mapngGroundY` or `minHeight` between
   the tile bake and the `.ter` datum **is** the gap (× `upm` for scene units).

4. **Confirm the bake-terrain heightMap.** Verify the mesh-asset bake (suspect 2) is a
   cache **hit** (reuses the group baked with the ORIGINAL DEM), not a re-bake with the
   extracted heightMap. If it can re-bake, either (a) bake tiles BEFORE replacing
   `td.heightMap`, or (b) pass the original-DEM terrain for the bake anchor while using the
   extracted ground only for the `.ter` heightmap. The anchor must always come from a
   single, stable terrain.

5. **Cross-check against the sandbox.** In the sandbox, `bakeVariant` bakes `terrain` and
   `buildTileHeightField` extracts from the same `terrain`; render uses `scale.y = upm` with
   no zOffset. Mirror that exact contract in production: one terrain object drives the
   bake anchor, the extraction datum, and the placement — and zOffset is out of the loop.

## Likely fix shape (to validate, not assume)

- **Zero (or propagate) zOffset** for the tile-derived ground path.
- **Single anchor terrain**: ensure the terrain that anchors the tile bake is the *same*
  object (same `heightMap` centre + `minHeight`) used for the `.ter` datum, and that
  replacing `td.heightMap` with the extracted ground does **not** leak into the
  mesh-asset bake's anchor. Options: bake the tiles once, up front, from the original DEM
  terrain; reuse that group for both extraction and placement; never re-bake from the
  extracted heightMap.
- Keep the datum fix from `30037b9` (original `minHeight`).

## Acceptance criteria

- Production (3D preview AND BeamNG) shows the same cm-level alignment / faint z-fighting
  the sandbox shows, for the same AOI — gap ≤ ~0.15 m (the intentional render bias), not
  metres.
- The anchor triple `{mapngGroundY, googleGroundAlt, minHeight}` is identical across the
  preview bake, the extraction bake, the mesh-asset bake, and the `.ter` datum.

## Key files & references

- Tile vertical anchor: `packages/bake/src/tiles/tileMeshTransform.js:26-92`
  (`createTileMeshTransformer`, `beamZMeters`).
- Anchor probe + bake log: `packages/bake/src/tiles/bakeGoogle3DTiles.js`
  (`probeGroundAltitude`, `vertical anchor` log line ~288).
- Scene scale: `packages/bake/src/scene/sceneFrame.js` (`computeUnitsPerMeter`, `SCENE_SIZE`).
- Extraction: `packages/bake/src/ground/heightField.js` (`buildTileHeightField`,
  local-frame extraction), `packages/bake/src/ground/extractTileGround.js`
  (`extractTileGround`, `buildGroundMesh`, `toMeters`, `getGroundStrategy`).
- Export injection: `packages/export/src/beamng/levelArtifacts.js` (~line 135 extraction,
  line ~270 `exportTer`, line ~309 `exportGoogleTilesForLevel`).
- Tile placement / zOffset: `packages/export/src/beamng/googleTilesAssets.js`,
  `components/three/GoogleTiles3D.vue:60` (`offsetY`), `bakeFlags.js`
  (`getGoogleTilesZOffset`, `TILE_RENDER_BIAS_M`).
- Preview swap: `components/three/Preview3D.vue` (`mergedTerrainData`,
  `recomputePreviewGround`).
- Sandbox reference: `components/terrain-sandbox/terrainSandbox.js` (`bakeTerrainScene`),
  `TerrainSandboxApp.vue` (renders ground meshes directly in scene units, no zOffset).
- Prior context: `docs/google-tiles-mesh-assembly-problem-statement.md`; memory
  `terrain-sandbox-ground-extraction` (datum gotcha, local-frame extraction, strategy).

## Branch / status

- Work to date is on `feat/terrain-elevation-sandbox` (PR #3), through commit `30037b9`.
- Route export (per-chunk + shared anchor) is **not yet wired** — only single-tile.
- This alignment gap is the blocker to validate before trusting the export.

---

## FINDINGS — static code trace (thread 2, 2026-06-26)

Traced the vertical frame end-to-end without the running app. Result: the plan's
ranked suspects are partly **refuted**, and the real export bug is now pinned to a
specific path.

### Refuted

- **Suspect 2 "re-anchor on cache miss" (in-browser):** the bake cache key
  (`packages/bake/src/tiles/bakeCache.js:44`) is derived **only** from
  `bounds + width×height + resolved options` — it never hashes `heightMap`
  *content*. Both production bakes pass just `{apiKey, errorTarget}` and let
  `stripGround`/quality resolve centrally (extraction: `levelArtifacts.js:148`;
  placement: `googleTilesAssets.js:37`). Same bounds/options ⇒ **cache HIT** ⇒ the
  in-browser placement reuses the *same group* baked from the original DEM `td`.
  So the in-browser export path is internally consistent (tiles + `.ter` share one
  anchor). No drift there.
- **Suspect 3 datum / foundations:** `applyBuildingFoundations`
  (`packages/export/src/buildingFoundations.js`) never references `minHeight`
  (grep-clean) — it carves the heightMap but **preserves the datum**. The crop
  recomputes `minHeight` from the cropped cells (`cropTerrain.js:156-163`), but
  that single `minHeight` is then used *consistently* by the export's bake,
  extraction, and `.ter` encode. Not the gap.

### The export bug (confirmed by code) — the SIDECAR re-anchors

The vertical anchor is set in `createTileMeshTransformer` (`tileMeshTransform.js:41,47,87`):
```
mapngGroundY = sampleHeightAtScene(data, 0, 0)   // ← the heightMap's CENTRE value
groundOffset = mapngGroundY - googleGroundAlt
beamZMeters  = (groundOffset - minH) + cart.height
```
So the anchor depends on **`data.heightMap`'s centre sample**. Both bakers derive it
identically (`bakeGoogle3DTiles.js:284`, `googleBakeWorker.mjs:832`).

Production export ordering (`levelArtifacts.js`):
1. `148` — extraction bake `getOrBakeGoogle3DTiles(td)` with `td.heightMap` =
   **DEM** (the swap hasn't happened yet) ⇒ anchored at `mapngGroundY = DEM(centre)`.
2. `152` — `extractTileGround(group, td)` rasterises *those* DEM-anchored tiles into
   the `.ter` ground (datum `td.minHeight`).
3. `157` — `td.heightMap` is replaced with the **extracted ground**.
4. `299` — `.ter` encoded from `exportTerrainData` (extracted ground, datum unchanged).
5. `339` → `exportGoogleTilesForLevel(exportTerrainData)`:
   - **In-browser fallback** `getOrBakeGoogle3DTiles(exportTerrainData)` — cache HIT,
     reuses the DEM-anchored group ⇒ **aligned**.
   - **Sidecar path** `exportGoogleTilesViaSidecar(exportTerrainData)`
     (`googleTilesAssets.js:319`) — bypasses the cache entirely, **re-bakes on the
     server from `exportTerrainData.heightMap` = the extracted ground**
     (`googleBakeSidecar.js:88-89` ships that heightMap; worker recomputes
     `mapngGroundY` from it). ⇒ placement anchored at `mapngGroundY = extracted(centre)`,
     not `DEM(centre)`.

**Gap = `extracted(centre) − DEM(centre)`** — a single scalar shift of the whole
Google mesh, magnitude = how far the bare-earth extraction disagrees with the coarse
DEM at the AOI centre cell (memory `terrain-sandbox-ground-extraction`: street ≈ DEM
±3 m). Constant *within* one export, **varies between AOIs** ⇒ matches "up to several
metres, not constant." Only the **sidecar** path is affected — which is the default
for real/large exports, and is why the sandbox (no sidecar, single in-frame bake)
never sees it.

### Confirm with EXISTING logs (no new instrumentation needed)

Run one sidecar export and diff the two anchor log lines already emitted:
- extraction bake → `[google3dTiles] vertical anchor: … mapngGroundY=X` (`bakeGoogle3DTiles.js:289`)
- sidecar placement → `[bakeWorker] vertical anchor: … mapngGroundY=Y` (`googleBakeWorker.mjs:837`)

`X ≠ Y` ⇒ bug confirmed; the gap ≈ `Y − X`.

### Fix shape (plumbing already exists)

The route mode already supports a route-wide anchor override: `sharedGroundOffsetM`
→ `createTileMeshTransformer({ groundOffsetM })`, and the sidecar **already forwards
it** (`googleBakeSidecar.js` `buildJobBody` destructures+ships `sharedGroundOffsetM`;
worker applies it at `googleBakeWorker.mjs:834`). The single-AOI export just never
passes it. So:
1. Capture `group.userData.groundOffsetM` from the extraction bake (`levelArtifacts.js:148`).
2. Thread it into `exportGoogleTilesForLevel` → `exportGoogleTilesViaSidecar` (and
   `generateGoogleTilesGLB`, belt-and-suspenders) as `sharedGroundOffsetM`.

`minHeight` already matches (`exportTerrainData.minHeight == td.minHeight`), so forcing
`groundOffsetM` is sufficient to co-locate the placed tiles with the `.ter` ground.
(Forcing the anchor adds `|gz=` to the sidecar cache key — correct; it's a distinct
anchored bake.) Equivalent alternative: bake placement tiles from the **original DEM
terrain** instead of `exportTerrainData`.

### Still runtime-only (separate, additive components)

- **z-offset slider** `getGoogleTilesZOffset()` (`mapng_google_bake_zoffset`) lifts
  tiles but never the ground on *every* path (preview `GoogleTiles3D.vue:60`, export
  GLB `googleTilesAssets.js:63`, sidecar `:325`). If non-zero ⇒ added constant gap.
  With tile-derived ground it should be **0**. Check first — fastest win.
- **Preview-only fallback:** if `recomputePreviewGround` yields null (tile-ground
  preview off / extraction throws), `mergedTerrainData` falls back to the **raw DEM**
  mesh (`Preview3D.vue:926,956`) while tiles show photogrammetry ⇒ metre-scale,
  spatially-varying gap that is *not* the export bug.
