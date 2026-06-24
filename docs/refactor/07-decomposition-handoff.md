# 07 — God-file Decomposition: Handoff & Last Steps

Pick-up doc for continuing the internal decomposition (plan
[06-internal-decomposition.md](06-internal-decomposition.md)) in a fresh thread.
Self-contained: read this + 06 and you have everything.

## Where things stand

- **Branch:** `refactor/internal-decomposition` (off `feat/tile-ground-conform`).
  Local only — **not pushed**. Working tree clean, everything green.
- **Resume check:** `npm run check` (= `boundaries` + `lint:size` + `test:all`,
  89 tests) must pass; `npm run build` and `node --check scripts/googleBakeWorker.mjs`
  too.
- **Done in earlier threads:** tooling/ratchet (step 0); `scene/` extracted
  (step 1); `googleBakeCore.js` **1218→272** drained into `tiles/*` (step 2);
  `osm.js` **658→138** (step 5); `kron86.js` **582→366** (step 5);
  `terrainResampler.js` **535→341** (step 7, `resample/resampleKernels.js`).
  → **`@mapng/fetching` is fully <500.**
- **Done this thread (6 more files, 6 commits — all verbatim moves + barrels):**
  - `beamngFlavorCatalog.js` **1008→128** → `materials/{groundCoverMaterials,
    forestAssetSets(A/B+combiner),waterProfiles,beamngFlavors}.js` (step 10).
  - `osmTerrainMaterials.js` **961→381** → `materials/terrainReferenceMaterials.js`
    + `materials/osmLayerMap.js` (pure rasterizer) (step 10).
  - `google3dTiles.js` **862→30** (barrel) → `tiles/{bakeCache,bakeFlags,
    bakeGoogle3DTiles,bakeSession}.js` (step 3). `bakeGoogle3DTiles` moved to its
    own module to avoid a barrel↔session import cycle.
  - `resamplerWorker.js` **828→188** → `resample/heightSampling.js` (io) +
    `resample/heightFinalize.js` (core) (step 7). Kernels kept SEPARATE from
    `resample/resampleKernels.js` — they are tuned differently (see Learnings).
  - `surroundingTiles.js` **668→466** → `terrain/surroundingTileMath.js` (core)
    + `terrain/surroundingTilesZip.js` (io) (step 7).
  - `junctionGeometry.js` **629→24** (barrel) → `roads/{junctionConstants,
    geomPrimitives,junctionPolygons,polylineCleanup}.js` (step 10). Covered by
    `tests/junctionGeometry.test.mjs`.
- **Also done this thread — `osmTexture.js` 1886→146 (the first giant, step 6):**
  pure core: `osm/{osmColors,pathGeometry,laneInference,roadWidths,junctionCaps}`;
  canvas io: `osm/{roadDraw,featureRender}`. Entry keeps the three texture
  builders + re-exports `getFeatureCategory`. **The handoff's "1430-LOC
  getFeatureCategory rewrite" was WRONG** — `getFeatureCategory` is a one-liner;
  the real classifier is `getFeatureColor` (208 lines, pure, moved verbatim). No
  rewrite was needed.
- **NEW: headless render oracle (no browser).** `tools/testlab/canvasShim.mjs`
  backs `document.createElement('canvas')`/`Image`/`URL` with `@napi-rs/canvas`
  (a devDep). `tests/osmTextureHeadless.test.mjs` renders `generateOSMTexture` in
  Node and pins a **golden PNG hash**, verified byte-identical to the
  pre-split monolith. This is the pattern for de-risking the remaining
  canvas-coupled giants (export3d, exportBeamNGLevel): import the shim, render,
  hash. Earlier claims that these "need a browser" were wrong.
- **Offenders remaining: 5** (tracked in `tools/lint-size-allow.json`; one is
  vendored → permanent). **4 real targets — all giants (1561–5558 LOC):**
  `exportBeamNGLevel.js`, `export3d.js`, `terrain.js`, `batchJob.js`. The
  small/medium files and the first giant are all done.

## The recipe that works (follow it every time)

1. `git` is on the branch; start green (`npm run check`).
2. **Read the whole god-file once** (don't try partial reads for the cut).
3. Identify the seam: pure compute (`core`) vs effects (`io`: fetch / canvas /
   IndexedDB / zip / three renderer) vs orchestration (`flow`).
4. **Write** the new focused module(s) under a domain subfolder, each with a
   `/** @layer core|io|flow */` header (see §convention in 06). Copy bodies
   **verbatim** — this is a move, not a rewrite. No logic changes.
5. Turn the original file into a thin **re-export barrel**: `export { ... } from
   './new/path.js'` (and `import` + re-export for names it still uses
   internally). This keeps EVERY consumer — incl. `scripts/googleBakeWorker.mjs`
   and `@mapng/<pkg>/<file>` subpath importers — unchanged.
6. Delete the file's entry from `tools/lint-size-allow.json` once it's <500.
7. **Verify:** `npm run check` + `npm run build` + `node --check
   scripts/googleBakeWorker.mjs`. All green → commit. One file per commit.

## Hard-won learnings (read before you start)

- **Re-export barrel = zero-churn.** Never update import sites across the repo.
  Leave the old filename re-exporting; consumers and the node worker stay byte-for-
  byte the same. This is why each step stays green.
- **The node worker is the trap.** `scripts/googleBakeWorker.mjs` imports bake
  geometry. Anything it touches must stay **DOM/renderer-free** (`@layer core`).
  The layer rule (`core` may not import `io`/`flow`) guards this — always
  `node --check` the worker after a bake-geometry move.
- **Big excisions: rewrite the file, don't Edit a 200-line block.** The Edit tool
  needs an *exact* match; god-files have inconsistent indentation and
  trailing-whitespace blank lines that break a long `old_string`. For anything
  over ~40 lines, read the whole file and `Write` the new version. (Range-delete
  via `sed` is disallowed by the repo's file-writing policy.)
- **Tests are the real safety net for behavior.** `weldSeams`, `stripGroundTris`,
  `buildCorridorStations`, `scalarFieldGrid`, `tileGroundConform`, `groundMask`,
  `junctionGeometry`, the loaders — all have `node --test`. Functions WITHOUT a
  test (e.g. `createTileMeshTransformer`, the osm parser, resample kernels) rely
  on the move being verbatim + build + worker-check. If you change anything in
  those, add a test first.
- **The ratchet keeps you honest.** `tools/check-filesize.mjs` errors on any
  un-allowlisted >500 file AND on stale allowlist entries (file dropped <500 but
  still listed). So: split → file drops <500 → remove its allowlist line → lint
  forces you to. Never *add* entries; new code is born small.
- **`computeUnitsPerMeter`/`sampleHeightAtScene`/`SCENE_SIZE`** now live in
  `bake/src/scene/`; import from there in new modules, not from googleBakeCore.
- **`@layer` is per file, not per export.** A file that does any IO is `io` even
  if it also exports a pure helper; that's fine (consumers ignore the tag). When
  a pure helper is imported by a `core` module, it MUST live in a `core` file —
  that's the only hard constraint.
- **Watch for near-duplicate kernels — don't "helpfully" merge them.** The
  resampler worker and `terrainResampler` each carried their OWN copies of
  `pushPullInpaint`/`expandFill`/`relaxFilled`. They look identical but are
  **tuned differently** (the worker's `relaxFilled` defaults to 200 iters and
  precomputes a filled-index list; `pushPullInpaint` uses a `!== noData` check
  without the finite guard the `resampleKernels.js` copy has). With no tests on
  either, the safe move is to relocate each copy verbatim into its own module
  (`resample/heightFinalize.js` vs `resample/resampleKernels.js`), NOT dedupe.
  A real dedup is a separate, test-first task (capture an oracle first).
- **The size-lint allowlist is real JSON — mind the trailing comma.** When you
  delete the LAST entry, remove the comma on the now-last line or
  `check-filesize.mjs` dies parsing it (it `JSON.parse`s the file before linting).
- **Barrel vs. accessor-file are both fine.** Most files here became a pure
  re-export barrel (`google3dTiles`, `junctionGeometry`). A couple kept logic and
  imported data modules (`beamngFlavorCatalog`, `osmTerrainMaterials`,
  `surroundingTiles`) — also fine, as long as the original file keeps re-exporting
  every name consumers use. The cycle trap: if the barrel re-exports from a module
  that imports back from the barrel, move the shared entry into its own module
  (as done for `tiles/bakeGoogle3DTiles.js`).

## Remaining steps (recommended order)

Risk-ascending. Each is one commit, kept green. **Steps 1–4 below are DONE** (see
"Done this thread"); the remaining work is the five giants, all in this list:

1. ~~**Data tables → `materials/` (step 10).**~~ DONE.
2. ~~**`google3dTiles.js` → `tiles/` orchestration (step 3).**~~ DONE.
3. ~~**`resamplerWorker.js` + `surroundingTiles.js` (step 7).**~~ DONE.
4. ~~**`junctionGeometry.js` (step 10).**~~ DONE → `roads/*`.
5. **`terrain.js` (1986) → `terrain/* ` (step 7).** Split: `mercatorTiles.js`
   (slippy/mercator math, core), `heightmapResample.js` (resample/decode/unit
   conversion, core), `terrainData.js` (fetchTerrainData orchestration, flow).
   **Move the raw elevation HTTP fetchers (GPXZ/USGS/Terrarium GET) to
   `@mapng/fetching/elevation/`** — they belong below bake (tightens
   `geo<fetching<bake`). Bigger; do after warming up on the above.
6. **`export3d.js` (2163) → `scene3d/*` (step 8).** `osmMeshes.js`,
   `tilePlacement3d.js`, `colladaExport.js` (wraps vendored ColladaExporter),
   `glbExport.js`; slim `export3d.js` to the orchestrator.
7. **`osmTexture.js` (1886) → `osm/*` (step 6).** Extract `osmColors.js`,
   `roads/{laneInference,pathGeometry,junctionRender,crosswalkRender}.js`,
   `osmRaster.js` first. The hard part is the **1430-LOC `getFeatureCategory`** —
   that needs an internal *rewrite* into `classify/{water,building,landcover,
   area,point}.js`, NOT just a move. **Snapshot-test its output on a fixed OSM
   fixture before splitting** so the pieces are provably equivalent.
8. **`exportBeamNGLevel.js` (5558) → `beamng/*` (step 9, last/most care).**
   Sub-extract in order, each green: `terWriter` → `levelMaterials` →
   `forestItems` → `osmObjectBoxes` → `decalRoads`/`meshRoads` → `levelManifest`
   → `levelZip` → `googleTilePlacement`, leaving `beamngLevel.js` orchestrator-
   only. Expect closure-shared state — thread an explicit context object instead
   of relying on scope. This is the one most worth a real bake (`npm run
   testlab:capture` as an oracle) since it's terminal and untested.
9. **Then Phase-8 remainder:** lift the single-tile orchestration (`handleGenerate`)
   out of `App.vue` into `@mapng/pipelines` (see 05 deferred #1). Needs a runtime
   bake to confirm — do it in a session with browser/bake verification.

## Caveats for the giants (7 & 8)

`exportBeamNGLevel.js` and `osmTexture.js`/`getFeatureCategory` have **no direct
unit tests** and produce the final artifacts. A pure verbatim move is safe; any
behavior change needs the bake oracle. `tools/testlab/captureRealBake.mjs` +
`diagnoseRoute.mjs` can capture a real bake to hash against before/after. Don't
guess on these — capture an oracle first, or stop and report.

## Definition of done (unchanged, from 06 §4)

No `packages/*/src` file >500 LOC except the vendored `ColladaExporter.js`; every
module `@layer`-tagged; `core` imports no `io`/`flow`; `npm run check` + build +
worker green; both bake paths and single-tile/route/batch exports smoke-verified.
