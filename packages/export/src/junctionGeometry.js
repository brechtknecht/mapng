// Re-export barrel (refactor doc 06 step 10). The pure OSM-road junction prism
// geometry + MeshRoad polyline cleanup now live under roads/: tunable constants
// (junctionConstants), shared 2D primitives (geomPrimitives), junction polygon
// build/validate/merge (junctionPolygons), and polyline cleanup
// (polylineCleanup). This file keeps the original public surface so every
// consumer (`./junctionGeometry.js`, `@mapng/bake/junctionGeometry`,
// exportBeamNGLevel, junctionMesh) stays unchanged.

export * from './roads/junctionConstants.js';
export {
  analyzeJunctions,
  buildJunctionPolygons,
  clampPolygonZRange,
  validateJunctionPolygon,
  mergeJunctionClusters,
} from './roads/junctionPolygons.js';
export {
  clipPolylineEnds,
  pruneShortEndEdges,
  balanceEndEdges,
  smoothSharpKinks,
  uniformResamplePolyline,
  zAtClipBack,
} from './roads/polylineCleanup.js';
