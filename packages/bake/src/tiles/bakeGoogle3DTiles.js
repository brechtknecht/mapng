/** @layer flow */
// Browser orchestrator for a Google Photorealistic 3D Tiles bake (refactor doc
// 06 step 3). Web-Worker ticker, decoded-texture snapshots, and the shared
// weld/conform/strip geometry passes. Moved verbatim from google3dTiles.js.
import * as THREE from 'three';
import { TilesRenderer, GoogleCloudAuthPlugin, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { registerTilesAuth, preflightTilesAuth } from '@mapng/fetching';
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
} from '../googleBakeCore.js';
import { conformTilesToFloor } from '../tileGroundConform.js';
import { buildGroundMask } from '../groundMask.js';
import {
  weldSeamsEnabled,
  riserStripEnabled,
  conformTilesEnabled,
  conformRoadmaskEnabled,
} from './bakeFlags.js';

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
 *   @param {'standard'|'high'|'roads'|'max'} [options.quality='standard'] 'high' = 25 stations incl. a 4×4 low-altitude grid; 'roads' = high + up to 40 street-level stations along OSM roads; 'max' = roads + a per-cell low-oblique facade ring + errorTarget 3 + a saturation stop (auto fly-mode — pulls Google's finest LOD everywhere)
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
    // Route-corridor mode (opt-in, set by the route bake via export3d.js).
    // When present, the sweep follows the route polyline within ±halfWidth
    // instead of covering the whole AOI box. Omitted for the area/single-tile
    // export, which keeps the full box-covering sweep.
    corridorSegment = null,
    corridorHalfWidthM = 0,
    // Route mode: one route-wide vertical anchor (metres) shared by every chunk
    // so adjacent chunks stay co-continuous at their seams. null → per-chunk.
    sharedGroundOffsetM = null,
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
  // 'max' adds a dense low-oblique facade ring + errorTarget 3, pulling more
  // tiles again than high/roads — give it the biggest budget the browser
  // fallback can hold (the Node worker uses its own multi-GB heap regardless).
  const heavyBake = quality === 'high' || quality === 'roads' || quality === 'max';
  const maxBake = quality === 'max';
  tiles.lruCache.minBytesSize = (heavyBake ? 2.5 : 1.0) * 1024 ** 3;
  tiles.lruCache.maxBytesSize = (maxBake ? 3.5 : heavyBake ? 3.0 : 1.5) * 1024 ** 3;
  if (heavyBake) {
    tiles.lruCache.minSize = maxBake ? 24000 : 20000;
    tiles.lruCache.maxSize = maxBake ? 28000 : 24000;
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

  const stations = buildSweepStations(frame, { quality, cameraSweep, corridorSegment });

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
      corridorSegment, corridorHalfWidthM,
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
    ...(Number.isFinite(sharedGroundOffsetM) ? { groundOffsetM: sharedGroundOffsetM } : {}),
  });
  console.info(
    `[google3dTiles] vertical anchor: googleGroundAlt=${googleGroundAlt.toFixed(1)}m (ellipsoidal), ` +
    `mapngGroundY=${transformMesh.mapngGroundY.toFixed(1)}m, minHeight=${transformMesh.minH.toFixed(1)}m`,
  );

  const out = new THREE.Group();
  out.name = 'GoogleTiles3D';
  // Station footprints for the 3D preview's camera-position overlay
  // (includes road/corridor stations appended mid-sweep).
  out.userData.bakeStations = stations.map((st) => st.viz).filter(Boolean);
  // Bake telemetry for the route manifest's per-chunk bake{} block (§6).
  out.userData.bakeStats = {
    stations: stations.length,
    selected: selectedTiles.size,
    kept: bakeTiles.length,
    timedOut,
    elapsedMs: Math.round(elapsedMs),
  };
  // The effective vertical anchor — route chunk 0 reports it so every later
  // chunk + the preview share one datum (no per-chunk seam float).
  out.userData.groundOffsetM = transformMesh.groundOffsetM;

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

  // Delta-field conform — AFTER the weld (consistent ground), BEFORE the ground
  // strip (needs the ground tris present to measure the residual). Seats the
  // whole mesh onto the .ter floor; buildings keep their height above ground.
  if (conformTilesEnabled()) {
    const soup = out.children.map((m) => ({
      positions: m.geometry.attributes.position.array,
      index: m.geometry.index?.array,
    }));
    // Semantic road mask (full-res, vector-clean) — lets the conform snap known
    // flat ground onto the DEM, flattening photogrammetry wiggle and seating
    // floaters the ±band can't reach. Null (delta field only) when disabled or
    // when this AOI carries no OSM roads.
    const groundMask = conformRoadmaskEnabled()
      ? buildGroundMask(data.osmFeatures, data)
      : null;
    const r = conformTilesToFloor(soup, data, { groundMask });
    for (let i = 0; i < out.children.length; i++) {
      if (r.positions[i]) {
        const attr = out.children[i].geometry.attributes.position;
        attr.array.set(r.positions[i]);
        attr.needsUpdate = true;
        out.children[i].geometry.computeVertexNormals();
      }
    }
    console.info(
      `[google3dTiles] tile conform: moved ${r.vertsMoved} verts across ${r.meshesMoved} meshes, ` +
      `${r.cellsFilled} field cells, ground residual ${r.residualBefore.toFixed(2)}m → ${r.residualAfter.toFixed(2)}m` +
      (groundMask
        ? `, snapped ${r.vertsSnapped} road verts (max float fixed ${r.maxFloatFixedM.toFixed(1)}m)`
        : ' (road mask off/none)'),
    );
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
