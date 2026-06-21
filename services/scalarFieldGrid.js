// Generic 2D scalar field over the Google-bake scene plane (X/Z in scene units,
// [-SCENE_SIZE/2, +SCENE_SIZE/2]). Built from scattered samples: each cell keeps
// the MEDIAN of the values that fall in it (robust to photogrammetry outliers),
// empty cells are inpainted from the nearest filled neighbours, the result is
// box-blurred, and reads are bilinear with edge clamping.
//
// DOM-free and dependency-free so it unit-tests in plain Node and runs identically
// in the browser bake and the headless worker. The tile-ground conform
// (tileGroundConform.js) is the only consumer today, but nothing here knows about
// tiles — it is a plain scattered-data → smooth-field resampler.

import { SCENE_SIZE } from './googleBakeCore.js';

const HALF = SCENE_SIZE / 2;

const median = (arr) => {
  arr.sort((a, b) => a - b);
  const n = arr.length;
  const mid = n >> 1;
  return n % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
};

/**
 * @param {object} opts
 * @param {number} [opts.cellM=8]  cell size in METRES; converted to scene units
 *   via unitsPerMeter so the grid is metrically square regardless of AOI size.
 * @param {number} opts.unitsPerMeter  scene units per metre (computeUnitsPerMeter).
 * @returns accumulator: { add(x, z, value), build(buildOpts), cellsPerSide }
 */
export const createScalarFieldGrid = ({ cellM = 8, unitsPerMeter } = {}) => {
  if (!unitsPerMeter || !Number.isFinite(unitsPerMeter)) {
    throw new Error('createScalarFieldGrid: unitsPerMeter required');
  }
  const cellScene = cellM * unitsPerMeter;
  const cellsPerSide = Math.max(1, Math.round(SCENE_SIZE / cellScene));
  const n = cellsPerSide;

  // Per-cell sample buckets (lazily allocated — most cells stay empty).
  const buckets = new Array(n * n).fill(null);

  const cellIndex = (x, z) => {
    const cx = Math.min(n - 1, Math.max(0, Math.floor(((x + HALF) / SCENE_SIZE) * n)));
    const cz = Math.min(n - 1, Math.max(0, Math.floor(((z + HALF) / SCENE_SIZE) * n)));
    return cz * n + cx;
  };

  const add = (x, z, value) => {
    if (!Number.isFinite(value)) return;
    const i = cellIndex(x, z);
    (buckets[i] ?? (buckets[i] = [])).push(value);
  };

  /**
   * Collapse buckets → per-cell median, inpaint empties from nearest filled
   * cells (iterative dilation), box-blur, and return a bilinear sampler.
   * @param {object} buildOpts
   * @param {number} [buildOpts.smoothPasses=2] box-blur passes (radius 1 each).
   * @param {number} [buildOpts.fallback=0] value when the grid had no samples at all.
   */
  const build = ({ smoothPasses = 2, fallback = 0 } = {}) => {
    const values = new Float32Array(n * n);
    const filled = new Uint8Array(n * n);
    let filledCount = 0;
    for (let i = 0; i < n * n; i++) {
      const b = buckets[i];
      if (b && b.length) {
        values[i] = median(b);
        filled[i] = 1;
        filledCount++;
      }
    }

    if (filledCount === 0) {
      // No ground samples anywhere — degrade to a constant field.
      values.fill(fallback);
    } else {
      inpaint(values, filled, n);
      for (let p = 0; p < smoothPasses; p++) boxBlur(values, n);
    }

    const sample = (x, z) => {
      // Map scene XZ to cell-centre grid coordinates, then bilinear with clamp.
      const gx = ((x + HALF) / SCENE_SIZE) * n - 0.5;
      const gz = ((z + HALF) / SCENE_SIZE) * n - 0.5;
      const x0 = Math.min(n - 1, Math.max(0, Math.floor(gx)));
      const z0 = Math.min(n - 1, Math.max(0, Math.floor(gz)));
      const x1 = Math.min(n - 1, x0 + 1);
      const z1 = Math.min(n - 1, z0 + 1);
      const tx = Math.min(1, Math.max(0, gx - x0));
      const tz = Math.min(1, Math.max(0, gz - z0));
      const v00 = values[z0 * n + x0];
      const v10 = values[z0 * n + x1];
      const v01 = values[z1 * n + x0];
      const v11 = values[z1 * n + x1];
      return (
        v00 * (1 - tx) * (1 - tz) +
        v10 * tx * (1 - tz) +
        v01 * (1 - tx) * tz +
        v11 * tx * tz
      );
    };

    return { sample, values, cellsPerSide: n, filledCount };
  };

  return { add, build, cellsPerSide: n };
};

// Iterative nearest-filled dilation: repeatedly average each empty cell from its
// already-filled 4-neighbours until none remain. Cheap and artefact-free for the
// sparse holes a ground field leaves (interiors of buildings, water).
function inpaint(values, filled, n) {
  const work = filled.slice();
  let remaining = 0;
  for (let i = 0; i < n * n; i++) if (!work[i]) remaining++;
  let guard = n * 2 + 4; // worst-case dilation distance + slack
  while (remaining > 0 && guard-- > 0) {
    const nextFilled = work.slice();
    const nextVals = values.slice();
    for (let z = 0; z < n; z++) {
      for (let x = 0; x < n; x++) {
        const i = z * n + x;
        if (work[i]) continue;
        let sum = 0, cnt = 0;
        if (x > 0 && work[i - 1]) { sum += values[i - 1]; cnt++; }
        if (x < n - 1 && work[i + 1]) { sum += values[i + 1]; cnt++; }
        if (z > 0 && work[i - n]) { sum += values[i - n]; cnt++; }
        if (z < n - 1 && work[i + n]) { sum += values[i + n]; cnt++; }
        if (cnt) {
          nextVals[i] = sum / cnt;
          nextFilled[i] = 1;
          remaining--;
        }
      }
    }
    work.set(nextFilled);
    values.set(nextVals);
  }
}

// Separable-ish 3x3 box blur, edge-clamped, one pass.
function boxBlur(values, n) {
  const src = values.slice();
  const at = (x, z) => src[Math.min(n - 1, Math.max(0, z)) * n + Math.min(n - 1, Math.max(0, x))];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) sum += at(x + dx, z + dz);
      }
      values[z * n + x] = sum / 9;
    }
  }
}
