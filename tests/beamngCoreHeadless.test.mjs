// Headless golden-hash oracle for the pure-compute beamng/* modules extracted
// from exportBeamNGLevel.js (refactor 06 step 9). These modules emit plain JS
// objects/strings (DecalRoads, MeshRoads, Road Architect session, barriers,
// water, forest, the export report) — no DOM/canvas/renderer — so they run in
// Node directly. We hash a canonical JSON serialization of each module's output
// against a fixed fixture + seed + flavor and pin it: a verbatim move keeps the
// bytes identical; any behavioural drift (field order, rounding, random-call
// order, lookup change) flips the hash.
//
// Coverage note (no silent caps): this oracle covers the CORE/compute path. The
// io modules textures.js / meshAssets.js / googleTilesAssets.js (canvas / THREE
// / WebGLRenderer) are NOT exercised here — they rely on the verbatim move + the
// Vite build + the in-app smoke. googleTilesAssets imports google3dTiles, which
// builds a WebGLRenderer at module eval and cannot be imported in Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { computeSquareSize } from '@mapng/bake/beamng/worldMath';
import { generateDecalRoads } from '@mapng/bake/beamng/decalRoads';
import { generateMeshRoads } from '@mapng/bake/beamng/meshRoads';
import { generateRoadArchitectSession } from '@mapng/bake/beamng/roadArchitectSession';
import { buildNativeBarrierObjects, buildBarrierFolderItems } from '@mapng/bake/beamng/barriers';
import { buildWaterBlockObjects, buildRiverObjects, buildSeaLevelWaterPlane } from '@mapng/bake/beamng/water';
import { buildForestPlacements, serializeForestFiles, buildGroundCoverObjects } from '@mapng/bake/beamng/forest';
import { buildBeamNGExportReport } from '@mapng/bake/beamng/report';
import { getBeamNGFlavorById } from '@mapng/bake/beamngFlavorCatalog';

// Deterministic mulberry32 — generatePersistentId() calls Math.random, so the
// oracle seeds a fixed PRNG. Identical input + seed → identical output.
const seededRandom = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const withSeededRandom = (seed, fn) => {
  const real = Math.random;
  Math.random = seededRandom(seed);
  try { return fn(); } finally { Math.random = real; }
};

const h = (o) => createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

// 64×64 height field with gentle relief, plus OSM features that exercise every
// generator: roads (decal + mesh + architect), barrier, closed water polygon,
// linear waterway, forest landuse, single tree point.
const makeTerrainData = () => {
  const W = 64, H = 64;
  const heightMap = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      heightMap[y * W + x] = 10 + 4 * Math.sin(x / 7) + 3 * Math.cos(y / 5) + (x + y) * 0.05;
    }
  }
  return {
    width: W, height: H, heightMap, minHeight: 10, maxHeight: 30,
    bounds: { north: 0.0012, south: -0.0012, east: 0.0012, west: -0.0012 },
    osmFeatures: [
      { id: 1, type: 'road', tags: { highway: 'primary', name: 'Main' }, geometry: [{ lat: -0.0011, lng: -0.0009 }, { lat: 0, lng: 0 }, { lat: 0.0011, lng: 0.0009 }] },
      { id: 2, type: 'road', tags: { highway: 'residential' }, geometry: [{ lat: 0, lng: -0.001 }, { lat: 0, lng: 0.001 }] },
      { id: 3, type: 'barrier', tags: { barrier: 'guard_rail' }, geometry: [{ lat: 0.0002, lng: -0.001 }, { lat: 0.0002, lng: 0.0008 }] },
      { id: 4, type: 'water', tags: { water: 'lake' }, geometry: [{ lat: -0.0008, lng: 0.0003 }, { lat: -0.0008, lng: 0.0008 }, { lat: -0.0004, lng: 0.0008 }, { lat: -0.0004, lng: 0.0003 }, { lat: -0.0008, lng: 0.0003 }] },
      { id: 5, type: 'water', tags: { waterway: 'river', width: '10' }, geometry: [{ lat: 0.0009, lng: -0.001 }, { lat: 0.0005, lng: -0.0002 }, { lat: 0.0009, lng: 0.0006 }] },
      { id: 6, type: 'landuse', tags: { landuse: 'forest' }, geometry: [{ lat: 0.0003, lng: -0.001 }, { lat: 0.0003, lng: -0.0004 }, { lat: 0.0009, lng: -0.0004 }, { lat: 0.0009, lng: -0.001 }, { lat: 0.0003, lng: -0.001 }] },
      { id: 7, type: 'vegetation', tags: { natural: 'tree' }, geometry: [{ lat: -0.0006, lng: -0.0006 }] },
    ],
  };
};

const flavor = getBeamNGFlavorById('italy');

// Goldens at seed 11 / fixture above / flavor 'italy', captured against the
// freshly-extracted beamng/* modules (each body is a verbatim copy of the
// pre-decomposition monolith). Pin = future-drift guard.
const GOLDEN = {
  decalRoads:   '609e4f5587338d6d',
  meshRoads:    '55b26a2fd671752e',
  raSession:    '3d5386c62c7bc2a3',
  barriers:     'cd350e4145673ed9',
  barrierFolder:'ce8c743896915d39',
  waterBlocks:  '92132d7dd7af65b8',
  rivers:       'c74ec9cbddec53de',
  seaPlane:     '7ce03cd191addfbf',
  forest:       '40a0d3181e18c7c9',
  forestFiles:  'ac73db1682597883',
  groundCover:  '7536a7b0d4fb0827',
  report:       '6e1f2f519bcb275b',
};

const compute = () => {
  const td = makeTerrainData();
  const ss = computeSquareSize(td);
  const barrierObjs = buildNativeBarrierObjects(td, ss);
  const fp = buildForestPlacements(td, ss, { includeTrees: true, includeRocks: true }, flavor);
  return {
    decalRoads:    h(generateDecalRoads(td, ss)),
    meshRoads:     h(generateMeshRoads(td, ss).meshRoads),
    raSession:     h(generateRoadArchitectSession(td, ss, 'test')),
    barriers:      h(barrierObjs),
    barrierFolder: h(buildBarrierFolderItems(barrierObjs)),
    waterBlocks:   h(buildWaterBlockObjects(td, ss, flavor)),
    rivers:        h(buildRiverObjects(td, ss, flavor)),
    seaPlane:      h(buildSeaLevelWaterPlane(td, flavor)),
    forest:        h([...fp.entries()]),
    forestFiles:   h(serializeForestFiles(fp)),
    groundCover:   h(buildGroundCoverObjects(td, ss, true, flavor)),
    report:        h(buildBeamNGExportReport({
      terrainData: td, originalTerrainData: td, center: { lat: 0, lng: 0 }, options: {},
      levelName: 'test', levelDisplayName: 'Test', flavor, squareSize: ss,
      satelliteTexSize: 1024, worldSize: td.width * ss,
      exportStartedAt: new Date(0), reportGeneratedAt: new Date(1000),
      processingLog: [], effectivePbrSource: 'osm', waterObjects: [], barrierObjects: [],
      barrierMeshSplineGroups: [], roadArchitectRoadCount: 0, roadArchitectJunctionCount: 0,
      forestPlacements: fp, forestFiles: [], groundCoverObjects: [], osmDaeBlob: null,
      backdropDaeBlob: null, backdropTextureFiles: [], backdropDiagnostics: null,
      mapngFlagFiles: [], didCropToSquare: false,
    })),
  };
};

test('beamng core generators are deterministic under a fixed seed', () => {
  const a = withSeededRandom(11, compute);
  const b = withSeededRandom(11, compute);
  assert.deepEqual(a, b, 'identical input + seed → identical output bytes');
});

test('beamng core generators match the pinned golden hashes (regression oracle)', () => {
  const out = withSeededRandom(11, compute);
  for (const key of Object.keys(GOLDEN)) {
    if (GOLDEN[key] === 'PENDING') {
      console.log(`[oracle] beamng ${key} golden = ${out[key]}`);
      continue;
    }
    assert.equal(out[key], GOLDEN[key], `${key} matches its pinned golden hash`);
  }
});
