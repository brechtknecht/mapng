import { defineStore } from 'pinia';
import { ref, shallowRef, reactive } from 'vue';
import { markRaw, toRaw } from 'vue';
import {
  getOrBakeGoogle3DTiles,
  restoreBakedGoogle3DTiles,
  getPreferredBakeQuality,
  refineGoogleTilesBake,
  disposeBakeGroup,
} from '../services/google3dTiles.js';

/**
 * State for the Google Photorealistic 3D Tiles preview in Preview3D.
 *
 * The baked THREE.Group is owned by the module-level cache in
 * services/google3dTiles.js (shared with the BeamNG/GLB/DAE export paths);
 * this store only holds a markRaw'd reference for display. Never make the
 * group deeply reactive — it contains >1k meshes with canvas textures.
 */
export const useGoogleTilesStore = defineStore('googleTiles', () => {
  const status = ref('idle'); // 'idle' | 'baking' | 'ready' | 'error'
  const error = ref(null);
  const show = ref(true);
  const showCameras = ref(false); // overlay the bake's camera stations in the preview
  const progress = reactive({ visible: 0, inflight: 0, station: 1, stations: 1 });
  const group = shallowRef(null);
  // 'standard' (5 camera stations) | 'high' (25 stations, much deeper LOD) |
  // 'roads' (high + street-level stations along the OSM roads).
  // Persisted so the exports resolve the same quality → same cache key.
  const quality = ref(getPreferredBakeQuality());

  function setQuality(q) {
    quality.value = q === 'high' || q === 'roads' ? q : 'standard';
    try { localStorage.setItem('mapng_google_bake_quality', quality.value); } catch (_) { /* private mode */ }
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

  async function bakeForPreview(terrainData, forceRebake = false) {
    if (!apiKey || !terrainData || status.value === 'baking') return;
    status.value = 'baking';
    error.value = null;
    progress.visible = 0;
    progress.inflight = 0;
    try {
      const baked = await getOrBakeGoogle3DTiles(toRaw(terrainData), {
        apiKey,
        forceRebake,
        quality: quality.value,
        onProgress: (p) => {
          progress.visible = p.visible;
          progress.inflight = p.downloading + p.parsing;
          progress.station = p.station ?? 1;
          progress.stations = p.stations ?? 1;
        },
      });
      group.value = markRaw(baked);
      show.value = true;
      status.value = 'ready';
    } catch (err) {
      console.error('[googleTilesStore] preview bake failed:', err);
      error.value = err?.message ?? String(err);
      group.value = null;
      status.value = 'error';
    }
  }

  // Fly-mode refinement: true while a user-station refinement runs on the
  // bake sidecar. status stays 'ready' — the old tiles keep rendering until
  // the refined group swaps in.
  const refining = ref(false);
  const refineError = ref(null);

  /**
   * Refine the current bake from a fly-mode camera station (see
   * services/google3dTiles.js refineGoogleTilesBake). Requires a live
   * sidecar bake session; errors land in refineError, not status.
   */
  async function refineFromView(terrainData, station) {
    if (!apiKey || !terrainData || status.value !== 'ready' || refining.value) return;
    refining.value = true;
    refineError.value = null;
    progress.visible = 0;
    progress.inflight = 0;
    // Stale station counts from the base bake would make the HUD claim a
    // session rebuild before the first progress event arrives.
    progress.station = 1;
    progress.stations = 1;
    try {
      const previous = group.value;
      const refreshed = await refineGoogleTilesBake(toRaw(terrainData), {
        apiKey,
        quality: quality.value,
        onProgress: (p) => {
          progress.visible = p.visible;
          progress.inflight = p.downloading + p.parsing;
          progress.station = p.station ?? 1;
          progress.stations = p.stations ?? 1;
        },
      }, station);
      group.value = markRaw(refreshed);
      // The swap is done — release the superseded group's GPU/canvas memory.
      if (previous && toRaw(previous) !== refreshed) disposeBakeGroup(toRaw(previous));
    } catch (err) {
      console.error('[googleTilesStore] refine failed:', err);
      refineError.value = err?.message ?? String(err);
    } finally {
      refining.value = false;
    }
  }

  /** New AOI loaded — drop the displayed group (cache eviction happens on next bake). */
  function reset() {
    group.value = null;
    status.value = 'idle';
    error.value = null;
    refineError.value = null;
  }

  /**
   * Probe the caches for an existing bake of this AOI — never fetches from
   * Google. Called when terrain data appears (page load / regenerate) so a
   * previously baked AOI reappears without clicking "Load".
   */
  async function tryRestore(terrainData) {
    if (!terrainData || status.value !== 'idle') return;
    try {
      const restored = await restoreBakedGoogle3DTiles(toRaw(terrainData), { apiKey, quality: quality.value });
      // Only apply if nothing else (a click on Load) changed state meanwhile.
      if (restored && status.value === 'idle') {
        group.value = markRaw(restored);
        show.value = true;
        status.value = 'ready';
      }
    } catch (err) {
      console.warn('[googleTilesStore] cache restore failed:', err);
    }
  }

  /** Force a fresh bake (purges both the in-memory and IndexedDB cache entries). */
  async function rebake(terrainData) {
    if (status.value === 'baking') return;
    group.value = null;
    await bakeForPreview(terrainData, true);
  }

  return {
    status, error, show, showCameras, progress, group, apiKey, quality,
    refining, refineError,
    setQuality, bakeForPreview, rebake, reset, tryRestore, refineFromView,
  };
});
