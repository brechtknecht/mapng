import * as THREE from 'three';
import { createMetricProjector } from './geoUtils.js';

// Shared, DOM-free core of the Google 3D Tiles bake — everything here runs
// both in the browser (services/google3dTiles.js) and headless in Node
// (scripts/googleBakeWorker.mjs). Environment-specific concerns stay in the
// orchestrators: tick scheduling, tile-content loaders, texture retention,
// caching. The WGS84 ellipsoid is dependency-injected because the two
// environments import the tiles library differently (the package index
// evaluates a WebGLRenderer at module scope and crashes Node — see
// scripts/headlessTilesEnv.mjs).

// Mirror export3d.js — kept local to avoid a circular import.
export const SCENE_SIZE = 100;

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

/**
 * AOI-centred reference frame shared by every bake step: geographic centre,
 * metric extent, the ECEF centre point and a local ENU basis around it.
 */
export const computeAoiFrame = (data, ellipsoid) => {
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

  const centerEcef = new THREE.Vector3();
  ellipsoid.getCartographicToPosition(latRad, lonRad, 0, centerEcef);
  const upDir = centerEcef.clone().normalize();
  // Local ENU basis at the AOI centre (ECEF +Z points at the north pole).
  const eastDir = new THREE.Vector3(0, 0, 1).cross(upDir).normalize();
  const northDir = upDir.clone().cross(eastDir).normalize();
  const horiz = (e, n) =>
    new THREE.Vector3().addScaledVector(eastDir, e).addScaledVector(northDir, n);

  return {
    centerLat, centerLng, latRad, lonRad,
    metersPerDegree, widthM, heightM, extentM,
    centerEcef, upDir, eastDir, northDir, horiz,
  };
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
export const buildRoadStations = (data, {
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
 * Camera stations for the sweep. ONE camera is swept through these in
 * sequence: top-down first (the proven baseline), then obliques/grid so
 * facades cover enough screen pixels for the LOD selector to refine them.
 * Registering multiple cameras SIMULTANEOUSLY broke the bake entirely
 * (0 tiles — hard-won lesson 7); repositioning a single camera keeps the
 * selector consistent, and tiles loaded at earlier stations stay in the LRU
 * cache.
 *
 * Stations: { label, offset (camera position relative to AOI centre),
 * target (look-at point relative to AOI centre, default = centre),
 * viz (ENU footprint for the preview overlay) }.
 */
export const buildSweepStations = (frame, { quality = 'standard', cameraSweep = true } = {}) => {
  const { extentM, upDir, horiz } = frame;
  const stations = [
    {
      label: 'top-down',
      offset: new THREE.Vector3().addScaledVector(upDir, extentM * 1.5 + 200),
      viz: { kind: 'overview', e: 0, n: 0, aglM: extentM * 1.5 + 200 },
    },
  ];
  if (!cameraSweep) return stations;

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
  return stations;
};

/**
 * Ellipsoidal ground altitude near the AOI centre: a low percentile of vertex
 * heights within `max(50m, 10% of extent)` of the centre.
 *
 * The probe must be HORIZONTAL (lat/lon distance). An earlier version
 * measured 3D ECEF distance from a point at ellipsoid height 0 — but real
 * ground sits tens of metres above the ellipsoid (geoid offset + terrain
 * elevation, ~75 m in Berlin), so few or no vertices fell inside the
 * sphere and the anchor collapsed to 0, floating the whole city by that
 * altitude. Use a low percentile rather than the minimum so below-ground
 * junk geometry (canals, basements) can't sink the anchor either.
 *
 * @param {(cb: (node) => void) => void} forEachMesh iterate candidate meshes (matrixWorld must be current)
 * @returns {number|null} ellipsoidal height, or null when no vertices hit
 */
export const probeGroundAltitude = (forEachMesh, frame, ellipsoid, { stride = 1, percentile = 0.05 } = {}) => {
  const probeRadiusM = Math.max(50, frame.extentM * 0.1);
  const probeRadiusSq = probeRadiusM * probeRadiusM;
  const cosLat = Math.cos(frame.latRad);
  const tmp = new THREE.Vector3();
  const cart = {};
  const heights = [];
  forEachMesh((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos = node.geometry.attributes.position;
    const m = node.matrixWorld;
    for (let i = 0; i < pos.count; i += stride) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      ellipsoid.getPositionToCartographic(tmp, cart);
      const dNorth = (cart.lat - frame.latRad) * 6371000;
      const dEast = (cart.lon - frame.lonRad) * 6371000 * cosLat;
      if (dNorth * dNorth + dEast * dEast > probeRadiusSq) continue;
      heights.push(cart.height);
    }
  });
  if (heights.length === 0) return null;
  heights.sort((x, y) => x - y);
  return heights[Math.floor(heights.length * percentile)];
};

/**
 * Drive the tiles update loop through every station until each settles
 * (queues quiet for `stabilityMs`, or the global budget runs out),
 * snapshotting the selection per station. tiles.group only ever contains the
 * CURRENT station's selection — later stations deselect what they don't
 * need — so the union of per-station snapshots is what gets baked.
 *
 * 'roads' quality appends street-level stations after the first (overview)
 * station, once loaded tiles make a ground-altitude probe possible.
 *
 * @param {object} params
 *   @param {TilesRenderer} params.tiles configured renderer (camera + resolution already set)
 *   @param {THREE.Camera} params.cam the ONE swept camera
 *   @param {object} params.data mapng terrain data
 *   @param {object} params.frame computeAoiFrame() result
 *   @param {object[]} params.stations buildSweepStations() result — MUTATED by the road pass
 *   @param {object} params.ellipsoid WGS84 ellipsoid (injected)
 *   @param {(tick: () => void) => () => void} params.startTicker start the
 *     environment's update scheduler calling `tick` (~30 Hz); returns a stop
 *     function. Browser: Web-Worker ticker (rAF is throttled in background
 *     tabs); Node: plain setInterval.
 * @returns {Promise<{selectedTiles: Set, timedOut: boolean, elapsedMs: number}>}
 */
export async function runStationSweep({
  tiles, cam, data, frame, stations, ellipsoid,
  quality = 'standard',
  maxWaitMs = null,
  stabilityMs = 2500,
  startTicker,
  onProgress,
}) {
  const startedAt = performance.now();
  let timedOut = false;
  const selectedTiles = new Set();
  // Derived from the (AOI-dependent) station count; recomputed when the
  // road pass appends stations mid-sweep.
  let bakeBudgetMs = maxWaitMs ?? (120000 + stations.length * 25000);

  let updateError = null;
  const onUpdateError = (e) => { updateError = e; };
  tiles.addEventListener('load-error', onUpdateError);

  const waitForQuiet = (stationIdx) => new Promise((resolve, reject) => {
    let lastChange = performance.now();
    let lastVisible = -1;
    // Stations served entirely from cache trigger no downloads — exit those
    // after a short grace period instead of the full stability window
    // (on a 70-station sweep that alone saves minutes of pure waiting).
    let sawActivity = false;
    let stop = null;
    const finish = (fn, arg) => { stop?.(); fn(arg); };

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
    stop = startTicker(tick);
    tick();
  });

  const lookTarget = new THREE.Vector3();
  try {
    for (let s = 0; s < stations.length; s++) {
      cam.position.copy(frame.centerEcef).add(stations[s].offset);
      lookTarget.copy(frame.centerEcef);
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
        tiles.group.updateMatrixWorld(true);
        const centerGroundAlt = probeGroundAltitude(
          (cb) => tiles.group.traverse(cb),
          frame, ellipsoid,
          { stride: 7 }, // stride — estimate only
        );
        if (centerGroundAlt === null) {
          console.warn('[google3dTiles] road pass: ground probe found nothing — skipping street-level stations');
        } else {
          const upm = computeUnitsPerMeter(data);
          const centerTerrain = sampleHeightAtScene(data, 0, 0);
          const groundAltAt = (e, n) =>
            centerGroundAlt + (sampleHeightAtScene(data, e * upm, -n * upm) - centerTerrain);
          // Cap scales with AOI area so road coverage density stays constant
          // (~40 stations per km², clamped) instead of thinning out on big maps.
          const areaKm2 = (frame.extentM / 1000) ** 2;
          const roadStations = buildRoadStations(data, {
            centerLat: frame.centerLat,
            centerLng: frame.centerLng,
            metersPerDegree: frame.metersPerDegree,
            extentM: frame.extentM,
            horiz: frame.horiz,
            upDir: frame.upDir,
            groundAltAt,
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
    tiles.removeEventListener('load-error', onUpdateError);
  }

  return { selectedTiles, timedOut, elapsedMs: performance.now() - startedAt };
}

/**
 * Different stations select the same region at different depths (e.g. the
 * far side of the AOI is coarser from an oblique view). Keep the finest:
 * drop any selected tile whose area is fully covered by selected
 * descendants. Tiles partially covered by finer selections are kept —
 * a small overlap beats a hole.
 */
export const selectFinestCovering = (selectedTiles) => {
  const coverMemo = new Map();
  const coveredBySelection = (tile) => {
    if (selectedTiles.has(tile)) return true;
    if (coverMemo.has(tile)) return coverMemo.get(tile);
    const kids = tile.children || [];
    const covered = kids.length > 0 && kids.every(coveredBySelection);
    coverMemo.set(tile, covered);
    return covered;
  };
  return [...selectedTiles].filter((tile) => {
    const kids = tile.children || [];
    return !(kids.length > 0 && kids.every(coveredBySelection));
  });
};

/**
 * Per-mesh ECEF → mapng transform + AOI clip + ground strip.
 *
 * Returns a function (node) => THREE.BufferGeometry|null. Output coordinates
 * are mode-neutral: X/Z in scene units ([-50, 50]), Y in REAL METERS above
 * the .ter datum. Consumers convert — the 3D preview scales Y by
 * computeUnitsPerMeter(data), the BeamNG export maps Y → world-Z with
 * factor 1 (BeamNG world-Z is meters above the .ter reference).
 *
 * Every output geometry carries the identical attribute set
 * (position+uv+normal): mergeGeometries() in the BeamNG export returns
 * null on any mismatch, which silently kills the entire Google output
 * (no DAE, no debug cube, no error). Zero-fill uv for the rare
 * untextured tile rather than dropping it or poisoning the merge.
 */
export const createTileMeshTransformer = (data, frame, ellipsoid, googleGroundAlt, {
  stripGround = true,
  groundNormalThreshold = 0.85,
  groundDistanceM = 2.5,
  // The Node worker skips this — its consumer (deserializeGroup) recomputes
  // normals on restore anyway, so shipping them would be pure waste.
  computeNormals = true,
} = {}) => {
  const projector = createMetricProjector(data.bounds, data.width, data.height);
  const mapngGroundY = sampleHeightAtScene(data, 0, 0);
  const halfScene = SCENE_SIZE / 2;
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  // Output Y is meters while X/Z are scene units — anisotropic. The ground-
  // normal test below must run in a metrically uniform space or sloped
  // hillsides stop counting as ground; scale Y by this when building tris.
  const unitsPerMeter = computeUnitsPerMeter(data);

  const tmpEcef = new THREE.Vector3();
  const cart = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

  const transform = (node) => {
    const srcGeom = node.geometry;
    const srcPos = srcGeom.attributes.position;
    if (!srcPos) return null;

    const vCount = srcPos.count;
    const worldMat = node.matrixWorld;

    const newPositions = new Float32Array(vCount * 3);
    const insideMask = new Uint8Array(vCount);
    // Metres above the local mapng terrain — lets the ground strip below
    // distinguish streets (≈0 m) from flat roofs (10–30 m).
    const aboveTerrain = new Float32Array(vCount);

    for (let i = 0; i < vCount; i++) {
      tmpEcef.set(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i)).applyMatrix4(worldMat);
      ellipsoid.getPositionToCartographic(tmpEcef, cart);
      const latDeg = (cart.lat * 180) / Math.PI;
      const lonDeg = (cart.lon * 180) / Math.PI;

      const p = projector(latDeg, lonDeg);
      const u = p.x / (data.width - 1);
      const v = p.y / (data.height - 1);
      const sceneX = u * SCENE_SIZE - halfScene;
      const sceneZ = v * SCENE_SIZE - halfScene;
      // Terrain top above minHeight + altitude above Google's local ground.
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

    if (newIdx.length === 0) return null;

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
    if (srcGeom.attributes.uv) {
      newGeom.setAttribute('uv', srcGeom.attributes.uv.clone());
    } else {
      newGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vCount * 2), 2));
    }
    newGeom.setIndex(newIdx);
    if (computeNormals) newGeom.computeVertexNormals();
    return newGeom;
  };

  // Expose anchor info for the orchestrators' log lines.
  transform.mapngGroundY = mapngGroundY;
  transform.minH = minH;
  return transform;
};
