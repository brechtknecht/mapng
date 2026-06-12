import * as THREE from 'three';
import { TilesRenderer, GoogleCloudAuthPlugin, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { createMetricProjector } from './geoUtils.js';
import { loadPersistedBake, persistBake, deletePersistedBake } from './googleTilesPersistentCache.js';

// Mirror export3d.js — kept local to avoid a circular import.
const SCENE_SIZE = 100;

export const sampleHeightAtScene = (data, x, z) => {
  const half = SCENE_SIZE / 2;
  const u = Math.max(0, Math.min(1, (x + half) / SCENE_SIZE));
  const v = Math.max(0, Math.min(1, (z + half) / SCENE_SIZE));
  const localX = u * (data.width - 1);
  const localZ = v * (data.height - 1);
  const x0 = Math.floor(localX);
  const x1 = Math.min(x0 + 1, data.width - 1);
  const y0 = Math.floor(localZ);
  const y1 = Math.min(y0 + 1, data.height - 1);
  const wx = localX - x0;
  const wy = localZ - y0;
  const hm = data.heightMap;
  const w = data.width;
  const minH = data.minHeight;
  const sample = (i) => (hm[i] < -10000 ? minH : hm[i]);
  const h00 = sample(y0 * w + x0);
  const h10 = sample(y0 * w + x1);
  const h01 = sample(y1 * w + x0);
  const h11 = sample(y1 * w + x1);
  return (
    h00 * (1 - wx) * (1 - wy) +
    h10 * wx * (1 - wy) +
    h01 * (1 - wx) * wy +
    h11 * wx * wy
  );
};

export const computeUnitsPerMeter = (data) => {
  const latRad = (((data.bounds.north + data.bounds.south) / 2) * Math.PI) / 180;
  const metersPerDegree = 111320 * Math.cos(latRad);
  const realWidthMeters = (data.bounds.east - data.bounds.west) * metersPerDegree;
  return SCENE_SIZE / realWidthMeters;
};

// Road classes worth a street-level camera, most important first — the
// station cap is spent on major driving corridors before side streets.
const ROAD_PRIORITY = {
  motorway: 0,
  trunk: 1,
  primary: 2,
  secondary: 3,
  tertiary: 4,
  residential: 5,
  unclassified: 6,
  living_street: 7,
};

/**
 * Sample street-level camera stations along the OSM road network: one every
 * `spacingM` metres along roads (major classes first), deduped to `minSepM`,
 * capped at `maxStations`. Returns ENU offsets + a down-street look target.
 */
const buildRoadStations = (data, {
  centerLat, centerLng, metersPerDegree, extentM,
  horiz, upDir, groundAltAt,
  spacingM = 120, minSepM = 60, altitudeM = 25, aheadM = 35, maxStations = 40,
}) => {
  const half = extentM / 2;
  const roads = (data.osmFeatures ?? [])
    .filter((f) => f.type === 'road' && f.geometry?.length >= 2 && (f.tags?.highway in ROAD_PRIORITY))
    .map((f) => ({ f, prio: ROAD_PRIORITY[f.tags.highway] }))
    .sort((a, b) => a.prio - b.prio);

  const accepted = [];
  const minSepSq = minSepM * minSepM;
  outer:
  for (const { f } of roads) {
    const pts = f.geometry.map((p) => ({
      e: (p.lng - centerLng) * metersPerDegree,
      n: (p.lat - centerLat) * 111320,
    }));
    let carry = spacingM * 0.5; // first station half a spacing into the road
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const segLen = Math.hypot(b.e - a.e, b.n - a.n);
      if (segLen < 1e-6) continue;
      let t = carry;
      while (t < segLen) {
        const u = t / segLen;
        const e = a.e + (b.e - a.e) * u;
        const n = a.n + (b.n - a.n) * u;
        t += spacingM;
        if (Math.abs(e) > half || Math.abs(n) > half) continue;
        if (accepted.some((s) => (s.e - e) ** 2 + (s.n - n) ** 2 < minSepSq)) continue;
        accepted.push({ e, n, dirE: (b.e - a.e) / segLen, dirN: (b.n - a.n) / segLen });
        if (accepted.length >= maxStations) break outer;
      }
      carry = t - segLen;
    }
  }

  return accepted.map((s, i) => {
    const groundAlt = groundAltAt(s.e, s.n);
    return {
      label: `road-${i}`,
      offset: horiz(s.e, s.n).addScaledVector(upDir, groundAlt + altitudeM),
      // Aim at the street surface a few car-lengths ahead — the frustum then
      // covers asphalt plus both facade walls at maximum LOD.
      target: horiz(s.e + s.dirE * aheadM, s.n + s.dirN * aheadM).addScaledVector(upDir, groundAlt),
      viz: { kind: 'road', e: s.e, n: s.n, aglM: altitudeM },
    };
  });
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
  // disabled, billing) would otherwise leave the bake polling 0 tiles
  // until maxWaitMs. Fail fast with the actual Google error instead.
  // Note: a 404 "Requested entity was not found" means the Map Tiles API
  // is not enabled / not allowed for this key's project.
  const probe = await fetch(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${apiKey}`);
  if (!probe.ok) {
    let detail = '';
    try { detail = (await probe.json())?.error?.message ?? ''; } catch (_) { /* noop */ }
    throw new Error(
      `Google Map Tiles API rejected the request (HTTP ${probe.status}${detail ? `: ${detail}` : ''}). ` +
      'Check that the Map Tiles API is enabled for the project, the API key allows it, and billing is active.',
    );
  }

  const centerLat = (data.bounds.north + data.bounds.south) / 2;
  const centerLng = (data.bounds.east + data.bounds.west) / 2;
  const latRad = (centerLat * Math.PI) / 180;
  const lonRad = (centerLng * Math.PI) / 180;

  // AOI extent (meters) — used to size the virtual camera so the LOD selector
  // picks tiles that cover the AOI from above.
  const metersPerDegree = 111320 * Math.cos(latRad);
  const widthM = (data.bounds.east - data.bounds.west) * metersPerDegree;
  const heightM = (data.bounds.north - data.bounds.south) * 111320;
  const extentM = Math.max(widthM, heightM);

  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
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

  // ONE camera, swept through several stations in sequence: top-down first
  // (the proven baseline), then four oblique views from the cardinal
  // directions so facades cover enough screen pixels for the LOD selector
  // to refine them. Registering multiple cameras SIMULTANEOUSLY broke the
  // bake entirely (0 tiles — hard-won lesson 7); repositioning a single
  // camera keeps the selector consistent, and tiles loaded at earlier
  // stations stay in the LRU cache. Each station's selection is snapshotted
  // and the union is deduped to the finest covering before the merge.
  const centerEcef = new THREE.Vector3();
  WGS84_ELLIPSOID.getCartographicToPosition(latRad, lonRad, 0, centerEcef);
  const upDir = centerEcef.clone().normalize();
  // Local ENU basis at the AOI centre (ECEF +Z points at the north pole).
  const eastDir = new THREE.Vector3(0, 0, 1).cross(upDir).normalize();
  const northDir = upDir.clone().cross(eastDir).normalize();
  // Stations: { label, offset (camera position relative to AOI centre),
  // target (look-at point relative to AOI centre, default = centre) }.
  const horiz = (e, n) =>
    new THREE.Vector3().addScaledVector(eastDir, e).addScaledVector(northDir, n);
  // `viz` carries an ENU footprint (east/north metres from the AOI centre,
  // approx. height above ground) so the 3D preview can display the stations.
  const stations = [
    {
      label: 'top-down',
      offset: new THREE.Vector3().addScaledVector(upDir, extentM * 1.5 + 200),
      viz: { kind: 'overview', e: 0, n: 0, aglM: extentM * 1.5 + 200 },
    },
  ];
  if (cameraSweep) {
    if (quality === 'high' || quality === 'roads') {
      // 8 perimeter obliques, lower than standard for sharper facades. The
      // near side fills the frustum at high LOD; the far side is covered by
      // the opposite station.
      const dirs = [
        ['north', 0, 1], ['north-east', Math.SQRT1_2, Math.SQRT1_2],
        ['east', 1, 0], ['south-east', Math.SQRT1_2, -Math.SQRT1_2],
        ['south', 0, -1], ['south-west', -Math.SQRT1_2, -Math.SQRT1_2],
        ['west', -1, 0], ['north-west', -Math.SQRT1_2, Math.SQRT1_2],
      ];
      for (const [label, e, n] of dirs) {
        stations.push({
          label: `oblique-${label}`,
          offset: horiz(e * extentM * 0.8, n * extentM * 0.8).addScaledVector(upDir, extentM * 0.5),
          viz: { kind: 'oblique', e: e * extentM * 0.8, n: n * extentM * 0.8, aglM: extentM * 0.5 },
        });
      }
      // Grid of low-altitude cells, each looked at straight down from much
      // closer than the overview — this is what drags the LOD selector
      // several levels deeper (screen-space error scales with distance).
      // The grid SIZE adapts to the AOI so detail DENSITY stays constant:
      // ~250 m cells regardless of map size (a fixed 4×4 would let cell
      // size — and camera altitude — grow with the AOI, collapsing quality
      // on larger maps back to overview level).
      const GRID = Math.min(8, Math.max(2, Math.round(extentM / 250)));
      const cellM = extentM / GRID;
      const gridAlt = cellM * 1.3 + 60;
      for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
          const cellE = ((gx + 0.5) / GRID - 0.5) * extentM;
          const cellN = ((gy + 0.5) / GRID - 0.5) * extentM;
          const target = horiz(cellE, cellN);
          stations.push({
            label: `grid-${gx},${gy}`,
            offset: target.clone().addScaledVector(upDir, gridAlt),
            target,
            viz: { kind: 'grid', e: cellE, n: cellN, aglM: gridAlt },
          });
        }
      }
    } else {
      // Standard: 4 oblique views, far enough out that the whole AOI fits
      // the 60° FOV and sits well past the near plane (the suspected
      // multi-camera killer).
      const obliqueOffset = (e, n) =>
        horiz(e * extentM * 1.1, n * extentM * 1.1).addScaledVector(upDir, extentM * 0.8);
      const obliqueViz = (e, n) =>
        ({ kind: 'oblique', e: e * extentM * 1.1, n: n * extentM * 1.1, aglM: extentM * 0.8 });
      stations.push(
        { label: 'north', offset: obliqueOffset(0, 1), viz: obliqueViz(0, 1) },
        { label: 'east', offset: obliqueOffset(1, 0), viz: obliqueViz(1, 0) },
        { label: 'south', offset: obliqueOffset(0, -1), viz: obliqueViz(0, -1) },
        { label: 'west', offset: obliqueOffset(-1, 0), viz: obliqueViz(-1, 0) },
      );
    }
  }
  const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e9);
  cam.up.copy(upDir);
  cam.position.copy(centerEcef).add(stations[0].offset);
  cam.lookAt(centerEcef);
  cam.updateMatrixWorld(true);

  // Offscreen WebGLRenderer is only consumed for setResolutionFromRenderer's
  // pixel-ratio + size info; nothing is ever drawn to it. Its size is the
  // virtual sensor the LOD selector measures screen-space error against —
  // see the `sensorSize` option.
  const offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = sensorSize;
  offscreenCanvas.height = sensorSize;
  const offscreen = new THREE.WebGLRenderer({ canvas: offscreenCanvas, alpha: true });
  offscreen.setSize(sensorSize, sensorSize, false);

  tiles.setCamera(cam);
  tiles.setResolutionFromRenderer(cam, offscreen);

  let updateError = null;
  const onUpdateError = (e) => { updateError = e; };
  tiles.addEventListener('load-error', onUpdateError);

  // Drive the update loop per station until the queue stays quiet for
  // `stabilityMs` (or the global `maxWaitMs` budget runs out), snapshotting
  // the selection after each station. tiles.group only ever contains the
  // CURRENT station's selection — later stations deselect what they don't
  // need — so the union of per-station snapshots is what gets baked.
  const startedAt = performance.now();
  let timedOut = false;
  const selectedTiles = new Set();
  // Derived from the (AOI-dependent) station count; recomputed when the
  // road pass appends stations mid-sweep.
  let bakeBudgetMs = maxWaitMs ?? (120000 + stations.length * 25000);

  const waitForQuiet = (stationIdx) => new Promise((resolve, reject) => {
    let lastChange = performance.now();
    let lastVisible = -1;
    // Stations served entirely from cache trigger no downloads — exit those
    // after a short grace period instead of the full stability window
    // (on a 70-station sweep that alone saves minutes of pure waiting).
    let sawActivity = false;
    const finish = (fn, arg) => { tickHandler = null; fn(arg); };

    const tick = () => {
      if (updateError) { finish(reject, updateError); return; }
      try {
        tiles.update();
      } catch (e) { finish(reject, e); return; }

      // Pin every tile selected by ANY earlier station. update() only marks
      // the CURRENT selection as used, so prior stations' tiles become
      // evictable once the cache crosses its byte threshold mid-sweep —
      // their scenes would be gone at merge time, leaving holes in the map.
      // Pinned, the cache instead stalls NEW loads when full: later stations
      // gracefully lose detail rather than earlier regions losing geometry.
      for (const t of selectedTiles) tiles.lruCache.markUsed(t);

      const now = performance.now();
      const downloading = tiles.stats?.downloading ?? 0;
      const parsing = tiles.stats?.parsing ?? 0;
      if (downloading + parsing > 0) sawActivity = true;
      let visible = 0;
      tiles.group.traverse((o) => { if (o.isMesh) visible++; });

      if (visible !== lastVisible) {
        lastVisible = visible;
        lastChange = now;
      }

      onProgress?.({
        visible,
        downloading,
        parsing,
        elapsed: now - startedAt,
        station: stationIdx + 1,
        stations: stations.length,
      });

      const quietMs = sawActivity ? stabilityMs : 700;
      const quiet = downloading === 0 && parsing === 0 && (now - lastChange) > quietMs;
      if (quiet && visible > 0) { finish(resolve); return; }
      if (now - startedAt > bakeBudgetMs) { timedOut = true; finish(resolve); return; }
    };
    tickHandler = tick;
    tick();
  });

  const lookTarget = new THREE.Vector3();
  try {
  for (let s = 0; s < stations.length; s++) {
    cam.position.copy(centerEcef).add(stations[s].offset);
    lookTarget.copy(centerEcef);
    if (stations[s].target) lookTarget.add(stations[s].target);
    cam.lookAt(lookTarget);
    cam.updateMatrixWorld(true);

    await waitForQuiet(s);

    for (const tile of tiles.visibleTiles) selectedTiles.add(tile);
    console.info(
      `[google3dTiles] station ${s + 1}/${stations.length} (${stations[s].label}): ` +
      `${tiles.visibleTiles.size} tiles selected, ${selectedTiles.size} unique total, ` +
      `${((performance.now() - startedAt) / 1000).toFixed(1)}s elapsed`,
    );
    if (timedOut) {
      console.warn(
        `[google3dTiles] bake budget (${Math.round(bakeBudgetMs / 1000)}s) exhausted at station ` +
        `${s + 1}/${stations.length} — skipping remaining stations`,
      );
      break;
    }

    // 'roads' quality: street-level stations need the ellipsoidal ground
    // altitude, which is only known once the overview station has loaded
    // tiles — probe now and append the road pass to the sweep. Per-station
    // street height = centre altitude + the mapng heightmap's relative
    // elevation (the geoid offset is locally constant).
    if (s === 0 && quality === 'roads') {
      const probeRadiusM = Math.max(50, extentM * 0.1);
      const probeRadiusSq = probeRadiusM * probeRadiusM;
      const cosLatP = Math.cos(latRad);
      const tmpP = new THREE.Vector3();
      const cartP = {};
      const heightsP = [];
      tiles.group.updateMatrixWorld(true);
      tiles.group.traverse((node) => {
        if (!node.isMesh || !node.geometry?.attributes?.position) return;
        const pos = node.geometry.attributes.position;
        const m = node.matrixWorld;
        for (let i = 0; i < pos.count; i += 7) { // stride — estimate only
          tmpP.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
          WGS84_ELLIPSOID.getPositionToCartographic(tmpP, cartP);
          const dN = (cartP.lat - latRad) * 6371000;
          const dE = (cartP.lon - lonRad) * 6371000 * cosLatP;
          if (dN * dN + dE * dE > probeRadiusSq) continue;
          heightsP.push(cartP.height);
        }
      });
      if (heightsP.length === 0) {
        console.warn('[google3dTiles] road pass: ground probe found nothing — skipping street-level stations');
      } else {
        heightsP.sort((x, y) => x - y);
        const centerGroundAlt = heightsP[Math.floor(heightsP.length * 0.05)];
        const upm = computeUnitsPerMeter(data);
        const centerTerrain = sampleHeightAtScene(data, 0, 0);
        const groundAltAt = (e, n) =>
          centerGroundAlt + (sampleHeightAtScene(data, e * upm, -n * upm) - centerTerrain);
        // Cap scales with AOI area so road coverage density stays constant
        // (~40 stations per km², clamped) instead of thinning out on big maps.
        const areaKm2 = (extentM / 1000) ** 2;
        const roadStations = buildRoadStations(data, {
          centerLat, centerLng, metersPerDegree, extentM, horiz, upDir, groundAltAt,
          maxStations: Math.min(160, Math.max(40, Math.round(40 * areaKm2))),
        });
        if (roadStations.length === 0) {
          console.warn('[google3dTiles] road pass: no OSM roads found in the AOI — skipping street-level stations');
        } else {
          stations.push(...roadStations);
          if (maxWaitMs == null) bakeBudgetMs = 120000 + stations.length * 25000;
          console.info(
            `[google3dTiles] road pass: ${roadStations.length} street-level stations queued ` +
            `(ground ≈ ${centerGroundAlt.toFixed(1)}m ellipsoidal, budget now ${Math.round(bakeBudgetMs / 1000)}s)`,
          );
        }
      }
    }
  }

  } finally {
    // Always kill the worker ticker — also on bake errors mid-sweep.
    stopTicker();
  }

  tiles.removeEventListener('load-error', onUpdateError);

  // Different stations select the same region at different depths (e.g. the
  // far side of the AOI is coarser from an oblique view). Keep the finest:
  // drop any selected tile whose area is fully covered by selected
  // descendants. Tiles partially covered by finer selections are kept —
  // a small overlap beats a hole.
  const coverMemo = new Map();
  const coveredBySelection = (tile) => {
    if (selectedTiles.has(tile)) return true;
    if (coverMemo.has(tile)) return coverMemo.get(tile);
    const kids = tile.children || [];
    const covered = kids.length > 0 && kids.every(coveredBySelection);
    coverMemo.set(tile, covered);
    return covered;
  };
  const bakeTiles = [...selectedTiles].filter((tile) => {
    const kids = tile.children || [];
    return !(kids.length > 0 && kids.every(coveredBySelection));
  });

  // Resolve scenes. With the per-tick markUsed pinning above, selected
  // tiles should never be evicted — if scenes are missing anyway, say so
  // LOUDLY: every missing scene is a visible hole in the map.
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
      `[google3dTiles] ${missingScenes}/${bakeTiles.length} selected tiles lost their scenes ` +
      '(LRU eviction under memory pressure) — the bake has coverage gaps. ' +
      'Reduce the AOI size or quality tier, or raise lruCache.maxBytesSize.',
    );
  }
  const forEachBakeMesh = (cb) => {
    for (const scene of bakeScenes) {
      scene.traverse((node) => {
        if (node.isMesh && node.geometry) cb(node);
      });
    }
  };

  const bakeSecs = ((performance.now() - startedAt) / 1000).toFixed(1);
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
    try { offscreen.dispose(); } catch (_) { /* noop */ }
    throw new Error(
      `bakeGoogle3DTiles: 0 tiles loaded after ${bakeSecs}s. ` +
      'Camera/LOD selection found nothing — check the API key (Map Tiles API enabled, quota left) ' +
      'and that the AOI bounds are sane.',
    );
  }

  // Sample Google's altitude near AOI center — we'll anchor Y so that Google's
  // ground at center == mapng's terrain at center.
  //
  // The probe must be HORIZONTAL (lat/lon distance). An earlier version
  // measured 3D ECEF distance from a point at ellipsoid height 0 — but real
  // ground sits tens of metres above the ellipsoid (geoid offset + terrain
  // elevation, ~75 m in Berlin), so few or no vertices fell inside the
  // sphere and the anchor collapsed to 0, floating the whole city by that
  // altitude. Use a low percentile rather than the minimum so below-ground
  // junk geometry (canals, basements) can't sink the anchor either.
  let googleGroundAlt = null;
  {
    const probeRadiusM = Math.max(50, extentM * 0.1);
    const probeRadiusSq = probeRadiusM * probeRadiusM;
    const cosLat = Math.cos(latRad);
    const tmp = new THREE.Vector3();
    const cart = {};
    const heights = [];
    forEachBakeMesh((node) => {
      const pos = node.geometry.attributes.position;
      if (!pos) return;
      const m = node.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
        WGS84_ELLIPSOID.getPositionToCartographic(tmp, cart);
        const dNorth = (cart.lat - latRad) * 6371000;
        const dEast = (cart.lon - lonRad) * 6371000 * cosLat;
        if (dNorth * dNorth + dEast * dEast > probeRadiusSq) continue;
        heights.push(cart.height);
      }
    });
    if (heights.length > 0) {
      heights.sort((x, y) => x - y);
      googleGroundAlt = heights[Math.floor(heights.length * 0.05)];
    }
  }
  if (googleGroundAlt === null) {
    console.warn(
      '[google3dTiles] ground probe found no vertices near the AOI centre — ' +
      'vertical anchor defaults to 0, tiles may float by the local ellipsoidal ground height',
    );
    googleGroundAlt = 0;
  }

  const projector = createMetricProjector(data.bounds, data.width, data.height);
  const mapngGroundY = sampleHeightAtScene(data, 0, 0);
  const halfScene = SCENE_SIZE / 2;
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  console.info(
    `[google3dTiles] vertical anchor: googleGroundAlt=${googleGroundAlt.toFixed(1)}m (ellipsoidal), ` +
    `mapngGroundY=${mapngGroundY.toFixed(1)}m, minHeight=${minH.toFixed(1)}m`,
  );
  // Output Y is meters while X/Z are scene units — anisotropic. The ground-
  // normal test below must run in a metrically uniform space or sloped
  // hillsides stop counting as ground; scale Y by this when building tris.
  const unitsPerMeter = computeUnitsPerMeter(data);

  const out = new THREE.Group();
  out.name = 'GoogleTiles3D';
  // Station footprints for the 3D preview's camera-position overlay
  // (includes road stations appended mid-sweep).
  out.userData.bakeStations = stations.map((st) => st.viz).filter(Boolean);

  const tmpEcef = new THREE.Vector3();
  const cart = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

  let outputMeshIdx = 0;
  forEachBakeMesh((node) => {
    const srcGeom = node.geometry;
    const srcPos = srcGeom.attributes.position;
    if (!srcPos) return;

    const vCount = srcPos.count;
    const worldMat = node.matrixWorld;

    const newPositions = new Float32Array(vCount * 3);
    const insideMask = new Uint8Array(vCount);
    // Metres above the local mapng terrain — lets the ground strip below
    // distinguish streets (≈0 m) from flat roofs (10–30 m).
    const aboveTerrain = new Float32Array(vCount);

    for (let i = 0; i < vCount; i++) {
      tmpEcef.set(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i)).applyMatrix4(worldMat);
      WGS84_ELLIPSOID.getPositionToCartographic(tmpEcef, cart);
      const latDeg = (cart.lat * 180) / Math.PI;
      const lonDeg = (cart.lon * 180) / Math.PI;

      const p = projector(latDeg, lonDeg);
      const u = p.x / (data.width - 1);
      const v = p.y / (data.height - 1);
      const sceneX = u * SCENE_SIZE - halfScene;
      const sceneZ = v * SCENE_SIZE - halfScene;
      // Mode-neutral output: X/Z in scene units, Y in REAL METERS above the
      // .ter datum (terrain top above minHeight + altitude above ground).
      // Consumers convert: the 3D preview scales Y by unitsPerMeter to match
      // TerrainMesh's `(h - minHeight) * upm`, the BeamNG export maps Y → Z
      // with factor 1 (BeamNG world-Z is meters above the .ter reference).
      const beamZMeters = (mapngGroundY - minH) + (cart.height - googleGroundAlt);

      newPositions[i * 3]     = sceneX;
      newPositions[i * 3 + 1] = beamZMeters;
      newPositions[i * 3 + 2] = sceneZ;
      aboveTerrain[i] = beamZMeters - (sampleHeightAtScene(data, sceneX, sceneZ) - minH);

      insideMask[i] = (Math.abs(sceneX) <= halfScene && Math.abs(sceneZ) <= halfScene) ? 1 : 0;
    }

    const srcIndex = srcGeom.index ? srcGeom.index.array : null;
    const triCount = srcIndex ? srcIndex.length / 3 : vCount / 3;
    const newIdx = [];

    for (let t = 0; t < triCount; t++) {
      const i0 = srcIndex ? srcIndex[t * 3]     : t * 3;
      const i1 = srcIndex ? srcIndex[t * 3 + 1] : t * 3 + 1;
      const i2 = srcIndex ? srcIndex[t * 3 + 2] : t * 3 + 2;

      if (!insideMask[i0] && !insideMask[i1] && !insideMask[i2]) continue;

      if (stripGround) {
        // Orientation alone can't tell a street from a flat roof — both are
        // near-horizontal. Only strip tris that are ALSO near the mapng
        // terrain height, so streets vanish and roofs survive.
        const elevAvg = (aboveTerrain[i0] + aboveTerrain[i1] + aboveTerrain[i2]) / 3;
        if (elevAvg < groundDistanceM) {
          a.fromArray(newPositions, i0 * 3);
          b.fromArray(newPositions, i1 * 3);
          c.fromArray(newPositions, i2 * 3);
          a.y *= unitsPerMeter;
          b.y *= unitsPerMeter;
          c.y *= unitsPerMeter;
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          normal.crossVectors(ab, ac).normalize();
          if (Math.abs(normal.y) > groundNormalThreshold) continue;
        }
      }

      newIdx.push(i0, i1, i2);
    }

    if (newIdx.length === 0) return;

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
    // Every output geometry MUST carry the identical attribute set
    // (position+uv+normal): mergeGeometries() in the BeamNG export returns
    // null on any mismatch, which silently kills the entire Google output
    // (no DAE, no debug cube, no error). Zero-fill uv for the rare
    // untextured tile rather than dropping it or poisoning the merge.
    if (srcGeom.attributes.uv) {
      newGeom.setAttribute('uv', srcGeom.attributes.uv.clone());
    } else {
      newGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vCount * 2), 2));
    }
    newGeom.setIndex(newIdx);
    newGeom.computeVertexNormals();

    // Each Google tile gets a unique material name so downstream Collada/material
    // pipelines can extract per-tile photogrammetry textures.
    //
    // Build a fresh MeshStandardMaterial regardless of the source type — Google's
    // photogrammetry tiles ship as MeshBasicMaterial (baked lighting), and the
    // ColladaExporter refuses to write texture refs for that type. The downstream
    // BeamNG materials.json defines an unlit-equivalent so visual result matches.
    const srcMat = Array.isArray(node.material) ? node.material[0] : node.material;
    const matName = `google_tile_${outputMeshIdx}`;
    const standard = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
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
        standard.map = snap;
      }
    }
    const newMesh = new THREE.Mesh(newGeom, standard);
    newMesh.name = matName;
    newMesh.userData.isGoogleTile = true;
    out.add(newMesh);
    outputMeshIdx++;
  });

  try { tiles.dispose(); } catch (_) { /* noop */ }
  try { offscreen.dispose(); } catch (_) { /* noop */ }

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
const BAKE_FORMAT_VERSION = 4;

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

const resolveBakeOptions = (options) => ({
  ...options,
  quality: options.quality ?? getPreferredBakeQuality(),
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

/** Dispose the cached bake (geometries, materials, canvas textures), if any. */
export function clearGoogleTilesCache() {
  if (!_bakeCache) return;
  const evicted = _bakeCache;
  _bakeCache = null;
  // Dispose once the bake settles — it may still be in flight.
  evicted.promise.then(disposeGroup).catch(() => { /* already logged */ });
}
