/** @layer flow */
// Top-level terrain assembly: pick an elevation source (GPXZ → KRON86 → USGS →
// global tiles), stitch global tiles + resample to the metric grid, then attach
// OSM features and procedural textures. Orchestrator over the io modules.
import { fetchOSMData, fetchOSMDataWithInfo, getLastOSMRequestInfo, getOSMQueryParameters } from '@mapng/fetching';
import { fetchKron86GridForBounds, isWithinKron86Coverage } from '@mapng/fetching';
import { createLocalToWGS84 } from '@mapng/geo';
import { generateOSMTexture, generateHybridTexture } from "../osmTexture.js";
import { resampleHeightAndImageOffThread } from "../resamplerClient.js";
import { getOutputBounds } from "../terrainResampler.js";
import { normalizeLng, computeMetricFetchBounds } from './mercatorTiles.js';
import { NO_DATA_VALUE } from './heightDecode.js';
import { fetchGPXZRaw } from './gpxzFetch.js';
import { fetchUSGSRaw } from './usgsFetch.js';
import { fetchGlobalTileSamplers } from './globalTiles.js';
import { canvasToSatelliteBlobUrl } from './tileLoaders.js';

/**
 * Fetch and assemble a complete TerrainData object for the given centre point.
 *
 * Elevation pipeline (first successful source wins):
 *   1. GPXZ hires-raster (if useGPXZ + key provided)
 *   2. USGS 1 m DEM (if useUSGS and location is within CONUS / Alaska / Hawaii)
 *   3. AWS Terrarium global tiles (always fetched as satellite-texture fallback)
 *
 * Satellite texture is always sourced from Esri World Imagery at zoom 17
 * (~1.2 m/px), independent of the elevation source.
 *
 * Both height and image resampling are performed off-thread via a Web Worker
 * to avoid blocking the main thread during the expensive per-pixel loop.
 *
 * @param {object}   center             - { lat, lng }
 * @param {number}   resolution         - Output pixel size (= metres, at 1 m/px)
 * @param {boolean}  includeOSM         - Fetch OSM features and generate textures
 * @param {boolean}  useUSGS            - Attempt USGS 1 m DEM first
 * @param {boolean}  useGPXZ            - Attempt GPXZ hires elevation first
 * @param {boolean}  useKRON86          - Attempt KRON86 (Poland only) first
 * @param {string}   gpxzApiKey         - GPXZ API key (required when useGPXZ)
 * @param {string}   [baseColor]        - Tint for OSM texture generation
 * @param {Function} [onProgress]       - Callback(statusString) for UI progress updates
 * @param {AbortSignal} [signal]        - Cancellation signal
 * @param {object}   [generationOptions]
 * @returns {Promise<object>} TerrainData — heightMap, bounds, satellite/OSM textures, …
 */
export const fetchTerrainData = async (
  center,
  resolution,
  includeOSM = false,
  useUSGS = false,
  useGPXZ = false,
  useKRON86 = false,
  gpxzApiKey = "",
  baseColor = undefined,
  onProgress,
  signal,
  generationOptions = {},
) => {
  const {
    keepSourceGeoTiffs = true,
    generateOSMTextureAsset = true,
    generateHybridTextureAsset = true,
    globalTileConcurrency = 20,
    targetBounds = null,
  } = generationOptions || {};
  // Normalize longitude to handle world wrapping
  const normalizedCenter = {
    lat: center.lat,
    lng: normalizeLng(center.lng),
  };

  // 1. Define Target Metric Grid
  // Resolution is treated as "Output Size in Pixels" AND "Extent in Meters" (1m/px)
  const width = resolution;
  const height = resolution;

  onProgress?.("Calculating metric bounds...");

  const fetchBounds = targetBounds
    ? {
        north: Number(targetBounds.north),
        south: Number(targetBounds.south),
        east: normalizeLng(Number(targetBounds.east)),
        west: normalizeLng(Number(targetBounds.west)),
      }
    : computeMetricFetchBounds(normalizedCenter, width, height);

  // OSM is an independent Overpass query (often the slowest, most variable call
  // in this fetch) that only needs the final metric output bounds — which are
  // deterministic from center + size, identical to what the resample returns
  // (getOutputBounds, same createLocalToWGS84 projection). Kick it off now so its
  // round-trip overlaps the elevation/satellite tile download + resample instead
  // of running serially after them. Awaited just before terrainData assembly.
  // fetchOSMDataWithInfo never rejects (it catches internally → empty features),
  // so no unhandled-rejection guard is needed. Each call keeps its own
  // requestInfo, avoiding the getLastOSMRequestInfo() race under parallel chunks.
  const osmOutputBounds = getOutputBounds(
    createLocalToWGS84(normalizedCenter.lat, normalizedCenter.lng),
    width,
    height,
    targetBounds,
  );
  const osmPromise = includeOSM ? fetchOSMDataWithInfo(osmOutputBounds) : null;

  // 2. Try GPXZ / USGS
  let rawData = null;
  let rawDataSourceType = null;
  let usgsFallback = false;
  let kron86Fallback = false;
  let kron86FallbackReason = null;
  let shouldSmooth = false;
  let gpxzChunkFailures = false;
  let sourceGeoTiffs = undefined;

  if (useGPXZ && gpxzApiKey) {
    onProgress?.("Fetching high-res GPXZ elevation data...");
    const gpxzResult = await fetchGPXZRaw(fetchBounds, gpxzApiKey, onProgress, signal);
    if (gpxzResult) {
      rawData = gpxzResult.data;
      rawDataSourceType = "geotiff";
      shouldSmooth = gpxzResult.smooth;
      gpxzChunkFailures = !!gpxzResult.hadChunkFailures;
      if (keepSourceGeoTiffs) {
        sourceGeoTiffs = {
          arrayBuffers: gpxzResult.rawArrayBuffers,
          source: "gpxz",
        };
      }
    }
  }

  if (!rawData && useKRON86) {
    if (!isWithinKron86Coverage(fetchBounds)) {
      kron86Fallback = true;
      kron86FallbackReason = 'outside_poland';
      onProgress?.('NMT EVRF2007 covers Poland only. Falling back to global elevation tiles...');
    } else {
      onProgress?.('Fetching NMT EVRF2007 elevation index (Poland)...');
      try {
        const kron86Result = await fetchKron86GridForBounds(fetchBounds, { onProgress, signal });
        if (kron86Result?.gridMeta?.gridTiles?.length) {
          rawData = {
            tiles: kron86Result.gridMeta.gridTiles,
          };
          rawDataSourceType = 'grid';
        } else {
          kron86Fallback = true;
          kron86FallbackReason = kron86Result?.fallbackReason || 'unavailable';
          onProgress?.('NMT EVRF2007 data was unavailable for this area. Falling back to global elevation tiles...');
        }
      } catch (error) {
        console.warn('[NMT-EVRF2007] Failed to load NMT EVRF2007 elevation data:', error);
        kron86Fallback = true;
        kron86FallbackReason = 'request_failed';
        onProgress?.('NMT EVRF2007 request failed. Falling back to global elevation tiles...');
      }
    }
  }

  const isCONUS =
    fetchBounds.north < 50 &&
    fetchBounds.south > 24 &&
    fetchBounds.west > -125 &&
    fetchBounds.east < -66;
  const isAlaska =
    fetchBounds.north < 72 &&
    fetchBounds.south > 50 &&
    fetchBounds.west > -170 &&
    fetchBounds.east < -129;
  const isHawaii =
    fetchBounds.north < 23 &&
    fetchBounds.south > 18 &&
    fetchBounds.west > -161 &&
    fetchBounds.east < -154;

  if (!rawData && useUSGS && (isCONUS || isAlaska || isHawaii)) {
    const usgsResult = await fetchUSGSRaw(fetchBounds, onProgress, signal);
    if (usgsResult) {
      rawData = usgsResult.data;
      if (keepSourceGeoTiffs) {
        sourceGeoTiffs = {
          arrayBuffers: usgsResult.rawArrayBuffers,
          source: "usgs",
        };
      }
    } else {
      usgsFallback = true;
      console.warn(
        "[USGS] Failed to fetch raw data, falling back to global tiles.",
      );
    }
  }

  // 3. Prepare Samplers — fetch + stitch global tiles, build samplers + payloads.
  const { heightSampler, colorSampler, fallbackSamplerData, imageSamplerData } =
    await fetchGlobalTileSamplers({
      fetchBounds,
      rawData,
      sourceGeoTiffs,
      gpxzChunkFailures,
      globalTileConcurrency,
      onProgress,
      signal,
    });

  // 4. Resample Heightmap to Metric Grid
  signal?.throwIfAborted();
  onProgress?.("Resampling heightmap to 1m/px...");

  const { heightMap, bounds: finalBounds, canvas: finalSatCanvas } = await resampleHeightAndImageOffThread(
    {
      type: rawData ? (rawDataSourceType || "geotiff") : "sampler",
      data: rawData || undefined,
      sampler: heightSampler || undefined,
      transferRasters: !!rawData && (rawDataSourceType === "geotiff"),
    },
    colorSampler,
    normalizedCenter,
    width,
    height,
    "bilinear",
    shouldSmooth,
    fallbackSamplerData,
    // GPXZ is generally hole-free; if GPXZ chunks failed, keep fill enabled.
    !(useGPXZ && rawData && !gpxzChunkFailures),
    imageSamplerData,
    targetBounds,
  );

  // 6. Calculate Min/Max
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let i = 0; i < heightMap.length; i++) {
    const h = heightMap[i];
    if (h !== NO_DATA_VALUE) {
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }
  if (minHeight === Infinity) minHeight = 0;
  if (maxHeight === -Infinity) maxHeight = 0;

  // 7. Await OSM Data (the request was started up front so its latency overlaps
  // the tile fetch + resample above; by now it's usually already settled).
  let osmFeatures = [];
  let osmRequestInfo = null;
  if (includeOSM && osmPromise) {
    signal?.throwIfAborted();
    onProgress?.("Fetching OpenStreetMap data...");
    const osmResult = await osmPromise;
    osmFeatures = osmResult.features;
    osmRequestInfo = osmResult.requestInfo || {
      ...getOSMQueryParameters(osmOutputBounds),
      endpointUsed: null,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      elementCount: 0,
    };
  }

  onProgress?.("Finalizing terrain data...");
  const satelliteTextureUrl = await canvasToSatelliteBlobUrl(finalSatCanvas);
  // Free the (potentially huge) source canvas immediately — it's no longer needed
  // and holding onto it during OSM/hybrid texture generation exhausts memory at 16k.
  finalSatCanvas.width = 0;
  finalSatCanvas.height = 0;

  const terrainData = {
    heightMap,
    width,
    height,
    minHeight,
    maxHeight,
    satelliteTextureUrl,
    bounds: finalBounds,
    osmFeatures,
    osmRequestInfo,
    usgsFallback,
    kron86Fallback,
    kron86FallbackReason,
    sourceGeoTiffs,
  };

  if (includeOSM && osmFeatures.length > 0) {
    const options = { Roads: true, baseColor, onProgress };
    if (generateOSMTextureAsset) {
      onProgress?.("Generating OSM texture...");
      const osmResult = await generateOSMTexture(terrainData, options);
      terrainData.osmTextureUrl = osmResult.url;
      terrainData.osmTextureCanvas = osmResult.canvas;
      terrainData.osmTextureBlob = osmResult.blob || null;
    }

    if (generateHybridTextureAsset) {
      onProgress?.("Generating Hybrid texture...");
      const hybridResult = await generateHybridTexture(
        terrainData,
        options,
      );
      terrainData.hybridTextureUrl = hybridResult.url;
      terrainData.hybridTextureCanvas = hybridResult.canvas;
      terrainData.hybridTextureBlob = hybridResult.blob || null;
    }

  }

  return terrainData;
};

/**
 * Fetch OSM features for an existing TerrainData object and attach the
 * resulting procedural textures (OSM + hybrid) to a cloned copy.
 *
 * Called when the user enables the OSM toggle after terrain has already been
 * generated — avoids a full re-fetch of elevation and satellite tiles.
 *
 * @returns {Promise<object>} New TerrainData with osmFeatures + texture URLs added
 */
export const addOSMToTerrain = async (
  terrainData,
  baseColor = undefined,
  onProgress,
) => {
  onProgress?.("Fetching OpenStreetMap data...");
  const osmFeatures = await fetchOSMData(terrainData.bounds);
  const osmRequestInfo = getLastOSMRequestInfo() || {
    ...getOSMQueryParameters(terrainData.bounds),
    endpointUsed: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    elementCount: 0,
  };

  const newTerrainData = { ...terrainData, osmFeatures, osmRequestInfo };

  if (osmFeatures.length > 0) {
    const options = { Roads: true, baseColor, onProgress };
    onProgress?.("Generating OSM texture...");
    const osmResult = await generateOSMTexture(
      newTerrainData,
      options,
    );
    newTerrainData.osmTextureUrl = osmResult.url;
    newTerrainData.osmTextureCanvas = osmResult.canvas;
    newTerrainData.osmTextureBlob = osmResult.blob || null;
    onProgress?.("Generating Hybrid texture...");
    const hybridResult = await generateHybridTexture(
      newTerrainData,
      options,
    );
    newTerrainData.hybridTextureUrl = hybridResult.url;
    newTerrainData.hybridTextureCanvas = hybridResult.canvas;
    newTerrainData.hybridTextureBlob = hybridResult.blob || null;

  }

  return newTerrainData;
};
