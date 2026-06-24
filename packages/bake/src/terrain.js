// Re-export barrel — terrain.js was decomposed into terrain/* (06 step 7).
// Keeps the public surface (and `@mapng/bake/terrain` subpath) byte-for-byte
// stable for every consumer while the implementation lives in focused modules.
export { TERRAIN_ZOOM, project } from './terrain/mercatorTiles.js';
export { parseTifFile, parseLazFile } from '@mapng/fetching';
export { probeGPXZLimits, getGPXZRateLimitInfo } from './terrain/gpxzFetch.js';
export { checkUSGSStatus } from './terrain/usgsFetch.js';
export { fetchTerrainData, addOSMToTerrain } from './terrain/fetchTerrainData.js';
export { loadTerrainFromTif } from './terrain/tifLoader.js';
export { loadTerrainFromLaz } from './terrain/lazLoader.js';
