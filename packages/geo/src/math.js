// ─── Shared scalar / grid math ───────────────────────────────────────────────
// Canonical home for the small numeric helpers that were duplicated inline
// across the bake pipelines (export3d, exportBeamNGLevel, terrainResampler,
// resamplerWorker, googleBakeCore). Behaviour is identical to the former inline
// copies — this just gives them one source of truth.

/** Clamp `value` into the inclusive range [min, max]. */
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Clamp into [0, 1]. */
export const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Linear interpolation between a and b by t. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Degrees → radians. */
export const deg2rad = (deg) => (deg * Math.PI) / 180;

/** Radians → degrees. */
export const rad2deg = (rad) => (rad * 180) / Math.PI;

/**
 * Metres per degree of longitude at a given latitude (WGS84 small-angle
 * approximation, 111320 m/deg at the equator scaled by cos(lat)). This is the
 * exact expression that was inlined throughout export3d.js / googleBakeCore.js.
 */
export const metersPerDegreeLng = (latDeg) =>
    111320 * Math.cos(deg2rad(latDeg));

/**
 * Bilinear sample of a single-channel raster, honouring a no-data sentinel.
 * Verbatim port of the byte-identical helper shared by terrainResampler.js and
 * resamplerWorker.js (boundary guard + finite checks preserved exactly).
 */
export const bilinear = (raster, w, x, y, noDataVal) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const dx = x - x0;
    const dy = y - y0;

    const i00 = y0 * w + x0;
    const i10 = i00 + 1;
    const i01 = (y0 + 1) * w + x0;
    const i11 = i01 + 1;

    if (i00 < 0 || i11 >= raster.length) return noDataVal;

    const h00 = raster[i00];
    const h10 = raster[i10];
    const h01 = raster[i01];
    const h11 = raster[i11];

    if (!Number.isFinite(h00) || !Number.isFinite(h10) || !Number.isFinite(h01) || !Number.isFinite(h11)) return noDataVal;
    if (h00 === noDataVal || h10 === noDataVal || h01 === noDataVal || h11 === noDataVal) return noDataVal;

    const interp = (1 - dy) * ((1 - dx) * h00 + dx * h10) + dy * ((1 - dx) * h01 + dx * h11);
    return Number.isFinite(interp) ? interp : noDataVal;
};
