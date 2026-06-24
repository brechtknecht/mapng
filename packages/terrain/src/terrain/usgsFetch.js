/** @layer io */
// USGS 3DEP 1-metre DEM fetching (CONUS/Alaska/Hawaii) + availability check.
import * as GeoTIFF from "geotiff";
import { getElevationCache, putElevationCache, usgsCacheKey } from '@mapng/fetching';
import { parseGeoTiffBuffers } from './heightDecode.js';

const USGS_PRODUCT_API = "https://tnmaccess.nationalmap.gov/api/v1/products";
const USGS_DATASET = "Digital Elevation Model (DEM) 1 meter";

/**
 * Fetch 1-metre DEM tiles from the USGS 3DEP National Map API.
 * Only covers CONUS, Alaska, and Hawaii — callers must check coverage first.
 *
 * Queries the USGS TNM Access product catalogue for GeoTIFF DEM tiles that
 * intersect the requested bounding box, then downloads them sequentially to
 * avoid memory exhaustion (1 m tiles are large). Retries transient network
 * failures up to MAX_RETRIES times with linear back-off.
 *
 * @returns {{ data: Array<{image, raster}>, rawArrayBuffers: ArrayBuffer[] } | null}
 */
export const fetchUSGSRaw = async (bounds, onProgress, signal) => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    signal?.throwIfAborted();

    // 0. Cache: identical bounds → reuse the previously downloaded DEM tiles
    // instead of re-querying the catalogue and re-downloading the GeoTIFFs.
    const cacheKey = usgsCacheKey(bounds);
    const cached = await getElevationCache(cacheKey);
    if (cached?.buffers?.length) {
      try {
        onProgress?.('Using cached USGS elevation data...');
        const data = await parseGeoTiffBuffers(cached.buffers);
        return { data, rawArrayBuffers: cached.buffers };
      } catch (e) {
        console.warn('[USGS] Cached buffers unreadable, refetching:', e);
      }
    }

    // 1. Query USGS API
    // Round coordinates to 6 decimal places to improve cache hit rate and reduce query string length
    const bbox = `${bounds.west.toFixed(6)},${bounds.south.toFixed(6)},${bounds.east.toFixed(6)},${bounds.north.toFixed(6)}`;
    // Limit to 4 tiles to cover corners/overlaps without overloading memory
    const url = `${USGS_PRODUCT_API}?datasets=${encodeURIComponent(USGS_DATASET)}&bbox=${bbox}&prodFormats=GeoTIFF&max=4`;

    console.log(`[USGS] Querying products: ${url}`);

    let response = null;
    let attempts = 0;

    while (attempts < MAX_RETRIES) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

        response = await fetch(url, {
          signal: signal || controller.signal,
          // Ensure no custom headers are sent to avoid preflight OPTIONS request which fails on USGS
          headers: {},
        });
        clearTimeout(timeoutId);

        if (response.ok) break;

        console.warn(
          `[USGS] API Query failed: ${response.status}. Retrying...`,
        );
      } catch (err) {
        console.warn(`[USGS] Network error: ${err}. Retrying...`);
      }

      attempts++;
      await sleep(RETRY_DELAY * attempts);
    }

    if (!response || !response.ok) {
      console.warn(`[USGS] Failed to query API after ${MAX_RETRIES} attempts.`);
      return null;
    }

    let data;
    try {
      const text = await response.text();
      data = JSON.parse(text);
    } catch (e) {
      console.warn(`[USGS] Failed to parse API response as JSON:`, e);
      return null;
    }

    if (!data.items || data.items.length === 0) {
      console.log(`[USGS] No products found for bounds.`);
      return null;
    }

    onProgress?.(`Found ${data.items.length} USGS tiles. Downloading...`);

    const results = [];
    const rawArrayBuffers = [];

    // 2. Download GeoTIFFs sequentially
    // We process sequentially to avoid memory exhaustion with large 1m tiles
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i];
      const downloadUrl = item.downloadURL;
      onProgress?.(`Downloading USGS tile ${i + 1}/${data.items.length}...`);
      signal?.throwIfAborted();

      try {
        const tiffResponse = await fetch(downloadUrl, { signal });
        if (!tiffResponse.ok) {
          console.warn(
            `[USGS] Failed to download tile: ${tiffResponse.status}`,
          );
          continue;
        }

        const arrayBuffer = await tiffResponse.arrayBuffer();

        // 3. Parse GeoTIFF
        const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
        const image = await tiff.getImage();
        const rasters = await image.readRasters();
        const raster = rasters[0]; // Height data

        await tiff.close();

        results.push({ image, raster });
        rawArrayBuffers.push(arrayBuffer);
      } catch (e) {
        console.warn(`[USGS] Failed to parse tile ${downloadUrl}`, e);
      }
    }

    if (results.length === 0) {
      console.warn("[USGS] All tile downloads failed.");
      return null;
    }

    // Cache only when every catalogued tile downloaded — a partial set would be
    // served forever, hiding tiles a retry could recover.
    if (results.length === data.items.length) {
      putElevationCache(cacheKey, { buffers: rawArrayBuffers });
    }
    return { data: results, rawArrayBuffers };
  } catch (e) {
    console.warn("Failed to load USGS terrain:", e);
    return null;
  }
};

/**
 * Quick health-check for the USGS TNM Access API.
 * Used by the elevation source selector to show/hide the USGS option.
 * @returns {Promise<boolean>}
 */
export const checkUSGSStatus = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    // Use empty headers to avoid preflight OPTIONS request
    const response = await fetch(`${USGS_PRODUCT_API}?max=1`, {
      headers: {},
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response.ok;
  } catch (e) {
    return false;
  }
};
