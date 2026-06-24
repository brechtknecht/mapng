/** @layer core */
// Geographic ↔ BeamNG world-space conversions, terrain-height sampling, spawn
// placement, polygon predicates, hashing and polyline simplification — the pure
// geometry/number core. Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import { roundTo } from './format.js';

/**
 * Sanitize a string for use as a BeamNG level folder name.
 */
export function sanitizeLevelName(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Generate a UUID v4 string for use as a BeamNG persistentId.
 * BeamNG uses these to track scene objects across editor save/load cycles.
 */
export function generatePersistentId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Check whether a {lat,lng} point lies inside inclusive geographic bounds.
 */
export function pointInBounds(pt, bounds) {
  return (
    pt &&
    pt.lat <= bounds.north &&
    pt.lat >= bounds.south &&
    pt.lng >= bounds.west &&
    pt.lng <= bounds.east
  );
}

/**
 * Keep only OSM features whose geometry intersects the provided bounds.
 *
 * A feature is retained when at least one geometry point is in bounds.
 */
export function filterOSMFeaturesToBounds(features, bounds) {
  if (!Array.isArray(features)) return [];
  return features.filter((feature) => {
    if (!Array.isArray(feature?.geometry) || feature.geometry.length === 0) return false;
    return feature.geometry.some((pt) => pointInBounds(pt, bounds));
  });
}

/**
 * Compute terrain square size (meters per grid square) from bounds.
 */
export function computeSquareSize(terrainData) {
  if (Number.isFinite(terrainData?.metersPerPixel) && terrainData.metersPerPixel > 0) {
    return Math.round(terrainData.metersPerPixel * 100) / 100;
  }

  const { bounds, width } = terrainData;
  const centerLat = (bounds.north + bounds.south) / 2;
  const latRad = (centerLat * Math.PI) / 180;
  const metersPerDegreeLng = 111320 * Math.cos(latRad);
  const realWidthMeters = (bounds.east - bounds.west) * metersPerDegreeLng;
  return Math.round((realWidthMeters / width) * 100) / 100;
}

/**
 * Convert a WGS84 coordinate to BeamNG world-space [x, y, z].
 * Z is meters above the terrain's minimum elevation (+ offset).
 */
export function geoToWorld(lat, lng, terrainData, squareSize, zOffset = 3) {
  const { bounds, width, height, heightMap, minHeight } = terrainData;
  const size = width;
  const worldSize = size * squareSize;

  const u = Math.max(0, Math.min(1, (lng - bounds.west) / (bounds.east - bounds.west)));
  // v=0 is north (top of heightMap), v=1 is south
  const v = Math.max(0, Math.min(1, (bounds.north - lat) / (bounds.north - bounds.south)));

  // Bilinear interpolation — matches BeamNG's own terrain height calculation,
  // preventing spawn/road positions from landing inside terrain peaks that fall
  // between heightmap samples.
  const fx = u * (width - 1);
  const fy = v * (height - 1);
  const c0 = Math.min(width - 1, Math.floor(fx));
  const c1 = Math.min(width - 1, c0 + 1);
  const r0 = Math.min(height - 1, Math.floor(fy));
  const r1 = Math.min(height - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const sanitizeHeight = (h) => (Number.isFinite(h) && h > -10000 ? h : minHeight);
  const h00 = sanitizeHeight(heightMap[r0 * width + c0]);
  const h10 = sanitizeHeight(heightMap[r0 * width + c1]);
  const h01 = sanitizeHeight(heightMap[r1 * width + c0]);
  const h11 = sanitizeHeight(heightMap[r1 * width + c1]);
  const worldH = (h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty) - minHeight;

  // X = east, Y = north (BeamNG convention)
  const worldX = (u - 0.5) * worldSize;
  const worldY = (0.5 - v) * worldSize;

  return [
    Math.round(worldX * 10) / 10,
    Math.round(worldY * 10) / 10,
    Math.round((worldH + zOffset) * 10) / 10,
  ];
}

/**
 * Compute a 9-element flat rotation matrix (row-major) for a spawn sphere
 * facing along the direction from ptA toward ptB in BeamNG world space.
 *
 * World space: X = east, Y = north. The rotation is around the Z axis.
 * Returns identity matrix if the two points are coincident.
 */
export function computeSpawnRotationMatrix(ptA, ptB) {
  const dx = ptB.lng - ptA.lng; // east component
  const dy = ptB.lat - ptA.lat; // north component
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-10) return [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const nx = dx / len; // normalized east
  const ny = dy / len; // normalized north

  // Rotation matrix: vehicle forward aligns with road tangent (nx, ny) in XY plane.
  // Row 0: right vector (ny, -nx, 0)
  // Row 1: forward vector (nx, ny, 0) — BeamNG +Y forward
  // Row 2: up vector (0, 0, 1)
  return [
    Math.round(ny * 1e6) / 1e6, Math.round(-nx * 1e6) / 1e6, 0,
    Math.round(nx * 1e6) / 1e6, Math.round(ny * 1e6) / 1e6,  0,
    0, 0, 1,
  ];
}

/**
 * Find the best spawn position: midpoint of the road nearest the terrain center,
 * falling back to terrain center if no usable roads exist.
 *
 * Returns { position: [x, y, z], rotationMatrix: [9 elements] }.
 */
export function findSpawnPosition(terrainData, center, squareSize) {
  const EXCLUDE = ['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway', 'corridor'];

  let spawnLat = center.lat;
  let spawnLng = center.lng;
  let rotationMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identity — facing north

  if (terrainData.osmFeatures?.length) {
    let bestDist = Infinity;
    for (const feature of terrainData.osmFeatures) {
      if (feature.type !== 'road' || !feature.geometry?.length) continue;
      const highway = feature.tags?.highway;
      if (highway && EXCLUDE.includes(highway)) continue;

      const midIdx = Math.floor(feature.geometry.length / 2);
      const mid = feature.geometry[midIdx];
      const dist = Math.hypot(mid.lat - center.lat, mid.lng - center.lng);
      if (dist < bestDist) {
        bestDist = dist;
        spawnLat = mid.lat;
        spawnLng = mid.lng;
        // Compute road tangent direction from adjacent geometry points.
        const prevIdx = Math.max(0, midIdx - 1);
        const nextIdx = Math.min(feature.geometry.length - 1, midIdx + 1);
        rotationMatrix = computeSpawnRotationMatrix(
          feature.geometry[prevIdx],
          feature.geometry[nextIdx],
        );
      }
    }
  }

  return {
    position: geoToWorld(spawnLat, spawnLng, terrainData, squareSize, 3),
    rotationMatrix,
  };
}

/**
 * Normalize a 2D vector, falling back to +X when magnitude is near zero.
 */
export function normalize2D(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/**
 * Find the highest sampled terrain point and return world-space [x,y,z].
 */
export function findHighestTerrainPoint(terrainData, squareSize) {
  const { width, height, heightMap, minHeight } = terrainData;
  let bestIndex = 0;
  let bestHeight = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    if (heightMap[i] > bestHeight) {
      bestHeight = heightMap[i];
      bestIndex = i;
    }
  }
  const x = bestIndex % width;
  const y = Math.floor(bestIndex / width);
  const worldSize = width * squareSize;
  const u = width > 1 ? x / (width - 1) : 0.5;
  const v = height > 1 ? y / (height - 1) : 0.5;
  return [
    roundTo((u - 0.5) * worldSize, 3),
    roundTo((0.5 - v) * worldSize, 3),
    roundTo(bestHeight - minHeight + 0.25, 3),
  ];
}

/**
 * Check whether a point array forms a closed lat/lng ring.
 */
export function isClosedRing(points) {
  if (!Array.isArray(points) || points.length < 4) return false;
  const a = points[0];
  const b = points[points.length - 1];
  return a.lat === b.lat && a.lng === b.lng;
}

/**
 * Sample terrain height at a lat/lng using bilinear interpolation.
 *
 * Returned value is world-space Z relative to terrain minHeight.
 */
export function getTerrainHeightWorld(lat, lng, terrainData) {
  const { bounds, width, height, heightMap, minHeight } = terrainData;
  const sanitizeHeight = (h) => (Number.isFinite(h) && h > -10000 ? h : minHeight);
  const u = Math.max(0, Math.min(1, (lng - bounds.west) / (bounds.east - bounds.west)));
  const v = Math.max(0, Math.min(1, (bounds.north - lat) / (bounds.north - bounds.south)));
  const fx = u * (width - 1);
  const fy = v * (height - 1);
  const c0 = Math.min(width - 1, Math.floor(fx));
  const c1 = Math.min(width - 1, c0 + 1);
  const r0 = Math.min(height - 1, Math.floor(fy));
  const r1 = Math.min(height - 1, r0 + 1);
  const tx = fx - c0;
  const ty = fy - r0;
  const h00 = sanitizeHeight(heightMap[r0 * width + c0]);
  const h10 = sanitizeHeight(heightMap[r0 * width + c1]);
  const h01 = sanitizeHeight(heightMap[r1 * width + c0]);
  const h11 = sanitizeHeight(heightMap[r1 * width + c1]);
  return (h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty) - minHeight;
}

/**
 * Convert a geographic point to BeamNG world-space coordinates.
 */
export function geoToWorldPoint(lat, lng, terrainData, squareSize, zOffset = 0) {
  const { bounds, width } = terrainData;
  const worldSize = width * squareSize;
  const u = Math.max(0, Math.min(1, (lng - bounds.west) / (bounds.east - bounds.west)));
  const v = Math.max(0, Math.min(1, (bounds.north - lat) / (bounds.north - bounds.south)));
  return [
    (u - 0.5) * worldSize,
    (0.5 - v) * worldSize,
    getTerrainHeightWorld(lat, lng, terrainData) + zOffset,
  ];
}

/**
 * Build a 3x3 Z-up rotation matrix from yaw radians.
 */
export function rotationMatrixFromYaw(yaw) {
  const c = roundTo(Math.cos(yaw), 6);
  const s = roundTo(Math.sin(yaw), 6);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/**
 * Point-in-polygon test in geographic coordinates using ray casting.
 */
export function pointInPolygonLatLng(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lng;
    const yi = ring[i].lat;
    const xj = ring[j].lng;
    const yj = ring[j].lat;
    const intersects = ((yi > point.lat) !== (yj > point.lat)) &&
      (point.lng < ((xj - xi) * (point.lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Point-in-polygon test in world XY coordinates using ray casting.
 */
export function pointInPolygonWorld(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && (x < (((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9)) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Deterministic string hash (FNV-1a style) used for pseudo-random seeding.
 */
export function hashString(value) {
  let hash = 2166136261;
  const input = String(value);
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Fast deterministic pseudo-random scalar in [0,1) from numeric seed.
 */
export function seededRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453123;
  return x - Math.floor(x);
}

/**
 * Downsample a polyline to at most maxPoints while preserving endpoints.
 */
export function simplifyPolyline(points, maxPoints = 80) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const out = [points[0]];
  const interior = points.length - 2;
  const targetInterior = Math.max(0, maxPoints - 2);
  const step = interior / Math.max(1, targetInterior);
  for (let i = 1; i <= targetInterior; i++) {
    out.push(points[Math.min(points.length - 2, Math.round(i * step))]);
  }
  out.push(points[points.length - 1]);
  return out;
}
