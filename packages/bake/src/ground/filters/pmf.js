// Progressive Morphological Filter (PMF) — bare-earth ground extraction.
//
// Distils a DTM (bare-earth drivable ground) from the DSM-derived height
// raster. The seed surface has tall "stalagmite" up-spikes where cells sampled
// buildings or trees; PMF strips those objects while preserving genuine terrain
// slope. It does so via grayscale morphological OPENING (erosion then dilation)
// over a window that grows geometrically — small windows shave thin clutter,
// large windows cut whole building footprints. A node is flagged as an object
// (and snapped to the opened surface) only when its drop exceeds an elevation
// threshold that itself scales with the window span and a slope tolerance, so
// real hillsides survive while objects do not.
//
// Ref: Zhang et al. (2003), "A progressive morphological filter for removing
// nonground measurements from airborne LIDAR data", IEEE TGRS 41(4).
//
// UNITS: every height in/out is in SCENE UNITS (× unitsPerMeter against any
// metre threshold). Output is a fresh, fully-finite Float32Array — field arrays
// are never mutated.

import { medianFilter, liftDownSpikes, windowNodes } from '../heightField.js';

export const meta = {
  id: 'pmf',
  label: 'PMF (morphological)',
  params: [
    { key: 'preMedian', label: 'Despike (median passes)', min: 0, max: 6, step: 1, default: 2 },
    { key: 'pitWidthM', label: 'Down-spike max width (m)', min: 0, max: 40, step: 1, default: 12 },
    { key: 'pitDropM', label: 'Down-spike min depth (m)', min: 0, max: 20, step: 0.5, default: 2 },
    { key: 'maxWindowM', label: 'Max window (m)', min: 10, max: 200, step: 5, default: 70 },
    { key: 'baseThreshM', label: 'Base threshold (m)', min: 0.1, max: 5, step: 0.1, default: 0.5 },
    { key: 'slope', label: 'Slope tolerance (m/m)', min: 0, max: 1, step: 0.02, default: 0.3 },
    { key: 'smoothIters', label: 'Smooth passes', min: 0, max: 6, step: 1, default: 2 },
  ],
};

// Read a param with a fallback to its meta default.
function param(params, key) {
  const desc = meta.params.find((p) => p.key === key);
  const fallback = desc ? desc.default : undefined;
  return params?.[key] ?? fallback;
}

// Clamp an index into [0, n-1] so border windows read the nearest in-bounds node.
const clampIdx = (i, n) => (i < 0 ? 0 : i > n - 1 ? n - 1 : i);

// Separable square min (erosion): min over rows, then min over cols → O(n·w).
function erode(src, nx, nz, w) {
  const tmp = new Float32Array(src.length);
  // horizontal pass: each node = min over [xi-w, xi+w]
  for (let zi = 0; zi < nz; zi++) {
    const row = zi * nx;
    for (let xi = 0; xi < nx; xi++) {
      let m = Infinity;
      for (let dx = -w; dx <= w; dx++) {
        const v = src[row + clampIdx(xi + dx, nx)];
        if (v < m) m = v;
      }
      tmp[row + xi] = m;
    }
  }
  // vertical pass: each node = min over [zi-w, zi+w]
  const out = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      let m = Infinity;
      for (let dz = -w; dz <= w; dz++) {
        const v = tmp[clampIdx(zi + dz, nz) * nx + xi];
        if (v < m) m = v;
      }
      out[zi * nx + xi] = m;
    }
  }
  return out;
}

// Separable square max (dilation): max over rows, then max over cols → O(n·w).
function dilate(src, nx, nz, w) {
  const tmp = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    const row = zi * nx;
    for (let xi = 0; xi < nx; xi++) {
      let m = -Infinity;
      for (let dx = -w; dx <= w; dx++) {
        const v = src[row + clampIdx(xi + dx, nx)];
        if (v > m) m = v;
      }
      tmp[row + xi] = m;
    }
  }
  const out = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      let m = -Infinity;
      for (let dz = -w; dz <= w; dz++) {
        const v = tmp[clampIdx(zi + dz, nz) * nx + xi];
        if (v > m) m = v;
      }
      out[zi * nx + xi] = m;
    }
  }
  return out;
}

// One 3×3 neighbour-average low-pass pass, index-clamped at borders.
function smoothOnce(src, nx, nz) {
  const out = new Float32Array(src.length);
  for (let zi = 0; zi < nz; zi++) {
    for (let xi = 0; xi < nx; xi++) {
      let sum = 0;
      let count = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += src[clampIdx(zi + dz, nz) * nx + clampIdx(xi + dx, nx)];
          count++;
        }
      }
      out[zi * nx + xi] = sum / count;
    }
  }
  return out;
}

/**
 * Run PMF over field.seed and return a bare-earth DTM (scene units).
 *
 * @param {import('../heightField.js').HeightField} field
 * @param {Object<string, number>} params
 * @returns {Float32Array}
 */
export function apply(field, params) {
  const { nx, nz, unitsPerMeter, cellSizeM } = field;
  const preMedian = param(params, 'preMedian');
  const pitWidthM = param(params, 'pitWidthM');
  const pitDropM = param(params, 'pitDropM');
  const maxWindowM = param(params, 'maxWindowM');
  const baseThreshM = param(params, 'baseThreshM');
  const slope = param(params, 'slope');
  const smoothIters = param(params, 'smoothIters');

  // Despike FIRST: the seed (per-cell min) carries salt-and-pepper needles.
  let surface = medianFilter(field.seed, nx, nz, 1, preMedian);

  // LIFT down-spikes before the opening: where Google's mesh sinks below the
  // street the min dives with it, and the opening's erosion would then smear
  // that pit across its window. Lift only narrow, deep pits — roads are left
  // alone (they're not pits).
  surface = liftDownSpikes(surface, nx, nz, windowNodes(field, pitWidthM), pitDropM * unitsPerMeter);

  // Progressive loop: window half-width grows 1, 2, 4, 8, … until the window
  // diameter in metres would exceed the largest object footprint we want to cut.
  for (let w = 1; (2 * w) * cellSizeM <= maxWindowM; w *= 2) {
    const opened = dilate(erode(surface, nx, nz, w), nx, nz, w);

    // Zhang elevation-difference threshold for this window, in metres → scene.
    const windowDiameterM = 2 * w * cellSizeM; // (2w+1 - 1) cells span
    const dhT = (baseThreshM + slope * windowDiameterM) * unitsPerMeter;

    // Flag objects: nodes that sit far above the opened (object-free) surface.
    for (let i = 0; i < surface.length; i++) {
      if (surface[i] - opened[i] > dhT) surface[i] = opened[i];
    }
  }

  // Light low-pass to erase residual stair-steps left by the openings.
  for (let s = 0; s < smoothIters; s++) {
    surface = smoothOnce(surface, nx, nz);
  }

  // Guarantee a finite result regardless of input pathologies.
  for (let i = 0; i < surface.length; i++) {
    if (!Number.isFinite(surface[i])) surface[i] = field.seed[i];
  }
  return surface;
}
