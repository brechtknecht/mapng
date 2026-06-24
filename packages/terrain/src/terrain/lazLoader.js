/** @layer io */
// BYOD LAZ/LAS point-cloud elevation loader: rasterize the point cloud to a
// metric grid. Satellite tiles + OSM are still fetched from the network so
// overlays/textures match the normal flow.
import { fetchOSMData, getLastOSMRequestInfo, getOSMQueryParameters } from '@mapng/fetching';
import { rasterizeLazOffThread } from '@mapng/fetching';
import { generateOSMTexture, generateHybridTexture } from "../osmTexture.js";
import { resampleImageOffThread } from "../resamplerClient.js";
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

// ─── LAZ/LAS terrain loader ───────────────────────────────────────────────────
export const loadTerrainFromLaz = async (
  lazData,
  center,
  resolution,
  includeOSM = false,
  onProgress,
  signal,
  generationOptions = {},
) => {
  const {
    generateOSMTextureAsset      = true,
    generateHybridTextureAsset   = true,
    globalTileConcurrency        = 20,
    elevationUnitOverride        = 'auto',
    targetBounds                 = null,
    preferNativeCoverage         = true,
  } = generationOptions || {};

  const normalizedCenter = { lat: center.lat, lng: normalizeLng(center.lng) };

  onProgress?.('Calculating metric bounds...');

  // If the LAZ has known WGS84 bounds + native pixel dimensions, use them
  // directly — this anchors both the heightmap and OSM to the exact same
  // geographic rectangle, eliminating the centre ± resolution/2 approximation
  // error that caused terrain/OSM misalignment for non-metric CRS files.
  // Fall back to the user-selected resolution when precise bounds are missing.
  let width, height, fetchBounds;
  const hasTargetBounds = targetBounds && ['north', 'south', 'east', 'west'].every((key) => Number.isFinite(Number(targetBounds[key])));
  if (hasTargetBounds) {
    width = resolution;
    height = resolution;
    fetchBounds = {
      north: Number(targetBounds.north),
      south: Number(targetBounds.south),
      east: normalizeLng(Number(targetBounds.east)),
      west: normalizeLng(Number(targetBounds.west)),
    };
  } else if (preferNativeCoverage && lazData.bounds && lazData.nativeWidth && lazData.nativeHeight) {
    width       = lazData.nativeWidth;
    height      = lazData.nativeHeight;
    fetchBounds = {
      north: lazData.bounds.north,
      south: lazData.bounds.south,
      east:  normalizeLng(lazData.bounds.east),
      west:  normalizeLng(lazData.bounds.west),
    };
  } else {
    width  = resolution;
    height = resolution;
    fetchBounds = computeMetricFetchBounds(normalizedCenter, width, height);
  }

  // ── Satellite tiles ───────────────────────────────────────────────────────
  const satNw = project(fetchBounds.north, fetchBounds.west, SATELLITE_ZOOM);
  const satSe = project(fetchBounds.south, fetchBounds.east, SATELLITE_ZOOM);
  const satMinTileX   = Math.floor(satNw.x / TILE_SIZE);
  const satMinTileY   = Math.floor(satNw.y / TILE_SIZE);
  const satMaxTileX   = Math.floor(satSe.x / TILE_SIZE);
  const satMaxTileY   = Math.floor(satSe.y / TILE_SIZE);
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

  onProgress?.(`Downloading ${satRequests.length} satellite tiles...`);
  let completed = 0;
  await pMap(satRequests, async ({ tx, ty }) => {
    completed++;
    if (completed % 10 === 0 || completed === satRequests.length)
      onProgress?.(`Downloaded ${completed}/${satRequests.length} satellite tiles...`);
    const numTiles  = Math.pow(2, SATELLITE_ZOOM);
    const wrappedTx = ((tx % numTiles) + numTiles) % numTiles;
    const satUrl    = `${SATELLITE_API_URL}/${SATELLITE_ZOOM}/${ty}/${wrappedTx}`;
    const sImg = await loadSatelliteTileCached(satUrl, SATELLITE_ZOOM, wrappedTx, ty, signal);
    const drawX = (tx - satMinTileX) * TILE_SIZE;
    const drawY = (ty - satMinTileY) * TILE_SIZE;
    if (sImg) sCtx.drawImage(sImg, drawX, drawY);
    else { sCtx.fillStyle = '#1a1a1a'; sCtx.fillRect(drawX, drawY, TILE_SIZE, TILE_SIZE); }
  }, Math.max(1, Number(globalTileConcurrency || 20)), signal);

  const satDataImg   = sCtx.getImageData(0, 0, satCanvas.width, satCanvas.height);
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

  // ── Rasterize point cloud ─────────────────────────────────────────────────
  signal?.throwIfAborted();
  onProgress?.('Processing point cloud...');
  const rasterCenter = hasTargetBounds
    ? {
        lat: (fetchBounds.north + fetchBounds.south) / 2,
        lng: (fetchBounds.east + fetchBounds.west) / 2,
      }
    : normalizedCenter;

  const { heightMap } = await rasterizeLazOffThread(
    lazData,
    rasterCenter,
    width,
    height,
    (current, total, status) => {
      const pct = total > 0 ? Math.round(current / total * 100) : 0;
      onProgress?.(status || `Processing point cloud… ${pct}%`);
    },
  );

  const lazUnit = resolveElevationUnitScale(lazData, elevationUnitOverride);
  convertHeightMapToMeters(heightMap, lazUnit.scale);

  // ── Resample satellite texture ────────────────────────────────────────────
  signal?.throwIfAborted();
  onProgress?.('Resampling satellite texture...');
  const imageSamplerData = {
    pixels:   satDataImg.data,
    width:    satDataImg.width,
    height:   satDataImg.height,
    zoom:     SATELLITE_ZOOM,
    minTileX: satMinTileX,
    minTileY: satMinTileY,
  };
  const finalSatCanvas = await resampleImageOffThread(
    { sampler: colorSampler },
    rasterCenter,
    width,
    height,
    imageSamplerData,
    hasTargetBounds ? fetchBounds : null,
  );

  // ── Min / Max ─────────────────────────────────────────────────────────────
  let minHeight = Infinity, maxHeight = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    const h = heightMap[i];
    if (h !== NO_DATA_VALUE) {
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }
  if (minHeight ===  Infinity) minHeight = 0;
  if (maxHeight === -Infinity) maxHeight = 0;

  // ── OSM ───────────────────────────────────────────────────────────────────
  let osmFeatures = [], osmRequestInfo = null;
  if (includeOSM) {
    signal?.throwIfAborted();
    onProgress?.('Fetching OpenStreetMap data...');
    osmFeatures = await fetchOSMData(fetchBounds);
    osmRequestInfo = getLastOSMRequestInfo() || {
      ...getOSMQueryParameters(fetchBounds),
      endpointUsed: null,
      startedAt:    new Date().toISOString(),
      completedAt:  new Date().toISOString(),
      elementCount: 0,
    };
  }

  onProgress?.('Finalizing terrain data...');
  const satelliteTextureUrl = await canvasToSatelliteBlobUrl(finalSatCanvas);
  finalSatCanvas.width = 0;
  finalSatCanvas.height = 0;

  const terrainData = {
    heightMap, width, height, minHeight, maxHeight,
    satelliteTextureUrl,
    bounds: fetchBounds,
    osmFeatures, osmRequestInfo,
    usgsFallback:   false,
    sourceGeoTiffs: undefined,
    elevationUnitApplied: {
      selected: elevationUnitOverride,
      detected: lazData.verticalUnitDetected || 'unknown',
      detectionSource: lazData.verticalUnitDetectionSource || null,
      scaleToMeters: lazUnit.scale,
      source: lazUnit.source,
    },
    // Custom upload exports default to full processed dimensions.
    exportCropSize: null,
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
