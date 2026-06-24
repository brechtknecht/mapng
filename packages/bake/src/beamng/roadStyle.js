/** @layer core */
// Road classification + dimensioning: decal material catalog, layer templates,
// per-highway styling, and the predicates/width estimators that decide how an
// OSM way is painted. Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import { clamp } from './format.js';

export const GLOBAL_DECAL_MATERIALS = {
  invisible: 'road_invisible',
  lineWhite: 'm_line_white',
  lineYellowDouble: 'm_line_yellow_double',
  lineYellowSingle: 'm_line_yellow',
  lineWhiteDashed: 'm_line_white_discontinue',
  edgeAsphaltGrass: 'm_road_asphalt_edge_grass',
  edgeAsphaltDirt: 'm_road_edge_dirt_grass',
  edgeDirt: 'm_road_edge_dirt',
  asphaltItaly: 'road_asphalt_2lane', // Using generic asphalt matching the screenshots
  asphaltECA: 'road_asphalt_2lane',
};

// Decal Road Layer Templates
// Logic derived from BeamNG.drive's internal roadSpline tool (Italy/ECA).
export const ROAD_TEMPLATES = {
  default: [
    { name: 'asphalt', material: GLOBAL_DECAL_MATERIALS.invisible, widthScale: 1.0, offset: 0, priority: 10 },
    { name: 'edge_left', material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass, width: 2.0, offset: -1.0, priority: 11, isEdge: true, mirrorByReversingNodes: true },
    { name: 'edge_right', material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass, width: 2.0, offset: 1.0, priority: 11, isEdge: true },
  ],
  major: [
    { name: 'asphalt', material: GLOBAL_DECAL_MATERIALS.invisible, widthScale: 1.0, offset: 0, priority: 10 },
    { name: 'edge_left', material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass, width: 2.5, offset: -1.0, priority: 11, isEdge: true, mirrorByReversingNodes: true },
    { name: 'edge_right', material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass, width: 2.5, offset: 1.0, priority: 11, isEdge: true },
    { name: 'line_center', material: GLOBAL_DECAL_MATERIALS.lineYellowDouble, width: 0.4, offset: 0, priority: 20 },
    { name: 'line_left', material: GLOBAL_DECAL_MATERIALS.lineWhite, width: 0.2, offset: -0.9, priority: 20, isEdgeRelative: true },
    { name: 'line_right', material: GLOBAL_DECAL_MATERIALS.lineWhite, width: 0.2, offset: 0.9, priority: 20, isEdgeRelative: true },
  ],
  minor: [
    { name: 'asphalt', material: GLOBAL_DECAL_MATERIALS.invisible, widthScale: 1.0, offset: 0, priority: 10 },
    { name: 'edge_left', material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass, width: 2.0, offset: -1.0, priority: 11, isEdge: true, mirrorByReversingNodes: true },
    { name: 'edge_right', material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass, width: 2.0, offset: 1.0, priority: 11, isEdge: true },
    { name: 'line_center', material: GLOBAL_DECAL_MATERIALS.lineWhiteDashed, width: 0.2, offset: 0, priority: 20 },
  ],
  unpaved: [
    { name: 'dirt', material: GLOBAL_DECAL_MATERIALS.edgeDirt, widthScale: 1.1, offset: 0, priority: 10 },
  ],
};

// OSM highway type → generated decal styling.
// width: half-width in metres (total road width = 2 × value).
// edgeMaterial: blend strip material along the road/terrain boundary.
export const HIGHWAY_STYLE = {
  motorway:       { width: 8, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  motorway_link:  { width: 5, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  trunk:          { width: 8, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  trunk_link:     { width: 5, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  primary:        { width: 8, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  primary_link:   { width: 5, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  secondary:      { width: 6, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  secondary_link: { width: 5, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  tertiary:       { width: 5, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  tertiary_link:  { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  residential:    { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  living_street:  { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  unclassified:   { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  road:           { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  service:        { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  raceway:        { width: 6, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  busway:         { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass },
  track:          { width: 4, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeDirt },
};

export const DEFAULT_ROAD_STYLE = { width: 3, edgeMaterial: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass };

export const ROAD_MARKING_STYLE = {
  edgeBlend: {
    material: GLOBAL_DECAL_MATERIALS.edgeAsphaltGrass,
    halfWidth: 2,
    offsetInsideEdge: 0.6,
    breakAngle: 0.5,
    detail: 0.3,
    renderPriority: 8,
    textureLength: 8,
    startEndFade: [1, 1],
  },
  edgeWhite: {
    material: GLOBAL_DECAL_MATERIALS.lineWhite,
    halfWidth: 0.2,
    offsetInsideEdge: 1.2,
    breakAngle: 1,
    renderPriority: 1,
    textureLength: 6.4,
    startEndFade: [0.2, 0.2],
  },
  centerDoubleYellow: {
    material: GLOBAL_DECAL_MATERIALS.lineYellowDouble,
    halfWidth: 0.4,
    breakAngle: 1,
    renderPriority: 2,
    textureLength: 6.4,
  },
};

// OSM highway types to exclude from road generation (non-vehicle ways).
export const ROAD_SKIP = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'cycleway',
  'bridleway', 'corridor', 'proposed', 'construction',
]);

// Only major roads receive painted lane markings.
export const MAJOR_ROAD_MARKINGS = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
]);

// Grass edge blends are useful mainly on higher class paved roads.
export const GRASS_EDGE_BLEND_HIGHWAYS = new Set([
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
]);

export const UNPAVED_SURFACES = new Set([
  'dirt', 'earth', 'gravel', 'fine_gravel', 'ground', 'mud', 'sand',
  'rock', 'scree', 'grass', 'compacted', 'unpaved', 'pebblestone',
  'snow', 'ice',
]);

/**
 * Infer that a road should not receive lane paint from OSM tags.
 *
 * Explicit lane_markings=no always disables paint. Unpaved surfaces are also
 * treated as unmarked unless tags explicitly force lane markings on.
 */
export function isLikelyUnmarkedRoad(tags = {}) {
  const laneMarkings = String(tags.lane_markings ?? '').trim().toLowerCase();
  if (laneMarkings === 'yes') return false;
  if (laneMarkings === 'no') return true;

  const surface = String(tags.surface ?? '').trim().toLowerCase();
  if (!surface) return false;
  return UNPAVED_SURFACES.has(surface);
}

/**
 * Decide if this highway class should get white/yellow lane line decals.
 */
export function shouldUseLaneMarkings(highway, tags = {}) {
  if (!MAJOR_ROAD_MARKINGS.has(highway)) return false;
  return !isLikelyUnmarkedRoad(tags);
}

/**
 * Decide if this road should get asphalt-to-grass blend edge decals.
 */
export function shouldUseGrassEdgeBlend(highway, tags = {}) {
  if (!GRASS_EDGE_BLEND_HIGHWAYS.has(highway)) return false;
  const surface = String(tags.surface ?? '').trim().toLowerCase();
  // If explicitly unpaved, skip asphalt-grass edge blend.
  if (surface && UNPAVED_SURFACES.has(surface)) return false;
  return true;
}

export function shouldGenerateDecalRoads(highway, tags = {}) {
  if (!highway || ROAD_SKIP.has(highway)) return false;
  if (tags.area === 'yes') return false;

  if (highway === 'trunk_link') return false;

  if (highway === 'service') return false;

  const service = String(tags.service ?? '').trim().toLowerCase();
  if (['parking_aisle', 'driveway', 'alley', 'emergency_access'].includes(service)) {
    return false;
  }

  return true;
}

/**
 * Infer one-way traffic from common OSM tags and implied highway types.
 */
export function isOneWayRoad(tags = {}) {
  const value = String(tags.oneway ?? '').trim().toLowerCase();
  if (value === 'yes' || value === '1' || value === 'true') return true;
  if (value === '-1' || value === 'reverse') return true;
  if (tags.junction === 'roundabout') return true;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return true;
  return false;
}

/**
 * Parse a strictly positive integer, returning 0 when invalid.
 */
export function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Parse OSM width-style values to meters.
 *
 * Supports values like "12", "12 m", and "40 ft". Unit-less large values
 * above 40 are interpreted as feet, matching common OSM tagging practice.
 */
export function parseRoadWidthMeters(value) {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();

  if (raw.includes('ft')) {
    const parsed = Number.parseFloat(raw.replace('ft', '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed * 0.3048 : null;
  }

  if (raw.includes('m')) {
    const parsed = Number.parseFloat(raw.replace('m', '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  // OSM width values above ~40 without units are commonly feet.
  return parsed > 40 ? parsed * 0.3048 : parsed;
}

/**
 * Return a class-based default lane width in meters.
 */
export function getDefaultLaneWidthMeters(highway) {
  if (['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(highway)) return 3.7;
  if (['primary', 'primary_link', 'secondary', 'secondary_link'].includes(highway)) return 3.5;
  if (['tertiary', 'tertiary_link'].includes(highway)) return 3.25;
  if (['service', 'track'].includes(highway)) return 2.8;
  return 3.0;
}

/**
 * Return a class-based default lane count, adjusted for one-way roads.
 */
export function getDefaultLaneCount(highway, isOneWay) {
  if (['motorway', 'trunk'].includes(highway)) return isOneWay ? 2 : 4;
  if (['motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'].includes(highway)) {
    return 1;
  }
  if (['service', 'track'].includes(highway)) return 1;
  return isOneWay ? 1 : 2;
}

/**
 * Return min/max half-width bounds for a given highway class.
 */
export function getRoadHalfWidthClamp(highway) {
  if (['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(highway)) {
    return { min: 3.5, max: 9.0 };
  }
  if (['primary', 'primary_link', 'secondary', 'secondary_link'].includes(highway)) {
    return { min: 2.8, max: 6.0 };
  }
  if (['service', 'track'].includes(highway)) {
    return { min: 1.8, max: 3.5 };
  }
  return { min: 2.2, max: 5.0 };
}

/**
 * Estimate road half-width in meters from OSM tags and roadway class.
 *
 * Priority: explicit `width` tag -> lane-based estimate -> style fallback,
 * always clamped to class-specific practical limits.
 */
export function estimateRoadHalfWidth(tags = {}, highway, isOneWay = false, fallbackHalfWidth = 3.5) {
  const explicitWidth = parseRoadWidthMeters(tags.width);
  const limits = getRoadHalfWidthClamp(highway);
  if (Number.isFinite(explicitWidth) && explicitWidth > 0) {
    return clamp(explicitWidth / 2, limits.min, limits.max);
  }

  const lanesFromTotal = parsePositiveInt(tags.lanes);
  const lanesFromDir = parsePositiveInt(tags['lanes:forward']) + parsePositiveInt(tags['lanes:backward']);
  const inferredLanes = Math.max(
    getDefaultLaneCount(highway, isOneWay),
    lanesFromTotal || lanesFromDir || 0,
  );
  const estimatedHalf = (inferredLanes * getDefaultLaneWidthMeters(highway)) / 2;

  return clamp(estimatedHalf || fallbackHalfWidth, limits.min, limits.max);
}
