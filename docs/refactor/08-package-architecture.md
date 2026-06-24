# 08 — Target Package Architecture (decided)

Follows the internal decomposition (06/07). Once the giant files are split into
`<500` `@layer`-tagged modules, the clean module folders get **lifted into new
packages**. Decided with the maintainer; sequencing is **decompose-first, then
lift** (moving a 5558-LOC monolith across a package boundary is strictly worse
than relocating a folder of small modules).

## Current packages & layering

```
geo < fetching < bake < { route, batch } < pipelines
```
`bake` is the kitchen sink today: terrain fetch/resample, osm texture, the
export formats, the Google-tiles bake, etc.

## Target packages & layering

```
geo < fetching < terrain < bake < export < { route, batch } < pipelines
```

### 1. `@mapng/terrain`  (new layer: fetching < terrain < bake)
- **Why it's clean:** `terrain.js` imports ONLY `@mapng/fetching` + `@mapng/geo`
  (verified) — zero upward/bake deps. bake/route/batch all sit above it and
  consume it. So it lifts with no cycle.
- **Contents:** `terrain.js` + its decomposition (`terrain/mercatorTiles`,
  `terrain/heightmapResample`, `terrain/terrainData`, the surrounding-tiles
  modules already under `terrain/`), `terrainResampler.js`, `resamplerWorker.js`
  + `resample/*`, `surroundingTiles.js`. Possibly the raw elevation HTTP fetchers
  move down into `@mapng/fetching/elevation/` (06 step 7 note) — decide during
  the lift.
- **Consumers to repoint:** `@mapng/bake/terrain` → `@mapng/terrain` in route
  (`exportRouteLevel`, `routeBake`), batch (`batchJob`, `traceability`), bake
  internals, and the Vue app.

### 2. `@mapng/export`  (new layer: bake < export < {route, batch})
- **Why it's a real boundary:** the export *formats* (GLB/DAE via `export3d`,
  BeamNG `.zip` via `exportBeamNGLevel`, `.ter` via `exportTer`, GeoTIFF via
  `exportGeoTiff`) consume bake internals (`google3dTiles`, `junctionMesh`,
  `osmTexture`, `ColladaExporter`); route/batch consume the exports. Distinct
  concern, sits above bake.
- **Cycle to break:** `bake/index.js` currently `export *`s `export3d` +
  `exportBeamNGLevel`. Those re-exports MUST be removed when the files leave
  (else bake→export→bake). Consumers import from `@mapng/export/*` instead.
- **Consumers to repoint:** route (`@mapng/bake/export3d`,
  `@mapng/bake/exportBeamNGLevel`), batch (`@mapng/bake/export3d`,
  `@mapng/bake/exportTer`, `@mapng/bake/exportGeoTiff`), the Vue app.
- **Package seam surfaced by the 9a/9b decomposition (NEW):** inside `beamng/*`
  there is now a clean, acyclic **compute → serialize** split, and it's the
  natural internal boundary if BeamNG export is carved into its own
  `@mapng/beamng` format package during the lift (instead of folding everything
  into `@mapng/export`):
  - **compute** (geometry/number generators → plain JS objects/blobs):
    `worldMath`, `format`, `roadStyle`, `decalRoads`, `roadArchitectProfiles`,
    `roadArchitectSession`, `meshRoads`, `report`, `levelZip`, `barriers` (`core`);
    `water`, `forest` (`io` only because they read the io flavor-catalog's lazy
    fetch). The renderer/canvas io: `textures`, `meshAssets`, `googleTilesAssets`.
  - **serialize** (computed artifacts → BeamNG level file tree): `levelArchive`
    → `levelFiles` + `missionGroup` + `levelLua` — **pure `core`**, takes
    everything via an explicit ctx, imports no renderer/canvas/fetch/`?raw`. This
    is the headless-testable core (oracle: `tests/beamngArchiveHeadless.test.mjs`).
  - The dependency arrow is **serialize ← orchestrator → compute** (the flow
    `exportBeamNGLevel` entry depends on both; serialize does NOT depend on
    compute). If split into packages, `@mapng/beamng-format` (serialize, pure)
    could even sit below the compute/io. Don't create the package now —
    decompose-first; this just records where the seam is for the lift.

### 3. `@mapng/batch` → **run in a worker** (runtime re-architecture, NOT a rename)
- Clarified: `batch` is the grid-export orchestrator (export an N×M grid of
  tiles); it is NOT "the worker." The repo's actual workers are unrelated:
  `worker.js` (Cloudflare API proxy) and `scripts/googleBakeWorker.mjs` (headless
  Node bake sidecar).
- **Decision:** keep `@mapng/batch` as a package, but re-architect `batchJob` so
  the grid bake executes **off the main thread** (Web Worker in-browser / Node
  worker thread headless) instead of blocking the UI. This is a runtime change on
  top of the file decomposition — do it AFTER `batchJob.js` is split into
  `<500` modules (grid / state / run), so the worker boundary lands on a clean
  message-passing seam rather than a 1561-LOC blob.

## Order of work

1. **Decompose the 4 remaining giants in-place** (06 recipe, each green, oracle
   where canvas-coupled):
   - `terrain.js` (1986) → `terrain/*` (mostly pure: mercator/heightmap math +
     fetch orchestration). No canvas oracle needed.
   - `export3d.js` (2163) → `scene3d/*` (osmMeshes, tilePlacement3d,
     colladaExport, glbExport). Canvas/THREE — use the headless render oracle
     (`tools/testlab/canvasShim.mjs`).
   - `exportBeamNGLevel.js` (5558) → `beamng/*`. **9a DONE** (`4e76859`):
     ~95 helpers → 15 modules (worldMath/format/roadStyle/decalRoads/
     roadArchitect{Profiles,Session}/meshRoads/report/levelZip/barriers +
     textures/meshAssets/googleTilesAssets/water/forest). **9b DONE** (`b497038`):
     archive serialization → `levelArchive`/`levelFiles`/`missionGroup`/`levelLua`
     (pure core, ctx-threaded) + headless oracle. Entry now 748 LOC. **9c TODO:**
     extract the ~480-line compute phase → `beamng/levelArtifacts.js` (flow, via a
     small progress-tracker passed in), thin the orchestrator <500, barrel
     `src/exportBeamNGLevel.js`, drop the allowlist entry. 9c's compute path can't
     run headless (google3dTiles WebGLRenderer + canvas + fetch) — verify the
     artifacts→orchestrator field contract statically (as 9b did) and confirm with
     ONE real in-app bake.
   - `batchJob.js` (1561) → grid / state / run modules.
2. **Lift folders into `@mapng/terrain` and `@mapng/export`** (mechanical move +
   repoint imports + update `tools/check-boundaries.mjs` ALLOWED graph + add the
   new layers; drop bake's re-exports of the moved files).
3. **batch → worker** (runtime change), last.

## Notes / guardrails

- `tools/check-boundaries.mjs` `ALLOWED` map must gain `terrain` and `export`
  entries with the right downward sets, and `bake` must add `terrain`, `route`/
  `batch`/`pipelines` must add `export`.
- The headless render oracle (`tests/osmTextureHeadless.test.mjs` pattern) is the
  net for the canvas-coupled giants — capture a golden hash against the monolith
  BEFORE splitting, assert it after (proven approach: osmTexture 06 step 6).
- Keep the zero-churn trick where possible: during decomposition the original
  filename stays a re-export barrel. The cross-PACKAGE move is the one place that
  unavoidably changes import paths at consumers — do it in one mechanical commit.
