import { defineStore } from 'pinia';
import { ref, shallowRef, reactive } from 'vue';
import { markRaw, toRaw } from 'vue';
import { getOrBakeGoogle3DTiles, clearGoogleTilesCache } from '../services/google3dTiles.js';

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
  const progress = reactive({ visible: 0, inflight: 0, station: 1, stations: 1 });
  const group = shallowRef(null);

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

  async function bakeForPreview(terrainData) {
    if (!apiKey || !terrainData || status.value === 'baking') return;
    status.value = 'baking';
    error.value = null;
    progress.visible = 0;
    progress.inflight = 0;
    try {
      const baked = await getOrBakeGoogle3DTiles(toRaw(terrainData), {
        apiKey,
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

  /** New AOI loaded — drop the displayed group (cache eviction happens on next bake). */
  function reset() {
    group.value = null;
    status.value = 'idle';
    error.value = null;
  }

  /** Force a fresh bake (drops the shared cache entry first). */
  async function rebake(terrainData) {
    if (status.value === 'baking') return;
    group.value = null;
    clearGoogleTilesCache();
    await bakeForPreview(terrainData);
  }

  return { status, error, show, progress, group, apiKey, bakeForPreview, rebake, reset };
});
