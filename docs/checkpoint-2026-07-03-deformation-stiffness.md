# Checkpoint — deformation stiffness (buildings keep their shape)

Date: 2026-07-03. Branch: `feat/road-elevation-profiles`.
Concept doc: [plan-deformation-stiffness.md](./plan-deformation-stiffness.md).

## Problem

The tile→ground conform bent every building — "no roof is straight." An
earlier per-footprint delta-freeze attempt (stash `building-footprint-protection
WIP`, `buildingMask.js`) changed nothing and was abandoned. Felix asked for the
right ABSTRACTION, not a "building fix".

## Root cause (measured, not guessed)

The conform subtracts a smooth delta field `D(x,z)` from every vertex. `D` is
per-cell medians on a 6 m grid with **zero smoothing** (deliberate — blur hurts
road accuracy). Measured cell-to-cell wobble **p95 ≈ 2 m/cell** (via the new
bend heatmap). Terrain absorbs it; a rigid building spanning k cells gets bent
by ~k× that. Building interiors are inpaint-guessed (no ground samples).

Two no-op-path traps found and fixed along the way:
1. The abandoned stash: sidecar payload filter **stripped building features**
   before the worker → any footprint logic silently saw nothing.
2. This session's first wiring: put stiffness in `applyConform`, which is
   **default-OFF (v15)** and NOT the pass route bakes run. The pass that
   actually runs is the worker's `applyTerGroundSnap` (terSnap + deckSnap).

## The abstraction

Two orthogonal fields, semantic-only by Felix's decision (street trees look
identical to buildings in mesh evidence — geometry must NOT rigidify):

- **Target** — where the surface should end up (existing delta field).
- **Stiffness** `s(x,z)∈[0,1]` — how much space may deform. NEW. A building is
  just a region of high stiffness; the conform never learns what a "building" is.

Field build becomes a weighted Gauss–Seidel solve:
```
minimize  Σ (1−s)·(D−median)²  +  Σ_edges κ·min(s_i,s_j)·(D_i−D_j)²   (κ=50)
```
`min()` ⇒ every s=0 cell is byte-identical to the old build (roads keep their
sharpness). s→1 ⇒ D forced locally constant → building translates rigidly.
Transition lives in the feather rim. Road snap attenuated by (1−s) per vertex.

## Field-validated result

Chunk 0: `structures 118 (snap vetoed 32217)`, bend p95 2.02→1.15 m/cell.
OSM ground truth for that bbox = **exactly 118 building ways** → 100% capture.
Chunk 1: `structures 0` — OSM has 0 buildings there (motorway junction), correct
non-result, not a bug. Band residual 0.48→0.70 m = shape preservation trading a
little floor-hugging, as designed. Road flatness unaffected (mean 0.12 m dev).

## Files

New:
- `packages/bake/src/deform/structureStiffness.js` — semantic provider
  (`collectStructureRings` + `rasterizeStructureStiffness`; 3 m buffer + 6 m
  feather for OSM↔photogrammetry misregistration).
- `tests/structureStiffness.test.mjs` — provider unit tests (git-add `-f`).
- `docs/plan-deformation-stiffness.md` — concept + migration plan.

Modified:
- `scalarFieldGrid.js` — `build({stiffness})` weighted solve (`relaxWithStiffness`).
- `tileGroundConform.js` — `structures` opt, snap veto, `fieldGrad`/`measureOnly`
  bend diagnostics.
- `scripts/googleBakeWorker.mjs` — stiffness into BOTH terSnap conforms (the
  path that runs); bend stats in the log.
- `bakeGoogle3DTiles.js` — stiffness into `applyConform` (browser path).
- `googleBakeSidecar.js` — payload filter now ships building/man_made footprints.
- `bakeCache.js` — `BAKE_FORMAT_VERSION` 15→16, `tsnap8`→`tsnap9`, `|ns` key.
- `bakeFlags.js` — `conformStiffnessEnabled` (default ON, `mapng_conform_stiffness='0'`).
- `RoutePreview.vue` + `GroundStrategyControls.vue` + `googleTilesStore.js` —
  "show conform bend heatmap (debug)" overlay (`conformFieldShow`).

Flags: `mapng_conform_stiffness` (browser) / `MAPNG_CONFORM_STIFFNESS` (worker),
default ON, `'0'` disables for A/B.

Verification: 116/116 tests, boundaries, filesize, `vite build` all green.

## Open / next

1. **Preview-carve** (step 3 remainder) — live preview floor carve still
   stiffness-blind (low urgency, doesn't touch tile mesh).
2. **Geometric-evidence provider** — deferred; needs a tree/facade discriminator
   before it can protect UNMAPPED structures. Only build when unmapped buildings
   actually show up bent.
3. **BeamNG drive-verify** chunk-0 area, then update the BeamNG-verified note.
