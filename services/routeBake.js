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
import { getGoogleTilesZOffset, googleBakeSidecarAvailable, endGoogleTilesSession } from './google3dTiles';
import { getCorridorTier, resolveChunkSizeM } from './routeCorridor';
import { computeRouteFrame } from './routeStitch';
import { createRouteProgress } from './routeProgress';
import { zipSidecarAvailable, compressZipViaSidecar } from './zipExportSidecar';

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
  const { tierId, googleApiKey, routeDistanceM = 0, onProgress, signal, concurrency } = opts;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error('bakeAndExportRoute: no chunks to bake');
  }
  if (!googleApiKey) {
    throw new Error('bakeAndExportRoute: missing tiles credential (VITE_GOOGLE_MAPS_API_KEY)');
  }

  const tier = getCorridorTier(tierId);
  // Effective box size — the optional override decouples it from the tier. MUST
  // match what chunkRoute() used to build `chunks` (App.vue passes the same
  // override to both), so the terrain box lines up with each chunk's bounds.
  const chunkSizeM = resolveChunkSizeM(tierId, opts.chunkSizeM);
  const total = chunks.length;
  // Archive entries recorded as a path→content map rather than built into a
  // JSZip up front: a long route's GLBs sum to multiple GB, and JSZip's
  // generateAsync({type:'blob'}) materialises the whole archive in one heap
  // Blob — past ~2 GB the ArrayBuffer cap is hit and JSZip throws
  // "Bug : can't construct the Blob." The dev zip sidecar streams each entry to
  // disk instead (no giant in-heap blob); JSZip stays the prod fallback.
  const zipEntries = new Map(); // path -> Blob | string
  const chunkBlobs = []; // kept in memory for the in-app stitched preview

  // Per-chunk progress (reusable util) — drives the map's live chunk fill and
  // the panel bar. Every mutation pushes an immutable snapshot to onProgress.
  const progress = createRouteProgress(total, onProgress);

  const manifest = {
    schemaVersion: 1,
    mode: 'route',
    createdAt: new Date().toISOString(),
    tier: tier.id,
    corridorHalfWidthM: tier.halfWidthM,
    chunkSizeM,
    googleQuality: tier.googleQuality,
    routeDistanceM,
    chunkCount: total,
    chunks: [],
  };

  // Terrain prefetch (Task C): the bake is independent network work that runs
  // off-thread (sidecar) or async (in-browser), so the next chunk's terrain +
  // OSM fetch is hidden entirely behind the current chunk's bake. Look-ahead is
  // bounded to 1 to cap memory (only ever 2 terrainData resident at once).
  const terrainCache = new Array(total).fill(null); // i → { promise, fetchMs }
  const startFetch = (i) => {
    if (i < 0 || i >= total || terrainCache[i]) return terrainCache[i];
    const t0 = performance.now();
    const rec = { fetchMs: null };
    rec.promise = fetchTerrainData(
      chunks[i].center,
      chunkSizeM, // 1 px = 1 m, so resolution doubles as the box extent
      true, // includeOSM — terrain texture is 'osm'
      false,
      false,
      false,
      '',
      undefined,
      undefined, // terrain progress is surfaced per-chunk by processChunk
      signal,
    ).then((d) => { rec.fetchMs = Math.round(performance.now() - t0); return d; });
    // A background prefetch may settle (or reject on abort) before anything
    // awaits it — mark it handled so a rejection can't surface as an unhandled
    // promise. The foreground `await rec.promise` still throws as normal.
    rec.promise.catch(() => {});
    terrainCache[i] = rec;
    return rec;
  };

  // Parallel chunk bakes (Task B). The dev sidecar spawns one worker per cache
  // key, so different chunk bounds bake CONCURRENTLY — run a bounded pool over
  // the chunks instead of one at a time. Bounded because each sidecar child
  // gets a large heap and Google's tile API has rate limits; the in-browser
  // fallback (prod, no sidecar) holds a multi-GB renderer per bake, so there we
  // stay STRICTLY sequential. Route bakes set memoryCache:false (see
  // export3d.js) so concurrent chunks don't fight over the single cache slot.
  const sidecar = await googleBakeSidecarAvailable();
  const limit = Math.max(1, Math.min(
    concurrency ?? (sidecar ? 2 : 1),
    total,
  ));

  // Results land here keyed by index, then get assembled in route order below —
  // the manifest/zip/preview must stay ordered regardless of completion order.
  const results = new Array(total);
  // One route-wide Google vertical anchor, captured from chunk 0 (baked first)
  // and reused by every later chunk so the stitched chunks don't float apart.
  let sharedGroundOffsetM = null;
  let nextIdx = 0;
  const claim = () => (nextIdx < total ? nextIdx++ : -1);
  // Keep terrain fetches primed `limit` chunks ahead of the claim cursor so the
  // pipeline never stalls waiting on terrain (the bake hides the fetch).
  const primePrefetch = () => {
    for (let j = nextIdx; j < Math.min(total, nextIdx + limit); j++) startFetch(j);
  };

  const processChunk = async (i) => {
    const chunk = chunks[i];
    const folder = `chunk_${pad2(i)}`;

    progress.setPhase(i, 'terrain', 'fetching terrain + OSM');
    const rec = startFetch(i);
    const terrainData = await rec.promise;
    const fetchMs = rec.fetchMs;
    terrainCache[i] = null; // release the settled-promise ref so terrainData can be GC'd

    progress.setPhase(i, 'bake', `baking Google tiles (${tier.googleQuality})`);
    let maskStats = { ran: false, reason: 'not-invoked' };
    let bakeStats = null;
    const bakeT0 = performance.now();
    // The anchor THIS chunk's bake uses (null for chunk 0, the shared value for
    // 1..N). Captured so the session-end below recomputes the exact bake key.
    const anchorAtBake = sharedGroundOffsetM;
    const blob = await exportToGLB(terrainData, {
      returnBlob: true,
      useGoogle3DTiles: true,
      googleApiKey,
      googleQuality: tier.googleQuality,
      centerTextureType: 'osm',
      // Bake ONLY the corridor (stations follow the route) and clip the result
      // to the buffer as a final safety trim — most of each box is outside
      // ±halfWidth, but the corridor stations mean little is baked there now.
      corridorMask: { segment: chunk.segment, halfWidthM: tier.halfWidthM },
      // One route-wide vertical anchor for the Google tiles, taken from chunk 0
      // (baked first) and shared by all others — otherwise each chunk re-seats
      // Google's ground on its own centre's DEM and neighbours float at seams.
      ...(anchorAtBake != null ? { googleGroundOffsetM: anchorAtBake } : {}),
      onGroundOffset: (off) => { if (i === 0 && Number.isFinite(off)) sharedGroundOffsetM = off; },
      onMaskStats: (s) => { maskStats = s; },
      onBakeStats: (s) => { if (s) bakeStats = s; },
      // Structured sweep progress → per-chunk map fill (station/stations).
      onBakeProgress: (p) => {
        const frac = p?.stations > 0 ? p.station / p.stations : 0;
        progress.setBakeFraction(i, frac, `${p.visible ?? 0} tiles, ${(p.downloading ?? 0) + (p.parsing ?? 0)} in flight`);
      },
    });
    const exportMs = Math.round(performance.now() - bakeT0);

    // Free this chunk's resident sidecar worker now that its GLB is encoded and
    // the bake is persisted (IndexedDB) — a route bake never refines. Without
    // this, every chunk's multi-GB worker stays alive until the ~15 min idle
    // reaper, piling up across the run until the machine swaps. Fire-and-forget.
    endGoogleTilesSession(terrainData, {
      quality: tier.googleQuality,
      corridorSegment: chunk.segment,
      corridorHalfWidthM: tier.halfWidthM,
      ...(anchorAtBake != null ? { sharedGroundOffsetM: anchorAtBake } : {}),
    }).catch(() => {});

    results[i] = {
      folder,
      blob,
      entry: {
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
        // Per-chunk perf telemetry (§6) — measurable from the downloaded manifest.
        // bakeMs is the Google sweep alone; exportMs adds mask + GLB encode.
        // null bakeStats fields mean the bake came from cache (no fresh sweep).
        bake: {
          fetchMs,
          exportMs,
          bakeMs: bakeStats?.elapsedMs ?? null,
          stationCount: bakeStats?.stations ?? null,
          tilesSelected: bakeStats?.selected ?? null,
          tilesKept: bakeStats?.kept ?? null,
          timedOut: bakeStats?.timedOut ?? null,
          glbBytes: blob.size,
          fromCache: bakeStats == null,
        },
        // neighbours that share an overlap edge (for a future weld/stitch pass)
        neighbours: [i - 1, i + 1].filter((n) => n >= 0 && n < total),
      },
    };
    progress.setPhase(i, 'done', 'complete');
  };

  // Process one chunk with its error surfaced on that chunk's box, then rethrown.
  const poolWorkerStep = async (i) => {
    try {
      await processChunk(i);
    } catch (err) {
      if (err?.name !== 'AbortError') progress.setPhase(i, 'error', err?.message ?? 'bake failed');
      throw err;
    }
  };

  // One pool worker pulls chunk indices until the queue drains; `limit` of them
  // run in parallel. A throw (incl. AbortError) propagates out of Promise.all.
  const poolWorker = async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = claim();
      if (i === -1) return;
      primePrefetch();
      await poolWorkerStep(i);
    }
  };

  onProgress?.(progress.snapshot()); // initial all-pending snapshot
  primePrefetch();
  // Bake chunk 0 alone first to learn the shared vertical anchor; every other
  // chunk then seats on it, so adjacent chunks meet at the seam instead of
  // floating. Costs one chunk of serial latency up front, then the pool fans
  // out the rest `limit`-wide as before.
  if (total > 0) {
    const first = claim(); // index 0
    primePrefetch();
    await poolWorkerStep(first);
  }
  await Promise.all(Array.from({ length: limit }, () => poolWorker()));

  // Assemble in route order — the pool finishes chunks out of order.
  for (let i = 0; i < total; i++) {
    const r = results[i];
    zipEntries.set(`${r.folder}/model.glb`, r.blob);
    chunkBlobs.push(r.blob);
    manifest.chunks.push(r.entry);
  }

  // Shared world frame: each chunk's placement (scale + translation in metres)
  // so the separate GLBs tile into one continuous world. See routeStitch.js.
  const frame = computeRouteFrame(
    manifest.chunks.map((c) => ({ center: c.center, unitsPerMeter: c.unitsPerMeter, minHeight: c.minHeight })),
    chunkSizeM,
  );
  manifest.frame = {
    anchor: frame.anchor,
    convention: frame.convention,
    worldBoundsM: frame.worldBoundsM,
  };
  manifest.chunks.forEach((c, i) => { c.placement = frame.placements[i]; });

  onProgress?.({ ...progress.snapshot(), phase: 'zip', detail: 'Packaging archive' });
  zipEntries.set('manifest.json', JSON.stringify(manifest, null, 2));

  const filename = `MapNG_Route_${manifest.createdAt.slice(0, 10)}_${total}chunks.zip`;

  // previewChunks: kept-in-memory GLB blobs + placements for the in-app stitched
  // 3D preview (RoutePreview loads + positions them — same content as the export).
  // Built from chunkBlobs (NOT zipEntries — the sidecar drains that map as it
  // uploads), so the preview survives the streaming archive.
  const previewChunks = manifest.chunks.map((c, i) => ({
    index: i,
    blob: chunkBlobs[i],
    placement: c.placement,
  }));

  // Stream the archive to disk via the dev sidecar when available — never
  // builds a single multi-GB heap Blob. Returns a same-origin GET URL the
  // caller streams straight to disk. Falls back to in-browser JSZip (prod),
  // which keeps the old memory ceiling but is the only option there.
  let archive;
  if (await zipSidecarAvailable()) {
    const { url, jobId } = await compressZipViaSidecar(
      { dirs: [], entries: zipEntries },
      {
        filename,
        onProgress: ({ step, pct }) =>
          onProgress?.({ ...progress.snapshot(), phase: 'zip', detail: step, zipPct: pct }),
      },
    );
    archive = { url, jobId };
  } else {
    const zip = new JSZip();
    for (const [p, content] of zipEntries) zip.file(p, content);
    archive = { blob: await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' }) };
  }

  return { ...archive, filename, manifest, previewChunks, worldBoundsM: frame.worldBoundsM };
}
