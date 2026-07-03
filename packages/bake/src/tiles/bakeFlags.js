/** @layer io */
// localStorage-backed bake toggles + option resolution (refactor doc 06 step 3).
// Moved verbatim from google3dTiles.js. Centralised so the preview, the cache
// key, the Node worker and the in-browser fallback agree on the same choices.

// Seam handling for the in-tab fallback bake (prod / sidecar unreachable).
// As of v15 the weld (and all geometry post-passes) are OFF by default while the
// post-processing strategy is reworked — see the note on the flag fns below.
//   localStorage mapng_weld_seams='1'   re-enable the weld
//   localStorage mapng_strip_risers='1' re-enable the old heuristic deletion
// NOTE: lateral footprint carving lives in the Node worker (it needs the live
// tile tree); the in-tab path runs the weld only, so it leans on weldSeams to
// close seams. On the dev server every bake routes through the worker anyway.
// NOTE: the geometry post-passes (weld / conform / road-mask / ground-strip) are
// DISABLED by default while the post-processing strategy is reworked — they each
// damaged the mesh more than they helped (cracks/lift/spikes, worst toward AOI
// edges; raw tiles are cleanest). See docs/google-tiles-mesh-assembly-problem-statement.md.
// Each remains opt-in via its localStorage flag (set to '1'/'true') and the
// per-bake option overrides + /quality-sandbox toggles.
export const weldSeamsEnabled = () => {
  try { return localStorage.getItem('mapng_weld_seams') === '1'; } catch (_) { return false; }
};
export const riserStripEnabled = () => {
  try { return localStorage.getItem('mapng_strip_risers') === '1'; } catch (_) { return false; }
};
// Delta-field conform — seat the tiles onto the .ter floor (tileGroundConform.js).
// Default OFF (see note above); localStorage mapng_conform_tiles='1' re-enables it.
export const conformTilesEnabled = () => {
  try { return localStorage.getItem('mapng_conform_tiles') === '1'; } catch (_) { return false; }
};

// Sub-flag for the semantic road-mask SNAP layered on the delta-field conform
// (groundMask.js). Default OFF (see note above); mapng_conform_roadmask='1' re-enables.
export const conformRoadmaskEnabled = () => {
  try { return localStorage.getItem('mapng_conform_roadmask') === '1'; } catch (_) { return false; }
};

// Sub-flag for semantic structure stiffness in the conform (deform/
// structureStiffness.js): OSM building footprints freeze the delta field
// locally constant (rigid re-seat, no roof shear) and veto the road snap
// underneath. Default ON whenever the conform runs — it only PREVENTS damage
// to buildings, so there is no reason to conform without it;
// mapng_conform_stiffness='0' disables it for A/B comparison.
export const conformStiffnessEnabled = () => {
  try { return localStorage.getItem('mapng_conform_stiffness') !== '0'; } catch (_) { return true; }
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
  // Default OFF while the post-processing strategy is reworked — raw Google tiles
  // (ground kept) for now. Re-enable with localStorage mapng_google_bake_stripground='true'.
  try {
    return localStorage.getItem('mapng_google_bake_stripground') === 'true';
  } catch (_) {
    return false;
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
