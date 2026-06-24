# 11 — batchJob.js Decomposition (cold-start handoff)

Single entry point for a fresh thread decomposing the **last real god-file**,
`packages/batch/src/batchJob.js` (**1561 LOC**). Read **this** first; it is
self-contained. For the general refactor context skim
[09](09-continuation-handoff.md) (recipe/oracle/learnings) and
[08](08-package-architecture.md) (the package lifts that follow). This doc
repeats the parts that matter and adds everything specific to this file.

---

## 0. Where you are

- **Branch:** `refactor/internal-decomposition` (local, NOT pushed). Tree clean,
  all green.
- **`exportBeamNGLevel.js` (5558 LOC) — DONE & bake-verified.** Decomposed into 18
  `beamng/*` modules across 9a (`4e76859`, helpers), 9b (`b497038`, archive
  serialization → pure-core writers + oracle), 9c (`0f6d49e`, compute →
  `levelArtifacts` + google export consolidated; entry → 162-LOC orchestrator,
  allowlist entry dropped). A real in-app single-tile + route bake was run and
  the `.zip` loads correctly in BeamNG — the compute path (unverifiable headless)
  is confirmed end-to-end.
- **Remaining offenders** in `tools/lint-size-allow.json`: just
  `batchJob.js` (1561, **this task**) and `ColladaExporter.js` (697, VENDORED —
  permanent exempt). After batchJob, the size ratchet is empty of real work.
- **After this:** the package lifts (08): `terrain/*`→`@mapng/terrain`,
  export→`@mapng/export`, then **batch-in-worker** (the runtime re-architecture
  this decomposition sets up — see §5).

## 1. Resume gate (run before AND after every commit)

```
npm run check     # = boundaries + lint:size + test:all (97 tests)
npm run build     # vite build of the Vue app
node --check scripts/googleBakeWorker.mjs   # node bake sidecar must parse
```
All three green. **One coherent step per commit, keep every commit green.** And
`npm run dev` must boot clean (a stale `services/` import was just fixed in
`4bccfb1`; dev-only `import.meta.env.DEV` branches are NOT covered by `build`).

## 2. The recipe (proven on terrain, export3d, exportBeamNGLevel)

1. Start green.
2. **Write** focused module(s) as siblings under `packages/batch/src/` (the batch
   package is flat — `batchCache.js`, `taskQueues.js`, `traceability.js`, etc.;
   match that, no subfolder needed), each with a `/** @layer core|io|flow */`
   header. Copy bodies **VERBATIM** — a move, not a rewrite. `io` =
   canvas/fetch/localStorage/THREE-renderer/document; `core` = pure compute;
   `flow` = the orchestrator.
3. **For big functions, destructure inputs at the top so bodies stay byte-verbatim**
   (the trick that made 9b/9c low-risk): `export function f(ctx){ const {a,b,...}=ctx; <verbatim body> }`.
4. Turn `batchJob.js` into a **re-export barrel** that keeps every public export
   (consumers: `App.vue` imports ~15 names incl. `computeGridTiles`,
   `computeGridTilesWithOffsets`, `computeGridBounds`, `normalizeTileNames`,
   `createBatchJobState`, `saveBatchState`, `loadBatchState`, `clearBatchState`,
   `clearBatchClientCache`, `resetFailedTiles`, `runBatchJob`; `BatchProgressModal.vue`
   imports `estimateTimeRemaining`, `formatDuration`). Keep their import paths
   byte-unchanged. The thin `runBatchJob` orchestrator + the two tiny utils can
   stay IN `batchJob.js` alongside the re-exports.
5. Drop the `batchJob.js` `tools/lint-size-allow.json` entry once <500.
6. **Big excisions: Write whole files, don't Edit 200-line blocks** (Edit needs an
   exact match; `sed` is policy-blocked).
7. **The size-lint is a ratchet** — never ADD allowlist entries; new code is born
   small. It errors on a STALE entry too, so dropping it is mandatory.
8. When you split a function-to-helpers across a wide object boundary (like the
   beamng ctx), **statically verify the producer keys == consumer reads** (a
   ~15-line node script — see how 9b/9c did it; it caught zero drift because it
   was run). Do the same for any state/context object you thread.

## 3. Oracle strategy — the pure core is headless, the runner is not

- **Headless-testable pure modules** (the oracle targets): `grid.js`,
  `schedulerConfig.js`, `batchState.js`, `batchReport.js` (see §4). Hash their
  plain-object/string output against a fixed fixture and pin it (pattern:
  `tests/beamngCoreHeadless.test.mjs`; wire new tests into `test:all` in root
  `package.json` and `git add -f` since `tests/` is gitignored-but-tracked).
- **The runner can't run headless:** `batchJob.js` imports the **export3d barrel**
  (`exportToGLB, exportToDAE from '@mapng/bake/export3d'`, line 11), which pulls
  `google3dTiles` → `3d-tiles-renderer` → a `WebGLRenderer` at module eval. So
  `processTile.js` / `runBatchJob` cannot be imported in Node. Repointing to the
  scene3d leaves does NOT help here — `glbExport`/`daeExport` themselves import
  `google3dTiles` (unlike the beamng OSM/terrain DAE path). So: oracle the pure
  leaves directly; reserve a **real in-app batch run** (grid export of a few
  tiles) for the orchestrator — exactly the confirmation just done for the
  single-tile/route export.
- Don't fabricate a fragile WebGLRenderer stub for batch — `log()` the coverage
  gap and lean on the real run.

## 4. Concrete seams (verified against the file 2026-06-24)

`batchJob.js` is 54 top-level decls (34 functions). The natural split — pure
compute out, io out, the per-tile pipeline isolated, the loop + public API in the
barrel:

| module | layer | contents (line ranges approx — VERIFY names against the file) |
|---|---|---|
| `grid.js` | core | computeGridTiles, normalizeTileOffsets, computeGridTilesWithOffsets, computeGridBounds, getDefaultTileLabel, normalizeTileNames, getTileLabel, sanitizeFilenamePart (37-181) — pure grid/label math. **Oracle.** |
| `schedulerConfig.js` | core | flattenNestedExportFlags, normalizeExportFlags, mapLegacyJobStatus, deriveSchedulerConfig (182-315) — pure config derivation. **Oracle.** |
| `batchState.js` | core | createBatchJobState, migrateLoadedState, resetFailedTiles (316-516 minus the localStorage fns) — pure state shape/migration. **Oracle.** |
| `statePersistence.js` | io | saveBatchState, loadBatchState, clearBatchState, clearBatchClientCache (465-516) — localStorage + batchCache. |
| `batchReport.js` | core | buildBatchElevationReportText, buildTileMetadata, computeBatchElevationNormalization, sanitizeError (533-960 selected) — pure text/metadata/normalization. **Oracle.** |
| `batchDownloads.js` | io | triggerDownload, downloadBatchElevationReport, downloadCompositeHeightmap, ensureExportBlobType (517-668 selected) — document/Blob/anchor. |
| `compositeHeightmap.js` | io | createCompositeHeightmapContext, writeTileToCompositeHeightmap, loadImage, generateTileSnapshot, releaseTerrainResources, getSnapshotSize (691-1109 selected) — canvas + fast-png encode. |
| `memorySampling.js` | io | readPerformanceMemory, sampleMemory (806-870) — performance.memory. |
| `tileQueues.js` | core/io | buildQueues, shouldFetchOSMForBatch (962-1020) — wraps taskQueues.js. |
| `processTile.js` | flow | processTile (1178-1451, **274 LOC** — the per-tile pipeline: fetchTerrainData → exportToGLB/DAE → snapshot → metadata → retry). The renderer-coupled heart. |
| `batchJob.js` | flow | **barrel** — re-export the full public API + keep runBatchJob (1452-1541), estimateTimeRemaining (1542), formatDuration (1552). Lands ~150 LOC. |

**Watch the interleaving** (decl order ≠ clean clusters): e.g. `buildTileMetadata`
(897) sits between memory-sampling and queues; `computeBatchElevationNormalization`
(1110) sits between composite-heightmap fns. Group by CONCERN, not adjacency —
and re-derive line ranges from the file (the decl scan in this thread's transcript
is the source).

## 5. The worker seam (sets up doc 08 step 3: batch-in-worker)

The whole point of the grid/state/run split (08 §3) is that **`processTile` is the
unit that moves off the main thread**. Decompose so `processTile(tileSpec, config,
deps)` is a clean function of explicit inputs → `{ exportBlobs, metadata,
snapshot }` (no reliance on closure over `runBatchJob`'s locals). Then `runBatchJob`
becomes a dispatcher over a queue of tile specs — and the message-passing boundary
to a Web Worker (browser) / worker_thread (node) lands on that seam instead of a
1561-LOC blob. **Do NOT build the worker now** (decompose-first); just make
`processTile`'s signature marshallable and note it.

## 6. Definition of done

`batchJob.js` <500 (barrel + thin runBatchJob); every new module `@layer`-tagged;
`core` imports no `io`/`flow`; allowlist entry dropped; gate green (check + build +
worker + `npm run dev` boots). Pure-core oracle(s) pin grid/config/state/report.
A real in-app **grid batch export** (a 2×2, with + without Google tiles) confirms
the runner path (headless can't). Then update [09](09-continuation-handoff.md) §0
+ the `refactor-plan` memory, and move to the package lifts ([08](08-package-architecture.md)).
Nothing pushed — the maintainer pushes/opens the PR.
