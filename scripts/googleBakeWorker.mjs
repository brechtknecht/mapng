// Headless Google 3D Tiles bake worker — the Node sidecar that replaces the
// in-browser bake whenever the dev server is available (see
// viteGoogleBakePlugin.mjs). Runs the SAME sweep/transform pipeline as
// services/google3dTiles.js via the shared core, with the browser-isms
// swapped out:
//   - plain setInterval instead of the anti-throttling Web-Worker ticker
//   - tiles.setResolution() instead of an offscreen WebGLRenderer
//   - textures are never decoded: the capture loader keeps the raw JPEG/PNG
//     bytes from the GLB (~10× less memory than RGBA bitmaps, no canvases)
//   - memory budgets sized for a dedicated child process
//     (spawned with --max-old-space-size, see the vite plugin)
//
// Usage:   node googleBakeWorker.mjs <job.json> <out.bin>
// Protocol: NDJSON on stdout ({type:'progress'|'done'|'error'}); all
// console logging (incl. the shared core's) is redirected to stderr.
//
// job.json: {
//   data: { bounds, width, height, minHeight, heightMap: <base64 Float32 LE>,
//           osmFeatures?: [...] },   // roads only needed for quality='roads'
//   options: { apiKey, errorTarget?, stripGround?, groundNormalThreshold?,
//              groundDistanceM?, cameraSweep?, quality?, sensorSize?,
//              maxWaitMs?, stabilityMs? }
// }
//
// out.bin (format 'MBK1'): u32 magic | u32 headerLen | header JSON (utf8,
// 4-byte padded) | payload. Header.meshes[*] reference payload ranges; the
// records carry exactly the persisted-bake schema of
// services/googleTilesPersistentCache.js (positions/uvs/index + compressed
// texture bytes + sampler props), so the browser restores them through the
// same deserializeGroup path as an IndexedDB hit.

import { readFileSync, createWriteStream } from 'node:fs';
import * as THREE from 'three';
import {
  TilesRenderer,
  GoogleCloudAuthPlugin,
  WGS84_ELLIPSOID,
  installCaptureLoader,
  getCapturedImage,
} from './headlessTilesEnv.mjs';
import {
  computeAoiFrame,
  buildSweepStations,
  runStationSweep,
  selectFinestCovering,
  probeGroundAltitude,
  createTileMeshTransformer,
} from '../services/googleBakeCore.js';

// stdout is the NDJSON protocol channel — push ALL logging to stderr,
// including console.info calls inside the shared core.
const stderrLine = (level) => (...args) =>
  process.stderr.write(`[${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
console.log = stderrLine('log');
console.info = stderrLine('info');
console.warn = stderrLine('warn');
console.error = stderrLine('error');

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const decodeFloat32 = (base64) => {
  const buf = Buffer.from(base64, 'base64');
  // Copy out of the Buffer pool — pooled slices are not 4-byte aligned.
  const aligned = new ArrayBuffer(buf.byteLength);
  new Uint8Array(aligned).set(buf);
  return new Float32Array(aligned);
};

const writeAll = (stream, buf) => new Promise((resolve, reject) => {
  stream.write(buf, (err) => (err ? reject(err) : resolve()));
});

async function bake(data, options, outPath) {
  const {
    apiKey,
    errorTarget = 5,
    stripGround = true,
    groundNormalThreshold = 0.85,
    groundDistanceM = 2.5,
    cameraSweep = true,
    quality = 'standard',
    sensorSize = quality === 'standard' ? 1024 : 1536,
    maxWaitMs = null,
    stabilityMs = 2500,
  } = options;

  if (!apiKey) throw new Error('bake worker: missing apiKey');
  if (!data?.bounds || !data?.heightMap) throw new Error('bake worker: invalid terrain data');

  // Preflight the root tileset — fail fast with Google's actual error
  // (key restrictions, API disabled, billing) instead of polling 0 tiles.
  const probe = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`);
  if (!probe.ok) {
    let detail = '';
    try { detail = (await probe.json())?.error?.message ?? ''; } catch (_) { /* noop */ }
    throw new Error(
      `Google Map Tiles API rejected the request (HTTP ${probe.status}${detail ? `: ${detail}` : ''}). ` +
      'Check that the Map Tiles API is enabled for the project, the API key allows it, and billing is active.',
    );
  }

  const frame = computeAoiFrame(data, WGS84_ELLIPSOID);

  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
  tiles.errorTarget = errorTarget;

  // Budgets for a dedicated child process with a multi-GB heap. Note the
  // cache's byte estimate only sees geometry here — captured JPEG bytes are
  // invisible to estimateBytesUsed, and they're ~10× smaller than the
  // decoded textures the browser counts. The tile-count caps are the
  // effective guard rail.
  tiles.lruCache.minBytesSize = 6 * 1024 ** 3;
  tiles.lruCache.maxBytesSize = 8 * 1024 ** 3;
  tiles.lruCache.minSize = 60000;
  tiles.lruCache.maxSize = 64000;
  tiles.downloadQueue.maxJobs = 32;
  tiles.parseQueue.maxJobs = 8;
  // Node timers are never throttled — no Web-Worker ticker needed.
  tiles.downloadQueue.schedulingCallback = (fn) => setImmediate(fn);
  tiles.parseQueue.schedulingCallback = (fn) => setImmediate(fn);

  installCaptureLoader(tiles);

  const stations = buildSweepStations(frame, { quality, cameraSweep });

  const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e9);
  cam.up.copy(frame.upDir);
  cam.position.copy(frame.centerEcef).add(stations[0].offset);
  cam.lookAt(frame.centerEcef);
  cam.updateMatrixWorld(true);

  tiles.setCamera(cam);
  tiles.setResolution(cam, sensorSize, sensorSize);

  const startTicker = (tick) => {
    const iv = setInterval(tick, 33);
    return () => clearInterval(iv);
  };

  // Throttle progress over the pipe to ~4 Hz (the sweep ticks at ~30 Hz).
  let lastProgressAt = 0;
  const onProgress = (p) => {
    const now = performance.now();
    if (now - lastProgressAt < 250) return;
    lastProgressAt = now;
    emit({ type: 'progress', ...p });
  };

  const { selectedTiles, timedOut, elapsedMs } = await runStationSweep({
    tiles, cam, data, frame, stations,
    ellipsoid: WGS84_ELLIPSOID,
    quality, maxWaitMs, stabilityMs,
    startTicker, onProgress,
  });

  const bakeTiles = selectFinestCovering(selectedTiles);

  const bakeScenes = [];
  let missingScenes = 0;
  for (const tile of bakeTiles) {
    const scene = tile.cached?.scene;
    if (!scene) { missingScenes++; continue; }
    scene.updateMatrixWorld(true);
    bakeScenes.push(scene);
  }
  if (missingScenes > 0) {
    console.warn(
      `[bakeWorker] ${missingScenes}/${bakeTiles.length} selected tiles lost their scenes ` +
      '(LRU eviction) — the bake has coverage gaps.',
    );
  }
  const forEachBakeMesh = (cb) => {
    for (const scene of bakeScenes) {
      scene.traverse((node) => {
        if (node.isMesh && node.geometry) cb(node);
      });
    }
  };

  const cacheFull = typeof tiles.lruCache?.isFull === 'function' ? tiles.lruCache.isFull() : false;
  console.info(
    `[bakeWorker] ${selectedTiles.size} tiles selected across ${stations.length} stations, ` +
    `${bakeTiles.length} kept after finest-covering dedup, in ${(elapsedMs / 1000).toFixed(1)}s ` +
    `(errorTarget=${errorTarget}, quality=${quality}, sensor=${sensorSize}px, timedOut=${timedOut}, cacheFull=${cacheFull})`,
  );
  if (bakeScenes.length === 0) {
    throw new Error(
      `bake worker: 0 tiles loaded after ${(elapsedMs / 1000).toFixed(1)}s. ` +
      'Camera/LOD selection found nothing — check the API key and the AOI bounds.',
    );
  }

  let googleGroundAlt = probeGroundAltitude(forEachBakeMesh, frame, WGS84_ELLIPSOID);
  if (googleGroundAlt === null) {
    console.warn('[bakeWorker] ground probe found no vertices near the AOI centre — vertical anchor defaults to 0');
    googleGroundAlt = 0;
  }

  const transformMesh = createTileMeshTransformer(data, frame, WGS84_ELLIPSOID, googleGroundAlt, {
    stripGround, groundNormalThreshold, groundDistanceM, computeNormals: false,
  });
  console.info(
    `[bakeWorker] vertical anchor: googleGroundAlt=${googleGroundAlt.toFixed(1)}m (ellipsoidal), ` +
    `mapngGroundY=${transformMesh.mapngGroundY.toFixed(1)}m, minHeight=${transformMesh.minH.toFixed(1)}m`,
  );

  // Transform every kept mesh and pack the result records. Buffers are
  // collected with payload offsets first, then streamed to disk — no
  // Buffer.concat of a multi-GB result.
  const parts = [];
  let payloadOffset = 0;
  const pushPart = (typedArray) => {
    const buf = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const ref = { offset: payloadOffset, byteLength: buf.byteLength };
    parts.push(buf);
    payloadOffset += buf.byteLength;
    const pad = (4 - (payloadOffset % 4)) % 4;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      payloadOffset += pad;
    }
    return ref;
  };

  const meshes = [];
  let texturesMissing = 0;
  forEachBakeMesh((node) => {
    const geom = transformMesh(node);
    if (!geom) return;

    const name = `google_tile_${meshes.length}`;
    const srcMat = Array.isArray(node.material) ? node.material[0] : node.material;
    const map = srcMat?.map ?? null;
    const captured = getCapturedImage(map);
    if (map && !captured) texturesMissing++;

    const index = geom.index ? geom.index.array : null;
    meshes.push({
      name,
      positions: pushPart(geom.attributes.position.array),
      uvs: pushPart(geom.attributes.uv.array),
      index: index
        ? { ...pushPart(index), kind: index instanceof Uint32Array ? 'u32' : 'u16' }
        : null,
      texture: captured
        ? { ...pushPart(captured.bytes), mimeType: captured.mimeType }
        : null,
      flipY: map?.flipY ?? true,
      wrapS: map?.wrapS ?? THREE.ClampToEdgeWrapping,
      wrapT: map?.wrapT ?? THREE.ClampToEdgeWrapping,
      colorSpace: map?.colorSpace ?? '',
    });
  });

  if (texturesMissing > 0) {
    console.warn(`[bakeWorker] ${texturesMissing} meshes had a material map but no captured image bytes`);
  }
  if (meshes.length === 0) {
    throw new Error(
      `bake worker: ${bakeScenes.length} tiles loaded but none survived AOI clipping/ground stripping.`,
    );
  }

  try { tiles.dispose(); } catch (_) { /* noop */ }

  const header = Buffer.from(JSON.stringify({
    format: 1,
    bakeStations: stations.map((st) => st.viz).filter(Boolean),
    stats: {
      selected: selectedTiles.size,
      kept: bakeTiles.length,
      stations: stations.length,
      timedOut,
      cacheFull,
      elapsedMs: Math.round(elapsedMs),
    },
    meshes,
  }), 'utf8');
  const headerPad = (4 - ((8 + header.byteLength) % 4)) % 4;

  const fixed = Buffer.alloc(8);
  fixed.writeUInt32LE(0x4d424b31, 0); // 'MBK1'
  // UNPADDED length — readers align the payload start to 4 bytes themselves
  // ((8 + headerLen + 3) & ~3). Padding bytes inside the parsed range would
  // be NULs that break JSON.parse.
  fixed.writeUInt32LE(header.byteLength, 4);

  const stream = createWriteStream(outPath);
  await writeAll(stream, fixed);
  await writeAll(stream, header);
  if (headerPad) await writeAll(stream, Buffer.alloc(headerPad));
  for (const part of parts) await writeAll(stream, part);
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

  const totalBytes = 8 + header.byteLength + headerPad + payloadOffset;
  console.info(
    `[bakeWorker] ${meshes.length} tile meshes written, ${(totalBytes / 1024 ** 2).toFixed(0)} MB, ` +
    `rss=${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)}MB`,
  );
  emit({
    type: 'done',
    meshes: meshes.length,
    bytes: totalBytes,
    selected: selectedTiles.size,
    kept: bakeTiles.length,
    stations: stations.length,
    timedOut,
    elapsedMs: Math.round(elapsedMs),
  });
}

const [jobPath, outPath] = process.argv.slice(2);
if (!jobPath || !outPath) {
  emit({ type: 'error', message: 'usage: node googleBakeWorker.mjs <job.json> <out.bin>' });
  process.exit(2);
}

try {
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const data = { ...job.data, heightMap: decodeFloat32(job.data.heightMap) };
  await bake(data, job.options ?? {}, outPath);
  process.exit(0);
} catch (err) {
  console.error('[bakeWorker] bake failed:', err?.stack ?? err);
  emit({ type: 'error', message: err?.message ?? String(err) });
  process.exit(1);
}
