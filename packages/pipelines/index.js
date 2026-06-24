// @mapng/pipelines — the canonical orchestration surface that App.vue drives.
// It owns the cross-pipeline glue (export download, credential resolution) and
// re-exports the domain pipeline entry points so the Vue shell depends on one
// "pipelines" layer rather than reaching into individual domain packages.
//
// The single-tile pipeline's terrain production (fetchTerrainData /
// loadTerrainFromLaz / loadTerrainFromTif / addOSMToTerrain) currently still
// runs inside App.vue's reactive handlers; its decomposition into a ref-free
// runSingleTileBake() is the remaining follow-up (see docs/refactor/05).
export * from './src/download.js';
export * from './src/credentials.js';

// Route corridor pipeline entry points.
export { chunkRoute } from '@mapng/route/routeCorridor';
export { bakeAndExportRoute, bakeAndExportRoute as runRouteBake } from '@mapng/route/routeBake';
export { exportRouteAsBeamNGLevel, exportRouteAsBeamNGLevel as runRouteLevelExport } from '@mapng/route/exportRouteLevel';
