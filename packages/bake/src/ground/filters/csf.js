// Cloth Simulation Filter (CSF) — bare-earth ground extraction.
//
// Distils a DTM (bare-earth drivable ground) from the DSM-derived height
// raster. The seed surface has tall "stalagmite" up-spikes where cells sampled
// buildings or trees. CSF works by INVERTING the surface (so objects now point
// DOWN and the ground points UP), then dropping a virtual cloth onto it from
// above: the cloth settles on the now-upward ground and drapes over the pits
// left by inverted objects. An internal rigidness constraint keeps the cloth
// stiff enough to bridge small spikes/noise instead of dipping into them. The
// settled cloth, INVERTED BACK, is the smooth ground. invert → drape → invert.
//
// Ref: Zhang et al. (2016), "An Easy-to-Use Airborne LiDAR Data Filtering
// Method Based on Cloth Simulation", Remote Sensing 8(6):501.
//
// One cloth particle per grid node (cloth resolution = grid resolution). UNITS:
// every height in/out is in SCENE UNITS (× unitsPerMeter against any metre
// value). Output is a fresh, fully-finite Float32Array — field arrays are never
// mutated.

import { medianFilter, liftDownSpikes, windowNodes } from '../heightField.js';

export const meta = {
  id: 'csf',
  label: 'Cloth simulation',
  params: [
    { key: 'preMedian', label: 'Despike (median passes)', min: 0, max: 6, step: 1, default: 2 },
    { key: 'pitWidthM', label: 'Down-spike max width (m)', min: 0, max: 40, step: 1, default: 12 },
    { key: 'pitDropM', label: 'Down-spike min depth (m)', min: 0, max: 20, step: 0.5, default: 2 },
    { key: 'iterations', label: 'Iterations', min: 20, max: 600, step: 10, default: 200 },
    { key: 'rigidness', label: 'Rigidness (stiffness)', min: 1, max: 6, step: 1, default: 3 },
    { key: 'stepM', label: 'Step per iter (m)', min: 0.05, max: 2, step: 0.05, default: 0.5 },
    { key: 'postSmooth', label: 'Post smooth passes', min: 0, max: 4, step: 1, default: 1 },
  ],
};

// Read a param with a fallback to its meta default.
function param(params, key) {
  const desc = meta.params.find((p) => p.key === key);
  const fallback = desc ? desc.default : undefined;
  return params?.[key] ?? fallback;
}

// Clamp an index into [0, n-1] so border nodes read the nearest in-bounds node.
const clampIdx = (i, n) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

/**
 * Run CSF over field.seed and return a bare-earth DTM (scene units).
 *
 * @param {import('../heightField.js').HeightField} field
 * @param {Object<string, number>} params
 * @returns {Float32Array}
 */
export function apply(field, params) {
  const { nx, nz, unitsPerMeter } = field;
  const preMedian = param(params, 'preMedian');
  const pitWidthM = param(params, 'pitWidthM');
  const pitDropM = param(params, 'pitDropM');
  const iterations = param(params, 'iterations');
  const rigidness = param(params, 'rigidness');
  const stepM = param(params, 'stepM');
  const postSmooth = param(params, 'postSmooth');

  const n = nx * nz;
  const step = stepM * unitsPerMeter; // downward move per iteration, scene units
  const eps = 1e-4 * unitsPerMeter; // contact tolerance, scene units

  // Clean the seed BEFORE draping: median kills isolated needles, then lift the
  // down-spikes where Google's mesh sinks below the street — otherwise the cloth
  // settles into those pits (it always seeks the lowest surface) and the .ter
  // dives into the floor. Roads aren't pits, so they're left alone.
  let seed = medianFilter(field.seed, nx, nz, 1, preMedian);
  seed = liftDownSpikes(seed, nx, nz, windowNodes(field, pitWidthM), pitDropM * unitsPerMeter);

  // 1. Invert the target surface: buildings/trees now point DOWN, ground is UP.
  const inv = new Float32Array(n);
  let invMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = -seed[i];
    inv[i] = v;
    if (v > invMax) invMax = v;
  }
  if (!Number.isFinite(invMax)) invMax = 0;

  // 2. Cloth starts as a flat sheet above everything (small margin in scene units).
  const margin = step * 2 + eps;
  const z = new Float32Array(n);
  const pinned = new Uint8Array(n); // 1 once a particle has contacted the surface
  z.fill(invMax + margin);

  // 3. Simulate: gravity drops the cloth, collision pins it on the inverted
  //    surface, and rigidness passes keep it stiff so it bridges narrow spikes.
  for (let it = 0; it < iterations; it++) {
    // a. Gravity: free particles fall by one step.
    for (let i = 0; i < n; i++) {
      if (!pinned[i]) z[i] -= step;
    }
    // b. Collision: a particle cannot sink below the inverted surface; pin it
    //    once it has reached/contacted the ground.
    for (let i = 0; i < n; i++) {
      if (z[i] <= inv[i] + eps) {
        z[i] = inv[i];
        pinned[i] = 1;
      }
    }
    // c. Internal rigidness: pull each free particle toward its 4-neighbour
    //    mean; pinned particles are immovable anchors. Re-clamp after each pass.
    for (let r = 0; r < rigidness; r++) {
      for (let zi = 0; zi < nz; zi++) {
        const row = zi * nx;
        const up = clampIdx(zi - 1, nz) * nx;
        const dn = clampIdx(zi + 1, nz) * nx;
        for (let xi = 0; xi < nx; xi++) {
          const i = row + xi;
          if (pinned[i]) continue;
          const xl = clampIdx(xi - 1, nx);
          const xr = clampIdx(xi + 1, nx);
          const avg = 0.25 * (z[row + xl] + z[row + xr] + z[up + xi] + z[dn + xi]);
          // Stiffer-than-spring move straight to the neighbour mean.
          let zv = avg;
          // Re-apply collision so smoothing never pushes below the surface.
          if (zv <= inv[i] + eps) {
            zv = inv[i];
            pinned[i] = 1;
          }
          z[i] = zv;
        }
      }
    }
  }

  // 4. Invert back: settled cloth becomes the ground surface.
  let result = new Float32Array(n);
  for (let i = 0; i < n; i++) result[i] = -z[i];

  // 5. Optional light 3×3 low-pass for cleanliness, index-clamped at borders.
  for (let s = 0; s < postSmooth; s++) {
    result = smoothOnce(result, nx, nz);
  }

  // 6. Guarantee a finite result regardless of input pathologies.
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(result[i])) result[i] = seed[i];
  }
  return result;
}

// One 3×3 neighbour-average low-pass pass, index-clamped at borders.
function smoothOnce(src, nx, nz) {
  const out = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const row = clampIdx(zi + dz, nz) * nx;
        for (let dx = -1; dx <= 1; dx++) {
          sum += src[row + clampIdx(xi + dx, nx)];
          count++;
        }
      }
      out[zi * nx + xi] = sum / count;
    }
  }
  return out;
}
