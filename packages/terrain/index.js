// @mapng/terrain — terrain fetch/resample subsystem lifted out of @mapng/bake
// (refactor doc 08 step 2). Layer: geo < fetching < terrain < bake. Imports
// only @mapng/fetching + @mapng/geo + npm — zero upward deps, so it sits cleanly
// below bake. Consumers should prefer subpath imports (@mapng/terrain/terrain,
// @mapng/terrain/surroundingTiles); this flat barrel is browser-app convenience.
// resamplerWorker.js is a Web Worker entry (self.onmessage) and is intentionally
// NOT re-exported.
export * from './src/terrain.js';
export * from './src/surroundingTiles.js';
export * from './src/terrainResampler.js';
export * from './src/resamplerClient.js';
