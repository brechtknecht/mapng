/** @layer core */
// Shared scene-space projection + height sampling for the 3D exporters.
// Owns the per-dataset projection cache (keyed by bounds+size) so every
// scene3d module samples the same metric grid. SCENE_SIZE is the canonical
// edge length of a tile in scene units.
import * as THREE from "three";
import { createMetricProjector } from '@mapng/geo';

// --- Constants & Helpers ---
export const SCENE_SIZE = 100;

// Cached per-dataset projection and constants to avoid recomputation
let _cachedDataId = null;
let _cachedProjector = null;
let _cachedUnitsPerMeter = 0;
let _cachedMinHeight = 0;
let _cachedWidth = 0;
let _cachedHeight = 0;
let _cachedHeightMap = null;

export const ensureCache = (data) => {
  // Use bounds as identity — same bounds = same projection
  const dataId = `${data.bounds.north},${data.bounds.south},${data.bounds.east},${data.bounds.west},${data.width},${data.height}`;
  if (_cachedDataId !== dataId) {
    _cachedDataId = dataId;
    _cachedProjector = createMetricProjector(data.bounds, data.width, data.height);
    const latRad = (((data.bounds.north + data.bounds.south) / 2) * Math.PI) / 180;
    const metersPerDegree = 111320 * Math.cos(latRad);
    const realWidthMeters = (data.bounds.east - data.bounds.west) * metersPerDegree;
    _cachedUnitsPerMeter = SCENE_SIZE / realWidthMeters;
    _cachedMinHeight = data.minHeight;
    _cachedWidth = data.width;
    _cachedHeight = data.height;
    _cachedHeightMap = data.heightMap;
  }
};

// Expose the cached units-per-meter for callers that build geometry off it
// (road/barrier widths, corridor half-width). Always call ensureCache() first.
export const getCachedUnitsPerMeter = () => _cachedUnitsPerMeter;

export const getTerrainHeight = (data, lat, lng) => {
  const scenePos = latLngToScene(data, lat, lng);
  return getHeightAtScenePos(data, scenePos.x, scenePos.z);
};

export const latLngToScene = (data, lat, lng) => {
  ensureCache(data);
  const p = _cachedProjector(lat, lng);

  const u = p.x / (_cachedWidth - 1);
  const v = p.y / (_cachedHeight - 1);

  const sceneX = u * SCENE_SIZE - SCENE_SIZE / 2;
  const sceneZ = v * SCENE_SIZE - SCENE_SIZE / 2;

  return new THREE.Vector3(sceneX, 0, sceneZ);
};

// Reusable Vector3 for latLngToScene when caller only needs x/z
const _tmpSceneVec = new THREE.Vector3();
export const latLngToSceneFast = (data, lat, lng) => {
  ensureCache(data);
  const p = _cachedProjector(lat, lng);
  const u = p.x / (_cachedWidth - 1);
  const v = p.y / (_cachedHeight - 1);
  _tmpSceneVec.x = u * SCENE_SIZE - SCENE_SIZE / 2;
  _tmpSceneVec.y = 0;
  _tmpSceneVec.z = v * SCENE_SIZE - SCENE_SIZE / 2;
  return _tmpSceneVec;
};

// Helper to get height from scene coordinates — uses cached constants
export const getHeightAtScenePos = (data, x, z) => {
  ensureCache(data);
  const half = SCENE_SIZE / 2;
  // Ensure we are exactly on or inside the boundary for sampling.
  const u = Math.max(0, Math.min(1, (x + half) / SCENE_SIZE));
  const v = Math.max(0, Math.min(1, (z + half) / SCENE_SIZE));

  const localX = u * (_cachedWidth - 1);
  const localZ = v * (_cachedHeight - 1);

  const x0 = Math.floor(localX);
  const x1 = Math.min(x0 + 1, _cachedWidth - 1);
  const y0 = Math.floor(localZ);
  const y1 = Math.min(y0 + 1, _cachedHeight - 1);

  const wx = localX - x0;
  const wy = localZ - y0;

  const hm = _cachedHeightMap;
  const w = _cachedWidth;
  const minH = _cachedMinHeight;

  const i00 = y0 * w + x0;
  const i10 = y0 * w + x1;
  const i01 = y1 * w + x0;
  const i11 = y1 * w + x1;

  const h00 = hm[i00] < -10000 ? minH : hm[i00];
  const h10 = hm[i10] < -10000 ? minH : hm[i10];
  const h01 = hm[i01] < -10000 ? minH : hm[i01];
  const h11 = hm[i11] < -10000 ? minH : hm[i11];

  const h = (1 - wy) * ((1 - wx) * h00 + wx * h10) + wy * ((1 - wx) * h01 + wx * h11);

  return (h - minH) * _cachedUnitsPerMeter;
};
