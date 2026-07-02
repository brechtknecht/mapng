# Plan: Route generation — bring the tile-extracted drive surface to routes

## TL;DR

Single-tile export now drives on the **tile-extracted bare-earth ground** (rasterise
baked Google tiles → bare-earth filter → `.ter`), aligned to the photogrammetry to
~cm. Route export is **already built end-to-end** (`exportRouteAsBeamNGLevel`) with a
route-wide shared anchor, corridor bakes, and a composited terrain — **but it still
drives on the coarse composited DEM**, not the tile ground. The headline work is to
composite the per-chunk **tile-extracted** ground into the route's one `.ter`,
watertight across seams, on the shared anchor. Everything else (verify alignment,
preview parity, seam/corridor QA, perf, tests) hangs off that.

> Supersedes the stale "Route export … not yet wired — only single-tile" line in
> `docs/ter-tile-alignment-gap-plan.md`. It IS wired; it just drives on the DEM.

---

## Status (2026-06-26)

End-to-end pipeline IMPLEMENTED (Phases 0–3); needs an in-BeamNG bake to verify.

- ✅ **Phase 0** (code-side): `tests/routeConform.test.mjs` green (4/4) — shared anchor
  absorbs geoid drift; per-chunk DEM disagreement is the seam the tile ground fixes.
  *In-BeamNG seam check still pending (needs a live bake).*
- ✅ **Phase 1** — worker ground extraction. `extractTileGroundFromSoup` (new, in
  `extractTileGround.js`) builds an identity group from the worker's transformed record
  buffers and extracts; `extractTileGround` now also returns a per-cell `coveredMask`.
  Worker (`googleBakeWorker.mjs`) extracts after weld+conform / before ground-strip,
  caches on the session, ships base64 ground in the `exported` message; sidecar
  (`googleBakeSidecar.js` `buildJobBody` + `bakeSession.js` `exportGoogleTilesViaSidecar`)
  forwards `extractGround`/`groundStrategy` and decodes the ground. Tested:
  `tests/extractTileGround.test.mjs` (4/4).
- ✅ **Phase 2** — `compositeRouteGround` in `routeTerrainComposite.js`: coverage-
  weighted overlap blend + grassfire corridor-edge feather. Tested:
  `tests/routeGround.test.mjs` (6/6).
- ✅ **Phase 3** — `exportRouteLevel.js` resolves the strategy once
  (`getGroundStrategy`/`getPreferredTerGround`), requests extraction per chunk,
  composites the grounds, and swaps the `.ter` heightMap (keeping `combined.minHeight`
  datum). `_routeAsm` caches the composited ground; `asmKey` fingerprints the strategy.
- ✅ **Phase 4** — route preview drives on the LIVE tile-ground. `RoutePreview.vue`
  re-extracts each chunk's bare-earth ground from its resident `GoogleTiles3D` wrapper
  (`buildGroundMesh`; `groupInv` strips the wrapper's upm scale — same engine as the
  single-tile preview), hides the DEM `center_terrain` mesh, and shows the extracted
  ground instead — so the preview floor tracks the tiles (geoid drift gone) and matches
  the export. New `GroundStrategyControls.vue` (bound to `googleTilesStore.ground`) gives
  source/filter/post controls IN the route preview; changes re-extract live (debounced).
  Live extraction uses a flat-DEM stub (bounds+datum only); the EXPORT still uses the
  real per-chunk DEM. Build + 101/102 tests green; **GPU/visual still needs your eyes.**
- ⏳ **Phase 5** (seam/corridor QA in BeamNG), **Phase 6** (perf — base64 ground over
  stdout/SSE; live re-extraction keeps all chunks resident) — NOT started.

### Drift root cause (diagnosed 2026-06-27)

Progressive vertical `.ter`↔tiles drift = **geoid undulation**. Google tiles carry
ELLIPSOIDAL heights; the DEM is ORTHOMETRIC. One shared anchor (chunk 0) nulls the
undulation `N` only at the start, so each chunk's tile-vs-DEM gap ≈ `(N_i − N_0) +
zOffset + bias`, growing with distance. The tile-ground `.ter` (Phase 3) + tile-ground
preview (Phase 4) fix it by deriving the drive surface FROM the tiles (same ellipsoidal
frame), so ground tracks tiles regardless of `N`. Off-corridor DEM filler still carries
the drift (cosmetic; feathered).

**Tuning knobs at defaults:** corridor-edge `featherM = 15` (exportRouteLevel); overlap
= coverage-feather (compositeRouteGround). Both want in-BeamNG tuning.

**Known caveat:** a strategy change is picked up only on a fresh route run — the worker
session caches `extractedGround`, and a live session reused for the same key keeps the
old ground even though `asmKey` busts `_routeAsm`. Hard-refresh to be safe (memory
`hmr-stale-deep-modules`).

---

## What already exists (do NOT rebuild)

`packages/route/` is a full pipeline on top of `@mapng/bake`:

- **Corridor / chunking** — `routeCorridor.js` (tiers, `resolveChunkSizeM`), chunks
  carry `{center, bounds, segment}`.
- **Combined terrain** — `routeTerrainComposite.js`:
  - `buildCombinedRouteTerrain(terrains, {targetMetersPerPixel:1})` — squares the route
    bbox, blits each chunk's DEM into its pixel rect, off-corridor = flat `fillFloor`
    (lowest chunk datum), pow2 grid capped at `maxSize=4096` (`routeTerrainComposite.js:65`).
  - `sampleCombinedHeightMap(combined, chunk)` — resamples the combined surface onto a
    chunk's grid; the heightMap each chunk BAKES against so tiles seat on the driven
    surface, not the chunk's own DEM (`:44`).
- **Orchestrator** — `exportRouteLevel.js` `exportRouteAsBeamNGLevel(chunks, opts)`:
  1. Fetch per-chunk terrain (pooled, `terrainConcurrency` 2–4).
  2. `buildCombinedRouteTerrain` + `compositeRouteTexture` (one aerial floor).
  3. **Per chunk**: sidecar-bake tiles against `sampleCombinedHeightMap` slice with the
     route-wide **`sharedGroundOffsetM`** (captured from chunk 0, `exportRouteLevel.js:279,314`),
     corridor mask (`corridorSegment`/`corridorHalfWidthM`), GLB→DAE, compute placement
     `{east, north, baseUp}` where `baseUp = chunkMinHeight − combinedMinHeight`
     (`:328`), encode a z-offset-free preview GLB with the same shared anchor (`:346`).
  4. `exportBeamNGLevel(combined, …, googleTilePlacements: placedPieces)` — route mode:
     N `google_tiles_NN` TSStatics placed at `[east, north, baseUp + zOffset + bias]`
     (`:425-444`). `applyFoundations:false`, `roadType:'none'`, no OSM/water/trees.
  - **In-session cache** `_routeAsm` keyed by everything except z-offset (`:133-146`),
    so re-export with a tweaked z-offset only re-places + re-zips.
- **Progress / preview / stitch** — `routeProgress.js` (per-chunk map overlay),
  `routeStitch.js` (`computeRouteFrame` → placements + `worldBoundsM`),
  `RoutePreview.vue`, `App.vue` wiring.
- **Tests / lab** — `tests/routeConform.test.mjs`; `tools/testlab/routeScene.mjs`,
  `diagnoseRoute.mjs`, `captureRoute.mjs` (synthetic geoid-drift / seam-disagreement
  failure modes — pure Node, no GPU).

### Structural win to preserve

Route bakes **always pass `sharedGroundOffsetM`**, so the vertical anchor is decoupled
from `data.heightMap`. That makes routes **immune to the single-tile sidecar re-anchor
bug** (where the placement bake re-derived `mapngGroundY` from a swapped heightMap — see
`docs/ter-tile-alignment-gap-plan.md` FINDINGS). **Invariant to keep:** never feed an
extracted ground back in as a bake heightMap; always drive the anchor with the shared
offset.

---

## The core gap

The route `.ter` is the composited **DEM** (`buildCombinedRouteTerrain` → `combined.heightMap`).
Single-tile's tile-ground extraction (`extractTileGround`) is **skipped** for routes:
`levelArtifacts.js:144` gates it on `!routeTilePieces`, and route mode passes
`googleTilePlacements`. So the car drives on the coarse DEM while the photogrammetry
tiles sit on top via the shared anchor — exactly the misalignment we fixed for
single-tile, but for the whole corridor.

**Goal:** the route `.ter` = the **tile-extracted bare-earth ground**, composited from
all chunks on the shared anchor, watertight at seams, DEM only as off-corridor filler.

---

## Datum math (must hold — this is the whole game)

With the shared anchor, a tile vertex's height is
```
beamZMeters = (sharedGroundOffset − minH) + cart.height          (tileMeshTransform.js:87)
```
`extractTileGround` converts the rasterised tile bottom back to absolute metres via
`toMeters(sceneH) = sceneH/upm + minHeight` (`extractTileGround.js:121`). The `minH`/
`minHeight` terms cancel, so:
```
extractedAbs(cell) = sharedGroundOffset + cart.height_bottom(cell)
```
**Independent of each chunk's `minHeight`** — because every chunk shares one
`sharedGroundOffset`, the per-chunk extracted grounds are in **one continuous absolute
frame** and can be composited by absolute height directly (same `sampleHeightAt` blit as
the DEM composite). Seams line up by construction *iff* every chunk extracted from tiles
baked with the same `sharedGroundOffsetM`. Keep the combined datum (`combined.minHeight`)
unchanged when swapping in the ground — same lesson as single-tile (commit `30037b9`,
`Preview3D.vue:953`): swap heightMap, keep the datum the tiles/placements are anchored to.

---

## Phased plan

### Phase 0 — Verify the EXISTING route alignment (baseline, before adding ground)
The orchestrator's own header flags it: "Alignment note (NEEDS in-BeamNG verification)"
(`exportRouteLevel.js:17`). Confirm the shared anchor seats chunks 1..N on chunk 0's
datum with **no seam float**, on the current DEM `.ter`, in BeamNG.
- Diff the per-chunk `[bakeWorker] vertical anchor: … mapngGroundY=…` logs — chunks 1..N
  must show the **same effective `groundOffsetM`** (the shared one), chunk 0 the natural.
- Run `tools/testlab/diagnoseRoute.mjs` / `routeScene.mjs` to assert seam continuity
  under synthetic per-chunk DEM bias + geoid drift.
- Acceptance: tiles co-continuous across seams; gap to the DEM `.ter` is uniform
  (`zOffset + TILE_RENDER_BIAS_M`). Lock this in before layering ground on top.

### Phase 1 — Per-chunk ground extraction in the worker (the main new plumbing)
The sidecar keeps tiles server-side, so extraction must run **in the bake worker**
(`scripts/googleBakeWorker.mjs`), which already holds the transformed meshes and exposes
`groundOffsetM`. Add: after assembly, run `extractTileGround` (or its `buildTileHeightField`
core) on the session meshes at the chunk's `.ter` resolution, and return the ground.
- Extend the sidecar result (`exportGoogleTilesViaSidecar`, `googleBakeSidecar.js`) to
  carry a ground payload: `{ ground: base64 Float32, gw, gh, coverage: base64 Uint8 }`
  alongside `groundOffsetM` (mirror how `groundOffsetM` already round-trips).
- Strategy source: reuse `getGroundStrategy()` semantics so route == single-tile == what
  the Scene-settings menu persists (`mapng_ter_ground_strategy`). Pass the resolved
  strategy into the worker job (the per-bake override channel the uncommitted
  `weld/conform/roadmask` plumbing already adds is the template).
- Extract from the **anchored** group (all chunks share `sharedGroundOffsetM`) so the
  output is in the one absolute frame from the datum-math section.
- Keep the existing `groundOffsetM` return; chunk 0 still seeds the shared anchor.

### Phase 2 — Composite per-chunk grounds → one route ground heightMap
New pure function in `routeTerrainComposite.js` (Node-testable, no GPU):
`compositeRouteGround(chunkGrounds, combined, { featherM }) → Float32Array`.
- Blit each chunk's extracted ground into the combined grid by bbox→pixel rect (reuse the
  `buildCombinedRouteTerrain` blit + `sampleHeightAt`).
- **Overlaps** (chunks overlap ~15%): blend in the overlap band — feather by coverage so
  neither chunk's edge artifacts win a hard seam (min is the safe default; feather is
  nicer). Driven by the per-chunk `coverage` mask from Phase 1.
- **Off-corridor / uncovered cells**: fall back to `combined.heightMap` (the DEM), and
  **feather the corridor edge** (blend ground→DEM over `featherM`) so there's no step
  where the tile ribbon ends.
- Output is absolute metres on `combined.minHeight` (datum unchanged).

### Phase 3 — Wire the route `.ter` to the composited ground
In `exportRouteAsBeamNGLevel`, after assembly, build `combinedGround` and pass a terrain
whose `heightMap` is the composited ground but whose **`minHeight`/`bounds`/`width` are
unchanged** into `exportBeamNGLevel`:
```js
const combinedDrive = { ...asm.combined, heightMap: combinedGround,
                        maxHeight: Math.max(asm.combined.maxHeight, groundMax) };
```
- Cache `combinedGround` inside `_routeAsm` (it's part of the expensive assembly).
- Keep `applyFoundations:false` / `roadType:'none'` (no buildings on routes).
- Placements (`baseUp`) and the shared anchor are unchanged — the datum is preserved.

### Phase 4 — Preview parity (WYSIWYG)
Make the route preview's **drive surface** show the extracted ground, like single-tile
`Preview3D` swaps `mergedTerrainData`. Today `RoutePreview` shows tiles (shared anchor)
over… confirm what mesh it renders for the floor. If it renders the DEM combined, swap in
`combinedGround` so the preview predicts BeamNG. (As with single-tile: the live preview
may extract coarser — call out the fidelity gap rather than chase pixel parity.)

### Phase 5 — Seam & corridor QA
- Watertightness across chunk overlaps (no cracks/spikes in the blend band).
- Corridor-edge feather smooth (no cliff where ground meets DEM filler).
- In BeamNG: residual tile↔ground gap is uniform `zOffset + bias`, no per-chunk steps.
- Extend `tests/routeConform.test.mjs` (or a new `tests/routeGround.test.mjs`) with a
  pure-Node composite test: synthetic per-chunk grounds + overlap → assert seam
  continuity and corridor-edge feather (the lab already fakes geoid/DEM drift).

### Phase 6 — Performance / memory
- Ground payload ≈ `gw·gh·4` bytes/chunk (e.g. 1024² → 4 MB). Composite then release with
  the existing per-chunk terrain release (`exportRouteLevel.js:371`).
- Extraction folds into the existing assemble pool (`concurrency`); it runs in the worker
  the bake already spun up — no extra process.
- Long routes: combined caps at `maxSize=4096`; raise alongside the DEM path if a long
  route degrades (the `targetMetersPerPixel:1` comment at `:248` flags the same ceiling).

---

## Open decisions (resolve before/while coding)

1. **Overlap blend**: min (safe, may pick stitch lows) vs coverage-feather (smoother, more
   code). Lean feather, fall back to min.
2. **Corridor-edge feather width** (`featherM`): how far ground blends into DEM. Start ~tier
   `halfWidthM` fraction; tune in BeamNG.
3. **Extraction resolution per chunk**: match the chunk `.ter` res (1:1, like single-tile
   export) vs a capped grid for very long routes. Default 1:1.
4. **Where the strategy is read**: worker job param (preferred — one source via
   `getGroundStrategy`) vs hardcode the sandbox default. Use the job param.
5. **Off-corridor**: keep DEM filler (current) vs lower it further. Keep DEM; feather only.

## Acceptance criteria

- Route BeamNG level drives on the **tile-extracted** ground across the whole corridor,
  with single-tile-level alignment (faint uniform z-fight, ≤ ~0.15 m), no per-chunk seam
  steps, no corridor-edge cliff.
- Per-chunk effective anchors identical (shared); extracted grounds composite in one
  absolute frame; `combined.minHeight` datum preserved end-to-end.
- Re-export with tweaked z-offset still hits the `_routeAsm` cache (ground composite cached).
- Pure-Node ground-composite test passes (seams + feather), alongside `routeConform`.

## Key files

- Orchestrator: `packages/route/src/exportRouteLevel.js` (assembly, shared anchor `:279`,
  per-chunk bake `:297`, placement `:326`, level build `:429`).
- Composite: `packages/route/src/routeTerrainComposite.js` (`buildCombinedRouteTerrain`,
  `sampleCombinedHeightMap`, `sampleHeightAt`) — home for `compositeRouteGround`.
- Worker (add extraction + return ground): `scripts/googleBakeWorker.mjs`,
  `packages/bake/src/googleBakeSidecar.js`.
- Extraction core: `packages/bake/src/ground/extractTileGround.js`,
  `packages/bake/src/ground/heightField.js`.
- Anchor: `packages/bake/src/tiles/tileMeshTransform.js:87` (`beamZMeters`, `groundOffsetM`).
- Level build / route gate: `packages/export/src/beamng/levelArtifacts.js:144` (extraction
  gated `!routeTilePieces`), `:336` (route placements).
- Preview: `components/three/RoutePreview.vue`, `packages/route/src/routeStitch.js`.
- Tests/lab: `tests/routeConform.test.mjs`, `tools/testlab/{routeScene,diagnoseRoute,captureRoute}.mjs`.
- Prior context: `docs/ter-tile-alignment-gap-plan.md` (single-tile datum + sidecar anchor),
  memory `terrain-sandbox-ground-extraction`.
