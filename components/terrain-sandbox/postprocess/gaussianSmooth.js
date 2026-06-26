// Gaussian-smooth post-processor — evens out residual little spikes/steps in an
// already-extracted ground, the way a Gaussian blur smooths a 2D image. Runs on
// the OUTPUT heights of any pane (post-process), not on the raw field.
//
// Post-processor contract (mirrors the filters' { meta, apply }, but apply takes
// the heights to transform):
//   apply(heights, field, params) -> Float32Array   (scene units; heights untouched)
import { gaussianBlur } from '../groundRaster.js';

export const meta = {
  id: 'gaussian',
  label: 'Gaussian smooth',
  params: [
    { key: 'radiusM', label: 'Blur radius (m)', short: 'radius', min: 0, max: 30, step: 0.5, default: 4 },
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
 * @param {import('../groundRaster.js').HeightField} field
 * @param {Object<string, number>} params
 * @returns {Float32Array} smoothed heights (scene units), heights never mutated
 */
export function apply(heights, field, params) {
  const radiusM = param(params, 'radiusM');
  const passes = param(params, 'passes');
  const strength = param(params, 'strength');
  const radius = Math.max(0, Math.round(radiusM / field.cellSizeM)); // metres → nodes
  if (radius <= 0 || strength <= 0) return Float32Array.from(heights);

  const blurred = gaussianBlur(heights, field.nx, field.nz, radius, passes);
  // Mix between the original and the blur so strength dials the smoothing in.
  const out = new Float32Array(heights.length);
  for (let i = 0; i < heights.length; i++) out[i] = heights[i] + strength * (blurred[i] - heights[i]);
  return out;
}
