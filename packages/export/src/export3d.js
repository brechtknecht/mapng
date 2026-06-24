// Re-export barrel — export3d.js was decomposed into scene3d/* (06 step 8).
// Keeps the public surface (and `@mapng/bake/export3d` subpath) byte-for-byte
// stable for every consumer while the implementation lives in focused modules.
// NOTE: the GLB/DAE exporters pull in google3dTiles (3d-tiles-renderer builds a
// WebGLRenderer at import), so importing this barrel requires a GPU/browser. The
// headless geometry oracle imports scene3d/osmMeshes directly instead.
export { SCENE_SIZE } from './scene3d/sceneProjection.js';
export { createOSMGroup } from './scene3d/osmMeshes.js';
export { createSurroundingMeshes } from './scene3d/surroundingMeshes.js';
export { exportToGLB } from './scene3d/glbExport.js';
export { exportToDAE } from './scene3d/daeExport.js';
