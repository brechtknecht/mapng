/** @layer io */
// Image/tile loading with persistent caching + satellite canvas → blob URL encode.
import {
  getElevationCache,
  putElevationCache,
  terrainTileCacheKey,
  satelliteTileCacheKey,
} from '@mapng/fetching';

export const loadImage = (url, signal) => {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const img = new Image();
    img.crossOrigin = "Anonymous";
    const onAbort = () => { img.src = ''; reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
    img.onload = () => { signal?.removeEventListener('abort', onAbort); resolve(img); };
    img.onerror = () => { signal?.removeEventListener('abort', onAbort); resolve(null); };
    img.src = url;
  });
};

// Load a Terrarium elevation PNG, served from the persistent cache when present.
// Terrarium tiles are immutable per z/x/y, so the same tile is reused across any
// overlapping single-tile or route fetch (and across reloads). Falls back to the
// uncached Image path on any cache/fetch trouble so behaviour never regresses.
export const loadTerrainTileCached = async (url, z, x, y, signal) => {
  const key = terrainTileCacheKey(z, x, y);
  const cached = await getElevationCache(key);
  if (cached?.blob) {
    const objUrl = URL.createObjectURL(cached.blob);
    try { return await loadImage(objUrl, signal); }
    finally { URL.revokeObjectURL(objUrl); }
  }
  let blob;
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return loadImage(url, signal);
    blob = await resp.blob();
  } catch (e) {
    if (signal?.aborted) throw e;
    return loadImage(url, signal); // network hiccup: let the Image path retry
  }
  putElevationCache(key, { blob });
  const objUrl = URL.createObjectURL(blob);
  try { return await loadImage(objUrl, signal); }
  finally { URL.revokeObjectURL(objUrl); }
};

// Load an ArcGIS World Imagery satellite tile, served from the persistent cache
// when present. Satellite (Z17) tiles are the bulk of a route export's network
// traffic and were previously re-downloaded for every overlapping corridor chunk
// (~220 m overlap) and on every reload. Caching them per z/x/y — exactly like the
// Terrarium elevation tiles — eliminates that redundant download. Falls back to
// the uncached Image path on any cache/fetch trouble so behaviour never regresses.
export const loadSatelliteTileCached = async (url, z, x, y, signal) => {
  const key = satelliteTileCacheKey(z, x, y);
  const cached = await getElevationCache(key);
  if (cached?.blob) {
    const objUrl = URL.createObjectURL(cached.blob);
    try { return await loadImage(objUrl, signal); }
    finally { URL.revokeObjectURL(objUrl); }
  }
  let blob;
  try {
    const resp = await fetch(url, { signal });
    if (!resp.ok) return loadImage(url, signal);
    blob = await resp.blob();
  } catch (e) {
    if (signal?.aborted) throw e;
    return loadImage(url, signal); // network hiccup: let the Image path retry
  }
  putElevationCache(key, { blob });
  const objUrl = URL.createObjectURL(blob);
  try { return await loadImage(objUrl, signal); }
  finally { URL.revokeObjectURL(objUrl); }
};

export const SAT_TEX_MAX_SIZE = 8192;

// Converts a satellite canvas to a blob URL, capping at SAT_TEX_MAX_SIZE to
// avoid GPU upload failures at extreme resolutions (e.g. 16k dev mode).
// Uses OffscreenCanvas.convertToBlob() when available so JPEG encoding runs
// off the main thread, preventing the visible freeze that canvas.toBlob()
// causes in Chrome right after a progress status update.
export const canvasToSatelliteBlobUrl = async (srcCanvas) => {
  console.log(`[Sat URL] srcCanvas: ${srcCanvas.width}x${srcCanvas.height}`);

  // Sample the center pixel of the source canvas to detect a blank/black canvas
  // early — a GPU-backed canvas can silently lose its data under memory pressure.
  try {
    const sCtx = srcCanvas.getContext('2d');
    if (sCtx) {
      const cx = srcCanvas.width >> 1, cy = srcCanvas.height >> 1;
      const px = sCtx.getImageData(cx, cy, 1, 1).data;
      console.log(`[Sat URL] srcCanvas center pixel: r=${px[0]} g=${px[1]} b=${px[2]} a=${px[3]}`);
    } else {
      console.warn('[Sat URL] srcCanvas.getContext("2d") returned null');
    }
  } catch (e) {
    console.warn('[Sat URL] could not sample srcCanvas:', e.message);
  }

  // Yield so Vue can flush the preceding onProgress status update before the
  // encode starts, preventing a perceived freeze/flicker in the loading modal.
  await new Promise(r => setTimeout(r, 0));

  const needsDownscale = srcCanvas.width > SAT_TEX_MAX_SIZE || srcCanvas.height > SAT_TEX_MAX_SIZE;
  const targetW = needsDownscale ? Math.round(srcCanvas.width  * Math.min(SAT_TEX_MAX_SIZE / srcCanvas.width,  SAT_TEX_MAX_SIZE / srcCanvas.height)) : srcCanvas.width;
  const targetH = needsDownscale ? Math.round(srcCanvas.height * Math.min(SAT_TEX_MAX_SIZE / srcCanvas.width,  SAT_TEX_MAX_SIZE / srcCanvas.height)) : srcCanvas.height;

  let blob = null;
  // Prefer OffscreenCanvas path: encoding + optional downscale run off the main
  // thread. When downscaling, use createImageBitmap with resize options to avoid
  // creating a second GPU-backed canvas (saves ~256 MB at 16k).
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      let source = srcCanvas;
      if (needsDownscale) {
        source = await createImageBitmap(srcCanvas, { resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high' });
        console.log(`[Sat URL] capped ${srcCanvas.width}x${srcCanvas.height} → ${targetW}x${targetH} via ImageBitmap`);
      }
      const offscreen = new OffscreenCanvas(targetW, targetH);
      offscreen.getContext('2d').drawImage(source, 0, 0);
      if (source !== srcCanvas && 'close' in source) source.close();
      blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
      console.log(`[Sat URL] OffscreenCanvas encode — blob=${blob ? `${(blob.size/1024).toFixed(0)} KB` : 'null'}`);
    } catch (e) {
      console.warn('[Sat URL] OffscreenCanvas path failed, falling back:', e.message);
    }
  }
  if (!blob) {
    // Fallback: draw to a regular canvas (creates second backing store if downscaling)
    let canvas = srcCanvas;
    if (needsDownscale) {
      const scaled = document.createElement('canvas');
      scaled.width  = targetW;
      scaled.height = targetH;
      const scaledCtx = scaled.getContext('2d');
      if (scaledCtx) scaledCtx.drawImage(srcCanvas, 0, 0, targetW, targetH);
      canvas = scaled;
    }
    blob = await new Promise(r => canvas.toBlob(b => r(b), 'image/jpeg', 0.9));
    console.log(`[Sat URL] canvas.toBlob fallback — blob=${blob ? `${(blob.size/1024).toFixed(0)} KB` : 'null'}`);
    if (canvas !== srcCanvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  const url = blob ? URL.createObjectURL(blob) : '';
  console.log(`[Sat URL] result: ${url ? 'ok' : 'empty'}`);
  return url;
};
