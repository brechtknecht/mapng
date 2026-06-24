import * as THREE from 'three';
import { computeUnitsPerMeter } from './scene/sceneFrame.js';
import { sampleHeightAtScene } from './scene/sceneSample.js';
import { buildRoadStations, buildCorridorStations } from './tiles/tileStations.js';
import { probeGroundAltitude } from './tiles/probeGround.js';

// Shared, DOM-free core of the Google 3D Tiles bake — everything here runs
// both in the browser (google3dTiles.js) and headless in Node
// (scripts/googleBakeWorker.mjs). Environment-specific concerns stay in the
// orchestrators: tick scheduling, tile-content loaders, texture retention,
// caching. The WGS84 ellipsoid is dependency-injected because the two
// environments import the tiles library differently (the package index
// evaluates a WebGLRenderer at module scope and crashes Node — see
// scripts/headlessTilesEnv.mjs).
//
// The pure pieces have been split into scene/ (frame + sampling) and tiles/
// (stations, probe, mesh transform, seam weld/riser, ground strip) per
// docs/refactor/06. They are re-exported here unchanged so every consumer —
// the node worker and `@mapng/bake/googleBakeCore` subpath importers — is
// untouched. This file keeps only runStationSweep, the renderer-driven flow.
export { SCENE_SIZE, computeUnitsPerMeter, computeAoiFrame } from './scene/sceneFrame.js';
export { sampleHeightAtScene } from './scene/sceneSample.js';
export { buildRoadStations, buildCorridorStations, buildSweepStations } from './tiles/tileStations.js';
export { probeGroundAltitude, selectFinestCovering } from './tiles/probeGround.js';
export { createTileMeshTransformer } from './tiles/tileMeshTransform.js';
export { stripSeamRisers } from './tiles/tileSeamRisers.js';
export { weldSeams, stripGroundTris } from './tiles/tileSeamWeld.js';

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
 *   @param {Set} [params.selectedTiles] selection set from a previous sweep —
 *     a refinement pass reuses it so earlier tiles stay pinned and the
 *     finest-covering dedup runs over the full union.
 *   @param {boolean} [params.enableRoadPass] append road stations after the
 *     first station (quality 'roads' only). Refinement sweeps pass false —
 *     their station 0 is a user camera, not the overview.
 * @returns {Promise<{selectedTiles: Set, timedOut: boolean, elapsedMs: number}>}
 */
export async function runStationSweep({
  tiles, cam, data, frame, stations, ellipsoid,
  quality = 'standard',
  maxWaitMs = null,
  stabilityMs = 2500,
  startTicker,
  onProgress,
  selectedTiles = new Set(),
  enableRoadPass = true,
  // Route-corridor mode: when a route segment is supplied the station-0 block
  // appends corridor-following stations (buildCorridorStations) instead of the
  // OSM road pass, for ANY quality tier. buildSweepStations has already trimmed
  // the box-covering sweep to just the overview.
  corridorSegment = null,
  corridorHalfWidthM = 0,
}) {
  const startedAt = performance.now();
  let timedOut = false;
  // Derived from the (AOI-dependent) station count; recomputed when the
  // road pass appends stations mid-sweep.
  let bakeBudgetMs = maxWaitMs ?? (120000 + stations.length * 25000);

  // 'max' tier: stop sweeping the deepen oblique tail once it stops adding new
  // tiles. Google's photorealistic LOD is finite — past the ceiling, extra
  // low-oblique stations only re-select tiles already in the union, so flying
  // lower yields bigger triangles, not new geometry. Counts CONSECUTIVE deepen
  // stations that each add < ~0.3% (min 8) new unique tiles; only ever trims
  // the redundant tail (deepen stations run last; roads/grid already done).
  const saturationStop = quality === 'max';
  const saturationWindow = 4;
  let lowDeltaRun = 0;

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
  const baseFov = cam.isPerspectiveCamera ? cam.fov : null;
  try {
    for (let s = 0; s < stations.length; s++) {
      cam.position.copy(frame.centerEcef).add(stations[s].offset);
      lookTarget.copy(frame.centerEcef);
      if (stations[s].target) lookTarget.add(stations[s].target);
      cam.lookAt(lookTarget);
      // User-placed refinement stations carry their preview camera's FOV so
      // "what you see is what gets refined" holds literally.
      if (baseFov !== null) {
        cam.fov = stations[s].fov ?? baseFov;
        cam.updateProjectionMatrix();
      }
      cam.updateMatrixWorld(true);

      await waitForQuiet(s);

      const uniqueBefore = selectedTiles.size;
      for (const tile of tiles.visibleTiles) selectedTiles.add(tile);
      const added = selectedTiles.size - uniqueBefore;
      console.info(
        `[google3dTiles] station ${s + 1}/${stations.length} (${stations[s].label}): ` +
        `${tiles.visibleTiles.size} tiles selected, ${selectedTiles.size} unique total ` +
        `(+${added}), ${((performance.now() - startedAt) / 1000).toFixed(1)}s elapsed`,
      );
      if (timedOut) {
        console.warn(
          `[google3dTiles] bake budget (${Math.round(bakeBudgetMs / 1000)}s) exhausted at station ` +
          `${s + 1}/${stations.length} — skipping remaining stations`,
        );
        break;
      }

      if (saturationStop && stations[s].phase === 'deepen') {
        const thresh = Math.max(8, Math.round(uniqueBefore * 0.003));
        lowDeltaRun = added < thresh ? lowDeltaRun + 1 : 0;
        if (lowDeltaRun >= saturationWindow) {
          console.info(
            `[google3dTiles] saturation reached at station ${s + 1}/${stations.length}: ` +
            `${saturationWindow} consecutive deepen stations each added < ${thresh} new tiles ` +
            `— Google's LOD ceiling hit, skipping the remaining ${stations.length - s - 1} stations`,
          );
          break;
        }
      }

      // Street-level / corridor stations need the ellipsoidal ground altitude,
      // which is only known once the overview station has loaded tiles — probe
      // now and append the extra pass to the sweep. Per-station street height =
      // centre altitude + the mapng heightmap's relative elevation (the geoid
      // offset is locally constant). Route-corridor mode runs the corridor pass
      // for ANY quality; otherwise the OSM road pass runs for 'roads'/'max'.
      const corridorMode = Array.isArray(corridorSegment) && corridorSegment.length >= 2;
      if (s === 0 && enableRoadPass && (corridorMode || quality === 'roads' || quality === 'max')) {
        tiles.group.updateMatrixWorld(true);
        const centerGroundAlt = probeGroundAltitude(
          (cb) => tiles.group.traverse(cb),
          frame, ellipsoid,
          { stride: 7 }, // stride — estimate only
        );
        if (centerGroundAlt === null) {
          console.warn('[google3dTiles] ground probe found nothing — skipping street-level/corridor stations');
        } else {
          const upm = computeUnitsPerMeter(data);
          const centerTerrain = sampleHeightAtScene(data, 0, 0);
          const groundAltAt = (e, n) =>
            centerGroundAlt + (sampleHeightAtScene(data, e * upm, -n * upm) - centerTerrain);
          let appended = [];
          if (corridorMode) {
            appended = buildCorridorStations(corridorSegment, {
              centerLat: frame.centerLat,
              centerLng: frame.centerLng,
              metersPerDegree: frame.metersPerDegree,
              extentM: frame.extentM,
              horiz: frame.horiz,
              upDir: frame.upDir,
              groundAltAt,
              halfWidthM: corridorHalfWidthM,
            });
            // buildSweepStations left only the overview, so there's no deepen
            // tail to protect — just append.
            stations.push(...appended);
          } else {
            // Cap scales with AOI area so road coverage density stays constant
            // (~40 stations per km², clamped) instead of thinning on big maps.
            const areaKm2 = (frame.extentM / 1000) ** 2;
            appended = buildRoadStations(data, {
              centerLat: frame.centerLat,
              centerLng: frame.centerLng,
              metersPerDegree: frame.metersPerDegree,
              extentM: frame.extentM,
              horiz: frame.horiz,
              upDir: frame.upDir,
              groundAltAt,
              maxStations: Math.min(160, Math.max(40, Math.round(40 * areaKm2))),
            });
            // 'roads' appends street-level stations at the end. 'max' splices
            // them in right after the overview so they run BEFORE the deepen
            // oblique tail — the saturation stop must never sacrifice the
            // deepest (street-level) stations, only the redundant tail.
            if (quality === 'max') stations.splice(s + 1, 0, ...appended);
            else stations.push(...appended);
          }
          if (appended.length === 0) {
            console.warn(
              `[google3dTiles] ${corridorMode ? 'corridor' : 'road'} pass: no stations produced ` +
              `(${corridorMode ? 'degenerate route segment' : 'no OSM roads in the AOI'}) — overview only`,
            );
          } else {
            if (maxWaitMs == null) bakeBudgetMs = 120000 + stations.length * 25000;
            console.info(
              `[google3dTiles] ${corridorMode ? 'corridor' : 'road'} pass: ${appended.length} stations queued ` +
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
