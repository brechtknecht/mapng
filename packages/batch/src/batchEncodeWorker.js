/** @layer io */
/**
 * batchEncodeWorker.js — Web Worker entry for off-main-thread export encoding.
 *
 * Receives a DOM-free encode op + payload, runs the matching pure encoder
 * (imported from batchExports.js — its DOM code lives only inside the functions
 * the worker never calls, so module-eval stays worker-safe), and posts the
 * result back as a transferable ArrayBuffer. Mirrors resamplerWorker.js.
 *
 * Only DOM-free encoders run here. Canvas-bound stages (satellite/osm/hybrid
 * textures, the tile snapshot), the GLB/DAE serializers (they import
 * google3dTiles, which evaluates a renderer at module scope), and the file
 * download stay on the main thread.
 */

import { generateHeightmapBlob } from './batchExports.js';

const encoders = {
  // payload.terrainData carries only the DOM-free fields the encoder reads.
  heightmap: (payload) => ({
    blob: generateHeightmapBlob(payload.terrainData, payload.normalization),
    mime: 'image/png',
  }),
};

self.onmessage = async (e) => {
  const { id, op, payload } = e.data || {};
  try {
    const encode = encoders[op];
    if (!encode) throw new Error(`Unknown encode op: ${op}`);
    const { blob, mime } = encode(payload);
    const buffer = blob ? await blob.arrayBuffer() : null;
    self.postMessage({ id, ok: true, buffer, mime }, buffer ? [buffer] : []);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
