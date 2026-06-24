/** @layer core */
/**
 * batchState.js — Pure batch-job state construction and migration.
 *
 * Builds the canonical job-state object from a config, and migrates a loaded
 * (possibly legacy) state forward. No DOM, no network, no persistence — the
 * localStorage side lives in statePersistence.js.
 */

import {
  computeGridTilesWithOffsets,
  normalizeTileNames,
  normalizeTileOffsets,
  getDefaultTileLabel,
} from './grid.js';
import {
  toStrictBool,
  normalizeExportFlags,
  mapLegacyJobStatus,
  mapLegacyTileStatus,
  deriveSchedulerConfig,
} from './schedulerConfig.js';
import {
  JOB_STATES,
  TILE_STATES,
  computeDeterministicJobId,
  computeTileId,
  ensureJobAndTileStates,
} from './batchRuntime.js';

export function createBatchJobState(config) {
  const id = computeDeterministicJobId(config);
  const normalizedExports = normalizeExportFlags(config.exports);
  const includeOSM = toStrictBool(config.includeOSM);
  const performanceProfile = ['throughput', 'balanced', 'low_memory'].includes(config?.performanceProfile)
    ? config.performanceProfile
    : 'balanced';
  const scheduler = {
    ...deriveSchedulerConfig({ ...config, includeOSM, exports: normalizedExports, performanceProfile }),
    ...(config.scheduler || {}),
  };
  const normalizedTileOffsets = normalizeTileOffsets(
    config.tileOffsets,
    Number(config.gridCols || 1) * Number(config.gridRows || 1),
  );
  const normalizedTileNames = normalizeTileNames(
    config.tileNames,
    Number(config.gridCols || 1) * Number(config.gridRows || 1),
    Number(config.gridCols || 1),
  );
  const baseTiles = computeGridTilesWithOffsets(
    config.center,
    config.resolution,
    config.gridCols,
    config.gridRows,
    normalizedTileOffsets,
  );
  const tileNamesByIndex = new Map(normalizedTileNames.map((entry) => [entry.index, entry.name]));
  const tiles = baseTiles.map((tile) => ({
    ...tile,
    id: computeTileId(id, tile),
    customName: tileNamesByIndex.get(tile.index) || '',
    label: tileNamesByIndex.get(tile.index) || getDefaultTileLabel(tile),
    status: TILE_STATES.QUEUED,
    snapshot: null,
    elevationStats: null,
    stageTimings: {},
    memory: {
      startUsedBytes: null,
      afterFetchUsedBytes: null,
      beforeZipUsedBytes: null,
      afterZipUsedBytes: null,
      endUsedBytes: null,
      peakUsedBytes: 0,
    },
    lifecycle: {
      startedAt: null,
      fetchCompletedAt: null,
      zipCompletedAt: null,
      completedAt: null,
      totalMs: 0,
    },
    attempts: 0,
    errors: [],
    lastError: null,
    nextRetryAt: null,
    retryable: false,
  }));

  return {
    schemaVersion: 2,
    id,
    center: { ...config.center },
    resolution: config.resolution,
    gridCols: config.gridCols,
    gridRows: config.gridRows,
    tileNames: normalizedTileNames,
    tileOffsets: normalizedTileOffsets,
    exports: normalizedExports,
    includeOSM,
    elevationSource: config.elevationSource,
    gpxzApiKey: config.gpxzApiKey || '',
    gpxzStatus: config.gpxzStatus || null,
    glbMeshResolution: config.glbMeshResolution || 512,
    performanceProfile,
    elevationNormalization: {
      enabled: !!config?.elevationNormalization?.enabled,
      scope: 'global_batch',
      status: 'idle',
      globalMinHeight: null,
      globalMaxHeight: null,
      scannedTiles: 0,
      totalTiles: baseTiles.length,
    },

    scheduler,

    status: JOB_STATES.PENDING,
    currentTileIndex: -1,
    currentTileId: null,
    tiles,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    totalCompleted: 0,
    totalFailed: 0,
    tileCompletionTimes: [],
    instrumentation: {
      memory: {
        supported: false,
        samples: [],
        peakUsedBytes: 0,
        peakTotalBytes: 0,
        sampleLimit: 120,
        sampleIntervalMs: 1200,
        lastSampleAt: 0,
      },
    },
    summary: null,
  };
}

export const migrateLoadedState = (state) => {
  if (!state) return null;

  state.status = mapLegacyJobStatus(state.status);
  if (Array.isArray(state.tiles)) {
    state.tiles.forEach((tile) => {
      tile.status = mapLegacyTileStatus(tile.status);
    });
  }

  if (!state.schemaVersion) state.schemaVersion = 2;
  state.includeOSM = toStrictBool(state.includeOSM);
  state.exports = normalizeExportFlags(state.exports);
  state.tileNames = normalizeTileNames(
    state.tileNames,
    Number(state.gridCols || 1) * Number(state.gridRows || 1),
    Number(state.gridCols || 1),
  );
  state.performanceProfile = ['throughput', 'balanced', 'low_memory'].includes(state.performanceProfile)
    ? state.performanceProfile
    : 'balanced';
  const fallbackScheduler = deriveSchedulerConfig(state);
  state.scheduler = {
    ...fallbackScheduler,
    ...(state.scheduler || {}),
  };
  ensureJobAndTileStates(state);
  const tileNamesByIndex = new Map((state.tileNames || []).map((entry) => [entry.index, entry.name]));
  if (Array.isArray(state.tiles)) {
    state.tiles.forEach((tile) => {
      tile.customName = String(tile.customName || tile.name || tileNamesByIndex.get(tile.index) || '').trim();
      tile.label = tile.customName || getDefaultTileLabel(tile, state.gridCols);
    });
  }
  return state;
};
