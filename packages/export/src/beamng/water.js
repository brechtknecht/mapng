/** @layer io */
// Inland water generation: WaterBlock/WaterPlane/River templates plus the
// best-fit-rectangle WaterBlock, sea-level plane, and waterway River builders.
// Pure compute, but tagged `io` because it depends on the io-layer flavor
// catalog (getWaterProfile) — that module carries a lazy material fetch, so a
// core file may not import it. (Lazy: these builders still run headless.)
// Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import { getWaterProfile } from '@mapng/bake/beamngFlavorCatalog';
import { clamp, roundTo } from './format.js';
import {
  geoToWorldPoint,
  getTerrainHeightWorld,
  isClosedRing,
  generatePersistentId,
  rotationMatrixFromYaw,
  simplifyPolyline,
} from './worldMath.js';

const WATERWAY_WIDTHS = {
  river: 26,
  canal: 14,
  stream: 8,
  drain: 4,
  ditch: 3,
};

const WATERWAY_DEPTHS = {
  river: 8,
  canal: 5,
  stream: 3,
  drain: 2,
  ditch: 1.5,
};


const WATER_BLOCK_TEMPLATE = {
  class: 'WaterBlock',
  Foam: [{}, {}],
  'Ripples (texture animation)': [
    { rippleDir: [0, 1], rippleMagnitude: 0.8, rippleSpeed: 0.001, rippleTexScale: [12, 12] },
    { rippleDir: [0, 1], rippleSpeed: 0.02, rippleTexScale: [6, 6] },
    { rippleDir: [0.7, -0.7], rippleMagnitude: 1, rippleSpeed: 0.02, rippleTexScale: [3, 3] },
  ],
  'Waves (vertex undulation)': [
    { waveDir: [0, 1], waveMagnitude: 0.2, waveSpeed: 1 },
    { waveDir: [0.707, 0.707], waveMagnitude: 0.2, waveSpeed: 1 },
    { waveDir: [0.5, 0.86], waveMagnitude: 0.2, waveSpeed: 1 },
  ],
  baseColor: [189, 253, 255, 255],
  cubemap: 'cubemap_italy_reflection',
  depthGradientMax: 30,
  depthGradientTex: '/levels/italy/art/water/depthcolor_ramp_italy_muddy.png',
  foamAmbientLerp: 1.29999995,
  foamMaxDepth: 0.150000006,
  foamRippleInfluence: 0.0149999997,
  foamTex: 'levels/italy/art/water/foam2.dds',
  fresnelBias: 0.2,
  fresnelPower: 20,
  fullReflect: false,
  gridElementSize: 1,
  gridSize: 1,
  overallRippleMagnitude: 0.2,
  overallWaveMagnitude: 0,
  reflectivity: 0.8,
  rippleTex: '/levels/italy/art/water/ripple.dds',
  specularPower: 200,
  waterFogDensity: 1,
  waterFogDensityOffset: 0.1,
  wetDarkening: 0.5,
  wetDepth: 0.2,
};

const WATER_PLANE_TEMPLATE = {
  class: 'WaterPlane',
  Foam: [
    { foamDir: [0, 1], foamSpeed: 0.01 },
    { foamDir: [0, -1], foamOpacity: 5, foamSpeed: 0.01, foamTexScale: [4, 4] },
  ],
  'Ripples (texture animation)': [
    { rippleDir: [0, -1], rippleMagnitude: 0.5, rippleSpeed: 0.008, rippleTexScale: [12, 12] },
    { rippleDir: [0.707, 0.707], rippleMagnitude: 0.5, rippleSpeed: 0.05, rippleTexScale: [2, 2] },
    { rippleDir: [-0.5, 0.86], rippleMagnitude: 0.35, rippleSpeed: 0.003, rippleTexScale: [120, 120] },
  ],
  'Waves (vertex undulation)': [
    { waveDir: [0, -1], waveMagnitude: 0.5, waveSpeed: 1 },
    { waveDir: [0.25, 0.2], waveMagnitude: 0.2, waveSpeed: 2 },
    { waveDir: [0.1, -0.7], waveMagnitude: 0.2, waveSpeed: 3 },
  ],
  baseColor: [253, 254, 254, 0],
  clarity: 0.25,
  depthGradientMax: 70,
  distortEndDist: 10,
  distortFullDepth: 5.5,
  distortStartDist: 0,
  foamAmbientLerp: 1,
  foamMaxDepth: 0.35,
  foamRippleInfluence: 0.005,
  fresnelBias: -0.1,
  fresnelPower: 0.8,
  gridSize: 100,
  overallFoamOpacity: 3.5,
  overallRippleMagnitude: 1,
  overallWaveMagnitude: 0.15,
  reflectDetailAdjust: 0,
  reflectMaxRateMs: 20,
  reflectivity: 0.2,
  specularPower: 210,
  underwaterColor: [60, 223, 254, 253],
  viscosity: 0.001,
  waterFogDensity: 0.8,
  waterFogDensityOffset: 0.1,
  wetDarkening: 0.15,
  wetDepth: 0.5,
};

const RIVER_TEMPLATE = {
  class: 'River',
  Foam: [{}, {}],
  'Ripples (texture animation)': [
    { rippleDir: [0, 1], rippleMagnitude: 1.5, rippleSpeed: 0.1, rippleTexScale: [2, 2] },
    { rippleDir: [0, 1], rippleMagnitude: 2, rippleSpeed: 0.2, rippleTexScale: [5, 5] },
    { rippleDir: [0.1, 0.9], rippleMagnitude: 1, rippleSpeed: 0.01, rippleTexScale: [20, 20] },
  ],
  'Waves (vertex undulation)': [
    { waveDir: [-0.5, 0.8], waveMagnitude: 0.2, waveSpeed: 2 },
    { waveDir: [0.1, -1.5], waveMagnitude: 0.2, waveSpeed: 2 },
    { waveDir: [0.1, 0.5], waveMagnitude: 0.2, waveSpeed: 3 },
  ],
  baseColor: [254, 220, 165, 255],
  cubemap: 'cubemap_ocean_reflection',
  depthGradientMax: 20,
  depthGradientTex: 'levels/italy/art/water/depthcolor_ramp_italy_rivers.png',
  flowMagnitudePhysics: 4,
  foamMaxDepth: 1,
  foamRippleInfluence: 0.09,
  foamTex: 'core/art/water/foam.dds',
  fresnelBias: 0.5,
  fresnelPower: 5,
  fullReflect: false,
  lowLODDistance: 150,
  overallFoamOpacity: 3,
  overallRippleMagnitude: 1.2,
  overallWaveMagnitude: 0.5,
  reflectDetailAdjust: -2,
  reflectMaxRateMs: 10,
  reflectivity: 0.3,
  rippleTex: 'levels/italy/art/water/ripple3.dds',
  subdivideLength: 2,
  underwaterColor: [254, 253, 252, 250],
  waterFogDensity: 0.8,
  waterFogDensityOffset: 0,
  wetDarkening: 0.3,
  wetDepth: 0.35,
};

/**
 * Exclude ocean/marina-like water features from inland water generation.
 */
export function isExcludedWaterFeature(tags = {}) {
  return (
    tags.place === 'sea' ||
    tags.place === 'ocean' ||
    tags.natural === 'bay' ||
    tags.water === 'dock' ||
    tags.water === 'harbour' ||
    tags.harbour === 'yes' ||
    tags.leisure === 'marina'
  );
}

/**
 * Return percentile value from an ascending-sorted numeric array.
 */
export function percentileValue(sortedValues, fraction) {
  if (!sortedValues.length) return 0;
  const idx = clamp(Math.floor((sortedValues.length - 1) * fraction), 0, sortedValues.length - 1);
  return sortedValues[idx];
}

/**
 * Compute a minimum-area oriented rectangle fit for polygon world points.
 *
 * Used to place WaterBlock primitives that best match OSM polygon footprint.
 */
export function computeBestFitWaterBlock(worldPoints) {
  let cx = 0;
  let cy = 0;
  for (const pt of worldPoints) {
    cx += pt[0];
    cy += pt[1];
  }
  cx /= worldPoints.length;
  cy /= worldPoints.length;

  let best = null;
  for (let i = 0; i < worldPoints.length; i++) {
    const a = worldPoints[i];
    const b = worldPoints[(i + 1) % worldPoints.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-6) continue;

    const yaw = Math.atan2(dy, dx);
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const pt of worldPoints) {
      const relX = pt[0] - cx;
      const relY = pt[1] - cy;
      const rx = relX * cos + relY * sin;
      const ry = -relX * sin + relY * cos;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      minY = Math.min(minY, ry);
      maxY = Math.max(maxY, ry);
    }

    const width = maxX - minX;
    const length = maxY - minY;
    const area = width * length;
    if (!best || area < best.area) {
      best = { yaw, width, length, area };
    }
  }

  if (best) return { cx, cy, ...best };

  return { cx, cy, yaw: 0, width: 4, length: 4, area: 16 };
}

/**
 * Build WaterBlock objects for closed inland water polygons.
 */
export function buildWaterBlockObjects(terrainData, squareSize, flavor) {
  const waterProfile = getWaterProfile(flavor);
  const features = terrainData.osmFeatures?.filter((feature) => {
    if (feature.type !== 'water') return false;
    if (!Array.isArray(feature.geometry) || feature.geometry.length < 4) return false;
    if (!isClosedRing(feature.geometry)) return false;
    if (feature.tags?.waterway) return false;
    return !isExcludedWaterFeature(feature.tags);
  }) ?? [];

  return features.map((feature, index) => {
    const ring = feature.geometry.slice(0, -1);
    const worldPoints = ring.map((pt) => geoToWorldPoint(pt.lat, pt.lng, terrainData, squareSize, 0));
    const fit = computeBestFitWaterBlock(worldPoints);
    const rawWidth = Math.max(4, fit.width);
    const rawLength = Math.max(4, fit.length);
    const pad = clamp(Math.min(rawWidth, rawLength) * 0.092, 1.5, 6.9);
    const width = rawWidth + (pad * 2);
    const length = rawLength + (pad * 2);
    const height = Math.max(1.5, Math.min(width, length) * 0.08);
    const ringHeights = ring.map((pt) => getTerrainHeightWorld(pt.lat, pt.lng, terrainData));
    ringHeights.sort((a, b) => a - b);
    const surfaceElevation = percentileValue(ringHeights, 0.8) + 0.14;

    return {
      ...structuredClone(WATER_BLOCK_TEMPLATE),
      cubemap: waterProfile.waterCubemap,
      depthGradientTex: waterProfile.waterDepthGradientTex,
      foamTex: waterProfile.waterFoamTex,
      rippleTex: waterProfile.waterRippleTex,
      name: `water_body_${index}`,
      persistentId: generatePersistentId(),
      __parent: 'Water',
      position: [roundTo(fit.cx, 3), roundTo(fit.cy, 3), roundTo(surfaceElevation, 3)],
      rotationMatrix: rotationMatrixFromYaw(fit.yaw),
      scale: [roundTo(width, 3), roundTo(length, 3), roundTo(height, 3)],
    };
  });
}

/**
 * Build one sea-level WaterPlane spanning the exported level.
 */
export function buildSeaLevelWaterPlane(terrainData, flavor) {
  const waterProfile = getWaterProfile(flavor);
  const minHeight = Number(terrainData?.minHeight);
  // Terrain world-space Z is stored relative to min elevation, so sea level (0m)
  // sits at -minHeight in exported level coordinates.
  const seaLevelZ = Number.isFinite(minHeight) ? -minHeight : 0;
  return {
    ...structuredClone(WATER_PLANE_TEMPLATE),
    cubemap: waterProfile.waterCubemap,
    depthGradientTex: waterProfile.waterDepthGradientTex,
    foamTex: waterProfile.waterFoamTex,
    rippleTex: waterProfile.waterRippleTex,
    name: 'ocean',
    persistentId: generatePersistentId(),
    __parent: 'Water',
    position: [0, 0, roundTo(seaLevelZ, 3)],
  };
}

/**
 * Apply a simple 3-point moving average to a height sequence.
 */
export function smoothHeights(heights) {
  if (heights.length < 3) return heights;
  const out = heights.slice();
  for (let i = 1; i < heights.length - 1; i++) {
    out[i] = (heights[i - 1] + heights[i] + heights[i + 1]) / 3;
  }
  return out;
}

/**
 * Parse a numeric width token (with optional units) or return fallback.
 */
export function parseNumericWidth(value, fallback) {
  if (value == null) return fallback;
  const match = String(value).match(/[\d.]+/);
  const parsed = match ? parseFloat(match[0]) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build River objects for linear waterway OSM features.
 */
export function buildRiverObjects(terrainData, squareSize, flavor) {
  const waterProfile = getWaterProfile(flavor);
  const features = terrainData.osmFeatures?.filter((feature) => {
    if (feature.type !== 'water') return false;
    if (!Array.isArray(feature.geometry) || feature.geometry.length < 2) return false;
    if (isClosedRing(feature.geometry)) return false;
    if (!feature.tags?.waterway) return false;
    return !isExcludedWaterFeature(feature.tags);
  }) ?? [];

  return features.map((feature, index) => {
    const geom = simplifyPolyline(feature.geometry, 72);
    const fallbackWidth = WATERWAY_WIDTHS[feature.tags.waterway] ?? 10;
    const width = Math.max(3, parseNumericWidth(feature.tags.width, fallbackWidth));
    const depth = Math.max(1.5, WATERWAY_DEPTHS[feature.tags.waterway] ?? Math.max(2, width * 0.25));
    const worldPts = geom.map((pt) => geoToWorldPoint(pt.lat, pt.lng, terrainData, squareSize, 0));
    const heights = smoothHeights(worldPts.map((pt) => pt[2] + 0.9));
    const nodes = worldPts.map((pt, ptIndex) => ([
      roundTo(pt[0], 3),
      roundTo(pt[1], 3),
      roundTo(heights[ptIndex], 3),
      roundTo(width, 3),
      roundTo(depth, 3),
      0,
      0,
      1,
    ]));
    return {
      ...structuredClone(RIVER_TEMPLATE),
      cubemap: waterProfile.riverCubemap,
      depthGradientTex: waterProfile.riverDepthGradientTex,
      rippleTex: waterProfile.riverRippleTex,
      name: `waterway_${index}`,
      persistentId: generatePersistentId(),
      __parent: 'Water',
      position: nodes.length > 0 ? nodes[0].slice(0, 3) : [0, 0, 0],
      nodes,
    };
  }).filter((river) => river.nodes.length >= 2);
}
