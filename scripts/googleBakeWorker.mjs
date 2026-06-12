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
// Protocol: NDJSON on stdout ({type:'progress'|'done'|'refined'|
// 'refine-error'|'error'}); all console logging (incl. the shared core's) is
// redirected to stderr.
//
// job.json: {
//   data: { bounds, width, height, minHeight, heightMap: <base64 Float32 LE>,
//           osmFeatures?: [...] },   // roads only needed for quality='roads'
//   options: { apiKey, errorTarget?, stripGround?, groundNormalThreshold?,
//              groundDistanceM?, cameraSweep?, quality?, sensorSize?,
//              maxWaitMs?, stabilityMs?, session? }
// }
//
// BAKE SESSIONS: with options.session=true (the plugin always sets it), the
// worker does NOT exit after the base bake. The TilesRenderer stays alive —
// warm LRU cache, full selection set, vertical anchor — and stdin accepts
// NDJSON refine commands:
//   { type:'refine', revision, station:{ e, n, heightM, lookE, lookN,
//     lookHeightM, fov?, label?, maxWaitMs? } }
// Station coordinates are ENU metres from the AOI centre; heights are metres
// above the .ter datum (exactly the preview's scene-Y ÷ unitsPerMeter), so
// the browser needs no knowledge of the ellipsoidal anchor. The user station
// is swept (pinning persists), finest-covering re-runs over the UNION of all
// sweeps so far, only newly kept tiles are transformed, and the FULL result
// container is rewritten to a new revision path:
//   { type:'refined', revision, resultPath, meshes, added, removed, bytes }
//
// out.bin (format 'MBK1'): u32 magic | u32 UNPADDED headerLen | header JSON
// (utf8, payload 4-byte aligned) | payload. Header.meshes[*] reference
// payload ranges; the records carry exactly the persisted-bake schema of
// services/googleTilesPersistentCache.js, so the browser restores them
// through the same deserializeGroup path as an IndexedDB hit.

import { readFileSync, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
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
  sampleHeightAtScene,
  computeUnitsPerMeter,
} from '../services/googleBakeCore.js';
import { TileDiskCache } from './googleTileDiskCache.mjs';

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

// Throttle progress over the pipe to ~4 Hz (the sweep ticks at ~30 Hz).
let lastProgressAt = 0;
const onProgress = (p) => {
  const now = performance.now();
  if (now - lastProgressAt < 250) return;
  lastProgressAt = now;
  emit({ type: 'progress', ...p });
};

const startTicker = (tick) => {
  const iv = setInterval(tick, 33);
  return () => clearInterval(iv);
};

// Refinement pulls Google's DEEPEST tiles for ONE camera frustum, so it can
// afford settings far more aggressive than the whole-AOI base bake — whose
// errorTarget=5 / sensor=1024 exist only to bound TOTAL memory across every
// station. errorTarget is the screen-space-error cap in pixels: 5 = "stop
// when error drops below 5 px" (visibly soft + edgy vs Google Maps, which
// renders at ~1 px on a high-res buffer). A close street-level camera plus
// errorTarget≈1 and a 2048 px sensor is what reaches Google's finest LOD —
// sharper textures AND finer mesh, both being functions of tile depth.
// Tune without editing via env vars (restart the dev server to apply).
const REFINE_ERROR_TARGET = Number(process.env.MAPNG_REFINE_ERROR_TARGET) || 1;
const REFINE_SENSOR = Number(process.env.MAPNG_REFINE_SENSOR) || 2048;
const REFINE_MAX_WAIT_MS = Number(process.env.MAPNG_REFINE_MAX_WAIT_MS) || 180000;

/**
 * Transform every mesh of a kept tile into result records. Buffers stay in
 * memory for the session's lifetime so refinements never re-transform old
 * tiles and the full container can be rewritten cheaply.
 */
const buildTileRecords = (session, tile) => {
  const scene = tile.cached?.scene;
  if (!scene) return null; // caller counts the gap
  scene.updateMatrixWorld(true);
  const records = [];
  scene.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const geom = session.transformMesh(node);
    if (!geom) return;

    const srcMat = Array.isArray(node.material) ? node.material[0] : node.material;
    const map = srcMat?.map ?? null;
    const captured = getCapturedImage(map);
    if (map && !captured) session.texturesMissing++;

    records.push({
      name: `google_tile_${session.recordCounter++}`,
      positions: geom.attributes.position.array,
      uvs: geom.attributes.uv.array,
      index: geom.index ? geom.index.array : null,
      texture: captured, // {bytes, mimeType} | null
      flipY: map?.flipY ?? true,
      wrapS: map?.wrapS ?? THREE.ClampToEdgeWrapping,
      wrapT: map?.wrapT ?? THREE.ClampToEdgeWrapping,
      colorSpace: map?.colorSpace ?? '',
    });
  });
  return records;
};

/**
 * Sync session.outputs (Map<tile, records[]>) with the current finest
 * covering of the union selection. Only tiles not already in the map get
 * transformed. Returns the diff for logging/protocol.
 */
const rebuildOutputs = (session) => {
  const keep = new Set(selectFinestCovering(session.selectedTiles));
  let added = 0;
  let removed = 0;
  let missingScenes = 0;
  for (const tile of [...session.outputs.keys()]) {
    if (!keep.has(tile)) {
      session.outputs.delete(tile);
      removed++;
    }
  }
  for (const tile of keep) {
    if (session.outputs.has(tile)) continue;
    const records = buildTileRecords(session, tile);
    if (records === null) { missingScenes++; continue; }
    if (records.length > 0) {
      session.outputs.set(tile, records);
      added++;
    }
  }
  if (missingScenes > 0) {
    console.warn(
      `[bakeWorker] ${missingScenes}/${keep.size} kept tiles lost their scenes ` +
      '(LRU eviction) — the bake has coverage gaps.',
    );
  }
  return { added, removed, kept: keep.size, missingScenes };
};

/** Rewrite the full MBK1 container from the session's current records. */
const writeContainer = async (session, outPath) => {
  const parts = [];
  let payloadOffset = 0;
  const pushPart = (bytes) => {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
  for (const records of session.outputs.values()) {
    for (const r of records) {
      meshes.push({
        name: r.name,
        positions: pushPart(r.positions),
        uvs: pushPart(r.uvs),
        index: r.index
          ? { ...pushPart(r.index), kind: r.index instanceof Uint32Array ? 'u32' : 'u16' }
          : null,
        texture: r.texture
          ? { ...pushPart(r.texture.bytes), mimeType: r.texture.mimeType }
          : null,
        flipY: r.flipY,
        wrapS: r.wrapS,
        wrapT: r.wrapT,
        colorSpace: r.colorSpace,
      });
    }
  }

  const header = Buffer.from(JSON.stringify({
    format: 1,
    revision: session.revision,
    bakeStations: session.stations.map((st) => st.viz).filter(Boolean),
    anchor: {
      googleGroundAlt: session.googleGroundAlt,
      mapngGroundY: session.transformMesh.mapngGroundY,
      minHeight: session.transformMesh.minH,
    },
    stats: {
      selected: session.selectedTiles.size,
      kept: session.outputs.size,
      stations: session.stations.length,
      timedOut: session.lastTimedOut,
      elapsedMs: Math.round(session.lastElapsedMs),
    },
    meshes,
  }), 'utf8');
  const headerPad = (4 - ((8 + header.byteLength) % 4)) % 4;

  const fixed = Buffer.alloc(8);
  fixed.writeUInt32LE(0x4d424b31, 0); // 'MBK1'
  // UNPADDED length — readers align the payload start to 4 bytes themselves.
  fixed.writeUInt32LE(header.byteLength, 4);

  const stream = createWriteStream(outPath);
  await writeAll(stream, fixed);
  await writeAll(stream, header);
  if (headerPad) await writeAll(stream, Buffer.alloc(headerPad));
  for (const part of parts) await writeAll(stream, part);
  await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));

  return { meshes: meshes.length, bytes: 8 + header.byteLength + headerPad + payloadOffset };
};

async function startBake(data, options, outPath) {
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
  const auth = new GoogleCloudAuthPlugin({ apiToken: apiKey });
  // GLB content is content-addressed — serve repeat downloads (session
  // rebuilds after a restart, quality re-bakes) from local disk.
  const tileCache = new TileDiskCache();
  const cacheState = await tileCache.prune();
  console.info(
    `[bakeWorker] tile disk cache: ${cacheState.files} files, ` +
    `${(cacheState.bytes / 1024 ** 2).toFixed(0)} MB (${cacheState.pruned} pruned)`,
  );
  tileCache.wrapPlugin(auth);
  tileCache.attach(tiles);
  tiles.registerPlugin(auth);
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

  const selectedTiles = new Set();
  const { timedOut, elapsedMs } = await runStationSweep({
    tiles, cam, data, frame, stations,
    ellipsoid: WGS84_ELLIPSOID,
    quality, maxWaitMs, stabilityMs,
    startTicker, onProgress, selectedTiles,
  });

  const cacheFull = typeof tiles.lruCache?.isFull === 'function' ? tiles.lruCache.isFull() : false;
  const cs = tileCache.stats();
  console.info(
    `[bakeWorker] ${selectedTiles.size} tiles selected across ${stations.length} stations ` +
    `in ${(elapsedMs / 1000).toFixed(1)}s (errorTarget=${errorTarget}, quality=${quality}, ` +
    `sensor=${sensorSize}px, timedOut=${timedOut}, cacheFull=${cacheFull}, ` +
    `diskCache=${cs.hits} hits/${cs.misses} misses/${cs.unkeyed} unkeyed/${cs.hitMB} MB served locally)`,
  );
  if (selectedTiles.size === 0) {
    throw new Error(
      `bake worker: 0 tiles loaded after ${(elapsedMs / 1000).toFixed(1)}s. ` +
      'Camera/LOD selection found nothing — check the API key and the AOI bounds.',
    );
  }

  // Vertical anchor: probe over the kept tiles' scenes.
  const keptForProbe = selectFinestCovering(selectedTiles);
  const forEachKeptMesh = (cb) => {
    for (const tile of keptForProbe) {
      const scene = tile.cached?.scene;
      if (!scene) continue;
      scene.updateMatrixWorld(true);
      scene.traverse((node) => { if (node.isMesh && node.geometry) cb(node); });
    }
  };
  let googleGroundAlt = probeGroundAltitude(forEachKeptMesh, frame, WGS84_ELLIPSOID);
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

  const session = {
    data, options, tiles, cam, frame, stations, selectedTiles,
    quality, stabilityMs, tileCache,
    googleGroundAlt, transformMesh,
    outputs: new Map(),       // tile → records[]
    recordCounter: 0,
    texturesMissing: 0,
    revision: 0,
    lastTimedOut: timedOut,
    lastElapsedMs: elapsedMs,
    outBase: outPath,
    currentResultPath: outPath,
  };

  const diff = rebuildOutputs(session);
  if (session.texturesMissing > 0) {
    console.warn(`[bakeWorker] ${session.texturesMissing} meshes had a material map but no captured image bytes`);
  }
  if (session.outputs.size === 0) {
    throw new Error('bake worker: tiles loaded but none survived AOI clipping/ground stripping.');
  }

  const { meshes, bytes } = await writeContainer(session, outPath);
  console.info(
    `[bakeWorker] ${meshes} tile meshes written (${diff.kept} tiles), ${(bytes / 1024 ** 2).toFixed(0)} MB, ` +
    `rss=${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)}MB`,
  );
  emit({
    type: 'done',
    meshes,
    bytes,
    selected: selectedTiles.size,
    kept: diff.kept,
    stations: stations.length,
    timedOut,
    elapsedMs: Math.round(elapsedMs),
    session: options.session === true,
  });
  return session;
}

/**
 * Build a sweep station from a user camera pose. ENU metres + heights above
 * the .ter datum come straight from the preview; the ellipsoidal conversion
 * happens HERE with the session's anchor, so refined geometry can never
 * float relative to the base bake.
 */
const buildUserStation = (session, s, revision) => {
  const { frame, transformMesh, googleGroundAlt, data } = session;
  for (const k of ['e', 'n', 'heightM', 'lookE', 'lookN', 'lookHeightM']) {
    if (!Number.isFinite(s?.[k])) throw new Error(`refine station: missing/invalid '${k}'`);
  }
  const datumToEllipsoid = (m) => googleGroundAlt + (m - (transformMesh.mapngGroundY - transformMesh.minH));
  const upm = computeUnitsPerMeter(data);
  const terrainM = sampleHeightAtScene(data, s.e * upm, -s.n * upm) - transformMesh.minH;
  return {
    label: s.label ?? `user-${revision}`,
    offset: frame.horiz(s.e, s.n).addScaledVector(frame.upDir, datumToEllipsoid(s.heightM)),
    target: frame.horiz(s.lookE, s.lookN).addScaledVector(frame.upDir, datumToEllipsoid(s.lookHeightM)),
    fov: Number.isFinite(s.fov) ? Math.min(120, Math.max(20, s.fov)) : undefined,
    viz: { kind: 'user', e: s.e, n: s.n, aglM: s.heightM - terrainM },
  };
};

async function refine(session, revision, stationSpec) {
  const station = buildUserStation(session, stationSpec, revision);
  session.stations.push(station);

  // Aggressive LOD for this one frustum (see REFINE_* above). Applied to the
  // shared tiles instance — only the user station is swept afterwards, so
  // only its frustum refines deep; off-frustum tiles aren't visible and
  // stay put. Persists across refinements (every refine wants max detail).
  const errorTarget = Number.isFinite(stationSpec.errorTarget) ? stationSpec.errorTarget : REFINE_ERROR_TARGET;
  const sensor = Number.isFinite(stationSpec.sensorSize) ? stationSpec.sensorSize : REFINE_SENSOR;
  session.tiles.errorTarget = errorTarget;
  session.tiles.setResolution(session.cam, sensor, sensor);

  const { timedOut, elapsedMs } = await runStationSweep({
    tiles: session.tiles,
    cam: session.cam,
    data: session.data,
    frame: session.frame,
    stations: [station],
    ellipsoid: WGS84_ELLIPSOID,
    quality: session.quality,
    maxWaitMs: Number.isFinite(stationSpec.maxWaitMs) ? stationSpec.maxWaitMs : REFINE_MAX_WAIT_MS,
    stabilityMs: session.stabilityMs,
    startTicker,
    onProgress,
    selectedTiles: session.selectedTiles, // union — earlier tiles stay pinned
    enableRoadPass: false,
  });
  session.lastTimedOut = timedOut;
  session.lastElapsedMs = elapsedMs;
  session.revision = revision;

  const diff = rebuildOutputs(session);
  const resultPath = `${session.outBase}.rev${revision}`;
  const { meshes, bytes } = await writeContainer(session, resultPath);
  const previous = session.currentResultPath;
  session.currentResultPath = resultPath;
  await unlink(previous).catch(() => { /* may be mid-download; tmp dir is cleaned with the job */ });

  const cs = session.tileCache.stats();
  console.info(
    `[bakeWorker] refine rev${revision} (${station.label}): +${diff.added}/-${diff.removed} tiles, ` +
    `${meshes} meshes, ${(bytes / 1024 ** 2).toFixed(0)} MB, ${(elapsedMs / 1000).toFixed(1)}s, ` +
    `errorTarget=${errorTarget}, sensor=${sensor}px, fov=${station.fov ?? 'base'}, ` +
    `rss=${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)}MB, ` +
    `diskCache=${cs.hits} hits/${cs.misses} misses`,
  );
  emit({
    type: 'refined',
    revision,
    resultPath,
    meshes,
    bytes,
    added: diff.added,
    removed: diff.removed,
    selected: session.selectedTiles.size,
    kept: diff.kept,
    timedOut,
    elapsedMs: Math.round(elapsedMs),
  });
}

const [jobPath, outPath] = process.argv.slice(2);
if (!jobPath || !outPath) {
  emit({ type: 'error', message: 'usage: node googleBakeWorker.mjs <job.json> <out.bin>' });
  process.exit(2);
}

let session = null;
try {
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const data = { ...job.data, heightMap: decodeFloat32(job.data.heightMap) };
  session = await startBake(data, job.options ?? {}, outPath);
} catch (err) {
  console.error('[bakeWorker] bake failed:', err?.stack ?? err);
  emit({ type: 'error', message: err?.message ?? String(err) });
  process.exit(1);
}

if (session.options.session !== true) {
  process.exit(0);
}

// --- session mode: serve refine commands until stdin closes ------------------
console.info('[bakeWorker] session alive — awaiting refine commands on stdin');
let chain = Promise.resolve(); // refines run strictly sequentially
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let cmd;
  try { cmd = JSON.parse(line); } catch { return; }
  if (cmd.type !== 'refine') return;
  chain = chain.then(async () => {
    try {
      await refine(session, cmd.revision, cmd.station ?? {});
    } catch (err) {
      console.error(`[bakeWorker] refine rev${cmd.revision} failed:`, err?.stack ?? err);
      emit({ type: 'refine-error', revision: cmd.revision, message: err?.message ?? String(err) });
    }
  });
});
rl.on('close', () => {
  chain.then(() => process.exit(0));
});
