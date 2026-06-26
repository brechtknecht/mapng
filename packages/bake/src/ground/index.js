/** @layer core */
// Barrel for the shared ground-extraction module. Import surface for both the
// terrain sandbox (components/terrain-sandbox) and the BeamNG export.
export * from './heightField.js';
export { extractTileGround, buildGroundMesh, DEFAULT_GROUND_STRATEGY, getPreferredTerGround, getGroundStrategy } from './extractTileGround.js';
export { FILTERS, defaultParams } from './filters/index.js';
export { POSTPROCESSORS, postProcessorById } from './postprocess/index.js';
