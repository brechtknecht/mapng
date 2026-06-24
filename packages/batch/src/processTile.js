/** @layer flow */
/**
 * processTile.js — The per-tile pipeline: fetch terrain → encode requested
 * exports into a zip → snapshot → metadata → retry policy. The renderer-coupled
 * heart of the batch runner (imports the export3d barrel, so not headless).
 *
 * processTile(state, tile, ctx, signal) is a function of explicit inputs (the
 * ctx carries the progress callbacks + the scheduling queues) — the seam the
 * batch-in-worker re-architecture (docs/refactor/08 §3) will marshal across.
 */

import JSZip from 'jszip';
import { fetchTerrainData } from '@mapng/bake/terrain';
import { exportToGLB, exportToDAE } from '@mapng/bake/export3d';
import {
  generateHeightmapBlob,
  generateSatelliteBlob,
  generateOSMTextureBlob,
  generateHybridTextureBlob,
  generateRoadMaskBlob,
  generateGeoTIFFBlob,
  generateGeoJSONBlob,
  generateTerBlob,
} from './batchExports.js';
import { JOB_STATES, TILE_STATES } from './batchRuntime.js';
import { classifyError, runWithRetry } from '@mapng/fetching';
import { getTileLabel, sanitizeFilenamePart } from './grid.js';
import { buildTileMetadata } from './batchReport.js';
import { sampleMemory, checkpoint } from './memorySampling.js';
import { addTiming, runTimedStage, updateCounts, sanitizeError } from './tileTiming.js';
import { shouldFetchOSMForBatch } from './tileQueues.js';
import { generateTileSnapshot, releaseTerrainResources } from './tileSnapshot.js';
import { triggerDownload, ensureExportBlobType } from './batchDownloads.js';

export async function processTile(state, tile, ctx, signal) {
  const {
    onProgress,
    onTileComplete,
    onError,
    onHeightmapGenerated,
    scheduleFetch,
    scheduleCompute,
    scheduleEncode,
  } = ctx;

  const shouldFetchOSM = shouldFetchOSMForBatch(state);

  const label = getTileLabel(tile, state.gridCols);
  tile.status = TILE_STATES.PROCESSING;
  tile.lifecycle = tile.lifecycle || {};
  tile.lifecycle.startedAt = Date.now();
  tile.lastError = null;
  tile.nextRetryAt = null;
  tile.retryable = false;
  tile.attempts = 0;
  const tileStartSample = sampleMemory(state, { tile, label: 'tile_start', force: true });
  if (tileStartSample) {
    tile.memory.startUsedBytes = tileStartSample.usedBytes;
  }
  checkpoint(state);

  const tileStart = Date.now();

  await runWithRetry(
    async (attempt) => {
      tile.attempts = attempt;
      const fetchStatus = { activeStage: null, startedAt: 0 };

      onProgress({
        tileIndex: tile.index,
        step: `OSM fetch ${shouldFetchOSM ? 'enabled' : 'disabled'} for ${label}`,
        tile,
      });

      const terrainData = await scheduleFetch(tile, () => runTimedStage(tile, 'fetch_total', async () => {
        onProgress({ tileIndex: tile.index, step: `Fetching terrain data (${label})...`, tile });
        const needsOsmTexture = !!(shouldFetchOSM && state.exports.osmTexture);
        const needsHybridTexture = !!(shouldFetchOSM && state.exports.hybridTexture);
        return fetchTerrainData(
          tile.center,
          state.resolution,
          shouldFetchOSM,
          state.elevationSource === 'usgs',
          state.elevationSource === 'gpxz',
          state.elevationSource === 'kron86',
          state.gpxzApiKey,
          undefined,
          (status) => {
            const now = performance.now();
            const next = /OpenStreetMap/.test(status)
              ? 'osm_fetch'
              : /Generating OSM texture/i.test(status)
                  ? 'osm_texture_generation'
                  : /Generating Hybrid texture/i.test(status)
                    ? 'hybrid_texture_generation'
                    : /(global tiles|Downloading .*terrain|Downloading .*satellite)/i.test(status)
                        ? 'imagery_fetch'
                        : /GPXZ|USGS|elevation/i.test(status)
                          ? 'elevation_fetch'
                          : null;

            if (fetchStatus.activeStage && fetchStatus.activeStage !== next) {
              addTiming(tile, fetchStatus.activeStage, now - fetchStatus.startedAt);
              fetchStatus.startedAt = now;
            }
            if (next && fetchStatus.activeStage !== next) {
              fetchStatus.activeStage = next;
              if (!fetchStatus.startedAt) fetchStatus.startedAt = now;
            }
            onProgress({ tileIndex: tile.index, step: status, tile });
            checkpoint(state);
          },
          signal,
          {
            keepSourceGeoTiffs: !!state.exports.geotiff,
            generateOSMTextureAsset: needsOsmTexture,
            generateHybridTextureAsset: needsHybridTexture,
            globalTileConcurrency: Number(state.scheduler?.globalTileConcurrency || 20),
          },
        );
      }));

      tile.lifecycle.fetchCompletedAt = Date.now();
      const sharedMin = state.elevationNormalization?.enabled
        && Number.isFinite(state.elevationNormalization.globalMinHeight)
          ? state.elevationNormalization.globalMinHeight
          : terrainData.minHeight;
      const sharedMax = state.elevationNormalization?.enabled
        && Number.isFinite(state.elevationNormalization.globalMaxHeight)
          ? state.elevationNormalization.globalMaxHeight
          : terrainData.maxHeight;
      const localRange = Number(terrainData.maxHeight) - Number(terrainData.minHeight);
      const encodedRange = Number(sharedMax) - Number(sharedMin);
      tile.elevationStats = {
        localMinHeight: Number(terrainData.minHeight),
        localMaxHeight: Number(terrainData.maxHeight),
        localRange,
        encodedMinHeight: Number(sharedMin),
        encodedMaxHeight: Number(sharedMax),
        encodedRange,
        deltaMinToEncoded: Number(terrainData.minHeight) - Number(sharedMin),
        deltaMaxToEncoded: Number(sharedMax) - Number(terrainData.maxHeight),
        extraEncodedRange: encodedRange - localRange,
      };
      const afterFetchSample = sampleMemory(state, { tile, label: 'after_fetch', force: true });
      if (afterFetchSample) {
        tile.memory.afterFetchUsedBytes = afterFetchSample.usedBytes;
      }

      checkpoint(state);

      const zip = new JSZip();
      const metadata = buildTileMetadata(state, tile, terrainData);
      zip.file('metadata.json', JSON.stringify(metadata, null, 2));

      if (state.exports.heightmap) {
        onProgress({ tileIndex: tile.index, step: 'Encoding heightmap...', tile });
        const sharedRange = state.elevationNormalization?.enabled
          && Number.isFinite(state.elevationNormalization.globalMinHeight)
          && Number.isFinite(state.elevationNormalization.globalMaxHeight)
            ? {
              minHeight: state.elevationNormalization.globalMinHeight,
              maxHeight: state.elevationNormalization.globalMaxHeight,
            }
            : null;
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_png_heightmap', async () => generateHeightmapBlob(terrainData, sharedRange)));
        if (blob) zip.file('heightmap_16bit.png', await ensureExportBlobType(blob, 'image/png'));
        onHeightmapGenerated?.(tile, terrainData);
        checkpoint(state);
      }

      if (state.exports.satellite) {
        onProgress({ tileIndex: tile.index, step: 'Encoding satellite texture...', tile });
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_png_satellite', async () => generateSatelliteBlob(terrainData)));
        if (blob) zip.file('satellite.png', await ensureExportBlobType(blob, 'image/png'));
        checkpoint(state);
      }

      if (state.exports.osmTexture && terrainData.osmTextureUrl) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_png_osm_texture', async () => generateOSMTextureBlob(terrainData)));
        if (blob) zip.file('osm_texture.png', await ensureExportBlobType(blob, 'image/png'));
        checkpoint(state);
      }

      if (state.exports.hybridTexture && terrainData.hybridTextureUrl) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_png_hybrid_texture', async () => generateHybridTextureBlob(terrainData)));
        if (blob) zip.file('hybrid_texture.png', await ensureExportBlobType(blob, 'image/png'));
        checkpoint(state);
      }

      if (state.exports.roadMask && terrainData.osmFeatures?.length > 0) {
        const blob = await scheduleCompute(tile, () => runTimedStage(tile, 'compute_road_mask', async () => generateRoadMaskBlob(terrainData, tile.center)));
        if (blob) zip.file('road_mask_16bit.png', await ensureExportBlobType(blob, 'image/png'));
        checkpoint(state);
      }

      if (state.exports.glb) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_glb', async () => exportToGLB(terrainData, {
          maxMeshResolution: state.glbMeshResolution,
          includeSurroundings: false,
          returnBlob: true,
          onProgress: (s) => onProgress({ tileIndex: tile.index, step: s, tile }),
        })));
        if (blob) zip.file('model.glb', await ensureExportBlobType(blob, 'model/gltf-binary', 'application/octet-stream'));
        checkpoint(state);
      }

      if (state.exports.dae) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_dae', async () => exportToDAE(terrainData, {
          maxMeshResolution: state.glbMeshResolution,
          includeSurroundings: false,
          returnBlob: true,
          onProgress: (s) => onProgress({ tileIndex: tile.index, step: s, tile }),
        })));
        if (blob) zip.file('model.dae.zip', await ensureExportBlobType(blob, 'application/zip'));
        checkpoint(state);
      }

      if (state.exports.geotiff) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_geotiff', async () => generateGeoTIFFBlob(terrainData, tile.center)));
        if (blob) zip.file('heightmap.tif', await ensureExportBlobType(blob, 'image/tiff'));
        checkpoint(state);
      }

      if (state.exports.ter) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_ter', async () => generateTerBlob(terrainData)));
        if (blob) zip.file('terrain.ter', await ensureExportBlobType(blob, 'application/octet-stream', 'application/octet-stream'));
        checkpoint(state);
      }

      if (state.exports.geojson && terrainData.osmFeatures?.length > 0) {
        const blob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_geojson', async () => generateGeoJSONBlob(terrainData)));
        if (blob) zip.file('features.geojson', await ensureExportBlobType(blob, 'application/geo+json', 'application/geo+json'));
        checkpoint(state);
      }

      const tileSnapshot = await runTimedStage(tile, 'snapshot_generation', async () => generateTileSnapshot(terrainData, state));
      tile.snapshot = tileSnapshot;

      const beforeZipSample = sampleMemory(state, { tile, label: 'before_zip', force: true });
      if (beforeZipSample) {
        tile.memory.beforeZipUsedBytes = beforeZipSample.usedBytes;
      }

      releaseTerrainResources(terrainData);
      await new Promise(r => setTimeout(r, 0));

      const zipBlob = await scheduleEncode(tile, () => runTimedStage(tile, 'encode_zip', async () => {
        try {
          return await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });
        } catch {
          return await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        }
      }));

      tile.lifecycle.zipCompletedAt = Date.now();
      const afterZipSample = sampleMemory(state, { tile, label: 'after_zip', force: true });
      if (afterZipSample) {
        tile.memory.afterZipUsedBytes = afterZipSample.usedBytes;
      }

      const date = new Date().toISOString().slice(0, 10);
      triggerDownload(zipBlob, `MapNG_Batch_${sanitizeFilenamePart(label)}_${date}_${tile.center.lat.toFixed(4)}_${tile.center.lng.toFixed(4)}.zip`);

      tile.status = TILE_STATES.DONE;
      tile.lifecycle.completedAt = Date.now();
      tile.lifecycle.totalMs = tile.lifecycle.startedAt
        ? Math.max(0, tile.lifecycle.completedAt - tile.lifecycle.startedAt)
        : 0;
      state.tileCompletionTimes.push(Date.now() - tileStart);
      updateCounts(state);
      checkpoint(state);
      onTileComplete(tile);

      await new Promise(r => setTimeout(r, 120));
      const endSample = sampleMemory(state, { tile, label: 'post_cleanup', force: true });
      if (endSample) {
        tile.memory.endUsedBytes = endSample.usedBytes;
      }
    },
    {
      maxAttempts: 3,
      signal,
      onRetry: ({ attempt, waitMs, classification, error }) => {
        tile.retryable = true;
        tile.nextRetryAt = new Date(Date.now() + waitMs).toISOString();
        const detail = sanitizeError(error, classification, attempt, waitMs);
        tile.lastError = detail;
        tile.errors.push(detail);
        checkpoint(state);
      },
    },
  ).catch((error) => {
    const classification = classifyError(error);
    const detail = sanitizeError(error, classification, tile.attempts || 1, null);
    tile.lastError = detail;
    tile.errors.push(detail);
    tile.retryable = classification.retryable;
    tile.status = classification.kind === 'aborted' && state.status === JOB_STATES.PAUSED
      ? TILE_STATES.QUEUED
      : TILE_STATES.FAILED;
    updateCounts(state);
    checkpoint(state);
    onError(tile, error);
    throw error;
  });
}
