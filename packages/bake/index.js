// @mapng/bake — tile/scene compute core (Google 3D tiles bake, scene framing,
// junction/scalar-field/ground compute, materials, terrain conform). The export
// FORMATS (GLB/DAE/BeamNG/GeoTIFF/TER) now live in @mapng/export (above bake);
// terrain fetch/resample lives in @mapng/terrain (below bake). Consumers should
// prefer subpath imports (@mapng/bake/googleBakeCore); this flat barrel is
// browser-app convenience.
export * from './src/beamngFlavorCatalog.js';
export * from './src/cropTerrain.js';
export * from './src/google3dTiles.js';
export * from './src/googleBakeCore.js';
export * from './src/googleBakeSidecar.js';
export * from './src/groundMask.js';
export * from './src/scalarFieldGrid.js';
export * from './src/textureGenerator.js';
export * from './src/tileGroundConform.js';
export * from './src/uploadBounds.js';
export * from './src/zipExportSidecar.js';
// LIFTED OUT (refactor doc 08 step 2):
//   → @mapng/terrain : terrain.js, terrain/*, resampler*, resample/*,
//     surroundingTiles.js, osmTexture.js, osm/*, roadNetwork.js
//   → @mapng/export  : export3d.js, exportBeamNGLevel.js, exportGeoTiff.js,
//     exportTer.js, scene3d/*, beamng/*, roads/*, junction{Geometry,Mesh,Raster}.js,
//     osmTerrainMaterials.js, materials/{osmLayerMap,terrainReferenceMaterials}.js,
//     buildingFoundations.js, ColladaExporter.js
