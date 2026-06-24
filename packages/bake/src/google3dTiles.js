// Re-export barrel (refactor doc 06 step 3). The Google 3D-tiles browser
// orchestrator is now decomposed under tiles/: the bake itself
// (bakeGoogle3DTiles), the pure cache key (bakeCache), the localStorage toggles
// (bakeFlags), and the cached front-ends + sidecar session lifecycle
// (bakeSession). This file keeps the original public surface so every consumer
// (`./google3dTiles.js`, `@mapng/bake`, the BeamNG export) stays unchanged.

// The geometry/station/sweep machinery lives in googleBakeCore.js (shared with
// the headless Node bake worker). Re-export the shared helpers the rest of the
// app imports from here.
export { sampleHeightAtScene, computeUnitsPerMeter } from './googleBakeCore.js';
export { purgeRetainedBakes, sidecarAvailable as googleBakeSidecarAvailable } from './googleBakeSidecar.js';

export { bakeGoogle3DTiles } from './tiles/bakeGoogle3DTiles.js';
export { BAKE_FORMAT_VERSION } from './tiles/bakeCache.js';
export {
  getPreferredBakeQuality,
  getPreferredStripGround,
  getGoogleTilesZOffset,
  TILE_RENDER_BIAS_M,
} from './tiles/bakeFlags.js';
export {
  getOrBakeGoogle3DTiles,
  restoreBakedGoogle3DTiles,
  refineGoogleTilesBake,
  exportGoogleTilesViaSidecar,
  endGoogleTilesSession,
  disposeBakeGroup,
  clearGoogleTilesCache,
} from './tiles/bakeSession.js';
