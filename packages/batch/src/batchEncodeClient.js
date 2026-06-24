/** @layer io */
/**
 * batchEncodeClient.js — Promise-based client for the batch encode Web Worker,
 * with a transparent main-thread fallback when workers are unavailable (or fail).
 * Mirrors resamplerClient.js. Each public `encode*OffThread` returns the exact
 * same Blob the corresponding batchExports generator would — the worker is a
 * pure offload, never a behaviour change.
 */

import { generateHeightmapBlob, generateTerBlob, generateGeoTIFFBlob } from './batchExports.js';

let worker = null;
let messageId = 0;
const pending = new Map();

const getWorker = () => {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  try {
    worker = new Worker(new URL('./batchEncodeWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, ok, buffer, mime, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve(buffer ? new Blob([buffer], { type: mime }) : null);
      else p.reject(new Error(error || 'encode worker error'));
    };
    worker.onerror = () => {
      // Reject all in-flight, drop the worker so the next call recreates it (or
      // falls through to the main-thread path).
      for (const [, p] of pending) p.reject(new Error('encode worker crashed'));
      pending.clear();
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    };
  } catch {
    worker = null;
  }
  return worker;
};

const post = (op, payload, transfer = []) => new Promise((resolve, reject) => {
  const w = getWorker();
  const id = ++messageId;
  pending.set(id, { resolve, reject });
  w.postMessage({ id, op, payload }, transfer);
});

// Both heightmap and ter read the same DOM-free subset of terrainData. Copy the
// heightMap and transfer the COPY — the main thread keeps the original (the
// composite-heightmap pass reads terrainData.heightMap after these encodes).
const heightSubset = (terrainData) => {
  const { width, height, heightMap, minHeight, maxHeight } = terrainData;
  const copy = heightMap.slice();
  return { terrainData: { width, height, heightMap: copy, minHeight, maxHeight }, transfer: [copy.buffer] };
};

/**
 * Encode the 16-bit PNG heightmap off the main thread. Falls back to a
 * synchronous main-thread encode if no worker is available or the worker fails.
 */
export async function encodeHeightmapOffThread(terrainData, normalization = null) {
  if (!terrainData?.heightMap) return null;
  const w = getWorker();
  if (!w) return generateHeightmapBlob(terrainData, normalization);
  const { terrainData: sub, transfer } = heightSubset(terrainData);
  try {
    return await post('heightmap', { terrainData: sub, normalization }, transfer);
  } catch {
    return generateHeightmapBlob(terrainData, normalization);
  }
}

/**
 * Encode the BeamNG .ter binary off the main thread. Falls back to a
 * synchronous main-thread encode if no worker is available or the worker fails.
 */
export async function encodeTerOffThread(terrainData) {
  if (!terrainData?.heightMap) return generateTerBlob(terrainData);
  const w = getWorker();
  if (!w) return generateTerBlob(terrainData);
  const { terrainData: sub, transfer } = heightSubset(terrainData);
  try {
    return await post('ter', { terrainData: sub }, transfer);
  } catch {
    return generateTerBlob(terrainData);
  }
}

/**
 * Encode the GeoTIFF off the main thread. The single-source passthrough (just
 * wrapping an existing GeoTIFF buffer) is cheap, so it stays on the main thread;
 * only the heightMap → writeArrayBuffer encode is offloaded. Falls back to the
 * main-thread encoder if no worker / worker failure.
 */
export async function encodeGeoTiffOffThread(terrainData, center) {
  const sources = terrainData?.sourceGeoTiffs?.arrayBuffers;
  if (sources?.length === 1) return generateGeoTIFFBlob(terrainData, center); // passthrough, no encode
  if (!terrainData?.heightMap) return generateGeoTIFFBlob(terrainData, center);
  const w = getWorker();
  if (!w) return generateGeoTIFFBlob(terrainData, center);
  const { width, height, heightMap } = terrainData;
  const copy = heightMap.slice();
  try {
    // Omit sourceGeoTiffs so exportGeoTiff takes the WGS84 heightMap path.
    return await post('geotiff', { terrainData: { width, height, heightMap: copy }, center }, [copy.buffer]);
  } catch {
    return generateGeoTIFFBlob(terrainData, center);
  }
}
