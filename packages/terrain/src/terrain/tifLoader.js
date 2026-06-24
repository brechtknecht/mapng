/** @layer io */
// BYOD GeoTIFF elevation loader: build TerrainData from a user-uploaded TIF.
// Satellite tiles + OSM are still fetched from the network so overlays/textures
// match the normal flow.
import { fetchOSMData, getLastOSMRequestInfo, getOSMQueryParameters } from '@mapng/fetching';
import { generateOSMTexture, generateHybridTexture } from "../osmTexture.js";
import {
  resampleHeightAndImageOffThread,
  resampleImageOffThread,
} from "../resamplerClient.js";
import {
  project,
  TILE_SIZE,
  SATELLITE_ZOOM,
  SATELLITE_API_URL,
  normalizeLng,
  computeMetricFetchBounds,
} from './mercatorTiles.js';
import {
  NO_DATA_VALUE,
  resolveElevationUnitScale,
  convertHeightMapToMeters,
} from './heightDecode.js';
import { pMap } from './pMap.js';
import { loadSatelliteTileCached, canvasToSatelliteBlobUrl } from './tileLoaders.js';

/**
 * Generate terrain data from a user-uploaded TIF file instead of fetching
 * elevation from GPXZ/USGS/Terrarium.
 *
 * Satellite tiles are still fetched normally from the network using the
 * coordinates, so OSM overlays and textures work exactly as in the normal flow.
 *
 * @param {object} tifData     - Parsed result from parseTifFile()
 * @param {object} center      - { lat, lng } — from GeoTIFF metadata or user input
 * @param {number} resolution  - Output size in pixels (= metres at 1m/px)
 * @param {boolean} includeOSM
 * @param {Function} onProgress
 * @param {AbortSignal} signal
 * @param {object} generationOptions
 */
export const loadTerrainFromTif = async (
  tifData,
  center,
  resolution,
  includeOSM = false,
  onProgress,
  signal,
  generationOptions = {},
) => {
  const {
    generateOSMTextureAsset = true,
    generateHybridTextureAsset = true,
    globalTileConcurrency = 20,
    elevationUnitOverride = 'auto',
    targetBounds = null,
    preferNativeCoverage = true,
  } = generationOptions || {};

  const normalizedCenter = { lat: center.lat, lng: normalizeLng(center.lng) };
  const emitProgress = (update) => onProgress?.(update);
  let width;
  let height;
  let fetchBounds;
  const hasTargetBounds = targetBounds && ['north', 'south', 'east', 'west'].every((key) => Number.isFinite(Number(targetBounds[key])));

  emitProgress('Calculating metric bounds...');

  if (hasTargetBounds) {
    width = resolution;
    height = resolution;
    fetchBounds = {
      north: Number(targetBounds.north),
      south: Number(targetBounds.south),
      east: normalizeLng(Number(targetBounds.east)),
      west: normalizeLng(Number(targetBounds.west)),
    };
  } else if (preferNativeCoverage && tifData.bounds && tifData.nativeWidth && tifData.nativeHeight) {
    width = tifData.nativeWidth;
    height = tifData.nativeHeight;
    fetchBounds = {
      north: tifData.bounds.north,
      south: tifData.bounds.south,
      east: normalizeLng(tifData.bounds.east),
      west: normalizeLng(tifData.bounds.west),
    };
  } else {
    width = resolution;
    height = resolution;
    fetchBounds = computeMetricFetchBounds(normalizedCenter, width, height);
  }

  // ── Satellite tiles (same as fetchTerrainData, no terrain tiles needed) ────
  const satNw = project(fetchBounds.north, fetchBounds.west, SATELLITE_ZOOM);
  const satSe = project(fetchBounds.south, fetchBounds.east, SATELLITE_ZOOM);
  const satMinTileX = Math.floor(satNw.x / TILE_SIZE);
  const satMinTileY = Math.floor(satNw.y / TILE_SIZE);
  const satMaxTileX = Math.floor(satSe.x / TILE_SIZE);
  const satMaxTileY = Math.floor(satSe.y / TILE_SIZE);
  const satTileCountX = satMaxTileX - satMinTileX + 1;
  const satTileCountY = satMaxTileY - satMinTileY + 1;

  const satCanvas = document.createElement('canvas');
  satCanvas.width  = satTileCountX * TILE_SIZE;
  satCanvas.height = satTileCountY * TILE_SIZE;
  const sCtx = satCanvas.getContext('2d', { willReadFrequently: true });
  if (!sCtx) throw new Error('Failed to create satellite canvas context');

  const satRequests = [];
  for (let tx = satMinTileX; tx <= satMaxTileX; tx++)
    for (let ty = satMinTileY; ty <= satMaxTileY; ty++)
      satRequests.push({ tx, ty });

  emitProgress({
    status: `Downloading ${satRequests.length} satellite tiles...`,
    percent: 0,
    detail: `0/${satRequests.length} tiles`,
  });
  let completed = 0;
  await pMap(satRequests, async ({ tx, ty }) => {
    completed++;
    if (completed % 10 === 0 || completed === satRequests.length) {
      emitProgress({
        status: `Downloading ${satRequests.length} satellite tiles...`,
        percent: (completed / Math.max(1, satRequests.length)) * 100,
        detail: `${completed}/${satRequests.length} tiles`,
      });
    }
    const numTiles = Math.pow(2, SATELLITE_ZOOM);
    const wrappedTx = ((tx % numTiles) + numTiles) % numTiles;
    const satUrl = `${SATELLITE_API_URL}/${SATELLITE_ZOOM}/${ty}/${wrappedTx}`;
    const sImg = await loadSatelliteTileCached(satUrl, SATELLITE_ZOOM, wrappedTx, ty, signal);
    const drawX = (tx - satMinTileX) * TILE_SIZE;
    const drawY = (ty - satMinTileY) * TILE_SIZE;
    if (sImg) sCtx.drawImage(sImg, drawX, drawY);
    else { sCtx.fillStyle = '#1a1a1a'; sCtx.fillRect(drawX, drawY, TILE_SIZE, TILE_SIZE); }
  }, Math.max(1, Number(globalTileConcurrency || 20)), signal);

  const satDataImg = sCtx.getImageData(0, 0, satCanvas.width, satCanvas.height);
  const colorSampler = (lat, lng) => {
    const p = project(lat, lng, SATELLITE_ZOOM);
    const localX = p.x - satMinTileX * TILE_SIZE;
    const localY = p.y - satMinTileY * TILE_SIZE;
    const x = Math.floor(localX);
    const y = Math.floor(localY);
    if (x < 0 || x >= satDataImg.width || y < 0 || y >= satDataImg.height)
      return { r: 0, g: 0, b: 0, a: 255 };
    const i = (y * satDataImg.width + x) * 4;
    return { r: satDataImg.data[i], g: satDataImg.data[i+1], b: satDataImg.data[i+2], a: satDataImg.data[i+3] };
  };

  // ── Resample TIF heightmap to metric grid ───────────────────────────────────
  signal?.throwIfAborted();
  console.info(`[BYOD] Resampling ${tifData.gridTiles?.length || 1} uploaded tile(s) to ${width}x${height}.`);
  emitProgress({ status: 'Mapping uploaded elevation to the output grid...', percent: 0 });

  let heightMap, finalBounds;
  let finalSatCanvas = null;

  if (tifData.bounds) {
    // Known CRS — use geographic coordinate mapping through the worker
    const imageSamplerData = {
      pixels: satDataImg.data,
      width: satDataImg.width,
      height: satDataImg.height,
      zoom: SATELLITE_ZOOM,
      minTileX: satMinTileX,
      minTileY: satMinTileY,
    };
    const source = tifData.sourceType === 'grid'
      ? { type: 'grid', data: { tiles: tifData.gridTiles || [] } }
      : { type: 'geotiff', data: [{ image: tifData.image, raster: tifData.raster }] };
    const result = await resampleHeightAndImageOffThread(
      source,
      colorSampler,
      normalizedCenter,
      width,
      height,
      'bilinear',
      false,
      null,
      true,
      imageSamplerData,
      hasTargetBounds ? fetchBounds : null,
      (progress) => emitProgress({
        status: progress.message || 'Mapping uploaded elevation to the output grid...',
        percent: Number.isFinite(progress.percent) ? progress.percent : null,
        detail: Number.isFinite(progress.current) && Number.isFinite(progress.total)
          ? `${progress.current}/${progress.total}`
          : null,
        stage: progress.stage || null,
      }),
    );
    heightMap = result.heightMap;
    finalBounds = result.bounds;
    finalSatCanvas = result.canvas;
  } else {
    // Unknown/user-defined CRS — stretch TIF directly to output grid via bilinear scaling.
    // The user has positioned the map on the correct location, so we fill the selected area
    // with the TIF data regardless of coordinate metadata.
    const srcW = tifData.sourceWidth;
    const srcH = tifData.sourceHeight;
    const noDataVal = tifData.noData ?? -99999;
    heightMap = new Float32Array(width * height);

    for (let oy = 0; oy < height; oy++) {
      for (let ox = 0; ox < width; ox++) {
        const sx = (ox / (width - 1)) * (srcW - 1);
        const sy = (oy / (height - 1)) * (srcH - 1);
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(srcW - 1, x0 + 1);
        const y1 = Math.min(srcH - 1, y0 + 1);
        const tx = sx - x0;
        const ty = sy - y0;
        const h00 = tifData.raster[y0 * srcW + x0];
        const h10 = tifData.raster[y0 * srcW + x1];
        const h01 = tifData.raster[y1 * srcW + x0];
        const h11 = tifData.raster[y1 * srcW + x1];
        const anyNoData = [h00, h10, h01, h11].some(
          h => h === noDataVal || !Number.isFinite(h)
        );
        heightMap[oy * width + ox] = anyNoData
          ? noDataVal
          : h00 * (1-tx) * (1-ty) + h10 * tx * (1-ty) + h01 * (1-tx) * ty + h11 * tx * ty;
      }
    }
    finalBounds = fetchBounds;
  }

  const tifUnit = resolveElevationUnitScale(tifData, elevationUnitOverride);
  convertHeightMapToMeters(heightMap, tifUnit.scale);

  // ── Resample satellite texture ───────────────────────────────────────────────
  if (!finalSatCanvas) {
    signal?.throwIfAborted();
    emitProgress({ status: 'Resampling satellite texture...', percent: null, detail: null });
    const imageSamplerData = {
      pixels: satDataImg.data,
      width: satDataImg.width,
      height: satDataImg.height,
      zoom: SATELLITE_ZOOM,
      minTileX: satMinTileX,
      minTileY: satMinTileY,
    };
    finalSatCanvas = await resampleImageOffThread(
      { sampler: colorSampler },
      normalizedCenter,
      width,
      height,
      imageSamplerData,
      hasTargetBounds ? fetchBounds : null,
    );
  }

  // ── Min/Max ──────────────────────────────────────────────────────────────────
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    const h = heightMap[i];
    if (h !== NO_DATA_VALUE) {
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }
  if (minHeight === Infinity)  minHeight = 0;
  if (maxHeight === -Infinity) maxHeight = 0;

  // ── OSM ──────────────────────────────────────────────────────────────────────
  let osmFeatures = [];
  let osmRequestInfo = null;
  if (includeOSM) {
    signal?.throwIfAborted();
    emitProgress('Fetching OpenStreetMap data...');
    osmFeatures = await fetchOSMData(finalBounds);
    osmRequestInfo = getLastOSMRequestInfo() || {
      ...getOSMQueryParameters(finalBounds),
      endpointUsed: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elementCount: 0,
    };
  }

  emitProgress('Finalizing terrain data...');
  const satelliteTextureUrl = await canvasToSatelliteBlobUrl(finalSatCanvas);
  finalSatCanvas.width = 0;
  finalSatCanvas.height = 0;

  const terrainData = {
    heightMap, width, height, minHeight, maxHeight,
    satelliteTextureUrl,
    bounds: finalBounds,
    osmFeatures, osmRequestInfo,
    usgsFallback: false,
    sourceGeoTiffs: undefined,
    // Custom upload exports default to full processed dimensions.
    exportCropSize: null,
    elevationUnitApplied: {
      selected: elevationUnitOverride,
      detected: tifData.verticalUnitDetected || 'unknown',
      detectionSource: tifData.verticalUnitDetectionSource || null,
      scaleToMeters: tifUnit.scale,
      source: tifUnit.source,
    },
  };

  if (includeOSM && osmFeatures.length > 0) {
    const options = { Roads: true, onProgress };
    if (generateOSMTextureAsset) {
      onProgress?.('Generating OSM texture...');
      const osmResult = await generateOSMTexture(terrainData, options);
      terrainData.osmTextureUrl    = osmResult.url;
      terrainData.osmTextureCanvas = osmResult.canvas;
      terrainData.osmTextureBlob   = osmResult.blob || null;
    }
    if (generateHybridTextureAsset) {
      onProgress?.('Generating Hybrid texture...');
      const hybridResult = await generateHybridTexture(terrainData, options);
      terrainData.hybridTextureUrl    = hybridResult.url;
      terrainData.hybridTextureCanvas = hybridResult.canvas;
      terrainData.hybridTextureBlob   = hybridResult.blob || null;
    }
  }

  return terrainData;
};
