/** @layer io */
// localStorage-backed bake toggles + option resolution (refactor doc 06 step 3).
// Moved verbatim from google3dTiles.js. Centralised so the preview, the cache
// key, the Node worker and the in-browser fallback agree on the same choices.

// Seam handling for the in-tab fallback bake (prod / sidecar unreachable). The
// DEFAULT is the root-cause seam weld (weldSeams); the old magic-threshold
// strip is OFF by default, behind a kill switch for parity with the worker.
//   localStorage mapng_weld_seams='0'   disable the weld
//   localStorage mapng_strip_risers='1' re-enable the old heuristic deletion
// NOTE: lateral footprint carving lives in the Node worker (it needs the live
// tile tree); the in-tab path runs the weld only, so it leans on weldSeams to
// close seams. On the dev server every bake routes through the worker anyway.
export const weldSeamsEnabled = () => {
  try { return localStorage.getItem('mapng_weld_seams') !== '0'; } catch (_) { return true; }
};
export const riserStripEnabled = () => {
  try { return localStorage.getItem('mapng_strip_risers') === '1'; } catch (_) { return false; }
};
// Delta-field conform — seat the tiles onto the .ter floor (tileGroundConform.js).
// Default ON; localStorage mapng_conform_tiles='0' disables it.
export const conformTilesEnabled = () => {
  try { return localStorage.getItem('mapng_conform_tiles') !== '0'; } catch (_) { return true; }
};

// Sub-flag for the semantic road-mask SNAP layered on the delta-field conform
// (groundMask.js): full-res flatten of road wiggle + pull-down of floaters the
// ±band leaves behind. Default ON; mapng_conform_roadmask='0' → delta field only.
export const conformRoadmaskEnabled = () => {
  try { return localStorage.getItem('mapng_conform_roadmask') !== '0'; } catch (_) { return true; }
};

/**
 * The preferred bake quality, persisted by the 3D-preview selector. Resolved
 * centrally so the preview AND the exports (which don't pass `quality`)
 * agree on the same cache key — a mismatch would silently re-bake.
 */
export function getPreferredBakeQuality() {
  try {
    const q = localStorage.getItem('mapng_google_bake_quality');
    return q === 'high' || q === 'roads' || q === 'max' ? q : 'standard';
  } catch (_) {
    return 'standard';
  }
}

/**
 * Persisted ground-stripping preference. true (default) = streets/ground
 * near the mapng terrain are removed so the heightmap stays the driving
 * surface; false = keep Google's full ground (visible when the tiles are
 * lifted via the preview z-offset). Resolved centrally like the quality so
 * preview and exports agree on the same cache key.
 */
export function getPreferredStripGround() {
  try {
    return localStorage.getItem('mapng_google_bake_stripground') !== 'false';
  } catch (_) {
    return true;
  }
}

// Render bias (metres) lifting the VISUAL Google tiles a hair above the .ter
// surface they were conformed onto, so the two no longer z-fight where they sit
// coplanar. Purely visual — the car still drives on the terrain just beneath,
// and terrain still shows beyond the tile footprint (the useful far texture).
// Distinct from the user z-offset slider (a trim, default 0); this is a fixed
// depth-bias epsilon. Tune up if z-fighting persists at far view distances.
export const TILE_RENDER_BIAS_M = 0.15;

/**
 * Manual vertical lift (real metres) set via the preview's z-offset slider.
 * Display-side only — NOT part of the bake or its cache key — but the export
 * paths apply it so what you aligned in the preview is what you get in the
 * level/GLB/DAE.
 */
export function getGoogleTilesZOffset() {
  try {
    const v = Number(localStorage.getItem('mapng_google_bake_zoffset'));
    return Number.isFinite(v) ? v : 0;
  } catch (_) {
    return 0;
  }
}

export const resolveBakeOptions = (options) => {
  const quality = options.quality ?? getPreferredBakeQuality();
  return {
    ...options,
    quality,
    stripGround: options.stripGround ?? getPreferredStripGround(),
    // 'max' deepens the global screen-space-error threshold so EVERY station
    // pulls finer mesh + texture tiles (library-tuned 5 stays for the lighter
    // tiers). Pinned here — the single choke point — so the cache key, the
    // Node worker, and the in-browser fallback all resolve the same value.
    errorTarget: options.errorTarget ?? (quality === 'max' ? 3 : 5),
  };
};
