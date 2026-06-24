// Server-side PNG rendering for the test lab (delta-field heatmap). Uses
// fast-png (already an app dependency) so it runs in plain Node — lets the
// harness verify a real image comes back, not just JSON.

import { encode } from 'fast-png';

// Simple blue→cyan→yellow→red ramp over a normalised [0,1] value.
const ramp = (t) => {
  t = Math.max(0, Math.min(1, t));
  // piecewise linear through 4 stops
  const stops = [
    [30, 60, 150],   // low  — blue
    [40, 170, 170],  // cyan
    [230, 200, 60],  // yellow
    [200, 50, 40],   // high — red
  ];
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
};

/**
 * Encode an n×n scalar field to an upscaled RGBA PNG heatmap.
 * @param {Float32Array} values length n*n
 * @param {number} n grid side
 * @param {object} [opts] { scale=8 } pixel size per cell
 * @returns {{ buffer: Uint8Array, min:number, max:number }}
 */
export const fieldHeatmapPng = (values, n, { scale = 8 } = {}) => {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  const W = n * scale, H = n * scale;
  const data = new Uint8Array(W * H * 4);
  for (let py = 0; py < H; py++) {
    const cz = Math.min(n - 1, Math.floor(py / scale));
    for (let px = 0; px < W; px++) {
      const cx = Math.min(n - 1, Math.floor(px / scale));
      const [r, g, b] = ramp((values[cz * n + cx] - min) / span);
      const o = (py * W + px) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
  }
  return { buffer: encode({ width: W, height: H, data, channels: 4 }), min, max };
};
