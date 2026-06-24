/** @layer core */
// Tunable constants for OSM-road junction prisms + MeshRoad polyline cleanup
// (refactor doc 06 step 10). Pure data, moved verbatim from junctionGeometry.js.

export const MESH_ROAD_SURFACE_LIFT = 0.5;
export const MESH_ROAD_DEPTH = 0.5;
export const JUNCTION_COLLISION_OVERLAP = 0.05;
export const MIN_MESH_ROAD_LENGTH = 3.0;
export const MESH_ROAD_RESAMPLE_SPACING_M = 4.0;
export const MITER_LIMIT_FACTOR = 4.0;
export const MIN_TANGENT_DISTANCE = 3.0;
export const MIN_JUNCTION_SEGMENTS = 3;
export const MAX_CLIPBACK_RATIO = 0.4;
export const JUNCTION_MERGE_RADIUS_M = 15.0;
export const JUNCTION_MERGE_MAX_Z_RANGE_M = 1.5;
export const JUNCTION_MERGE_BBOX_SLOP_M = 0.5;
export const JUNCTION_POLYGON_Z_CLAMP_RANGE_M = 1.0;
export const JUNCTION_VALIDATE_MIN_AREA_M2 = 0.5;
export const JUNCTION_VALIDATE_MIN_EDGE_M = 0.05;
export const JUNCTION_VALIDATE_MAX_BBOX_DIAG_M = 200.0;
export const KINK_SMOOTH_THRESHOLD_DEG = 75;
export const KINK_SMOOTH_THRESHOLD_TIGHT_DEG = 30;
export const KINK_SHORT_EDGE_M = 4.0;
export const KINK_SMOOTH_OFFSET_M = 2.0;
export const KINK_OFFSET_MAX_RATIO = 0.4;
export const END_EDGE_RATIO_THRESHOLD = 0.4;
export const END_EDGE_KINK_DEG = 15;
export const END_EDGE_PRUNE_MIN_M = 2.0;
