import * as THREE from 'three';
import { TilesRenderer, GoogleCloudAuthPlugin, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { registerTilesAuth, preflightTilesAuth } from './tilesAuth.js';
import {
  computeAoiFrame,
  buildSweepStations,
  runStationSweep,
  selectFinestCovering,
  probeGroundAltitude,
  createTileMeshTransformer,
  sampleHeightAtScene,
  computeUnitsPerMeter,
  stripSeamRisers,
  weldSeams,
  stripGroundTris,
} from './googleBakeCore.js';
import { loadPersistedBake, persistBake, deletePersistedBake } from './googleTilesPersistentCache.js';
import {
  sidecarAvailable,
  bakeViaSidecar,
  restoreSidecarBake,
  bakeRefinementViaSidecar,
  ensureSidecarSession,
  exportAssemblyViaSidecar,
} from './googleBakeSidecar.js';

export { sidecarAvailable as googleBakeSidecarAvailable };

// The geometry/station/sweep machinery lives in googleBakeCore.js (shared
// with the headless Node bake worker). This module is the BROWSER
// orchestrator: Web-Worker ticker, decoded-texture snapshots for the
// preview/export paths, and the bake caches. Re-export the shared helpers
// the rest of the app imports from here.
export { sampleHeightAtScene, computeUnitsPerMeter };

// Seam handling for the in-tab fallback bake (prod / sidecar unreachable). The
// DEFAULT is the root-cause seam weld (weldSeams); the old magic-threshold
// strip is OFF by default, behind a kill switch for parity with the worker.
//   localStorage mapng_weld_seams='0'   disable the weld
//   localStorage mapng_strip_risers='1' re-enable the old heuristic deletion
// NOTE: lateral footprint carving lives in the Node worker (it needs the live
// tile tree); the in-tab path runs the weld only, so it leans on weldSeams to
// close seams. On the dev server every bake routes through the worker anyway.
const weldSeamsEnabled = () => {
  try { return localStorage.getItem('mapng_weld_seams') !== '0'; } catch (_) { return true; }
};
const riserStripEnabled = () => {
  try { return localStorage.getItem('mapng_strip_risers') === '1'; } catch (_) { return false; }
};

/**
 * Fetch Google Photorealistic 3D Tiles covering the AOI in `data.bounds`, transform
 * into mapng's scene coordinate system, optionally strip ground tris, and return a
 * THREE.Group of per-tile meshes.
 *
 * Output coordinates are mode-neutral: X/Z in scene units ([-50, 50]), Y in REAL
 * METERS above the .ter datum. Consumers convert — the 3D preview scales Y by
 * computeUnitsPerMeter(data), the BeamNG export maps Y → world-Z with factor 1.
 *
 * @param {object} data terrain data with .bounds, .width, .height, .heightMap, .minHeight
 * @param {object} options
 *   @param {string} options.apiKey Google Maps Platform API key with Map Tiles API enabled
 *   @param {number} [options.errorTarget=5] lower = higher detail, more requests, slower bake
 *   @param {boolean} [options.stripGround=true] drop near-horizontal tris (preserve mapng terrain)
 *   @param {number} [options.groundNormalThreshold=0.85] |normal.y| above this counts as ground
 *   @param {number} [options.groundDistanceM=2.5] only strip near-flat tris within this many metres of the mapng terrain (keeps flat/gentle roofs)
 *   @param {boolean} [options.cameraSweep=true] sweep the camera through extra stations so facades get refined
 *   @param {'standard'|'high'|'roads'} [options.quality='standard'] 'high' = 25 stations incl. a 4×4 low-altitude grid; 'roads' = high + up to 40 street-level stations along OSM roads
 *   @param {number} [options.sensorSize] virtual sensor resolution the SSE is measured against (1024 standard, 1536 high/roads) — higher = deeper tiles at the same errorTarget
 *   @param {number} [options.maxWaitMs] hard cap on total bake time; default derives from the station count (2 min + 25 s/station)
 *   @param {number} [options.stabilityMs=2500] queue must stay quiet this long to consider a station done
 *   @param {(p: {visible:number, downloading:number, parsing:number, elapsed:number, station:number, stations:number}) => void} [options.onProgress]
 */
export async function bakeGoogle3DTiles(data, options = {}) {
  const {
    apiKey,
    // Lower = higher-detail tiles (in BOTH mesh resolution and texture
    // resolution). Library default is 6, GoogleTilesRenderer mixin defaults
    // to 40 (realtime budget). errorTarget=5 pulls ~4× more tiles than the
    // earlier baseline of 8, sharpening mesh + textures without exploding
    // the browser memory budget.
    errorTarget = 5,
    stripGround = true,
    groundNormalThreshold = 0.85,
    // Near-flat tris are only stripped when they also sit within this many
    // metres of the mapng terrain — streets go, roofs stay.
    groundDistanceM = 2.5,
    cameraSweep = true,
    // 'standard': 5 stations (top-down + 4 oblique).
    // 'high':    top-down + 8 lower obliques + a low-altitude grid sized to
    //            ~250 m cells (4×4 on a 1 km AOI, up to 8×8 on large maps).
    //            Screen-space error scales with camera distance, so the much
    //            closer grid cameras force several LOD levels more mesh +
    //            texture detail. Expect 3-10× tiles/time/memory.
    // 'roads':   'high' plus street-level stations (~25 m above the OSM
    //            roads, aimed down-street, ~40 per km²) pulling Google's
    //            DEEPEST tiles along the driving corridor.
    quality = 'standard',
    // Virtual sensor resolution. Screen-space error is measured in PIXELS
    // against this render target, so resolution scales refinement directly:
    // 1.5× resolution = 1.5× stricter in world terms (~half an LOD level
    // deeper) — sharper tiles with no camera changes. 2048 was tried and
    // roughly QUADRUPLED tile counts (a full LOD level everywhere), blowing
    // every time/memory budget; 1536 is the sweet spot.
    sensorSize = quality === 'standard' ? 1024 : 1536,
    // Optional override for the total bake budget. By default it is derived
    // from the station count (which scales with AOI size): 2 min base +
    // 25 s per station. 2.5 s queue-quiet window per station.
    maxWaitMs = null,
    stabilityMs = 2500,
    onProgress,
  } = options;

  if (!apiKey) throw new Error('bakeGoogle3DTiles: missing apiKey');
  if (!data?.bounds || !data?.heightMap) throw new Error('bakeGoogle3DTiles: invalid terrain data');

  // Preflight the root tileset. 3d-tiles-renderer 0.3.46 dispatches no
  // 'load-error' event — a failed root fetch (key restrictions, API
  // disabled, billing, or EEA 403) would otherwise leave the bake polling
  // 0 tiles until maxWaitMs. Fail fast with the actual upstream error.
  // `apiKey` carries either a Google key or a Cesium ion token — see
  // tilesAuth.js; preflightTilesAuth routes to the right endpoint.
  await preflightTilesAuth(apiKey);

  const frame = computeAoiFrame(data, WGS84_ELLIPSOID);

  const tiles = new TilesRenderer();
  await registerTilesAuth(tiles, apiKey, { GoogleCloudAuthPlugin });
  tiles.errorTarget = errorTarget;

  // The library refuses to load new tiles while lruCache.isFull()
  // (TilesRendererBase.loadRootTileSet → `!lruCache.isFull()` guard). The
  // 0.3.46 defaults cap cachedBytes at 0.4 GB — errorTarget=5 over a dense
  // 1 km² AOI needs ~1.3–1.8k photogrammetry tiles which brushes right up
  // against that, so the bake stalls quietly and resolves with PARTIAL
  // coverage that looks like success. This is a one-shot offline bake, not
  // realtime rendering: give it a generous byte budget and wider queues.
  // (Tile-count caps of 8000/6000 are already ample — leave them alone.)
  // High/roads quality pulls several thousand extra tiles — scale the budgets
  // up (and the 8000-tile default count cap, which standard never reaches).
  const heavyBake = quality === 'high' || quality === 'roads';
  tiles.lruCache.minBytesSize = (heavyBake ? 2.5 : 1.0) * 1024 ** 3;
  tiles.lruCache.maxBytesSize = (heavyBake ? 3.0 : 1.5) * 1024 ** 3;
  if (heavyBake) {
    tiles.lruCache.minSize = 20000;
    tiles.lruCache.maxSize = 24000;
  }
  tiles.downloadQueue.maxJobs = 32;
  tiles.parseQueue.maxJobs = 8;

  // Everything time-driven runs off a Web-Worker ticker, NOT
  // requestAnimationFrame: browsers throttle rAF (and main-thread timers)
  // to ~1 fps or pause them entirely in background tabs, which turned long
  // bakes into hour-long crawls the moment the user tabbed away. Worker
  // messages are not throttled. This covers BOTH our own update loop AND
  // the library's PriorityQueue job pump, whose default scheduler is rAF.
  const tickerUrl = URL.createObjectURL(
    new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }),
  );
  const ticker = new Worker(tickerUrl);
  let tickHandler = null;
  const scheduledJobs = [];
  ticker.onmessage = () => {
    if (scheduledJobs.length) {
      for (const job of scheduledJobs.splice(0)) job();
    }
    tickHandler?.();
  };
  const stopTicker = () => {
    tickHandler = null;
    ticker.terminate();
    URL.revokeObjectURL(tickerUrl);
  };
  tiles.downloadQueue.schedulingCallback = (fn) => { scheduledJobs.push(fn); };
  tiles.parseQueue.schedulingCallback = (fn) => { scheduledJobs.push(fn); };
  // runStationSweep drives tiles.update() through this adapter.
  const startTicker = (tick) => {
    tickHandler = tick;
    return () => { tickHandler = null; };
  };

  const stations = buildSweepStations(frame, { quality, cameraSweep });

  const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e9);
  cam.up.copy(frame.upDir);
  cam.position.copy(frame.centerEcef).add(stations[0].offset);
  cam.lookAt(frame.centerEcef);
  cam.updateMatrixWorld(true);

  tiles.setCamera(cam);
  // The virtual sensor the LOD selector measures screen-space error against.
  // (Equivalent to the old offscreen-WebGLRenderer + setResolutionFromRenderer
  // dance — that helper only ever read the drawing-buffer size, which at
  // pixelRatio 1 was exactly sensorSize × sensorSize.)
  tiles.setResolution(cam, sensorSize, sensorSize);

  let sweep;
  try {
    sweep = await runStationSweep({
      tiles, cam, data, frame, stations,
      ellipsoid: WGS84_ELLIPSOID,
      quality, maxWaitMs, stabilityMs,
      startTicker, onProgress,
    });
  } finally {
    // Always kill the worker ticker — also on bake errors mid-sweep.
    stopTicker();
  }
  const { selectedTiles, timedOut, elapsedMs } = sweep;

  const bakeTiles = selectFinestCovering(selectedTiles);

  // Resolve scenes. With the per-tick markUsed pinning in the sweep,
  // selected tiles should never be evicted — if scenes are missing anyway,
  // say so LOUDLY: every missing scene is a visible hole in the map.
  const bakeScenes = [];
  // Owning tile's geometricError per scene (SMALLER = finer), parallel to
  // bakeScenes — the weld needs each output mesh's LOD to know which side of a
  // seam is authoritative.
  const bakeSceneGE = [];
  let missingScenes = 0;
  for (const tile of bakeTiles) {
    const scene = tile.cached?.scene;
    if (!scene) { missingScenes++; continue; }
    scene.updateMatrixWorld(true);
    bakeScenes.push(scene);
    bakeSceneGE.push(tile.geometricError ?? Infinity);
  }
  if (missingScenes > 0) {
    console.warn(
      `[google3dTiles] ${missingScenes}/${bakeTiles.length} selected tiles lost their scenes ` +
      '(LRU eviction under memory pressure) — the bake has coverage gaps. ' +
      'Reduce the AOI size or quality tier, or raise lruCache.maxBytesSize.',
    );
  }
  const forEachBakeMesh = (cb) => {
    for (let s = 0; s < bakeScenes.length; s++) {
      bakeScenes[s].traverse((node) => {
        // Pass the source-tile index so the output meshes can be grouped by
        // owning tile for the cross-tile seam-riser strip.
        if (node.isMesh && node.geometry) cb(node, s);
      });
    }
  };

  const bakeSecs = (elapsedMs / 1000).toFixed(1);
  const cacheBytes = tiles.lruCache?.cachedBytes ?? 0;
  const cacheFull = typeof tiles.lruCache?.isFull === 'function' ? tiles.lruCache.isFull() : false;
  console.info(
    `[google3dTiles] ${selectedTiles.size} tiles selected across ${stations.length} stations, ` +
    `${bakeTiles.length} kept after finest-covering dedup, in ${bakeSecs}s ` +
    `(errorTarget=${errorTarget}, quality=${quality}, sensor=${sensorSize}px, timedOut=${timedOut}, ` +
    `cache=${(cacheBytes / 1024 ** 2).toFixed(0)}MB, cacheFull=${cacheFull})`,
  );
  if (cacheFull) {
    console.warn(
      '[google3dTiles] LRU cache saturated during bake — coverage is likely partial. ' +
      'Raise lruCache.maxBytesSize or use a higher errorTarget.',
    );
  }
  if (bakeScenes.length === 0) {
    try { tiles.dispose(); } catch (_) { /* noop */ }
    throw new Error(
      `bakeGoogle3DTiles: 0 tiles loaded after ${bakeSecs}s. ` +
      'Camera/LOD selection found nothing — check the API key (Map Tiles API enabled, quota left) ' +
      'and that the AOI bounds are sane.',
    );
  }

  // Sample Google's altitude near AOI center — anchor Y so that Google's
  // ground at center == mapng's terrain at center.
  let googleGroundAlt = probeGroundAltitude(forEachBakeMesh, frame, WGS84_ELLIPSOID);
  if (googleGroundAlt === null) {
    console.warn(
      '[google3dTiles] ground probe found no vertices near the AOI centre — ' +
      'vertical anchor defaults to 0, tiles may float by the local ellipsoidal ground height',
    );
    googleGroundAlt = 0;
  }

  // Keep the ground here; the strip runs LAST (after the weld) so street risers
  // can be welded onto the street before it's removed. Mirrors the worker.
  const transformMesh = createTileMeshTransformer(data, frame, WGS84_ELLIPSOID, googleGroundAlt, {
    stripGround: false,
  });
  console.info(
    `[google3dTiles] vertical anchor: googleGroundAlt=${googleGroundAlt.toFixed(1)}m (ellipsoidal), ` +
    `mapngGroundY=${transformMesh.mapngGroundY.toFixed(1)}m, minHeight=${transformMesh.minH.toFixed(1)}m`,
  );

  const out = new THREE.Group();
  out.name = 'GoogleTiles3D';
  // Station footprints for the 3D preview's camera-position overlay
  // (includes road stations appended mid-sweep).
  out.userData.bakeStations = stations.map((st) => st.viz).filter(Boolean);

  let outputMeshIdx = 0;
  forEachBakeMesh((node, sceneIdx) => {
    const newGeom = transformMesh(node);
    if (!newGeom) return;

    // Each Google tile gets a unique material name so downstream Collada/material
    // pipelines can extract per-tile photogrammetry textures.
    //
    // Build a fresh MeshStandardMaterial regardless of the source type — Google's
    // photogrammetry tiles ship as MeshBasicMaterial (baked lighting), and the
    // ColladaExporter refuses to write texture refs for that type. The downstream
    // BeamNG materials.json defines an unlit-equivalent so visual result matches.
    const srcMat = Array.isArray(node.material) ? node.material[0] : node.material;
    const matName = `google_tile_${outputMeshIdx}`;
    // Unlit display via emissive routing — see deserializeGroup in
    // googleTilesPersistentCache.js for the full rationale.
    const standard = new THREE.MeshStandardMaterial({
      color: 0x000000,
      roughness: 1,
      metalness: 0,
      emissive: 0xffffff,
    });
    // Explicit assignment — Material constructor param sometimes drops `name`
    // depending on Three.js version, and BeamNG resolves materials by the DAE's
    // <material name=""> attribute which ColladaExporter writes from `m.name`.
    standard.name = matName;
    // Snapshot the source texture to a standalone canvas. tiles.dispose() below
    // frees the b3dm/glb image data, which would leave the original Texture's
    // .image empty by the time ColladaExporter reads it for PNG extraction.
    if (srcMat?.map?.image) {
      const img = srcMat.map.image;
      const w = img.width || img.naturalWidth;
      const h = img.height || img.naturalHeight;
      if (w > 0 && h > 0) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0);
        const snap = new THREE.CanvasTexture(c);
        snap.name = matName;
        snap.flipY = srcMat.map.flipY;
        snap.wrapS = srcMat.map.wrapS;
        snap.wrapT = srcMat.map.wrapT;
        snap.colorSpace = srcMat.map.colorSpace;
        snap.anisotropy = 16;
        standard.map = snap;
        standard.emissiveMap = snap;
      }
    }
    const newMesh = new THREE.Mesh(newGeom, standard);
    newMesh.name = matName;
    newMesh.userData.isGoogleTile = true;
    // Owning source tile — groups the soup for the seam-riser strip so a
    // tile's own vertical detail is never treated as the neighbour's ground.
    newMesh.userData.riserGroup = sceneIdx;
    out.add(newMesh);
    outputMeshIdx++;
  });

  try { tiles.dispose(); } catch (_) { /* noop */ }

  const upm = computeUnitsPerMeter(data);

  // Seam weld — close the LOD-transition tile-edge walls by snapping coarse
  // vertices onto the finer ground. The SAME shared pass the headless worker
  // runs, so the in-tab fallback and the export match. Default on.
  if (weldSeamsEnabled()) {
    const soup = out.children.map((m) => ({
      positions: m.geometry.attributes.position.array,
      index: m.geometry.index?.array,
      lod: bakeSceneGE[m.userData.riserGroup] ?? Infinity,
    }));
    const { positions, meshesMoved, vertsMoved } = weldSeams(soup, { unitsPerMeter: upm });
    for (let i = 0; i < out.children.length; i++) {
      if (positions[i]) {
        const attr = out.children[i].geometry.attributes.position;
        attr.array.set(positions[i]);
        attr.needsUpdate = true;
        out.children[i].geometry.computeVertexNormals();
      }
    }
    console.info(`[google3dTiles] seam weld: moved ${vertsMoved} verts across ${meshesMoved} meshes`);
  }

  // Ground strip — LAST, after the weld (so welded street risers go with the
  // street). The transform keeps the ground now, so this is where the heightmap
  // gets exposed. Mirrors the worker's applyGroundStrip.
  if (stripGround) {
    const soup = out.children.map((m) => ({
      positions: m.geometry.attributes.position.array,
      index: m.geometry.index?.array,
    }));
    const { indices, removed, total } = stripGroundTris(soup, data, {
      groundNormalThreshold, groundDistanceM,
    });
    for (let i = 0; i < out.children.length; i++) {
      if (indices[i] && indices[i] !== soup[i].index) {
        out.children[i].geometry.setIndex(Array.from(indices[i]));
      }
    }
    console.info(`[google3dTiles] ground strip: removed ${removed}/${total} near-terrain tris`);
  }

  // Legacy heuristic strip — off by default, behind localStorage mapng_strip_risers='1'.
  if (riserStripEnabled()) {
    const soup = out.children.map((m) => ({
      positions: m.geometry.attributes.position.array,
      index: m.geometry.index?.array,
      groupId: m.userData.riserGroup ?? -1,
    }));
    const { indices, removed, candidates } = stripSeamRisers(soup, { unitsPerMeter: upm });
    for (let i = 0; i < out.children.length; i++) {
      if (indices[i] && indices[i] !== soup[i].index) {
        out.children[i].geometry.setIndex(Array.from(indices[i]));
      }
    }
    console.info(`[google3dTiles] seam-riser strip: removed ${removed}/${candidates} candidate tris`);
  }

  console.info(
    `[google3dTiles] ${outputMeshIdx} tile meshes (from ${bakeScenes.length} tiles) survived AOI clip + ground strip`,
  );
  if (outputMeshIdx === 0) {
    throw new Error(
      `bakeGoogle3DTiles: ${bakeScenes.length} tiles loaded but none survived AOI clipping/ground stripping. ` +
      'The AOI bounds and the Google tile region may not overlap, or stripGround removed everything.',
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// In-memory bake cache — single entry, because a photogrammetry group holds
// hundreds of MB of canvas textures. Shared by the 3D preview and the BeamNG
// export so "preview first, then export" costs zero extra API calls.
//
// The cached group is OWNED BY THE CACHE: callers must not mutate or dispose
// it (the export path clones geometries before transforming). Deliberately
// not persisted to disk — memory cost aside, Google's Map Tiles ToS prohibits
// storing tile content.
// ---------------------------------------------------------------------------

let _bakeCache = null; // { key, promise }

// Bump when the bake output format/semantics change — persisted bakes from
// older versions are then simply never matched (and age out via LRU prune).
// v5: cross-tile seam-riser strip (removes the LOD-transition tile-edge walls).
const BAKE_FORMAT_VERSION = 5;

const bakeCacheKey = (
  data,
  {
    errorTarget = 5,
    stripGround = true,
    groundDistanceM = 2.5,
    cameraSweep = true,
    quality = 'standard',
    sensorSize = quality === 'standard' ? 1024 : 1536,
  } = {},
) => {
  const b = data.bounds;
  // Round to ~1 cm so float formatting noise between sessions can't split
  // identical coordinates into different cache keys.
  const r = (x) => Number(x).toFixed(7);
  return (
    `v${BAKE_FORMAT_VERSION}|${r(b.north)},${r(b.south)},${r(b.east)},${r(b.west)}` +
    `|${data.width}x${data.height}|et=${errorTarget}|sg=${stripGround}` +
    `|gd=${groundDistanceM}|sweep=${cameraSweep}|q=${quality}|px=${sensorSize}`
  );
};

/**
 * The preferred bake quality, persisted by the 3D-preview selector. Resolved
 * centrally so the preview AND the exports (which don't pass `quality`)
 * agree on the same cache key — a mismatch would silently re-bake.
 */
export function getPreferredBakeQuality() {
  try {
    const q = localStorage.getItem('mapng_google_bake_quality');
    return q === 'high' || q === 'roads' ? q : 'standard';
  } catch (_) {
    return 'standard';
  }
}

/**
 * Persisted ground-stripping preference. true (default) = streets/ground
 * near the mapng terrain are removed so the heightmap stays the driving
 * surface; false = keep Google's full ground (visible when the tiles are
 * lifted via the preview z-offset). Resolved centrally like the quality so
 * preview and exports agree on the same cache key.
 */
export function getPreferredStripGround() {
  try {
    return localStorage.getItem('mapng_google_bake_stripground') !== 'false';
  } catch (_) {
    return true;
  }
}

/**
 * Manual vertical lift (real metres) set via the preview's z-offset slider.
 * Display-side only — NOT part of the bake or its cache key — but the export
 * paths apply it so what you aligned in the preview is what you get in the
 * level/GLB/DAE.
 */
export function getGoogleTilesZOffset() {
  try {
    const v = Number(localStorage.getItem('mapng_google_bake_zoffset'));
    return Number.isFinite(v) ? v : 0;
  } catch (_) {
    return 0;
  }
}

const resolveBakeOptions = (options) => ({
  ...options,
  quality: options.quality ?? getPreferredBakeQuality(),
  stripGround: options.stripGround ?? getPreferredStripGround(),
});

const disposeGroup = (group) => {
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry?.dispose();
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      m?.map?.dispose();
      m?.dispose();
    }
  });
};

/**
 * Cached front-end for bakeGoogle3DTiles(). Two layers:
 *
 * 1. In-memory (this module, single entry) — same Group for identical
 *    (bounds, resolution, bake options); concurrent calls during a bake
 *    share one in-flight promise.
 * 2. IndexedDB (googleTilesPersistentCache.js) — survives page reloads /
 *    dev-server HMR, so re-generating the same coordinates restores the
 *    bake from disk instead of re-fetching from Google.
 *
 * On cache miss the bake itself routes by environment:
 *
 * - Node sidecar (dev server, scripts/viteGoogleBakePlugin.mjs) whenever it
 *   is reachable — ALL quality tiers. The worker runs the same shared-core
 *   pipeline in a child process with a multi-GB heap, so large AOIs and
 *   heavy tiers stop dying at the browser's ~4 GB ceiling. Jobs are keyed
 *   by this cache key and survive page reloads.
 * - In-browser bake otherwise (prod builds) — today's behavior and limits.
 *
 * `onProgress` only fires when a real bake runs — cache hits resolve fast.
 * Pass `forceRebake: true` to bypass and purge both layers for this key.
 */
export function getOrBakeGoogle3DTiles(data, options = {}) {
  const { forceRebake = false, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  if (!forceRebake && _bakeCache?.key === key) {
    console.info('[google3dTiles] cache hit — reusing baked tiles');
    return _bakeCache.promise;
  }

  clearGoogleTilesCache();

  const run = async () => {
    if (forceRebake) {
      await deletePersistedBake(key).catch(() => { /* best effort */ });
    } else {
      try {
        const t0 = performance.now();
        const restored = await loadPersistedBake(key);
        if (restored) {
          console.info(
            `[google3dTiles] restored ${restored.children.length} tile meshes from IndexedDB ` +
            `in ${((performance.now() - t0) / 1000).toFixed(1)}s — no Google refetch`,
          );
          return restored;
        }
      } catch (err) {
        console.warn('[google3dTiles] persistent cache read failed — baking fresh:', err);
      }
    }

    if (await sidecarAvailable()) {
      console.info('[google3dTiles] baking via Node sidecar');
      // The sidecar client persists the result records to IndexedDB itself.
      return bakeViaSidecar(data, bakeOptions, key, { force: forceRebake });
    }

    const group = await bakeGoogle3DTiles(data, bakeOptions);
    // Persist in the background; never block or fail the bake on it.
    persistBake(key, group)
      .then((bytes) => {
        if (bytes !== null) {
          console.info(
            `[google3dTiles] bake persisted to IndexedDB (~${(bytes / 1024 ** 2).toFixed(0)} MB) key=${key}`,
          );
        }
      })
      .catch((err) => console.warn('[google3dTiles] persisting bake failed (quota?):', err));
    return group;
  };

  const promise = run().catch((err) => {
    // Failed bakes must not poison the cache.
    if (_bakeCache?.promise === promise) _bakeCache = null;
    throw err;
  });
  _bakeCache = { key, promise };
  return promise;
}

/**
 * Restore-only probe: returns the baked Group for this AOI from the
 * in-memory or IndexedDB cache, or null — never fetches from Google.
 * Used by the 3D preview on page load so an already-baked AOI reappears
 * without clicking "Load".
 */
export async function restoreBakedGoogle3DTiles(data, options = {}) {
  const { forceRebake: _ignored, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  if (_bakeCache?.key === key) return _bakeCache.promise;

  let group = null;
  try {
    group = await loadPersistedBake(key);
  } catch (err) {
    console.warn('[google3dTiles] persistent cache probe failed:', err);
    return null;
  }
  if (!group) {
    // The sidecar may still hold a finished job for this key (page reloaded
    // before the IndexedDB persist landed, or the persist failed on quota).
    // Restore-only: never starts or joins a bake.
    group = await restoreSidecarBake(key);
  }
  if (!group) {
    console.info(`[google3dTiles] no persisted bake for key ${key}`);
    return null;
  }
  // A bake may have started for the same key while we were decoding —
  // defer to it rather than overwriting (its group would get disposed).
  if (_bakeCache?.key === key) return _bakeCache.promise;

  clearGoogleTilesCache();
  _bakeCache = { key, promise: Promise.resolve(group) };
  console.info(
    `[google3dTiles] restored ${group.children.length} tile meshes from IndexedDB — no Google refetch`,
  );
  return group;
}

/**
 * Refine the current bake from a user camera station (fly mode in the 3D
 * preview). Requires a live sidecar bake session for this AOI/options key —
 * the worker sweeps the station with its warm cache, merges via
 * finest-covering and rewrites the result; we decode the full update here.
 *
 * Returns the NEW group and installs it as the in-memory cache entry. The
 * caller owns the swap in the UI and must dispose the previous group
 * afterwards via disposeBakeGroup() — disposing here would yank textures out
 * from under the still-rendering preview.
 */
export async function refineGoogleTilesBake(data, options, station) {
  const { forceRebake: _ignored, onProgress, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  // A bake restored from cache has no live worker session (dev-server
  // restart, idle reap) — transparently re-bake once to rebuild it. The
  // result content is identical, so only the session state is fetched.
  await ensureSidecarSession(data, bakeOptions, key, onProgress);
  const group = await bakeRefinementViaSidecar(key, station, onProgress);
  _bakeCache = { key, promise: Promise.resolve(group) };
  return group;
}

/**
 * Assemble the BeamNG google_tiles export server-side (atlas + GLB in the
 * bake worker — see exportAssemblyViaSidecar). Resolves the same cache key
 * as the preview, rebuilding the worker session first if it died, so the
 * export always assembles exactly the bake (incl. refinements) on screen.
 *
 * @param {object} spec { worldSize, zOffsetM }
 * @returns {{glbPath, glbBytes, textures, materialNames, meshes}}
 */
export async function exportGoogleTilesViaSidecar(data, options, spec) {
  const { forceRebake: _ignored, onProgress, ...bakeOptions } = resolveBakeOptions(options);
  const key = bakeCacheKey(data, bakeOptions);
  await ensureSidecarSession(data, bakeOptions, key, onProgress);
  return exportAssemblyViaSidecar(key, spec, onProgress);
}

/** Dispose a bake group's geometries, materials and textures (see refineGoogleTilesBake). */
export function disposeBakeGroup(group) {
  if (group) disposeGroup(group);
}

/** Dispose the cached bake (geometries, materials, canvas textures), if any. */
export function clearGoogleTilesCache() {
  if (!_bakeCache) return;
  const evicted = _bakeCache;
  _bakeCache = null;
  // Dispose once the bake settles — it may still be in flight.
  evicted.promise.then(disposeGroup).catch(() => { /* already logged */ });
}
