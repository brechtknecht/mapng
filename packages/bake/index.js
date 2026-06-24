// @mapng/bake — tiles + OSM + export compute core (one coupled subsystem).
// Terrain fetch/resample now lives in @mapng/terrain (below bake). Consumers
// should prefer subpath imports (@mapng/bake/export3d); this flat barrel is
// browser-app convenience.
export * from './src/ColladaExporter.js';
export * from './src/beamngFlavorCatalog.js';
export * from './src/buildingFoundations.js';
export * from './src/cropTerrain.js';
export * from './src/export3d.js';
export * from './src/exportBeamNGLevel.js';
export * from './src/exportGeoTiff.js';
export * from './src/exportTer.js';
export * from './src/google3dTiles.js';
export * from './src/googleBakeCore.js';
export * from './src/googleBakeSidecar.js';
export * from './src/groundMask.js';
export * from './src/junctionGeometry.js';
export * from './src/junctionMesh.js';
export * from './src/junctionRaster.js';
export * from './src/osmTerrainMaterials.js';
export * from './src/scalarFieldGrid.js';
export * from './src/textureGenerator.js';
export * from './src/tileGroundConform.js';
export * from './src/uploadBounds.js';
export * from './src/zipExportSidecar.js';
// terrain.js, terrainResampler.js, resamplerClient.js, surroundingTiles.js,
// osmTexture.js, roadNetwork.js + terrain/* + resample/* + osm/* lifted to
// @mapng/terrain (refactor doc 08 step 2).
