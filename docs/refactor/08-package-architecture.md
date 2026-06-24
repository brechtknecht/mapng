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

### 1. `@mapng/terrain`  ✅ DONE (`72c798e`) — new layer fetching < terrain < bake
- **Correction to the original "it's clean" claim:** the closure was BIGGER than
  documented. `terrain.js`'s *direct* imports are only fetching+geo, but its
  transitive tree (`terrain/{fetchTerrainData,lazLoader,tifLoader}`) imports
  `osmTexture.js` (with **double quotes** — the original single-quote-only grep
  missed it), which pulls `osm/*` → `roadNetwork.js`. So the OSM texture group
  came down into terrain too. The true closure (verified by a both-quote-styles
  import-closure scan) is clean: imports only `@mapng/geo` + `@mapng/fetching` +
  npm + intra-package. **Lesson: scan BOTH quote styles + follow the transitive
  closure, not just the entry file's direct imports.**
- **Contents (moved verbatim, git-renamed):** `terrain.js` + `terrain/*` (12),
  `terrainResampler.js`, `resamplerClient.js`, `resamplerWorker.js`,
  `surroundingTiles.js`, `resample/*` (3), **plus** `osmTexture.js`, `osm/*` (7),
  `roadNetwork.js`. (Raw elevation fetchers did NOT move to `@mapng/fetching` —
  deferred; they're fine where they are.)
- **Back-edges bake→terrain (all allowed):** `scene3d/surroundingMeshes` →
  `@mapng/terrain/surroundingTiles`; `beamng/{decalRoads,meshRoads,
  roadArchitectSession}` → `@mapng/terrain/roadNetwork`.
- **Consumers repointed:** `@mapng/bake/{terrain,surroundingTiles,osmTexture}` →
  `@mapng/terrain/*` in route (`exportRouteLevel`, `routeBake`), batch
  (`processTile`, `batchRun`, `traceability`), the Vue app (App.vue + 5
  components), and the osmTexture headless test. `tools/check-boundaries.mjs`
  ALLOWED gained the `terrain` layer; bake/route/batch gained the `@mapng/terrain`
  dep. Subpath mapping `@mapng/bake/terrain` → `@mapng/terrain/terrain` (1:1,
  preserves the subpath convention, avoids root-barrel `export *` collisions).

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
     (pure core, ctx-threaded) + headless oracle. **9c DONE** (`0f6d49e`):
     compute phase → `beamng/levelArtifacts.js` (flow), Google-tiles export
     orchestration → `beamng/googleTilesAssets.js` (`exportGoogleTilesForLevel`);
     `src/exportBeamNGLevel.js` is now a 162-LOC orchestrator (stayed in src/,
     no barrel needed since <500), allowlist entry dropped. The 5558-LOC giant is
     fully retired. 9c's compute path can't run headless (google3dTiles
     WebGLRenderer + canvas + fetch) — field contract verified statically
     (artifacts return 42 = writer reads 42) + vite build; a real in-app bake is
     the outstanding end-to-end confirmation.
   - `batchJob.js` (1561) → grid / state / run modules.
2. **Lift folders into `@mapng/terrain` and `@mapng/export`** (mechanical move +
   repoint imports + update `tools/check-boundaries.mjs` ALLOWED graph + add the
   new layers; drop bake's re-exports of the moved files).
   - **`@mapng/terrain` ✅ DONE (`72c798e`)** — see §1 (closure was bigger than
     planned: OSM texture group came along).
   - **`@mapng/export` — NEXT.** Heed §2's cycle warning (bake/index `export *`s
     export3d + exportBeamNGLevel; those re-exports must be dropped) and run the
     both-quote-styles closure scan FIRST (the terrain lift proved the entry
     file's direct imports under-count the real footprint).
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
