/** @layer flow */
/**
 * batchJob.js — Public barrel for the batch grid engine.
 *
 * Decomposed (docs/refactor/11) into focused siblings; this file preserves the
 * exact public import surface (consumers: App.vue, mainStore.js,
 * BatchProgressModal.vue, and `@mapng/batch` via index.js `export *`). The two
 * tiny UI utils below have no better home, so they live here alongside the
 * re-exports.
 *
 *   grid.js              core   grid/label math
 *   schedulerConfig.js   core   export-flag + scheduler-config derivation
 *   batchState.js        core   job-state construction + migration
 *   statePersistence.js  io     localStorage + cache reset
 *   batchReport.js       core   elevation report + tile metadata
 *   tileTiming.js        core   stage-timing/counts/error helpers
 *   memorySampling.js    io     performance.memory sampling + checkpoint
 *   tileSnapshot.js      io     canvas snapshot + resource release
 *   batchDownloads.js    io     anchor download + blob MIME coercion
 *   compositeHeightmap.js io    stitched grid heightmap
 *   tileQueues.js        core   OSM predicate + scheduling queues
 *   processTile.js       flow   per-tile pipeline (renderer-coupled)
 *   batchRun.js          flow   runBatchJob dispatcher + elevation scan
 */

import { TILE_STATES } from './batchRuntime.js';

export {
  computeGridTiles,
  normalizeTileOffsets,
  computeGridTilesWithOffsets,
  computeGridBounds,
  getDefaultTileLabel,
  normalizeTileNames,
} from './grid.js';
export { createBatchJobState } from './batchState.js';
export {
  saveBatchState,
  loadBatchState,
  clearBatchState,
  clearBatchClientCache,
  resetFailedTiles,
} from './statePersistence.js';
export { runBatchJob } from './batchRun.js';

export function estimateTimeRemaining(state) {
  if (!state.tileCompletionTimes?.length) return null;

  const avg = state.tileCompletionTimes.reduce((a, b) => a + b, 0) / state.tileCompletionTimes.length;
  const remaining = state.tiles.filter(t =>
    t.status === TILE_STATES.QUEUED || t.status === TILE_STATES.PROCESSING,
  ).length;
  return Math.round(avg * remaining);
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return '—';
  const seconds = Math.floor(ms / 1000) % 60;
  const minutes = Math.floor(ms / 60000) % 60;
  const hours = Math.floor(ms / 3600000);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
