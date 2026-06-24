# 05 — Execution Log

What was actually executed against the plan in [03-migration-plan.md](03-migration-plan.md),
including deviations forced by the real dependency graph, and what was
deliberately deferred. Every step below was gated by `npm run build` (resolves
every import incl. App.vue + workers) **and** the headless `node --test` suites
(`npm run test:all` → 89 tests). Each phase is a separate green commit.

## Done — `services/` fully dissolved into packages

The 60-file `services/` junk drawer is **gone**. Final layout:

```
packages/
  geo/        @mapng/geo       projections, grid math, CRS metadata (leaf, proj4 only)
  fetching/   @mapng/fetching  OSM, geocoding, routes, tile auth, loaders, caches, retry, laz worker
  bake/       @mapng/bake      terrain + Google-3D-Tiles + OSM + export compute core (one package)
  route/      @mapng/route     route-corridor pipeline (corridor, stitch, composite, bake, export)
  batch/      @mapng/batch     grid batch engine
App.vue, components/, stores/  the Vue shell — now imports @mapng/* only
tools/, scripts/               build/dev tooling + node sidecars
```

Layering enforced by `npm run boundaries` (zero-dep checker,
`tools/check-boundaries.mjs`): **geo < fetching < bake < {route, batch}**, and no
package imports Vue.

| Phase | Plan | Outcome |
|---|---|---|
| 0 | Scaffold workspaces + guardrails | npm workspaces; `@mapng/*` resolves in Vite **and** `node --test` via the node_modules symlink. dependency-cruiser replaced by a zero-dep boundary checker (no network install). |
| 1 | `@mapng/geo` | Done. Moved `geoUtils`; added canonical `math.js` (clamp, **verbatim** bilinear, metersPerDegreeLng, lerp, deg2rad). Wired the real duplicates (bilinear in terrainResampler/resamplerWorker, clamp in export3d). |
| 2 | `@mapng/fetching` | Done. 12 loaders/sources moved. Subpath exports (`@mapng/fetching/ascLoader`) let node tests white-box a single loader without barrel-loading browser siblings. Guarded `googleRoutes` `import.meta.env` so the barrel is node-safe; the bake sidecar imports the `tilesAuth` submodule. |
| 3 | `@mapng/workers` | **Deviated.** `resamplerClient` is coupled to `terrainResampler`, so a standalone workers package would create a workers→terrain back-edge. Instead **colocated each worker with its domain**: laz worker/client → `fetching`; resampler stack stayed with the terrain modules (now in `bake`); `taskQueues` → `batch`. |
| 4–6 | `terrain` / `tiles` / `osm` / `export` (4 packages) + god-file splits | **Deviated to one `@mapng/bake` package.** The terrain/tiles/osm/export modules form a tightly coupled, partly cyclic subsystem (`terrain→osmTexture`, `scalarFieldGrid→SCENE_SIZE`, `junctionMesh↔ColladaExporter`/`exportBeamNGLevel`). Splitting into 4 acyclic packages needs behaviour-affecting function moves that can't be verified byte-stable without a runtime bake. Moved all 28 as one package; intra-imports stay relative; every external importer uses the 1:1 subpath `@mapng/bake/<module>`. |
| 7 | `@mapng/route` + `@mapng/batch` | Done. Both moved cleanly on top of `bake`; no route↔batch edges. |
| 8 (partial) | Lift orchestrators → `@mapng/pipelines` | **Package created.** Lifted the ref-free orchestration glue out of `App.vue` (`downloadExportResult` DOM helper, `getTilesApiKey` credential resolver) and made `@mapng/pipelines` the canonical surface App.vue drives for the route pipeline (`chunkRoute`, `bakeAndExportRoute`/`runRouteBake`, `exportRouteAsBeamNGLevel`/`runRouteLevelExport`). The route pipeline is fully package-bound (its orchestrator already lived in `@mapng/route`). The single-tile `handleGenerate` body stays in App.vue — see deferred #1. |
| 9 (partial) | Enforce | Boundary checker (now incl. `pipelines`) + `test:all` + `boundaries` npm scripts. Extensionless relative imports normalized to `.js` (valid Node ESM, not just Vite). |

## Deferred — and why

These require runtime verification I could not perform safely (no in-game/browser
bake check available; the user explicitly prefers no screenshots), so doing them
blind would risk a working pipeline. They are **not** done:

1. **Phase 8 (remainder) — the single-tile `handleGenerate` body.** The
   `@mapng/pipelines` package exists and the route pipeline is fully routed
   through it, but the single-tile/batch control flow (`handleGenerate`,
   `handleStartBatch`) is still inline in `App.vue` because it is pervasively
   coupled to Vue refs (`terrainData`, `lastGenerationKey`, `isLoading`,
   `loadingStatus`, `previewMode`), i18n, `alert`, and Vue-unmount timing — even
   "pure-looking" helpers like `buildGenerationKey` read refs. Lifting it into a
   ref-free `runSingleTileBake(opts, onProgress)` is mechanical but changes
   runtime wiring the build + headless tests cannot confirm byte-stable; it needs
   a real bake run to verify. The data-production calls it makes
   (`fetchTerrainData`, `loadTerrainFromLaz/Tif`, `addOSMToTerrain`) are already
   package-bound in `@mapng/bake`.
2. **Internal split of `@mapng/bake` into terrain/tiles/osm/export.** Blocked on
   two decouplings that must stay byte-stable against the bake oracle:
   move `SCENE_SIZE` (and similar shared constants) into `@mapng/geo`, and
   extract the `terrain↔osmTexture` texture seam to break the upward edge.
3. **God-file decomposition** (`exportBeamNGLevel.js` 5558, `export3d.js` 2164,
   `terrain.js` 1986, `osmTexture.js` 1886). The playbook is in
   [04-conventions.md](04-conventions.md) §6; each extraction must be hashed
   against `tools/testlab/captureRealBake.mjs`.
4. **Physical `app/` move** (App.vue/components/stores under `app/`). Cosmetic;
   components already import `@mapng/*` cleanly. Low value, churn risk — skipped.

## Recommended next steps (for a session with runtime verification)

1. Capture the bake oracle (`npm run testlab:capture`) as the regression gate.
2. Move shared constants (`SCENE_SIZE`, …) into `@mapng/geo`; re-run oracle.
3. Extract the terrain texture seam; split `bake` → terrain/tiles/osm/export.
4. Decompose the export god-files one seam per commit, hashing each.
5. Lift the App.vue orchestrators into `@mapng/pipelines` and add the first
   pipeline integration tests (now possible — logic is package-bound).
