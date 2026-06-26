// Bilateral smooth — EDGE-PRESERVING post-processor. Smooths flat road surfaces
// while keeping building walls / curbs / elevation steps sharp, so buildings
// DON'T bleed into the street (the inverse failure of a plain Gaussian blur).
//
// Each cell is a weighted average of its neighbours, where the weight is the
// product of two Gaussians: a SPATIAL one (closer neighbours count more) and a
// RANGE one (neighbours at a SIMILAR height count more). A building next to the
// road differs in height by far more than `edgeM`, so its range weight collapses
// to ~0 and it never pulls the road up.
//
// Post-processor contract: apply(heights, field, params) -> Float32Array.
const clampIdx = (i, n) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

export const meta = {
  id: 'bilateral',
  label: 'Bilateral (edge-preserving)',
  params: [
    { key: 'radiusM', label: 'Radius (m)', short: 'radius', min: 1, max: 20, step: 0.5, default: 6 },
    { key: 'edgeM', label: 'Edge keep (m)', short: 'edge', min: 0.2, max: 10, step: 0.1, default: 1.5 },
    { key: 'passes', label: 'Passes', short: 'passes', min: 1, max: 4, step: 1, default: 1 },
    { key: 'strength', label: 'Strength (mix)', short: 'mix', min: 0, max: 1, step: 0.05, default: 1 },
  ],
};

function param(params, key) {
  const d = meta.params.find((p) => p.key === key);
  return params?.[key] ?? (d ? d.default : undefined);
}

/**
 * @param {Float32Array} heights  source ground (scene units)
 * @param {import('../heightField.js').HeightField} field
 * @param {Object<string, number>} params
 * @returns {Float32Array} edge-preserving-smoothed heights (heights never mutated)
 */
export function apply(heights, field, params) {
  const { nx, nz, cellSizeM, unitsPerMeter } = field;
  const radiusM = param(params, 'radiusM');
  const edgeM = param(params, 'edgeM');
  const passes = param(params, 'passes');
  const strength = param(params, 'strength');

  const r = Math.max(1, Math.round(radiusM / cellSizeM)); // window half-width, nodes
  if (strength <= 0) return Float32Array.from(heights);

  const sigmaS = Math.max(r / 2, 0.5);
  const sigmaR = Math.max(edgeM * unitsPerMeter, 1e-4); // height tolerance, scene units
  const twoSs2 = 2 * sigmaS * sigmaS;
  const twoSr2 = 2 * sigmaR * sigmaR;

  // Precompute the spatial-weight kernel (depends only on the offset).
  const win = 2 * r + 1;
  const spatial = new Float32Array(win * win);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      spatial[(dz + r) * win + (dx + r)] = Math.exp(-(dx * dx + dz * dz) / twoSs2);
    }
  }

  let cur = Float32Array.from(heights);
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(cur.length);
    for (let zi = 0; zi < nz; zi++) {
      for (let xi = 0; xi < nx; xi++) {
        const hc = cur[zi * nx + xi];
        let sum = 0;
        let wsum = 0;
        for (let dz = -r; dz <= r; dz++) {
          const zz = clampIdx(zi + dz, nz) * nx;
          const srow = (dz + r) * win + r;
          for (let dx = -r; dx <= r; dx++) {
            const hq = cur[zz + clampIdx(xi + dx, nx)];
            const dh = hq - hc;
            const w = spatial[srow + dx] * Math.exp(-(dh * dh) / twoSr2);
            sum += w * hq;
            wsum += w;
          }
        }
        out[zi * nx + xi] = wsum > 0 ? sum / wsum : hc;
      }
    }
    cur = out;
  }

  if (strength >= 1) return cur;
  const mixed = new Float32Array(heights.length);
  for (let i = 0; i < heights.length; i++) mixed[i] = heights[i] + strength * (cur[i] - heights[i]);
  return mixed;
}
