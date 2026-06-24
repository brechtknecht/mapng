/** @layer core */
// Pure tile-math + static position tables for the surrounding-tiles backdrop
// generator (refactor doc 06 step 7). No DOM/network — moved verbatim from
// surroundingTiles.js.

export const NO_DATA_VALUE = -99999;

// Position definitions with lat/lng offset multipliers
// dLat: +1 = north, -1 = south
// dLng: +1 = east,  -1 = west
export const POSITIONS = [
  { key: 'NW', label: '1', dLat: +1, dLng: -1 },
  { key: 'N',  label: '2', dLat: +1, dLng:  0 },
  { key: 'NE', label: '3', dLat: +1, dLng: +1 },
  { key: 'W',  label: '4', dLat:  0, dLng: -1 },
  { key: 'E',  label: '5', dLat:  0, dLng: +1 },
  { key: 'SW', label: '6', dLat: -1, dLng: -1 },
  { key: 'S',  label: '7', dLat: -1, dLng:  0 },
  { key: 'SE', label: '8', dLat: -1, dLng: +1 },
];

// Grid layout order (for rendering the 3×3 UI grid)
export const GRID_ORDER = ['NW', 'N', 'NE', 'W', 'CENTER', 'E', 'SW', 'S', 'SE'];

// Satellite quality presets
export const SATELLITE_QUALITY = [
  { value: 13, label: 'Low',      desc: '~19m/px, fastest' },
  { value: 14, label: 'Medium',   desc: '~10m/px, balanced' },
  { value: 15, label: 'Standard', desc: '~5m/px, best quality' },
];

// Number → compass label map
export const POSITION_LABELS = {
  NW: '1', N: '2', NE: '3',
  W:  '4',          E:  '5',
  SW: '6', S: '7', SE: '8',
};

/**
 * Compute adjacent tile bounds by shifting center bounds.
 */
export const getAdjacentBounds = (centerBounds, positionKey) => {
  const pos = POSITIONS.find(p => p.key === positionKey);
  if (!pos) throw new Error(`Invalid position: ${positionKey}`);

  const latSpan = centerBounds.north - centerBounds.south;
  const lngSpan = centerBounds.east - centerBounds.west;

  return {
    north: centerBounds.north + pos.dLat * latSpan,
    south: centerBounds.south + pos.dLat * latSpan,
    east:  centerBounds.east  + pos.dLng * lngSpan,
    west:  centerBounds.west  + pos.dLng * lngSpan,
  };
};

/**
 * Decode Terrarium-encoded RGB pixel to elevation in meters.
 * Mapzen/Terrarium encoding: height = R*256 + G + B/256 - 32768
 */
export const terrariumHeight = (r, g, b) => {
  const h = r * 256 + g + b / 256 - 32768;
  return h <= -32760 ? NO_DATA_VALUE : h;
};

/**
 * Suppress isolated elevation outliers that can appear in global Terrarium data
 * and produce extreme spikes in low-detail backdrop meshes.
 *
 * Strategy: compare each sample to the median of its 8-neighbour hood and
 * replace only when the deviation is implausibly large.
 */
export const suppressHeightSpikes = (heightMap, width, height) => {
  if (!heightMap || width < 3 || height < 3) return 0;

  const out = new Float32Array(heightMap);
  const neighbors = new Float32Array(8);
  let replaced = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const value = heightMap[idx];
      if (!Number.isFinite(value) || value === NO_DATA_VALUE) continue;

      let count = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const n = heightMap[(y + oy) * width + (x + ox)];
          if (!Number.isFinite(n) || n === NO_DATA_VALUE) continue;
          neighbors[count++] = n;
        }
      }

      if (count < 5) continue;

      const sorted = Array.from(neighbors.subarray(0, count)).sort((a, b) => a - b);
      const median = sorted[Math.floor(count / 2)];

      // Robust local spread estimate (median absolute deviation).
      const deviations = sorted.map((n) => Math.abs(n - median)).sort((a, b) => a - b);
      const mad = deviations[Math.floor(deviations.length / 2)] || 0;
      // Aggressive enough for single-pixel Terrarium speckles while still
      // preserving meaningful local relief in backdrop tiles.
      const robustDelta = Math.max(8, mad * 6);

      // Hard sanity limits for obvious decode artifacts.
      const isAbsurd = value > 12000 || value < -12000;
      if (isAbsurd || Math.abs(value - median) > robustDelta) {
        out[idx] = median;
        replaced++;
      }
    }
  }

  if (replaced > 0) {
    heightMap.set(out);
  }
  return replaced;
};

export const recomputeMinMax = (heightMap) => {
  let minH = Infinity;
  let maxH = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    const v = heightMap[i];
    if (!Number.isFinite(v) || v === NO_DATA_VALUE) continue;
    if (v < minH) minH = v;
    if (v > maxH) maxH = v;
  }
  if (minH === Infinity) minH = 0;
  if (maxH === -Infinity) maxH = minH;
  return { minH, maxH };
};
