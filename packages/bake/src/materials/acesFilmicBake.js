/** @layer core */
// ACES filmic tone-map BAKE for exported textures — the exact fit three.js
// uses for THREE.ACESFilmicToneMapping (Stephen Hill's RRT+ODT approximation),
// applied to 8-bit sRGB pixel buffers on the CPU.
//
// The 3D preview renders the whole scene through ACESFilmicToneMapping at
// exposure 0.8 (Preview3D.vue) — that grade is what gives the preview its
// contrast and saturation. BeamNG never sees it: the exported atlas textures
// are raw Google tile colours, re-tone-mapped by BeamNG's own pipeline, which
// reads as "washed out / added gamma filter" next to the preview. Baking the
// same curve into the atlas pixels ships the preview's look. Pairs with the
// emissive atlas materials (levelFiles.js): emissive surfaces aren't re-lit,
// so the baked texture IS the on-screen colour.

/** Exposure the 3D preview renders with (Preview3D.vue tone-mapping-exposure). */
export const ACES_BAKE_EXPOSURE = 0.8;

// 8-bit sRGB → linear decode table.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const s = i / 255;
  SRGB_TO_LINEAR[i] = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
// linear [0,1] → 8-bit sRGB encode table. 4096 steps keep the error under
// one output byte even on the steep dark end of the curve.
const LINEAR_TO_SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const l = i / 4096;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.round(s * 255);
}

/**
 * Tone-map an interleaved 8-bit pixel buffer IN PLACE (RGB or RGBA; alpha is
 * left untouched). Mirrors three.js exactly: decode sRGB, scale by
 * exposure/0.6, ACES input matrix, RRT/ODT fit, ACES output matrix, clamp,
 * re-encode sRGB — so a pixel bakes to the value the preview displays for an
 * unlit surface of that colour.
 *
 * @param {Uint8Array|Uint8ClampedArray} pixels interleaved 8-bit sRGB
 * @param {number} channels 3 (RGB) or 4 (RGBA)
 * @param {number} exposure tone-mapping exposure (preview default 0.8)
 * @returns the same buffer, for chaining
 */
export function bakeAcesToneMap(pixels, channels = 4, exposure = ACES_BAKE_EXPOSURE) {
  const gain = exposure / 0.6; // three.js pre-scales by 1/0.6 before the fit
  for (let p = 0; p < pixels.length; p += channels) {
    const r = SRGB_TO_LINEAR[pixels[p]] * gain;
    const g = SRGB_TO_LINEAR[pixels[p + 1]] * gain;
    const b = SRGB_TO_LINEAR[pixels[p + 2]] * gain;
    // ACESInputMat — sRGB primaries → the fit's rendering space
    let x = 0.59719 * r + 0.35458 * g + 0.04823 * b;
    let y = 0.07600 * r + 0.90834 * g + 0.01566 * b;
    let z = 0.02840 * r + 0.13383 * g + 0.83777 * b;
    // RRT + ODT rational fit
    x = (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081);
    y = (y * (y + 0.0245786) - 0.000090537) / (y * (0.983729 * y + 0.4329510) + 0.238081);
    z = (z * (z + 0.0245786) - 0.000090537) / (z * (0.983729 * z + 0.4329510) + 0.238081);
    // ACESOutputMat — back to sRGB primaries
    const ro = 1.60475 * x - 0.53108 * y - 0.07367 * z;
    const go = -0.10208 * x + 1.10813 * y - 0.00605 * z;
    const bo = -0.00327 * x - 0.07276 * y + 1.07602 * z;
    pixels[p] = LINEAR_TO_SRGB[Math.round(Math.min(1, Math.max(0, ro)) * 4096)];
    pixels[p + 1] = LINEAR_TO_SRGB[Math.round(Math.min(1, Math.max(0, go)) * 4096)];
    pixels[p + 2] = LINEAR_TO_SRGB[Math.round(Math.min(1, Math.max(0, bo)) * 4096)];
  }
  return pixels;
}
