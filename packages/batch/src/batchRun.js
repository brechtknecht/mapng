/** @layer flow */
/**
 * batchRun.js — The batch-job runner: the shared-baseline elevation scan and
 * the top-level runBatchJob dispatcher (queues, normalization, primary +
 * retry passes, composite heightmap + report finalization).
 */

import { fetchTerrainData } from '@mapng/terrain/terrain';
import { JOB_STATES, TILE_STATES, ensureJobAndTileStates } from './batchRuntime.js';
import { isPausedOrCanceled, addTiming, updateCounts } from './tileTiming.js';
import { checkpoint, sampleMemory } from './memorySampling.js';
import { releaseTerrainResources } from './tileSnapshot.js';
import { getTileLabel } from './grid.js';
import { buildQueues } from './tileQueues.js';
import {
  createCompositeHeightmapContext,
  writeTileToCompositeHeightmap,
  downloadCompositeHeightmap,
} from './compositeHeightmap.js';
import { downloadBatchElevationReport } from './batchDownloads.js';
import { installBatchFetchCache } from './batchCache.js';
import { processTile } from './processTile.js';

async function computeBatchElevationNormalization(state, scheduleFetch, onProgress, signal) {
  const normalization = state.elevationNormalization;
  if (!normalization?.enabled) return;

  normalization.status = 'scanning';
  normalization.scannedTiles = 0;
  normalization.totalTiles = state.tiles.length;

  let globalMin = Infinity;
  let globalMax = -Infinity;

  for (const tile of state.tiles) {
    if (isPausedOrCanceled(signal, state)) {
      normalization.status = 'aborted';
      checkpoint(state);
      return;
    }

    onProgress({
      tileIndex: tile.index,
      step: `Scanning elevation range (${normalization.scannedTiles + 1}/${state.tiles.length})...`,
      tile,
    });

    const previewData = await scheduleFetch(tile, () => fetchTerrainData(
      tile.center,
      state.resolution,
      false,
      state.elevationSource === 'usgs',
      state.elevationSource === 'gpxz',
      state.elevationSource === 'kron86',
      state.gpxzApiKey,
      undefined,
      undefined,
      signal,
      {
        keepSourceGeoTiffs: false,
        generateSegmentedSatellite: false,
        generateOSMTextureAsset: false,
        generateHybridTextureAsset: false,
        generateSegmentedHybridAsset: false,
        globalTileConcurrency: Number(state.scheduler?.globalTileConcurrency || 20),
      },
    ));

    if (Number.isFinite(previewData?.minHeight)) globalMin = Math.min(globalMin, previewData.minHeight);
    if (Number.isFinite(previewData?.maxHeight)) globalMax = Math.max(globalMax, previewData.maxHeight);
    normalization.scannedTiles += 1;
    checkpoint(state);

    releaseTerrainResources(previewData);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  if (!Number.isFinite(globalMin) || !Number.isFinite(globalMax) || globalMax <= globalMin) {
    normalization.enabled = false;
    normalization.status = 'invalid';
    normalization.globalMinHeight = null;
    normalization.globalMaxHeight = null;
  } else {
    normalization.status = 'ready';
    normalization.globalMinHeight = globalMin;
    normalization.globalMaxHeight = globalMax;
  }

  checkpoint(state);
}

export async function runBatchJob(state, onProgress, onTileComplete, onError, signal) {
  ensureJobAndTileStates(state);

  if (!state.startedAt) state.startedAt = Date.now();
  state.status = JOB_STATES.RUNNING;
  sampleMemory(state, { label: 'job_start', force: true });
  checkpoint(state);

  const uninstallFetchCache = installBatchFetchCache();
  const compositeHeightmap = createCompositeHeightmapContext(state);
  const queues = buildQueues(state, (tile, stage, waitMs) => {
    addTiming(tile, stage, waitMs);
  });

  const processTileList = async (tiles, passLabel) => {
    for (const tile of tiles) {
      if (isPausedOrCanceled(signal, state)) {
        checkpoint(state);
        return;
      }

      if (tile.status === TILE_STATES.DONE || tile.status === TILE_STATES.SKIPPED) {
        continue;
      }

      state.currentTileIndex = tile.index;
      state.currentTileId = tile.id || null;
      onProgress({ tileIndex: tile.index, step: `Starting ${passLabel} tile ${getTileLabel(tile, state.gridCols)}...`, tile });
      checkpoint(state);

      try {
        await processTile(state, tile, {
          onProgress,
          onTileComplete,
          onError,
          onHeightmapGenerated: (completedTile, terrainData) => {
            writeTileToCompositeHeightmap(compositeHeightmap, state, completedTile, terrainData);
          },
          ...queues,
        }, signal);
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) {
          if (state.status !== JOB_STATES.CANCELED) {
            state.status = JOB_STATES.PAUSED;
          }
          checkpoint(state);
          return;
        }
      }
    }
  };

  await computeBatchElevationNormalization(state, queues.scheduleFetch, onProgress, signal);

  try {
    const initialTiles = state.tiles.filter((t) => t.status === TILE_STATES.QUEUED || t.status === TILE_STATES.FAILED);
    await processTileList(initialTiles, 'primary');

    if (state.status === JOB_STATES.RUNNING) {
      const retryTiles = state.tiles.filter((t) => t.status === TILE_STATES.FAILED && t.retryable);
      if (retryTiles.length > 0) {
        await processTileList(retryTiles, 'retry');
      }
    }

    if (state.status === JOB_STATES.RUNNING) {
      updateCounts(state);
      state.currentTileIndex = -1;
      state.currentTileId = null;
      state.completedAt = Date.now();
      state.status = state.totalFailed > 0 ? JOB_STATES.FAILED : JOB_STATES.COMPLETED;
      if (state.status === JOB_STATES.COMPLETED && compositeHeightmap?.writtenTiles?.size === state.tiles.length) {
        onProgress({ tileIndex: -1, step: 'Generating stitched grid heightmap...', tile: null });
        downloadCompositeHeightmap(state, compositeHeightmap);
      }
      if (state.totalCompleted > 0) {
        onProgress({ tileIndex: -1, step: 'Generating elevation report...', tile: null });
        downloadBatchElevationReport(state);
      }
      sampleMemory(state, { label: 'job_completed', force: true });
      checkpoint(state);
    }
  } finally {
    sampleMemory(state, { label: 'job_finally', force: true });
    checkpoint(state);
    queues.close();
    uninstallFetchCache();
  }
}
