// Route-corridor bake + export orchestrator (Phase 1b).
//
// Walks the AOI chunks produced by chunkRoute(), and for EACH chunk:
//   1. fetches terrain (+ OSM) for the chunk box,
//   2. exports a GLB that auto-bakes Google 3D tiles at the tier's quality
//      (exportToGLB → getOrBakeGoogle3DTiles; the bake's road pass concentrates
//      detail along the road the route follows),
//   3. adds the GLB to a combined .zip under chunk_NN/model.glb.
// Finally writes a manifest.json describing the chain (geo-reference per chunk so
// the pieces can be repositioned into one continuous world later) and returns the
// combined zip Blob.
//
// Chunks bake SEQUENTIALLY: the Google bake routes through a single-session
// sidecar worker, and per-bounds caching makes re-runs of unchanged chunks free.

import JSZip from 'jszip';
import { fetchTerrainData } from './terrain';
import { exportToGLB } from './export3d';
import { computeUnitsPerMeter } from './googleBakeCore';
import { getGoogleTilesZOffset } from './google3dTiles';
import { getCorridorTier } from './routeCorridor';
import { computeRouteFrame } from './routeStitch';

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * @param {object[]} chunks  chunkRoute() output
 * @param {object} opts
 * @param {string} opts.tierId         corridor tier id (sets chunk size + quality)
 * @param {string} opts.googleApiKey   tiles credential (VITE_GOOGLE_MAPS_API_KEY)
 * @param {number} [opts.routeDistanceM]
 * @param {(p:{chunk:number,total:number,phase:string,detail?:string})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ blob: Blob, manifest: object }>}
 */
export async function bakeAndExportRoute(chunks, opts = {}) {
  const { tierId, googleApiKey, routeDistanceM = 0, onProgress, signal } = opts;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('bakeAndExportRoute: no chunks to bake');
  }
  if (!googleApiKey) {
    throw new Error('bakeAndExportRoute: missing tiles credential (VITE_GOOGLE_MAPS_API_KEY)');
  }

  const tier = getCorridorTier(tierId);
  const total = chunks.length;
  const zip = new JSZip();
  const chunkBlobs = []; // kept in memory for the in-app stitched preview

  const manifest = {
    schemaVersion: 1,
    mode: 'route',
    createdAt: new Date().toISOString(),
    tier: tier.id,
    corridorHalfWidthM: tier.halfWidthM,
    chunkSizeM: tier.chunkSizeM,
    googleQuality: tier.googleQuality,
    routeDistanceM,
    chunkCount: total,
    chunks: [],
  };

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const chunk = chunks[i];
    const folder = `chunk_${pad2(i)}`;

    onProgress?.({ chunk: i, total, phase: 'terrain', detail: 'Fetching terrain + OSM' });
    const terrainData = await fetchTerrainData(
      chunk.center,
      tier.chunkSizeM, // 1 px = 1 m, so resolution doubles as the box extent
      true, // includeOSM — needed for the road-station pass
      false,
      false,
      false,
      '',
      undefined,
      (msg) => onProgress?.({ chunk: i, total, phase: 'terrain', detail: msg }),
      signal,
    );

    onProgress?.({ chunk: i, total, phase: 'bake', detail: `Baking Google tiles (${tier.googleQuality})` });
    let maskStats = { ran: false, reason: 'not-invoked' };
    const blob = await exportToGLB(terrainData, {
      returnBlob: true,
      useGoogle3DTiles: true,
      googleApiKey,
      googleQuality: tier.googleQuality,
      centerTextureType: 'osm',
      // Clip the baked tiles to the corridor buffer — most of each box is outside ±halfWidth.
      corridorMask: { segment: chunk.segment, halfWidthM: tier.halfWidthM },
      onMaskStats: (s) => { maskStats = s; },
      onProgress: (msg) => onProgress?.({ chunk: i, total, phase: 'bake', detail: msg }),
    });

    zip.file(`${folder}/model.glb`, blob);
    chunkBlobs.push(blob);

    manifest.chunks.push({
      id: chunk.id,
      index: i,
      folder,
      file: `${folder}/model.glb`,
      center: chunk.center,
      bounds: terrainData.bounds,
      width: terrainData.width,
      height: terrainData.height,
      minHeight: terrainData.minHeight,
      distanceFromStartM: chunk.distanceFromStartM,
      unitsPerMeter: computeUnitsPerMeter(terrainData),
      googleTilesZOffsetM: getGoogleTilesZOffset(),
      segmentPoints: chunk.segment.length,
      mask: maskStats,
      // neighbours that share an overlap edge (for a future weld/stitch pass)
      neighbours: [i - 1, i + 1].filter((n) => n >= 0 && n < total),
    });

    onProgress?.({ chunk: i, total, phase: 'done', detail: 'Chunk complete' });
  }

  // Shared world frame: each chunk's placement (scale + translation in metres)
  // so the separate GLBs tile into one continuous world. See routeStitch.js.
  const frame = computeRouteFrame(
    manifest.chunks.map((c) => ({ center: c.center, unitsPerMeter: c.unitsPerMeter, minHeight: c.minHeight })),
    tier.chunkSizeM,
  );
  manifest.frame = {
    anchor: frame.anchor,
    convention: frame.convention,
    worldBoundsM: frame.worldBoundsM,
  };
  manifest.chunks.forEach((c, i) => { c.placement = frame.placements[i]; });

  onProgress?.({ chunk: total, total, phase: 'zip', detail: 'Packaging archive' });
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const archive = await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });

  // previewChunks: kept-in-memory GLB blobs + placements for the in-app stitched
  // 3D preview (RoutePreview loads + positions them — same content as the export).
  const previewChunks = manifest.chunks.map((c, i) => ({
    index: i,
    blob: chunkBlobs[i],
    placement: c.placement,
  }));

  return { blob: archive, manifest, previewChunks, worldBoundsM: frame.worldBoundsM };
}
