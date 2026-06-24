/** @layer io */
// GPXZ hires-raster elevation fetching + plan/rate-limit discovery.
import * as GeoTIFF from "geotiff";
import { getElevationCache, putElevationCache, gpxzCacheKey } from '@mapng/fetching';
import { normalizeLng } from './mercatorTiles.js';
import { parseGeoTiffBuffers } from './heightDecode.js';
import { pMap } from './pMap.js';

// ─── GPXZ Rate Limit Discovery & State ─────────────────────────────
// Cached state about the user's GPXZ plan limits
let gpxzRateLimitInfo = null;

/**
 * Probe the GPXZ API to discover the user's plan limits.
 * Makes a lightweight /v1/elevation/point request and reads rate-limit headers.
 * Returns { used, limit, remaining, resetSec, rps, concurrency, plan }
 */
export async function probeGPXZLimits(apiKey, signal) {
  try {
    const resp = await fetch(
      '/api/gpxz/v1/elevation/point?lat=0&lon=0',
      { headers: { 'x-api-key': apiKey }, signal }
    );

    const used = parseInt(resp.headers.get('x-ratelimit-used') || '0', 10);
    const limit = parseInt(resp.headers.get('x-ratelimit-limit') || '100', 10);
    const remainingHeader = resp.headers.get('x-ratelimit-remaining');
    const remaining = remainingHeader !== null ? parseInt(remainingHeader, 10) : Math.max(0, limit - used);
    const resetSec = parseInt(resp.headers.get('x-ratelimit-reset') || '0', 10);

    // Determine plan tier and concurrency from daily limit
    // Free: 100/day, 1 rps → concurrency 1
    // Small: 2,500/day, 10 rps → concurrency 8
    // Large: 7,500/day, 25 rps → concurrency 20
    // Advanced: >7,500/day → concurrency 20
    let plan, rps, concurrency;
    if (limit <= 100) {
      plan = 'free';
      rps = 1;
      concurrency = 1;
    } else if (limit <= 2500) {
      plan = 'small';
      rps = 10;
      concurrency = 8;
    } else {
      plan = 'large';
      rps = 25;
      concurrency = 20;
    }

    const info = { used, limit, remaining, resetSec, rps, concurrency, plan, valid: resp.ok };
    gpxzRateLimitInfo = info;
    console.log(`[GPXZ] Plan: ${plan} | Limit: ${limit}/day | Used: ${used} | Remaining: ${remaining} | Concurrency: ${concurrency}`);
    return info;
  } catch (e) {
    console.warn('[GPXZ] Failed to probe rate limits:', e);
    // Fallback to free-tier assumptions
    const fallback = { used: 0, limit: 100, remaining: 100, resetSec: 0, rps: 1, concurrency: 1, plan: 'free', valid: false };
    gpxzRateLimitInfo = fallback;
    return fallback;
  }
}

/**
 * Update cached rate limit info from response headers (called after each request).
 */
function updateRateLimitFromHeaders(response) {
  if (!gpxzRateLimitInfo) return;
  const used = response.headers.get('x-ratelimit-used');
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (used) gpxzRateLimitInfo.used = parseInt(used, 10);
  if (remaining !== null) {
    gpxzRateLimitInfo.remaining = parseInt(remaining, 10);
  } else if (used) {
    gpxzRateLimitInfo.remaining = Math.max(0, gpxzRateLimitInfo.limit - gpxzRateLimitInfo.used);
  }
}

/** Get the last known GPXZ rate limit info */
export function getGPXZRateLimitInfo() {
  return gpxzRateLimitInfo;
}

/**
 * Fetch high-resolution elevation data from the GPXZ hires-raster API.
 *
 * Flow:
 *  1. Probe the user's plan limits (once per session) to set concurrency + per-worker delay.
 *  2. Sample five representative points to decide whether to smooth the output
 *     (coarse-resolution data is common outside urban areas).
 *  3. Chunk the bounding box into ≤9 km² pieces (the API limit is 10 km²) with
 *     ~220 m overlaps so tile seams don't leave gaps after merging.
 *  4. Fetch chunks concurrently at plan-appropriate parallelism with retry logic
 *     for 429 rate-limit responses and mid-stream network failures.
 *
 * @returns {{ data, smooth, rawArrayBuffers, hadChunkFailures } | null}
 */
export const fetchGPXZRaw = async (bounds, apiKey, onProgress, signal) => {
  try {
    signal?.throwIfAborted();

    // 0. Cache: identical bounds + api-key → reuse the previously fetched DEM
    // bytes instead of re-probing and re-downloading every chunk.
    const cacheKey = gpxzCacheKey(bounds, apiKey);
    const cached = await getElevationCache(cacheKey);
    if (cached?.buffers?.length) {
      try {
        onProgress?.('Using cached GPXZ elevation data...');
        const data = await parseGeoTiffBuffers(cached.buffers);
        return {
          data,
          smooth: !!cached.smooth,
          rawArrayBuffers: cached.buffers,
          hadChunkFailures: !!cached.hadChunkFailures,
        };
      } catch (e) {
        console.warn('[GPXZ] Cached buffers unreadable, refetching:', e);
      }
    }

    // 1. Probe rate limits if not already known
    if (!gpxzRateLimitInfo) {
      onProgress?.('Checking GPXZ account limits...');
      await probeGPXZLimits(apiKey, signal);
    }

    const rateInfo = gpxzRateLimitInfo;
    const concurrency = rateInfo?.concurrency || 1;
    const rps = rateInfo?.rps || 1;
    // Delay between requests per worker to stay under rps limit
    // e.g. 8 workers at 10 rps → each worker delays 800ms between requests
    // Free tier gets a 200ms buffer to avoid 429s from timing jitter
    const rawDelay = Math.ceil((concurrency / rps) * 1000);
    const perWorkerDelayMs = (rateInfo?.plan === 'free') ? Math.max(rawDelay, 1200) : rawDelay;

    // 2. Check resolution profile via Points API.
    // Sample center + near-corners so smoothing reflects mixed-coverage areas.
    const centerLat = (bounds.north + bounds.south) / 2;
    const centerLng = (bounds.east + bounds.west) / 2;
    const latInset = (bounds.north - bounds.south) * 0.2;
    const lngInset = (bounds.east - bounds.west) * 0.2;
    const sampledLatLons = [
      [centerLat, centerLng],
      [bounds.north - latInset, bounds.west + lngInset],
      [bounds.north - latInset, bounds.east - lngInset],
      [bounds.south + latInset, bounds.west + lngInset],
      [bounds.south + latInset, bounds.east - lngInset],
    ];

    let shouldSmooth = false;
    try {
      // Wait before the points check to avoid 429 from the probe request
      await new Promise((r) => setTimeout(r, perWorkerDelayMs));
      const latlons = sampledLatLons.map(([lat, lng]) => `${lat},${lng}`).join('|');
      const pointsUrl = `/api/gpxz/v1/elevation/points?latlons=${encodeURIComponent(latlons)}`;
      const pointsResp = await fetch(pointsUrl, {
        headers: { "x-api-key": apiKey },
        signal,
      });
      if (pointsResp.ok) {
        const pointsData = await pointsResp.json();
        if (pointsData.results && pointsData.results.length > 0) {
          const resolutions = pointsData.results
            .map((r) => Number(r?.resolution))
            .filter((r) => Number.isFinite(r));

          if (resolutions.length > 0) {
            const coarseCount = resolutions.filter((r) => r > 2).length;
            const sorted = [...resolutions].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            const minRes = sorted[0];
            const maxRes = sorted[sorted.length - 1];

            // Smooth only when coarse data dominates; avoids over-smoothing mixed high-res areas.
            shouldSmooth = coarseCount >= Math.ceil(resolutions.length / 2) && median > 2;

            console.log(
              `[GPXZ] Sampled resolution profile: min=${minRes}m median=${median}m max=${maxRes}m; coarse=${coarseCount}/${resolutions.length}; smooth=${shouldSmooth}`,
            );
          }
        }
      }
    } catch (e) {
      console.warn("[GPXZ] Failed to check resolution:", e);
    }

    // 2. Calculate Area & Tiles
    // Calculate Area in km²
    const latDist = (bounds.north - bounds.south) * 111.32;
    const avgLatRad = (((bounds.north + bounds.south) / 2) * Math.PI) / 180;
    const lonDist = (bounds.east - bounds.west) * 111.32 * Math.cos(avgLatRad);
    const areaKm2 = latDist * lonDist;

    console.log(`[GPXZ] Total Requested Area: ${areaKm2.toFixed(2)} km²`);

    // GPXZ Limit is 10km². We use a safe chunk size of ~9km² (3km x 3km)
    const TARGET_CHUNK_SIDE_KM = 3;
    const BUFFER_DEG = 0.002; // ~220m overlap to prevent seams

    // Calculate grid size
    const latSpan = bounds.north - bounds.south;
    const lngSpan = bounds.east - bounds.west;

    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(avgLatRad);

    const chunkLatDeg = (TARGET_CHUNK_SIDE_KM * 1000) / metersPerDegLat;
    const chunkLngDeg = (TARGET_CHUNK_SIDE_KM * 1000) / metersPerDegLng;

    const rows = Math.ceil(latSpan / chunkLatDeg);
    const cols = Math.ceil(lngSpan / chunkLngDeg);

    const requests = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const s = bounds.south + r * (latSpan / rows);
        const n = bounds.south + (r + 1) * (latSpan / rows);
        const w = bounds.west + c * (lngSpan / cols);
        const e = bounds.west + (c + 1) * (lngSpan / cols);

        // Normalize longitudes to [-180, 180]
        const normW = normalizeLng(w);
        const normE = normalizeLng(e);

        // Check for dateline crossing
        if (w < e && normW > normE) {
          // Split into two requests
          // Add buffer to internal edges too
          requests.push({
            north: n + BUFFER_DEG,
            south: s - BUFFER_DEG,
            west: normW - BUFFER_DEG,
            east: 180,
          });
          requests.push({
            north: n + BUFFER_DEG,
            south: s - BUFFER_DEG,
            west: -180,
            east: normE + BUFFER_DEG,
          });
        } else {
          requests.push({
            north: n + BUFFER_DEG,
            south: s - BUFFER_DEG,
            west: normW - BUFFER_DEG,
            east: normE + BUFFER_DEG,
          });
        }
      }
    }

    console.log(`[GPXZ] Split into ${requests.length} tiles (with overlap). Concurrency: ${concurrency}, delay: ${perWorkerDelayMs}ms`);
    onProgress?.(`Fetching ${requests.length} GPXZ tiles (${rateInfo?.plan || 'free'} plan, ${concurrency}x concurrent)...`);

    let completedChunks = 0;
    const results = await pMap(
      requests,
      async (reqBounds) => {
        // Rate limit delay — adjusted per worker for the plan's rps limit
        await new Promise((r) => setTimeout(r, perWorkerDelayMs));
        signal?.throwIfAborted();

        const url = `/api/gpxz/v1/elevation/hires-raster?bbox_top=${reqBounds.north}&bbox_bottom=${reqBounds.south}&bbox_left=${reqBounds.west}&bbox_right=${reqBounds.east}&res_m=best&projection=best&tight_bounds=false`;

        // Retry logic for 429 Rate Limit AND network errors
        let result = null;
        let retries = 0;
        const MAX_RETRIES = 5;

        while (retries < MAX_RETRIES) {
          let response = null;
          try {
            response = await fetch(url, { headers: { "x-api-key": apiKey }, signal });
          } catch (fetchErr) {
            // Network error (ERR_QUIC_PROTOCOL_ERROR, Failed to fetch, etc.)
            const waitTime = 2000 * Math.pow(2, retries);
            console.warn(
              `[GPXZ] Network error: ${fetchErr.message}. Retrying in ${waitTime}ms... (attempt ${retries + 1}/${MAX_RETRIES})`,
            );
            onProgress?.(`Network error — retrying in ${Math.ceil(waitTime / 1000)}s...`);
            await new Promise((r) => setTimeout(r, waitTime));
            retries++;
            continue;
          }

          if (response.status === 429) {
            // Use retry-after header if available, otherwise exponential backoff
            const retryAfter = response.headers.get('retry-after');
            const waitTime = retryAfter
              ? parseInt(retryAfter, 10) * 1000 + 200 // Add small buffer
              : 2000 * Math.pow(2, retries); // Exponential backoff: 2s, 4s, 8s, 16s, 32s
            console.warn(
              `[GPXZ] Rate limit hit (429). Retrying in ${waitTime}ms... (attempt ${retries + 1}/${MAX_RETRIES})`,
            );
            onProgress?.(`Rate limited — retrying in ${Math.ceil(waitTime / 1000)}s...`);
            await new Promise((r) => setTimeout(r, waitTime));
            retries++;
            continue;
          }

          if (!response.ok) {
            console.error(`[GPXZ] Tile Error: ${response.status}`);
            return null;
          }

          // Update cached rate limit info from response headers
          updateRateLimitFromHeaders(response);

          // Read the body — this can also fail mid-stream on flaky connections
          try {
            const arrayBuffer = await response.arrayBuffer();
            const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
            const image = await tiff.getImage();
            const rasters = await image.readRasters();
            const raster = rasters[0];
            await tiff.close();
            result = { image, raster, arrayBuffer };
            break;
          } catch (bodyErr) {
            const waitTime = 2000 * Math.pow(2, retries);
            console.warn(
              `[GPXZ] Body read error: ${bodyErr.message}. Retrying in ${waitTime}ms... (attempt ${retries + 1}/${MAX_RETRIES})`,
            );
            onProgress?.(`Download interrupted — retrying in ${Math.ceil(waitTime / 1000)}s...`);
            await new Promise((r) => setTimeout(r, waitTime));
            retries++;
            continue;
          }
        }

        if (!result) {
          console.error(`[GPXZ] Tile failed after ${MAX_RETRIES} retries`);
          return null;
        }

        completedChunks++;
        const remaining = gpxzRateLimitInfo?.remaining;
        const quotaInfo = remaining != null ? ` (${remaining} API calls remaining today)` : '';
        onProgress?.(`Fetching GPXZ tiles... ${completedChunks}/${requests.length}${quotaInfo}`);

        return result;
      },
      concurrency,
    );

    const validResults = results.filter((r) => r !== null);
    const hadChunkFailures = validResults.length < requests.length;

    if (validResults.length === 0) return null;

    const rawArrayBuffers = validResults.map((r) => r.arrayBuffer);
    if (hadChunkFailures) {
      console.warn(`[GPXZ] ${requests.length - validResults.length}/${requests.length} chunks failed. Terrarium fallback will be enabled for gap recovery.`);
    }
    // Only cache complete fetches — a partial result (some chunks failed) would
    // otherwise be served forever, hiding gaps a retry could fill.
    if (!hadChunkFailures) {
      putElevationCache(cacheKey, {
        buffers: rawArrayBuffers,
        smooth: shouldSmooth,
        hadChunkFailures,
      });
    }
    return { data: validResults, smooth: shouldSmooth, rawArrayBuffers, hadChunkFailures };
  } catch (e) {
    console.error("Failed to fetch GPXZ terrain:", e);
    return null;
  }
};
