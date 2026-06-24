// @mapng/route — route-corridor pipeline: tiers/chunking (routeCorridor), metric
// stitching (routeStitch), combined-terrain composite (routeTerrainComposite),
// progress (routeProgress), the bake orchestrator (routeBake) and the BeamNG
// level export (exportRouteLevel). Sits on top of @mapng/bake.
// Prefer subpath imports (@mapng/route/routeCorridor) in node consumers to avoid
// eager-loading the browser-heavy bake/export orchestrators.
export * from './src/routeCorridor.js';
export * from './src/routeStitch.js';
export * from './src/routeTerrainComposite.js';
export * from './src/routeProgress.js';
export * from './src/routeBake.js';
export * from './src/exportRouteLevel.js';
