import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { loadBatchState } from '../services/batchJob';

export const useMainStore = defineStore('main', () => {
  // --- Global State ---
  const center = ref(
    JSON.parse(localStorage.getItem('mapng_center') || 'null') || { lat: 35.1983, lng: -111.6513 }
  );
  const zoom = ref(parseInt(localStorage.getItem('mapng_zoom')) || 13);
  const resolution = ref(parseInt(localStorage.getItem('mapng_resolution')) || 1024);
  const isDarkMode = ref(localStorage.getItem('theme') === 'dark');

  // Map mode: 'single' | 'batch' | 'route'. Source of truth; batchMode/routeMode
  // are derived shims so existing call sites keep working unchanged.
  // Migrate from the legacy boolean `mapng_batch_mode` if no mode is stored yet.
  const VALID_MAP_MODES = ['single', 'batch', 'route'];
  const storedMapMode = localStorage.getItem('mapng_map_mode');
  const mapMode = ref(
    VALID_MAP_MODES.includes(storedMapMode)
      ? storedMapMode
      : (localStorage.getItem('mapng_batch_mode') === 'true' ? 'batch' : 'single')
  );
  const batchMode = computed(() => mapMode.value === 'batch');
  const routeMode = computed(() => mapMode.value === 'route');

  if (batchMode.value && Number(resolution.value) > 8192) {
    resolution.value = 8192;
    localStorage.setItem('mapng_resolution', String(8192));
  }

  // --- Single Tile State ---
  const terrainData = ref(null);
  const lastGenerationKey = ref(null);
  const isLoading = ref(false);
  const loadingStatus = ref("Initializing...");
  const previewMode = ref(false);
  const surroundingTilePositions = ref([]);

  // --- Batch Job State ---
  const batchGridCols = ref(parseInt(localStorage.getItem('mapng_batch_cols')) || 3);
  const batchGridRows = ref(parseInt(localStorage.getItem('mapng_batch_rows')) || 3);
  const batchTileFollowCenter = ref(localStorage.getItem('mapng_batch_tile_follow_center') !== 'false');
  const batchTileOffsets = ref((() => {
    try {
      const saved = localStorage.getItem('mapng_batch_tile_offsets');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })());
  const batchTileNames = ref((() => {
    try {
      const saved = localStorage.getItem('mapng_batch_tile_names');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })());
  const batchState = ref(null);
  const batchRunning = ref(false);
  const batchCurrentStep = ref('');
  const showBatchProgress = ref(false);
  const savedBatchState = ref(loadBatchState());

  // --- Route Corridor State ---
  const routeStart = ref(JSON.parse(localStorage.getItem('mapng_route_start') || 'null')); // {lat,lng}|null
  const routeEnd = ref(JSON.parse(localStorage.getItem('mapng_route_end') || 'null'));     // {lat,lng}|null
  const routePolyline = ref([]);            // decoded centerline [{lat,lng}] — refetched, not persisted
  const routeDistanceM = ref(0);            // total route length in metres
  const routeFetching = ref(false);
  const routeError = ref('');
  const corridorTier = ref(localStorage.getItem('mapng_corridor_tier') || 'standard'); // draft|standard|fine|ultra
  // Manual AOI box-size override (metres), decoupled from the tier. null = Auto
  // (follow the tier's chunkSizeM). See routeCorridor.resolveChunkSizeM.
  const routeChunkSizeM = ref(
    (() => {
      const v = parseInt(localStorage.getItem('mapng_route_chunk_size'), 10);
      return Number.isFinite(v) && v > 0 ? v : null;
    })(),
  );
  // How many chunks to bake concurrently (dev sidecar only). 1–4; default 2.
  const routeConcurrency = ref(
    (() => {
      const v = parseInt(localStorage.getItem('mapng_route_concurrency'), 10);
      return Number.isFinite(v) ? Math.max(1, Math.min(4, v)) : 2;
    })(),
  );

  // --- Actions ---
  function setCenter(newCenter) {
    center.value = newCenter;
    localStorage.setItem('mapng_center', JSON.stringify(newCenter));
  }

  function setZoom(newZoom) {
    zoom.value = newZoom;
    localStorage.setItem('mapng_zoom', String(newZoom));
  }

  function setResolution(newResolution) {
    resolution.value = newResolution;
    localStorage.setItem('mapng_resolution', String(newResolution));
  }

  function toggleDarkMode() {
    isDarkMode.value = !isDarkMode.value;
    if (isDarkMode.value) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
  }

  function setMapMode(mode) {
    const next = VALID_MAP_MODES.includes(mode) ? mode : 'single';
    mapMode.value = next;
    localStorage.setItem('mapng_map_mode', next);
    // Keep the legacy flag in sync for any old readers.
    localStorage.setItem('mapng_batch_mode', next === 'batch' ? 'true' : 'false');
  }

  // Back-compat shim: older call sites toggle a boolean.
  function setBatchMode(value) {
    setMapMode(value ? 'batch' : 'single');
  }

  function setRouteStart(point) {
    routeStart.value = point;
    localStorage.setItem('mapng_route_start', JSON.stringify(point ?? null));
  }

  function setRouteEnd(point) {
    routeEnd.value = point;
    localStorage.setItem('mapng_route_end', JSON.stringify(point ?? null));
  }

  function setRoutePolyline(points, distanceMeters = 0) {
    routePolyline.value = Array.isArray(points) ? points : [];
    routeDistanceM.value = Number(distanceMeters) || 0;
  }

  function setCorridorTier(tier) {
    corridorTier.value = tier;
    localStorage.setItem('mapng_corridor_tier', tier);
  }

  function setRouteChunkSizeM(sizeM) {
    const v = Number(sizeM);
    if (Number.isFinite(v) && v > 0) {
      routeChunkSizeM.value = v;
      localStorage.setItem('mapng_route_chunk_size', String(v));
    } else {
      routeChunkSizeM.value = null; // Auto
      localStorage.removeItem('mapng_route_chunk_size');
    }
  }

  function setRouteConcurrency(n) {
    const v = Math.max(1, Math.min(4, Math.round(Number(n)) || 1));
    routeConcurrency.value = v;
    localStorage.setItem('mapng_route_concurrency', String(v));
  }

  function clearRoute() {
    routePolyline.value = [];
    routeDistanceM.value = 0;
    routeError.value = '';
  }

  function setBatchGridCols(cols) {
    batchGridCols.value = cols;
    localStorage.setItem('mapng_batch_cols', String(cols));
  }

  function setBatchGridRows(rows) {
    batchGridRows.value = rows;
    localStorage.setItem('mapng_batch_rows', String(rows));
  }

  function setBatchTileFollowCenter(value) {
    batchTileFollowCenter.value = !!value;
    localStorage.setItem('mapng_batch_tile_follow_center', batchTileFollowCenter.value ? 'true' : 'false');
  }

  function setBatchTileOffsets(offsets) {
    batchTileOffsets.value = Array.isArray(offsets) ? offsets : [];
    localStorage.setItem('mapng_batch_tile_offsets', JSON.stringify(batchTileOffsets.value));
  }

  function setBatchTileNames(names) {
    batchTileNames.value = Array.isArray(names) ? names : [];
    localStorage.setItem('mapng_batch_tile_names', JSON.stringify(batchTileNames.value));
  }

  return {
    // State
    center,
    zoom,
    resolution,
    isDarkMode,
    mapMode,
    batchMode,
    routeMode,
    terrainData,
    lastGenerationKey,
    isLoading,
    loadingStatus,
    previewMode,
    surroundingTilePositions,
    batchGridCols,
    batchGridRows,
    batchTileFollowCenter,
    batchTileOffsets,
    batchTileNames,
    batchState,
    batchRunning,
    batchCurrentStep,
    showBatchProgress,
    savedBatchState,
    routeStart,
    routeEnd,
    routePolyline,
    routeDistanceM,
    routeFetching,
    routeError,
    corridorTier,
    routeChunkSizeM,
    routeConcurrency,
    // Actions
    setCenter,
    setZoom,
    setResolution,
    toggleDarkMode,
    setMapMode,
    setBatchMode,
    setRouteStart,
    setRouteEnd,
    setRoutePolyline,
    setCorridorTier,
    setRouteChunkSizeM,
    setRouteConcurrency,
    clearRoute,
    setBatchGridCols,
    setBatchGridRows,
    setBatchTileFollowCenter,
    setBatchTileOffsets,
    setBatchTileNames
  };
});
