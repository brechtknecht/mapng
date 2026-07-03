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
import path from 'node:path';
import * as THREE from 'three';
import { assembleGoogleTilesExport } from './googleExportAssembly.mjs';
import {
  TilesRenderer,
  GoogleCloudAuthPlugin,
  WGS84_ELLIPSOID,
  installCaptureLoader,
  getCapturedImage,
} from './headlessTilesEnv.mjs';
import { registerTilesAuth, preflightTilesAuth } from '@mapng/fetching/tilesAuth';
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
  SCENE_SIZE,
} from '@mapng/bake/googleBakeCore';
import { conformTilesToFloor } from '@mapng/bake/tileGroundConform';
import { extractTileGroundFromSoup } from '@mapng/bake/ground/extractTileGround';
import { buildGroundMask } from '@mapng/bake/groundMask';
import { collectStructureRings } from '@mapng/bake/deform/structureStiffness';
import { buildRoadProfiles, carveRoadProfiles } from '@mapng/bake/roadProfiles';
import { createMetricProjector } from '@mapng/geo';
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

const encodeBytes = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');

// Serialise an extractTileGround result for the `exported` message — the route
// orchestrator decodes it and composites the per-chunk grounds into the .ter.
const encodeGround = (g) => ({
  heightMap: encodeBytes(g.heightMap), // Float32, width×height, ABSOLUTE metres
  coverage: encodeBytes(g.coveredMask), // Uint8, 1 where a tile covered the cell
  width: g.width,
  height: g.height,
  minHeight: g.minHeight,
  maxHeight: g.maxHeight,
  coverageRatio: g.coverage,
});

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

// Seam handling. The DEFAULT is now the root-cause pair — lateral footprint
// carving (computeCarveTargets, in rebuildOutputs) + seam welding (weldSeams,
// applyWeld) — which removes the LOD-transition tile-edge walls at the source
// instead of guessing them away. The old heuristic strip stays available as a
// belt-and-suspenders fallback but is OFF by default:
//   MAPNG_STRIP_RISERS=1   re-enable the old magic-threshold deletion
// The geometry post-passes below are DISABLED by default while the
// post-processing strategy is reworked (they damaged the mesh more than they
// helped — see docs/google-tiles-mesh-assembly-problem-statement.md). Opt back in:
//   MAPNG_WELD_SEAMS=1        re-enable the seam weld
//   MAPNG_CONFORM_TILES=1     re-enable the delta-field floor conform
//   MAPNG_CONFORM_ROADMASK=1  re-enable the semantic road/area mask snap
const WELD_SEAMS = process.env.MAPNG_WELD_SEAMS === '1';
const STRIP_RISERS = process.env.MAPNG_STRIP_RISERS === '1';
const CONFORM_TILES = process.env.MAPNG_CONFORM_TILES === '1';
const CONFORM_ROADMASK = process.env.MAPNG_CONFORM_ROADMASK === '1';
// Structure stiffness defaults ON whenever the conform runs (it only prevents
// damage to buildings); MAPNG_CONFORM_STIFFNESS=0 disables it for A/B.
const CONFORM_STIFFNESS = process.env.MAPNG_CONFORM_STIFFNESS !== '0';
// Weld tolerances (all metres) — tune without code edits, restart to apply.
//   BAND      vertical reach onto the target ground (raise to close taller seams)
//   COHERE    a cell welds only if its ground spans ≤ this (real steps survive)
//   MAX_RISER a vertex this far ABOVE local ground is a wall → never welded
const WELD_OPTS = {
  ...(process.env.MAPNG_WELD_BAND_M ? { bandM: Number(process.env.MAPNG_WELD_BAND_M) } : {}),
  ...(process.env.MAPNG_WELD_COHERE_M ? { cohereM: Number(process.env.MAPNG_WELD_COHERE_M) } : {}),
  ...(process.env.MAPNG_WELD_MAX_RISER_M ? { maxRiserM: Number(process.env.MAPNG_WELD_MAX_RISER_M) } : {}),
  ...(process.env.MAPNG_WELD_CELL_M ? { cellM: Number(process.env.MAPNG_WELD_CELL_M) } : {}),
};
const RISER_OPTS = {
  ...(process.env.MAPNG_RISER_MAX_HEIGHT_M ? { riserMaxHeightM: Number(process.env.MAPNG_RISER_MAX_HEIGHT_M) } : {}),
  ...(process.env.MAPNG_RISER_VERTICAL_NY ? { verticalNormalY: Number(process.env.MAPNG_RISER_VERTICAL_NY) } : {}),
  ...(process.env.MAPNG_RISER_PROBE_M ? { neighborProbeM: Number(process.env.MAPNG_RISER_PROBE_M) } : {}),
  ...(process.env.MAPNG_RISER_BAND_M ? { bandM: Number(process.env.MAPNG_RISER_BAND_M) } : {}),
  ...(process.env.MAPNG_RISER_DROP_M ? { dropM: Number(process.env.MAPNG_RISER_DROP_M) } : {}),
};

/**
 * Run the shared cross-tile seam-riser strip over the session's current output
 * records and write the trimmed indices back. Same function the browser preview
 * calls, so preview and export are identical. Mutates record.index in place.
 */
const applyRiserStrip = (session) => {
  if (!STRIP_RISERS) return;
  const upm = computeUnitsPerMeter(session.data);
  // groupId = owning TILE (not record/mesh) so a tile's own internal vertical
  // detail is never treated as the neighbour's ground.
  const tileId = new Map();
  const soup = [];
  const recs = [];
  for (const [tile, entry] of session.outputs) {
    let gid = tileId.get(tile);
    if (gid === undefined) { gid = tileId.size; tileId.set(tile, gid); }
    for (const r of entry.records) {
      if (!r.index) continue;
      recs.push(r);
      soup.push({ positions: r.positions, index: r.index, groupId: gid });
    }
  }
  if (soup.length === 0) return;
  const t0 = performance.now();
  const { indices, removed, candidates } = stripSeamRisers(soup, { unitsPerMeter: upm, ...RISER_OPTS });
  for (let i = 0; i < recs.length; i++) recs[i].index = indices[i];
  console.info(
    `[bakeWorker] seam-riser strip: removed ${removed}/${candidates} candidate tris across ` +
    `${tileId.size} tiles in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
};

/**
 * Close LOD seams by welding coarse vertices onto the finer ground
 * (googleBakeCore → weldSeams) — the default, root-cause replacement for the
 * heuristic strip. Recomputed every merge from each record's IMMUTABLE base
 * positions, so it's idempotent under refinement: a refine that adds finer
 * tiles simply re-snaps to the newly-finer ground, and a refine that drops a
 * finer tile reverts the affected coarse vertices to their base height.
 */
const applyWeld = (session) => {
  // Per-bake override (sandbox / debug) wins over the env default.
  if (!(session.options?.weld ?? WELD_SEAMS)) return;
  const upm = computeUnitsPerMeter(session.data);
  const recs = [];
  const soup = [];
  for (const [tile, entry] of session.outputs) {
    const lod = tile.geometricError ?? Infinity;
    for (const r of entry.records) {
      // Field from the FULL index (baseIndex) so the street ground is present
      // even after a previous merge stripped it — that's what lets the weld
      // snap street risers. Positions from the un-welded base so the weld never
      // compounds across merges.
      const idx = r.baseIndex ?? r.index;
      if (!idx) continue;
      recs.push(r);
      soup.push({ positions: r.basePositions ?? r.positions, index: idx, lod });
    }
  }
  if (soup.length === 0) return;
  const t0 = performance.now();
  const { positions, meshesMoved, vertsMoved } = weldSeams(soup, { unitsPerMeter: upm, ...WELD_OPTS });
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (positions[i]) {
      if (!r.basePositions) r.basePositions = r.positions; // stash the base once
      r.positions = positions[i];
    } else if (r.basePositions) {
      r.positions = r.basePositions; // no longer moved this merge — revert
    }
  }
  console.info(
    `[bakeWorker] seam weld: moved ${vertsMoved} verts across ${meshesMoved}/${recs.length} meshes ` +
    `in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
};

/**
 * Delta-field conform (googleBakeCore → conformTilesToFloor): seat the tiles onto
 * the .ter floor. Runs AFTER applyWeld (so it reads the welded, ground-consistent
 * positions) and BEFORE applyGroundStrip (which needs the ground tris to survive
 * until measured). Reads from the FULL base index so the street ground is present
 * even after an earlier merge stripped it; writes Y back into r.positions. Always
 * recomputed fresh from the welded output, so it stays correct across refines.
 */
const applyConform = (session) => {
  // Per-bake override (sandbox / debug) wins over the env default.
  if (!(session.options?.conform ?? CONFORM_TILES)) return;
  const recs = [];
  const soup = [];
  for (const entry of session.outputs.values()) {
    for (const r of entry.records) {
      const idx = r.baseIndex ?? r.index;
      if (!idx) continue;
      recs.push(r);
      soup.push({ positions: r.positions, index: idx });
    }
  }
  if (soup.length === 0) return;
  const t0 = performance.now();
  // Semantic road/area mask — full-res snap of known flat ground onto the DEM,
  // flattening photogrammetry wiggle and pulling down floaters the ±band can't
  // reach. Null when disabled or this AOI shipped no OSM ground (e.g. corridor /
  // non-road quality), in which case the delta field runs alone (prior behaviour).
  const osmFeatures = session.data.osmFeatures;
  const osmCount = Array.isArray(osmFeatures) ? osmFeatures.length : 0;
  const roadmask = session.options?.roadmask ?? CONFORM_ROADMASK;
  const groundMask = roadmask ? buildGroundMask(osmFeatures, session.data) : null;
  // Semantic structure stiffness — building footprints (shipped by the sidecar
  // since the payload filter was widened) freeze the delta field per structure.
  const stiffnessOn = session.options?.stiffness ?? CONFORM_STIFFNESS;
  const structures = stiffnessOn ? collectStructureRings(osmFeatures, session.data) : null;
  const r = conformTilesToFloor(soup, session.data, { groundMask, structures });
  for (let i = 0; i < recs.length; i++) {
    if (r.positions[i]) recs[i].positions = r.positions[i];
  }
  console.info(
    `[bakeWorker] [roadmask] tile conform: moved ${r.vertsMoved} verts across ${r.meshesMoved}/${recs.length} meshes, ` +
    `${r.cellsFilled} field cells, ground residual ${r.residualBefore.toFixed(2)}m → ${r.residualAfter.toFixed(2)}m` +
    `, field bend |ΔD| p50 ${r.fieldGradP50M.toFixed(2)}/p95 ${r.fieldGradP95M.toFixed(2)}/max ${r.fieldGradMaxM.toFixed(2)} m/cell` +
    `, structures ${r.structureCount} (snap vetoed ${r.structSnapVetoed})` +
    (groundMask
      ? `, snapped ${r.vertsSnapped} ground verts (max float fixed ${r.maxFloatFixedM.toFixed(1)}m)`
      : ` (mask off/none — osm features received=${osmCount}, roadmask=${roadmask})`) +
    ` in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
};

/**
 * Road-mask snap onto the EXTRACTED tile ground (.ter driving surface). Runs
 * AFTER extraction (which defines the floor) and BEFORE the ground strip.
 *
 * The legacy conform pass (applyConform) targets the DEM — the wrong shape, which
 * is why it is off by default. This one targets the surface the chunk's .ter will
 * actually ship (session.extractedGround), so it can only pull the visual road
 * mesh TOWARD the driving surface: the delta field is near-zero by construction
 * (the floor came from these very tiles) and mostly carries buildings along with
 * the local correction, while the OSM road mask snaps road verts flat onto the
 * floor (+roadEpsM) — killing the photogrammetry wobble that makes the road look
 * uneven against the smooth .ter. Gated by groundStrategy.snapRoads (default on
 * whenever extraction runs); the bake cache key fingerprints the strategy so
 * toggling/tuning it re-bakes (bakeCache `tsnap`).
 */
/**
 * (Re-)extract the bare-earth tile ground into session.extractedGround. Reads the
 * CURRENT record positions (post weld/conform), so a refine that changes geometry
 * refreshes the ground the sidecar ships for the .ter. No-op when extraction is
 * off; failure degrades to the DEM (extractedGround stays null).
 */
const extractSessionGround = (session, extractGround, groundStrategy) => {
  session.extractedGround = null;
  if (!extractGround) return;
  try {
    const soup = [];
    for (const entry of session.outputs.values()) {
      for (const r of entry.records) soup.push({ positions: r.positions, index: r.index });
    }
    const g = extractTileGroundFromSoup(soup, session.data, groundStrategy || {});
    session.extractedGround = g;
    console.info(
      `[bakeWorker] tile ground: ${(g.coverage * 100).toFixed(0)}% coverage, ` +
      `range ${g.minHeight.toFixed(1)}–${g.maxHeight.toFixed(1)}m (${g.width}×${g.height})`,
    );
  } catch (e) {
    console.warn('[bakeWorker] tile-ground extraction failed (route .ter will use the DEM):', e?.stack ?? e);
  }
  // Road elevation profiles: 1D profiles along the OSM centrelines from the
  // extracted ground, untrusted spans (tunnels, under-bridge holes, band-gated
  // underpasses) interpolated ALONG the road — then CARVED into the ground so
  // the .ter follows the road down into underpasses (per-cell pit defenses
  // cannot tell those from junk dips; the road can). Runs BEFORE terSnap, which
  // therefore snaps the road mesh onto the carved floor.
  session.roadProfiles = null;
  if (session.extractedGround) {
    try {
      const prof = buildRoadProfiles(session.data.osmFeatures, session.data, session.extractedGround);
      session.roadProfiles = prof;
      if (prof) {
        const st = prof.stats;
        const at = (p) => `${p.highway} @ scene(${p.x.toFixed(0)},${p.z.toFixed(0)})`;
        console.info(
          `[bakeWorker] [roadProfiles] ${st.roads} roads (${st.resolved} resolved, ` +
          `${st.stitched ?? 0} bridge-stitched) over ${st.totalKm}km: ` +
          `${st.trustedPct}% samples trusted, largest bridged gap ${st.maxUntrustedGapM}m, ` +
          `max grade ${st.maxGradePct}%` +
          (st.maxGradeAt ? ` (${at(st.maxGradeAt)})` : '') +
          (st.worstTrust ? `, least trusted ${st.worstTrust.pct}% (${at(st.worstTrust)})` : ''),
        );
        if (groundStrategy?.carveRoads ?? true) {
          const g = session.extractedGround;
          const cs = carveRoadProfiles(prof, session.data, g);
          if (cs.carvedCells > 0) {
            g.minHeight = Math.min(g.minHeight, cs.minH);
            g.maxHeight = Math.max(g.maxHeight, cs.maxH);
            console.info(
              `[bakeWorker] [roadProfiles] carved ${cs.carvedCells} cells into the .ter ` +
              `(max shift ${cs.maxShiftM}m)`,
            );
          }
        }
      } else {
        console.info('[bakeWorker] [roadProfiles] no drivable roads in this AOI');
      }
    } catch (e) {
      console.warn('[bakeWorker] road-profile build/carve failed (ground stays as extracted):', e?.stack ?? e);
    }
  }
};

const applyTerGroundSnap = (session, groundStrategy) => {
  const g = session.extractedGround;
  if (!g || (groundStrategy?.snapRoads ?? true) === false) return;
  const osmFeatures = session.data.osmFeatures;
  const groundMask = buildGroundMask(osmFeatures, session.data);
  if (!groundMask) {
    console.info('[bakeWorker] [terSnap] no OSM road/area features in this AOI — snap skipped');
    return;
  }
  const recs = [];
  const soup = [];
  for (const entry of session.outputs.values()) {
    for (const r of entry.records) {
      const idx = r.baseIndex ?? r.index;
      if (!idx) continue;
      recs.push(r);
      soup.push({ positions: r.positions, index: idx });
    }
  }
  if (soup.length === 0) return;
  const t0 = performance.now();
  // Semantic structure stiffness. The claim that "the delta field is near-zero
  // by construction" does NOT hold near buildings: the extracted floor is
  // filtered/carved bare earth while the tile ground next to facades carries
  // junk medians — measured p95 ≈ 2 m/cell of cell-to-cell wobble, which this
  // pass was printing onto every building (bent roofs). Footprints freeze the
  // field locally constant instead.
  const stiffnessOn = session.options?.stiffness ?? CONFORM_STIFFNESS;
  const structures = stiffnessOn ? collectStructureRings(osmFeatures, session.data) : null;
  // The extracted ground is a drop-in for data.heightMap (same grid, absolute
  // metres, ORIGINAL minHeight datum) — swap it in as the conform floor.
  const floor = { ...session.data, heightMap: g.heightMap };
  const r = conformTilesToFloor(soup, floor, {
    groundMask,
    structures,
    // Trust the floor only where extraction derived it FROM the tiles. Where it
    // fell back to the DEM (underpasses >3 m below the DEM are band-gated,
    // coverage holes under bridges), snapping would drag the real road metres
    // toward a surface that never saw it.
    floorCoveredMask: g.coveredMask ?? null,
    // Tight ceiling for the tile-derived floor: the road IS the floor's source,
    // so a multi-metre float means a DIFFERENT surface (viaduct, bridge deck,
    // ramp over ground) — not a floater to fix. The legacy 5 m ceiling was for
    // the DEM-target conform and pulled elevated roads down to the ground.
    maxSnapM: 2,
    snapTaperM: 1,
  });
  for (let i = 0; i < recs.length; i++) {
    if (r.positions[i]) recs[i].positions = r.positions[i];
  }
  console.info(
    `[bakeWorker] [terSnap] snapped ${r.vertsSnapped} road verts onto the extracted ground ` +
    `(max float fixed ${r.maxFloatFixedM.toFixed(1)}m), moved ${r.vertsMoved} verts across ` +
    `${r.meshesMoved}/${recs.length} meshes, residual ${r.residualBefore.toFixed(2)}m → ` +
    `${r.residualAfter.toFixed(2)}m, field bend |ΔD| p50 ${r.fieldGradP50M.toFixed(2)}/` +
    `p95 ${r.fieldGradP95M.toFixed(2)}/max ${r.fieldGradMaxM.toFixed(2)} m/cell, ` +
    `structures ${r.structureCount} (snap vetoed ${r.structSnapVetoed}) ` +
    `in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
  console.info(
    `[bakeWorker] [terSnap] carriageway flatness: ${r.roadVertsCore} road-surface verts, ` +
    `final deviation mean ${r.roadDevMeanM.toFixed(2)}m / max ${r.roadDevMaxM.toFixed(2)}m ` +
    `(unsnapped on-surface: ${r.roadWallExcluded} wall-shared, ${r.roadGateExcluded} taper-gated; ` +
    `${r.roadOverheadCount} overhead verts ignored)`,
  );

  // Deck snap: bridges are excluded from the road mask above (they must never
  // be pulled to the .ter), but their STITCHED profile — spanned between the
  // abutments of the resolved approach roads — is the deck's true line. Stamp
  // those profiles into a TRANSIENT deck floor (the .ter itself is untouched)
  // and snap the deck mesh onto it with a deck-only mask. The underpass road
  // metres below stays out of reach via the snap ceiling.
  const prof = session.roadProfiles;
  if (prof?.roads?.some((rd) => rd.throughStructure && rd.resolved)) {
    const deckGround = {
      heightMap: Float32Array.from(g.heightMap),
      coveredMask: new Uint8Array(g.heightMap.length),
    };
    const dc = carveRoadProfiles(prof, session.data, deckGround, {
      roadFilter: (rd) => rd.throughStructure && rd.resolved,
      featherM: 2,
    });
    const deckMask = dc.carvedCells > 0
      ? buildGroundMask(osmFeatures, session.data, { elevatedOnly: true })
      : null;
    if (deckMask) {
      // Rebuild the soup from the CURRENT positions — the pass above replaced
      // the moved records' arrays, and the old soup still points at the originals.
      const soup2 = recs.map((rec) => ({ positions: rec.positions, index: rec.baseIndex ?? rec.index }));
      const rd = conformTilesToFloor(soup2, { ...session.data, heightMap: deckGround.heightMap }, {
        groundMask: deckMask,
        // Same protection here: this second conform re-applies ITS delta field
        // to every vertex too — without stiffness it would re-bend the
        // buildings the first pass just protected.
        structures,
        floorCoveredMask: deckGround.coveredMask,
        maxSnapM: 3,
        snapTaperM: 1,
      });
      for (let i = 0; i < recs.length; i++) {
        if (rd.positions[i]) recs[i].positions = rd.positions[i];
      }
      console.info(
        `[bakeWorker] [deckSnap] snapped ${rd.vertsSnapped} deck verts onto ` +
        `${prof.stats.stitched ?? 0} stitched bridge profiles ` +
        `(max float fixed ${rd.maxFloatFixedM.toFixed(1)}m, ${dc.carvedCells} deck-floor cells)`,
      );
    }
  }
};

/**
 * Ground strip — LAST pass, after the weld (googleBakeCore → stripGroundTris).
 * Drops near-flat tris within groundDistanceM of the mapng terrain so the
 * heightmap shows through; running it here (not in the transform) means the
 * weld already collapsed the street's tile-edge risers onto the street, so they
 * get removed along with it instead of standing on the bare terrain.
 *
 * Recomputed every merge from each record's IMMUTABLE base index (the full,
 * unstripped triangle set), so it stays correct across refines and never feeds
 * a half-stripped surface back into the weld's ground field.
 */
const applyGroundStrip = (session) => {
  if (!session.groundStrip.enabled) return;
  const recs = [];
  const soup = [];
  for (const entry of session.outputs.values()) {
    for (const r of entry.records) {
      const idx = r.baseIndex ?? r.index;
      if (!idx) continue;
      recs.push(r);
      soup.push({ positions: r.positions, index: idx });
    }
  }
  if (soup.length === 0) return;
  const t0 = performance.now();
  const { indices, removed, total } = stripGroundTris(soup, session.data, {
    groundNormalThreshold: session.groundStrip.groundNormalThreshold,
    groundDistanceM: session.groundStrip.groundDistanceM,
  });
  for (let i = 0; i < recs.length; i++) {
    if (!recs[i].baseIndex) recs[i].baseIndex = recs[i].index; // stash the full index once
    recs[i].index = indices[i];
  }
  console.info(
    `[bakeWorker] ground strip: removed ${removed}/${total} near-terrain tris in ` +
    `${((performance.now() - t0) / 1000).toFixed(1)}s`,
  );
};

/**
 * Scene-space XZ footprint rect of a tile's OBB, shrunk by ~2 m so carving a
 * parent under it leaves a sliver of overlap at the seams instead of
 * hairline holes. Cached per tile (footprints never change).
 */
const footprintRect = (session, tile) => {
  if (session.footprints.has(tile)) return session.footprints.get(tile);
  let rect = null;
  const box = tile.boundingVolume?.box;
  if (Array.isArray(box) && box.length === 12) {
    const { projector, dataWidth, dataHeight, upm } = session.fp;
    const tmp = new THREE.Vector3();
    const cart = {};
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        for (let sz = -1; sz <= 1; sz += 2) {
          tmp.set(
            box[0] + sx * box[3] + sy * box[6] + sz * box[9],
            box[1] + sx * box[4] + sy * box[7] + sz * box[10],
            box[2] + sx * box[5] + sy * box[8] + sz * box[11],
          );
          WGS84_ELLIPSOID.getPositionToCartographic(tmp, cart);
          const p = projector((cart.lat * 180) / Math.PI, (cart.lon * 180) / Math.PI);
          const sceneX = (p.x / (dataWidth - 1)) * SCENE_SIZE - SCENE_SIZE / 2;
          const sceneZ = (p.y / (dataHeight - 1)) * SCENE_SIZE - SCENE_SIZE / 2;
          if (sceneX < minX) minX = sceneX;
          if (sceneX > maxX) maxX = sceneX;
          if (sceneZ < minZ) minZ = sceneZ;
          if (sceneZ > maxZ) maxZ = sceneZ;
        }
      }
    }
    const shrink = 2 * upm; // ≈2 m
    if (maxX - minX > 3 * shrink && maxZ - minZ > 3 * shrink) {
      rect = {
        minX: minX + shrink, maxX: maxX - shrink,
        minZ: minZ + shrink, maxZ: maxZ - shrink,
        key: `${minX.toFixed(2)},${maxX.toFixed(2)},${minZ.toFixed(2)},${maxZ.toFixed(2)}`,
      };
    }
  }
  session.footprints.set(tile, rect);
  return rect;
};

/**
 * Transform every mesh of a kept tile into result records. Buffers stay in
 * memory for the session's lifetime so refinements never re-transform old
 * tiles and the full container can be rewritten cheaply.
 *
 * `carveRects`: footprints of FINER kept descendants — triangles whose
 * centroid falls inside one are dropped, so the fine geometry replaces the
 * coarse surface instead of z-fighting it (a single-frustum refinement only
 * partially covers its parents, so the dedup can never drop them outright).
 */
const buildTileRecords = (session, tile, carveRects = []) => {
  const scene = tile.cached?.scene;
  if (!scene) return null; // caller counts the gap
  scene.updateMatrixWorld(true);
  const inAnyRect = (x, z) => {
    for (const r of carveRects) {
      if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return true;
    }
    return false;
  };
  const records = [];
  scene.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const geom = session.transformMesh(node);
    if (!geom) return;

    if (carveRects.length > 0) {
      const pos = geom.attributes.position.array;
      const idx = geom.index.array;
      const keptIdx = [];
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const cx = (pos[a] + pos[b] + pos[c]) / 3;
        const cz = (pos[a + 2] + pos[b + 2] + pos[c + 2]) / 3;
        if (!inAnyRect(cx, cz)) keptIdx.push(idx[t], idx[t + 1], idx[t + 2]);
      }
      if (keptIdx.length === 0) return; // fully carved away
      geom.setIndex(keptIdx);
    }

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
const tileDepth = (tile) => {
  let d = 0;
  for (let p = tile.parent; p; p = p.parent) d++;
  return d;
};

/**
 * For every kept tile, the footprints of all STRICTLY COARSER kept tiles it
 * overlaps — generalising the old ancestor-only carve to LATERAL LOD seams
 * (adjacent cousins, not just parent/child). A finer tile owns the ground it
 * covers, so its footprint is subtracted from every coarser kept tile beneath
 * OR beside it; that removes the coarse surface (and the riser geometry
 * standing on it) at the source, instead of leaving a wall for the heuristic
 * seam strip to guess at.
 *
 * Hole-safe: a tile only ever carves WITHIN its own inward-shrunk footprint,
 * which its real geometry fully covers — the same guarantee the ancestor carve
 * already relied on (footprintRect shrinks ~2 m inward).
 *
 * Returns Map<coarseTile, rect[]>. A broad-phase grid keeps it ~O(n) rather
 * than O(n²) over the thousands of tiles a dense bake selects.
 */
const computeCarveTargets = (session, keep) => {
  const items = [];
  for (const tile of keep) {
    const r = footprintRect(session, tile);
    if (!r) continue;
    items.push({ tile, r, ge: tile.geometricError ?? Infinity });
  }
  const CELL = 8; // scene units — broad-phase bucket only
  const inv = 1 / CELL;
  const keyOf = (gx, gz) => (gx + 1e6) * 4e6 + (gz + 1e6);
  // Carving only matters INSIDE the AOI — geometry beyond ±SCENE_SIZE/2 is
  // clipped away by the transform. Coarse far-field tiles, however, have
  // enormous footprints (whole-city OBBs); rasterising those raw would create
  // millions of grid cells and blow V8's Map cap ("Map maximum size
  // exceeded"). Clamp every footprint's CELL RANGE to the AOI window so the
  // grid stays bounded; the true rects are still used for the overlap test.
  const LIM = SCENE_SIZE / 2 + 4;
  const loCell = Math.floor(-LIM * inv);
  const hiCell = Math.floor(LIM * inv);
  const cellLo = (v) => Math.max(loCell, Math.floor(v * inv));
  const cellHi = (v) => Math.min(hiCell, Math.floor(v * inv));
  const grid = new Map();
  for (let i = 0; i < items.length; i++) {
    const { r } = items[i];
    for (let gx = cellLo(r.minX); gx <= cellHi(r.maxX); gx++) {
      for (let gz = cellLo(r.minZ); gz <= cellHi(r.maxZ); gz++) {
        const k = keyOf(gx, gz);
        let cell = grid.get(k);
        if (!cell) { cell = []; grid.set(k, cell); }
        cell.push(i);
      }
    }
  }
  const targets = new Map();
  for (let fi = 0; fi < items.length; fi++) {
    const F = items[fi];
    const seen = new Set();
    for (let gx = cellLo(F.r.minX); gx <= cellHi(F.r.maxX); gx++) {
      for (let gz = cellLo(F.r.minZ); gz <= cellHi(F.r.maxZ); gz++) {
        const cell = grid.get(keyOf(gx, gz));
        if (!cell) continue;
        for (const ci of cell) {
          if (ci === fi || seen.has(ci)) continue;
          seen.add(ci);
          const C = items[ci];
          if (!(C.ge > F.ge)) continue; // C must be strictly COARSER than F
          if (F.r.minX > C.r.maxX || F.r.maxX < C.r.minX ||
              F.r.minZ > C.r.maxZ || F.r.maxZ < C.r.minZ) continue; // AABB overlap
          let list = targets.get(C.tile);
          if (!list) { list = []; targets.set(C.tile, list); }
          list.push(F.r);
        }
      }
    }
  }
  return targets;
};

/**
 * Sync session.outputs (Map<tile, {records, carveSig}>) with the current
 * finest covering of the union selection.
 *
 * Tiles are processed DEEPEST FIRST: each tile that produces geometry
 * registers its footprint with every kept ancestor, and ancestors are then
 * (re)built with those rects carved out — fine geometry replaces the coarse
 * surface underneath instead of z-fighting it. A parent is only
 * re-transformed when its carve set actually changed (carveSig).
 */
const rebuildOutputs = (session) => {
  const keep = new Set(selectFinestCovering(session.selectedTiles));
  let added = 0;
  let removed = 0;
  let recarved = 0;
  let missingScenes = 0;
  let newInAoi = 0;
  let newOutsideAoi = 0;
  let newZeroInAoi = 0;
  let newZeroOutside = 0;
  const zeroSamples = [];
  const addedRects = []; // scene-space footprints of added tiles — debug overlay
  const insideAoi = (tile) => {
    // Cheap AOI proximity via the footprint rect (scene units: AOI = ±50).
    const r = footprintRect(session, tile);
    if (!r) return false;
    return r.minX <= 55 && r.maxX >= -55 && r.minZ <= 55 && r.maxZ >= -55;
  };

  for (const tile of [...session.outputs.keys()]) {
    if (!keep.has(tile)) {
      session.outputs.delete(tile);
      removed++;
    }
  }

  // Lateral + ancestor carve: every kept tile's coarse surface is subtracted
  // wherever a strictly finer kept tile (descendant OR cousin) covers it.
  const carveTargets = computeCarveTargets(session, keep);
  const byDepth = [...keep].sort((a, b) => tileDepth(b) - tileDepth(a));
  for (const tile of byDepth) {
    const rects = carveTargets.get(tile) ?? [];
    const carveSig = rects.map((r) => r.key).sort().join(';');
    const existing = session.outputs.get(tile);
    let entry = existing;

    // Tiles that produced zero geometry once (clipped/stripped) stay zero —
    // carving only ever REMOVES triangles. Skip the re-transform; without
    // this every merge re-processed ~3k known-empty tiles.
    if (!existing && session.zeroTiles.has(tile)) continue;

    if (!existing || existing.carveSig !== carveSig) {
      const records = buildTileRecords(session, tile, rects);
      if (records === null) {
        missingScenes++; // scene lost — keep whatever we had
      } else if (records.length > 0) {
        entry = { records, carveSig };
        session.outputs.set(tile, entry);
        if (!existing) {
          added++;
          if (insideAoi(tile)) newInAoi++; else newOutsideAoi++;
          if (addedRects.length < 300) {
            const r = footprintRect(session, tile);
            if (r) addedRects.push({ minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ });
          }
        } else {
          recarved++;
        }
      } else if (existing) {
        session.outputs.delete(tile);
        entry = null;
        removed++;
      } else {
        // Brand-new kept tile, ZERO geometry survived clip+strip — the
        // numbers that matter when a refine looks like a no-op.
        session.zeroTiles.add(tile);
        const inside = insideAoi(tile);
        if (inside) newZeroInAoi++; else newZeroOutside++;
        if (inside && zeroSamples.length < 3) {
          const r = footprintRect(session, tile);
          zeroSamples.push(
            `depth=${tileDepth(tile)} ge=${(tile.geometricError ?? -1).toFixed(2)} ` +
            `rect=${r ? `x[${r.minX.toFixed(1)},${r.maxX.toFixed(1)}] z[${r.minZ.toFixed(1)},${r.maxZ.toFixed(1)}]` : 'none'}`,
          );
        }
      }
    }

  }

  if (missingScenes > 0) {
    console.warn(
      `[bakeWorker] ${missingScenes}/${keep.size} kept tiles lost their scenes ` +
      '(LRU eviction) — the bake has coverage gaps.',
    );
  }
  console.info(
    `[bakeWorker] merge: keep=${keep.size}, added=${added} (in-AOI=${newInAoi}, outside=${newOutsideAoi}), ` +
    `zero-record new: in-AOI=${newZeroInAoi}, outside=${newZeroOutside}, ` +
    `recarved=${recarved}, removed=${removed}, missingScenes=${missingScenes}`,
  );
  // LOD histogram of what the OUTPUT actually contains inside the AOI —
  // geometricError ≈ 2 is the public API's deepest level. If mass sits at
  // ge ≥ 8, the bake is levels above the ceiling and selection is at fault;
  // if it sits at ge ≤ 2–4, we ARE at the API max (Google Maps' own renderer
  // still shows ~one LOD more — known public-API limitation).
  {
    const hist = { 'ge>=32': 0, 'ge16': 0, 'ge8': 0, 'ge4': 0, 'ge2': 0, 'ge<2': 0 };
    for (const tile of session.outputs.keys()) {
      if (!insideAoi(tile)) continue;
      const ge = tile.geometricError ?? 0;
      if (ge >= 32) hist['ge>=32']++;
      else if (ge >= 16) hist.ge16++;
      else if (ge >= 8) hist.ge8++;
      else if (ge >= 4) hist.ge4++;
      else if (ge >= 2) hist.ge2++;
      else hist['ge<2']++;
    }
    console.info(`[bakeWorker] in-AOI output LOD histogram: ${JSON.stringify(hist)}`);
  }
  if (zeroSamples.length > 0) {
    console.info(`[bakeWorker] zero-record in-AOI samples: ${zeroSamples.join(' | ')}`);
  }
  return { added, removed, recarved, kept: keep.size, missingScenes, addedRects };
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
  for (const entry of session.outputs.values()) {
    for (const r of entry.records) {
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
    // Default OFF (post-processing disabled pending rework); the resolved option
    // from buildJobBody normally carries the real value.
    stripGround = false,
    groundNormalThreshold = 0.85,
    groundDistanceM = 2.5,
    cameraSweep = true,
    quality = 'standard',
    sensorSize = quality === 'standard' ? 1024 : 1536,
    maxWaitMs = null,
    stabilityMs = 2500,
    // Route-corridor mode (opt-in) — see services/googleBakeCore.js. Mirrors
    // the in-browser bake so the sidecar produces the identical corridor result.
    corridorSegment = null,
    corridorHalfWidthM = 0,
    // Route mode: one route-wide vertical anchor (metres) shared by every chunk
    // so adjacent chunks don't float at their shared seam. null → per-chunk.
    sharedGroundOffsetM = null,
    // Route mode: also extract the bare-earth tile ground for this chunk's .ter
    // (browser sets it from getGroundStrategy so the route .ter matches the
    // single-tile export). null strategy → extractTileGround defaults.
    extractGround = false,
    groundStrategy = null,
  } = options;

  if (!apiKey) throw new Error('bake worker: missing apiKey');
  if (!data?.bounds || !data?.heightMap) throw new Error('bake worker: invalid terrain data');

  // Preflight the root tileset — fail fast with the actual upstream error
  // (key restrictions, API disabled, billing, or EEA 403) instead of polling
  // 0 tiles. `apiKey` carries either a Google key or a Cesium ion token.
  await preflightTilesAuth(apiKey);

  const frame = computeAoiFrame(data, WGS84_ELLIPSOID);

  const tiles = new TilesRenderer();
  const auth = await registerTilesAuth(tiles, apiKey, { GoogleCloudAuthPlugin });
  // GLB content is content-addressed — serve repeat downloads (session
  // rebuilds after a restart, quality re-bakes) from local disk. Content URLs
  // stay on tile.googleapis.com for both auth modes, so the cache is mode-agnostic.
  const tileCache = new TileDiskCache();
  const cacheState = await tileCache.prune();
  console.info(
    `[bakeWorker] tile disk cache: ${cacheState.files} files, ` +
    `${(cacheState.bytes / 1024 ** 2).toFixed(0)} MB (${cacheState.pruned} pruned)`,
  );
  tileCache.wrapPlugin(auth);
  tileCache.attach(tiles);
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

  const stations = buildSweepStations(frame, { quality, cameraSweep, corridorSegment });

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
    corridorSegment, corridorHalfWidthM,
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

  // Keep the ground here — the strip now runs LAST (after the weld), so the
  // weld can flatten street risers onto a street surface that still exists.
  const transformMesh = createTileMeshTransformer(data, frame, WGS84_ELLIPSOID, googleGroundAlt, {
    stripGround: false, computeNormals: false,
    ...(Number.isFinite(sharedGroundOffsetM) ? { groundOffsetM: sharedGroundOffsetM } : {}),
  });
  console.info(
    `[bakeWorker] vertical anchor: googleGroundAlt=${googleGroundAlt.toFixed(1)}m (ellipsoidal), ` +
    `mapngGroundY=${transformMesh.mapngGroundY.toFixed(1)}m, minHeight=${transformMesh.minH.toFixed(1)}m`,
  );

  const session = {
    data, options, tiles, cam, frame, stations, selectedTiles,
    quality, stabilityMs, tileCache,
    googleGroundAlt, transformMesh,
    // Ground strip runs as a final pass (applyGroundStrip), not in the transform.
    groundStrip: { enabled: stripGround, groundNormalThreshold, groundDistanceM },
    outputs: new Map(),       // tile → { records, carveSig }
    zeroTiles: new Set(),     // kept tiles known to clip/strip to nothing
    footprints: new Map(),    // tile → scene-XZ rect | null (stable, cached)
    // Projection context for footprintRect — same math as the transformer.
    fp: {
      projector: createMetricProjector(data.bounds, data.width, data.height),
      dataWidth: data.width,
      dataHeight: data.height,
      upm: computeUnitsPerMeter(data),
    },
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
  applyWeld(session);        // close seams while the street ground still exists
  applyConform(session);     // seat the welded mesh onto the .ter floor (delta field)

  // Extract the bare-earth ground HERE — after weld+conform (best surface), but
  // BEFORE the ground strip removes the road triangles the extraction needs. The
  // result is z-offset-independent, so it's cached on the session and reused
  // across re-exports (the route re-exports only to tweak the tile z-offset).
  extractSessionGround(session, extractGround, groundStrategy);
  applyTerGroundSnap(session, groundStrategy); // flatten road visuals onto the extracted .ter ground

  applyGroundStrip(session); // THEN drop the (now-flattened) street/ground
  applyRiserStrip(session);  // off by default — fallback behind MAPNG_STRIP_RISERS=1

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
  // Match the user's REAL frustum: THREE fov is vertical, so without the
  // preview's aspect the refine covers a square column — on a widescreen
  // canvas the left/right thirds of what the user SEES were never refined.
  const aspect = Number.isFinite(stationSpec.aspect)
    ? Math.min(3, Math.max(0.5, stationSpec.aspect))
    : 1;
  session.tiles.errorTarget = errorTarget;
  session.cam.aspect = aspect;
  session.tiles.setResolution(session.cam, Math.round(sensor * Math.sqrt(aspect)), Math.round(sensor / Math.sqrt(aspect)));

  // The fly camera looks HORIZONTALLY, and only frustum ∩ AOI matters — the
  // transform clips everything else. A corner-distance far plane was not
  // enough: on a 512 m AOI with the camera looking toward a nearby edge, the
  // frustum still swept ~2 km of outside world and the selector spent the
  // whole budget there (observed: 4.9k outside-AOI tiles united, +10 kept).
  // Clamp the far plane to where the VIEW RAY exits the AOI square instead
  // (slab test in ENU), padded for the FOV spread and tall geometry; fall
  // back to the farthest corner when looking across the whole AOI.
  const half = session.frame.extentM / 2;
  const maxCornerDist = Math.max(
    Math.hypot(stationSpec.e - half, stationSpec.n - half),
    Math.hypot(stationSpec.e - half, stationSpec.n + half),
    Math.hypot(stationSpec.e + half, stationSpec.n - half),
    Math.hypot(stationSpec.e + half, stationSpec.n + half),
  );
  let far = maxCornerDist;
  {
    const de = stationSpec.lookE - stationSpec.e;
    const dn = stationSpec.lookN - stationSpec.n;
    const len = Math.hypot(de, dn);
    if (len > 1e-6) {
      const slab = (p, d, h) => {
        if (Math.abs(d) < 1e-9) return Math.abs(p) <= h ? [-Infinity, Infinity] : null;
        const t0 = (-h - p) / d;
        const t1 = (h - p) / d;
        return t0 < t1 ? [t0, t1] : [t1, t0];
      };
      const a = slab(stationSpec.e, de / len, half);
      const b = slab(stationSpec.n, dn / len, half);
      if (a && b) {
        const tMin = Math.max(a[0], b[0]);
        const tMax = Math.min(a[1], b[1]);
        // tMax = where the centre ray leaves the AOI (camera inside: tMin<0).
        if (tMax > Math.max(0, tMin)) far = Math.min(maxCornerDist, tMax);
        else far = 400; // looking away from the AOI — only near geometry matters
      } else {
        far = 400;
      }
    }
  }
  session.cam.far = far * 1.4 + 250; // FOV spread + tall photogrammetry slack
  session.cam.near = 1;
  session.cam.updateProjectionMatrix();

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
  applyWeld(session);        // close seams while the street ground still exists
  applyConform(session);     // seat the welded mesh onto the .ter floor (delta field)
  // Same tail as runBake: the refine changed geometry, so the extracted ground
  // (shipped for the .ter) and the road snap onto it must be recomputed.
  extractSessionGround(session, session.options?.extractGround, session.options?.groundStrategy);
  applyTerGroundSnap(session, session.options?.groundStrategy);
  applyGroundStrip(session); // THEN drop the (now-flattened) street/ground
  applyRiserStrip(session);  // off by default — fallback behind MAPNG_STRIP_RISERS=1
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
    recarved: diff.recarved,
    selected: session.selectedTiles.size,
    kept: diff.kept,
    timedOut,
    elapsedMs: Math.round(elapsedMs),
    // Debug overlay payload: where the refine actually landed, plus the
    // frustum parameters the worker used (mismatches show up immediately).
    debug: {
      addedRects: diff.addedRects,
      station: { e: stationSpec.e, n: stationSpec.n, heightM: stationSpec.heightM },
      fov: station.fov ?? null,
      aspect,
      far: session.cam.far,
      errorTarget,
    },
  });
}

/**
 * Server-side BeamNG export assembly: atlas PNGs + chunked GLB straight from
 * the session's records (see googleExportAssembly.mjs). The browser never
 * touches the heavy artifacts — it gets file PATHS, which the Blender bridge
 * and the zip sidecar (same machine) consume directly.
 */
async function exportAssembly(session, revision, spec) {
  if (!Number.isFinite(spec?.worldSize) || spec.worldSize <= 0) {
    throw new Error('export: missing/invalid worldSize');
  }
  const records = [];
  for (const entry of session.outputs.values()) records.push(...entry.records);
  // Scene→metres scale from the AOI's REAL metric extent (SCENE_SIZE/upm), not
  // the requested box size: a 512 "px" chunk actually spans 511.05 m (fencepost),
  // so worldSize=512 stretched every mesh ~0.19% about its centre — zero at the
  // chunk centre, growing outward, doubled at chunk seams. The preview always
  // scaled by 1/upm, which is why it aligned and BeamNG didn't.
  const upmExport = computeUnitsPerMeter(session.data);
  const worldSizeM = upmExport > 0 ? SCENE_SIZE / upmExport : spec.worldSize;
  console.info(
    `[bakeWorker] export rev${revision}: assembling ${records.length} records ` +
    `(extent=${worldSizeM.toFixed(2)}m, requested=${spec.worldSize}, zOffset=${spec.zOffsetM ?? 0}m)…`,
  );
  const result = await assembleGoogleTilesExport(records, {
    worldSize: worldSizeM,
    sceneSize: SCENE_SIZE,
    zOffsetM: Number.isFinite(spec.zOffsetM) ? spec.zOffsetM : 0,
    materialPrefix: typeof spec.materialPrefix === 'string' ? spec.materialPrefix : '',
    outDir: path.dirname(session.outBase),
    log: console.info,
  });
  if (!result) throw new Error('export: no google tile geometry to assemble');
  emit({
    type: 'exported',
    revision,
    glbPath: result.glbPath,
    glbBytes: result.glbBytes,
    textures: result.textures,
    materialNames: result.materialNames,
    meshes: result.meshCount,
    meshBounds: result.meshBounds, // assembled-mesh AABB (final metres) — placement diagnostic

    // The effective vertical anchor this bake used — chunk 0 of a route reports
    // it back so every later chunk (and the preview) seats on the same datum.
    groundOffsetM: session.transformMesh?.groundOffsetM,
    // Route mode: the bare-earth tile ground for this chunk's .ter (z-offset-
    // independent, extracted once in startBake). Absent for single-tile bakes.
    ...(session.extractedGround ? { ground: encodeGround(session.extractedGround) } : {}),
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
  if (cmd.type === 'refine') {
    chain = chain.then(async () => {
      try {
        await refine(session, cmd.revision, cmd.station ?? {});
      } catch (err) {
        console.error(`[bakeWorker] refine rev${cmd.revision} failed:`, err?.stack ?? err);
        emit({ type: 'refine-error', revision: cmd.revision, message: err?.message ?? String(err) });
      }
    });
  } else if (cmd.type === 'export') {
    chain = chain.then(async () => {
      try {
        await exportAssembly(session, cmd.revision, cmd.spec ?? {});
      } catch (err) {
        console.error(`[bakeWorker] export rev${cmd.revision} failed:`, err?.stack ?? err);
        emit({ type: 'export-error', revision: cmd.revision, message: err?.message ?? String(err) });
      }
    });
  }
});
rl.on('close', () => {
  chain.then(() => process.exit(0));
});
