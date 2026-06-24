// Headless geometry oracle for export3d.js's createOSMGroup — the 700-line beast
// at the heart of the scene3d/* decomposition (refactor doc 06 step 8 / 09 §6b).
// createOSMGroup is pure THREE geometry (no canvas/network), so it runs in Node
// directly; we hash the merged buffer attributes of every mesh it emits and pin
// that as a regression oracle. A verbatim move preserves the exact float bytes;
// any behavioural drift (vertex order, colour, normal, random-call order) flips
// the hash.
//
// Determinism: building/vegetation/furniture placement calls Math.random(), so
// the test seeds a fixed PRNG. Identical input + seed → identical geometry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installCanvasShim } from '../tools/testlab/canvasShim.mjs';

installCanvasShim();
// Import the leaf module directly — the export3d barrel pulls in google3dTiles
// (3d-tiles-renderer instantiates a WebGLRenderer at import), which needs a GPU.
// osmMeshes has no such dependency, so it runs headless.
const { createOSMGroup } = await import('@mapng/export/scene3d/osmMeshes');
const { SCENE_SIZE } = await import('@mapng/export/scene3d/sceneProjection');

// Deterministic mulberry32 — replaces Math.random for the duration of a build.
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

// 64×64 height field with gentle relief so getHeightAtScenePos returns varied
// values across the tile (flat terrain would mask Y-coordinate regressions).
const makeTerrainData = () => {
  const width = 64, height = 64;
  const heightMap = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      heightMap[y * width + x] =
        10 + 4 * Math.sin(x / 7) + 3 * Math.cos(y / 5) + (x + y) * 0.05;
    }
  }
  return {
    width,
    height,
    heightMap,
    minHeight: 10,
    maxHeight: 30,
    bounds: { north: 0.0012, south: -0.0012, east: 0.0012, west: -0.0012 },
    osmFeatures: [
      // road — feeds roadSegments (furniture orientation)
      { type: 'road', tags: { highway: 'residential' }, geometry: [{ lat: -0.0011, lng: 0 }, { lat: 0.0011, lng: 0 }] },
      // building footprint
      { type: 'building', tags: { building: 'house', 'building:levels': '2' }, geometry: [
        { lat: -0.0008, lng: 0.0003 }, { lat: -0.0008, lng: 0.0008 },
        { lat: -0.0004, lng: 0.0008 }, { lat: -0.0004, lng: 0.0003 }, { lat: -0.0008, lng: 0.0003 },
      ] },
      // barrier (fence)
      { type: 'barrier', tags: { barrier: 'fence' }, geometry: [{ lat: 0.0002, lng: -0.001 }, { lat: 0.0002, lng: -0.0002 }] },
      // vegetation: wooded polygon (random tree placement) + a single tree point
      { type: 'vegetation', tags: { landuse: 'forest', leaf_type: 'needleleaved' }, geometry: [
        { lat: 0.0003, lng: -0.001 }, { lat: 0.0003, lng: -0.0004 },
        { lat: 0.0009, lng: -0.0004 }, { lat: 0.0009, lng: -0.001 }, { lat: 0.0003, lng: -0.001 },
      ] },
      { type: 'vegetation', tags: { natural: 'tree' }, geometry: [{ lat: -0.0006, lng: -0.0006 }] },
      // vegetation: scrub polygon (random bush placement)
      { type: 'vegetation', tags: { natural: 'scrub' }, geometry: [
        { lat: -0.001, lng: 0.0004 }, { lat: -0.001, lng: 0.001 },
        { lat: -0.0004, lng: 0.001 }, { lat: -0.0004, lng: 0.0004 }, { lat: -0.001, lng: 0.0004 },
      ] },
      // street furniture
      { type: 'street_furniture', tags: { highway: 'street_lamp' }, geometry: [{ lat: 0.0001, lng: 0.0001 }] },
      { type: 'street_furniture', tags: { amenity: 'bench' }, geometry: [{ lat: -0.0001, lng: 0.0002 }] },
      { type: 'street_furniture', tags: { barrier: 'bollard' }, geometry: [{ lat: 0.0005, lng: 0.0005 }] },
    ],
  };
};

// Serialize every mesh's geometry into a stable byte stream: group-child order,
// then each attribute (sorted by name) as raw little-endian floats, plus index.
const hashGroup = (group) => {
  const hash = createHash('sha256');
  group.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    hash.update(obj.name || '');
    const geo = obj.geometry;
    for (const name of Object.keys(geo.attributes).sort()) {
      const attr = geo.attributes[name];
      hash.update(name);
      hash.update(Buffer.from(Float32Array.from(attr.array).buffer));
    }
    if (geo.index) hash.update(Buffer.from(Uint32Array.from(geo.index.array).buffer));
  });
  return hash.digest('hex');
};

// Golden hash at seed 11 — captured against the pre-decomposition monolith
// (export3d.js createOSMGroup, before the scene3d/* split). A verbatim move
// keeps the merged buffer bytes identical; any drift flips this.
const GOLDEN_SHA256 = 'e339531f63d7ece8bf52a56ab6e84cd5ec8dcd829353eb925b2f048330f6b195';

test('createOSMGroup builds a non-empty group with the expected mesh layers', () => {
  assert.equal(SCENE_SIZE, 100);
  const group = withSeededRandom(11, () => createOSMGroup(makeTerrainData()));
  const names = new Set();
  group.traverse((o) => { if (o.isMesh) names.add(o.name); });
  for (const expected of ['buildings', 'barriers', 'vegetation', 'street_furniture']) {
    assert.ok(names.has(expected), `emits a "${expected}" mesh`);
  }
});

test('createOSMGroup matches the golden geometry hash (regression oracle)', () => {
  const a = hashGroup(withSeededRandom(11, () => createOSMGroup(makeTerrainData())));
  const b = hashGroup(withSeededRandom(11, () => createOSMGroup(makeTerrainData())));
  assert.equal(a, b, 'identical input + seed → identical geometry bytes');
  if (GOLDEN_SHA256 !== 'PENDING') {
    assert.equal(a, GOLDEN_SHA256, 'geometry matches the pinned golden hash');
  } else {
    console.log(`[oracle] createOSMGroup golden hash @seed11 = ${a}`);
  }
});
