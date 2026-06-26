import { defineStore } from 'pinia';
import { ref, shallowRef, reactive } from 'vue';
import { markRaw, toRaw } from 'vue';
import {
  getOrBakeGoogle3DTiles,
  restoreBakedGoogle3DTiles,
  getPreferredBakeQuality,
  getPreferredStripGround,
  refineGoogleTilesBake,
  disposeBakeGroup,
} from '@mapng/bake/google3dTiles';
import { FILTERS as GROUND_FILTERS } from '@mapng/bake/ground/filters/index';
import { POSTPROCESSORS as GROUND_POST } from '@mapng/bake/ground/postprocess/index';
import { DEFAULT_GROUND_STRATEGY } from '@mapng/bake/ground/extractTileGround';

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
  // True once the user has actually loaded Google tiles for the CURRENT AOI
  // (clicked Load, or a cached bake auto-restored). Lets the stripGround toggle
  // auto-bake the other variant only when tiles are already in play — flipping
  // the checkbox before ever loading must NOT kick off a bake. Cleared on a new
  // AOI (Preview3D's terrainData watch).
  const engaged = ref(false);
  const showCameras = ref(false); // overlay the bake's camera stations in the preview
  const progress = reactive({ visible: 0, inflight: 0, station: 1, stations: 1 });
  const group = shallowRef(null);
  // 'standard' (5 camera stations) | 'high' (25 stations, much deeper LOD) |
  // 'roads' (high + street-level stations along the OSM roads) |
  // 'max' (roads + per-cell low-oblique facade ring + errorTarget 3 +
  // saturation stop — auto fly-mode for Google's finest LOD everywhere).
  // Persisted so the exports resolve the same quality → same cache key.
  const quality = ref(getPreferredBakeQuality());

  function setQuality(q) {
    quality.value = q === 'high' || q === 'roads' || q === 'max' ? q : 'standard';
    try { localStorage.setItem('mapng_google_bake_quality', quality.value); } catch (_) { /* private mode */ }
  }

  // true (default): street-level ground tris are stripped so the mapng
  // terrain shows through; false: keep Google's full ground (visible when
  // lifting the tiles with the z-offset). Part of the bake cache key —
  // persisted so preview and exports resolve identically.
  const stripGround = ref(getPreferredStripGround());

  function setStripGround(v) {
    stripGround.value = !!v;
    try { localStorage.setItem('mapng_google_bake_stripground', String(stripGround.value)); } catch (_) { /* private mode */ }
  }

  // Manual vertical nudge (real metres) applied to the previewed mesh only —
  // lets the user lift/lower the Google tiles to line them up with the terrain.
  // Preview-only: does not affect the bake or its cache key.
  function loadZOffset() {
    try {
      const v = Number(localStorage.getItem('mapng_google_bake_zoffset'));
      return Number.isFinite(v) ? v : 0;
    } catch (_) { return 0; }
  }
  const zOffset = ref(loadZOffset());

  function setZOffset(m) {
    const v = Number(m);
    zOffset.value = Number.isFinite(v) ? v : 0;
    try { localStorage.setItem('mapng_google_bake_zoffset', String(zOffset.value)); } catch (_) { /* private mode */ }
  }

  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '';

  async function bakeForPreview(terrainData, forceRebake = false) {
    if (!apiKey || !terrainData || status.value === 'baking') return;
    engaged.value = true; // the user loaded tiles for this AOI
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
        engaged.value = true; // tiles are now showing — toggling may compare
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

  // --- drivable ground (.ter) strategy (Scene-settings menu) -----------------
  // Persisted as JSON; the export reads it via getGroundStrategy /
  // getPreferredTerGround so the menu and the exported .ter agree. Export-time
  // only — NOT part of the bake cache key (it runs on the already-baked group).
  const GROUND_LS = 'mapng_ter_ground_strategy';
  const metaById = (list, id) => (list.find((m) => m.meta.id === id) || list[0]).meta;
  const defaultParamsFor = (meta) => {
    const o = {};
    for (const p of meta.params) o[p.key] = p.default;
    return o;
  };
  function loadGround() {
    const base = {
      source: 'tiles',
      filterId: DEFAULT_GROUND_STRATEGY.filterId,
      filterParams: defaultParamsFor(metaById(GROUND_FILTERS, DEFAULT_GROUND_STRATEGY.filterId)),
      postOn: true,
      postId: DEFAULT_GROUND_STRATEGY.postId,
      postParams: defaultParamsFor(metaById(GROUND_POST, DEFAULT_GROUND_STRATEGY.postId)),
    };
    try {
      const raw = localStorage.getItem(GROUND_LS);
      if (raw) return { ...base, ...JSON.parse(raw) };
    } catch (_) { /* private mode / bad JSON */ }
    return base;
  }
  const ground = reactive(loadGround());
  function persistGround() {
    try { localStorage.setItem(GROUND_LS, JSON.stringify(ground)); } catch (_) { /* private mode */ }
  }
  function setGroundSource(s) { ground.source = s === 'dem' ? 'dem' : 'tiles'; persistGround(); }
  function setGroundFilter(id) {
    ground.filterId = id;
    ground.filterParams = defaultParamsFor(metaById(GROUND_FILTERS, id));
    persistGround();
  }
  function setGroundFilterParam(key, v) { ground.filterParams[key] = Number(v); persistGround(); }
  function setGroundPostOn(v) { ground.postOn = !!v; persistGround(); }
  function setGroundPostEffect(id) {
    ground.postId = id;
    ground.postParams = defaultParamsFor(metaById(GROUND_POST, id));
    persistGround();
  }
  function setGroundPostParam(key, v) { ground.postParams[key] = Number(v); persistGround(); }

  return {
    status, error, show, showCameras, progress, group, apiKey, quality, zOffset,
    refining, refineError, stripGround, engaged,
    setQuality, setZOffset, setStripGround,
    bakeForPreview, rebake, reset, tryRestore, refineFromView,
    // drivable-ground strategy (Scene-settings menu)
    ground, groundFilters: GROUND_FILTERS, groundPost: GROUND_POST,
    setGroundSource, setGroundFilter, setGroundFilterParam,
    setGroundPostOn, setGroundPostEffect, setGroundPostParam,
  };
});
