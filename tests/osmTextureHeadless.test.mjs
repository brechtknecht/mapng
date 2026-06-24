// Headless render test for the OSM texture painter (osmTexture.js) — proves the
// canvas-coupled bake path runs in Node under the @napi-rs/canvas shim, and
// pins its output as a regression oracle for the osmTexture decomposition
// (refactor doc 06 step 6). No browser.
//
// Determinism: generateOSMTexture's background noise calls Math.random(), so the
// test seeds a fixed PRNG. A verbatim refactor preserves the random call order,
// so the PNG bytes stay identical; a behavioural change to which features are
// classified/drawn changes them — exactly what we want to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installCanvasShim } from '../tools/testlab/canvasShim.mjs';

installCanvasShim();
const { generateOSMTexture } = await import('@mapng/terrain/osmTexture');

// Deterministic mulberry32 — replaces Math.random for the duration of a render.
const seededRandom = (seed) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const withSeededRandom = async (seed, fn) => {
  const real = Math.random;
  Math.random = seededRandom(seed);
  try { return await fn(); } finally { Math.random = real; }
};

// A rich synthetic AOI exercising the whole render: landcover (grass + water),
// a lane-marked primary + residential + service road meeting at a junction, a
// footway crossing (crosswalk), and a building.
const makeTerrainData = () => ({
  width: 96,
  height: 96,
  bounds: { north: 0.0012, south: -0.0012, east: 0.0012, west: -0.0012 },
  osmFeatures: [
    { type: 'landuse', tags: { landuse: 'grass' }, geometry: [{ lat: -0.001, lng: -0.001 }, { lat: -0.001, lng: 0.001 }, { lat: 0.001, lng: 0.001 }, { lat: 0.001, lng: -0.001 }] },
    { type: 'water', tags: { natural: 'water' }, geometry: [{ lat: 0.0003, lng: 0.0003 }, { lat: 0.0003, lng: 0.0008 }, { lat: 0.0008, lng: 0.0008 }, { lat: 0.0008, lng: 0.0003 }] },
    { type: 'road', tags: { highway: 'primary', lanes: '4' }, geometry: [{ lat: -0.0011, lng: 0 }, { lat: 0.0011, lng: 0 }] },
    { type: 'road', tags: { highway: 'residential' }, geometry: [{ lat: 0, lng: -0.0011 }, { lat: 0, lng: 0.0011 }] },
    { type: 'road', tags: { highway: 'service' }, geometry: [{ lat: 0, lng: 0 }, { lat: 0.0008, lng: 0.0008 }] },
    { type: 'road', tags: { highway: 'footway' }, geometry: [{ lat: -0.0005, lng: 0.0005 }, { lat: 0.0005, lng: -0.0005 }] },
    { type: 'building', tags: { building: 'yes' }, geometry: [{ lat: -0.0008, lng: 0.0003 }, { lat: -0.0008, lng: 0.0008 }, { lat: -0.0004, lng: 0.0008 }, { lat: -0.0004, lng: 0.0003 }] },
  ],
});

// Golden hash of the render at seed 7 — captured against the pre-decomposition
// monolith and verified byte-identical after the osm/* split (06 step 6). A
// behavioural change to classification/lane-layout/drawing flips this.
const GOLDEN_SHA256 = 'db6d1ffa04da0a761b88ee53e83087664e4f645b085f53d5d48ae2ce24c0b6c7';

test('generateOSMTexture renders headlessly to a non-empty canvas', async () => {
  const result = await withSeededRandom(7, () => generateOSMTexture(makeTerrainData(), { outputSize: 96 }));
  assert.ok(result.canvas, 'returns a canvas');
  assert.equal(result.canvas.width, 96);
  assert.equal(result.canvas.height, 96);
  assert.ok(result.blob && result.blob.size > 0, 'produced a non-empty PNG blob');

  // The features must have painted SOMETHING distinct from a uniform fill.
  const ctx = result.canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, 96, 96);
  const first = [data[0], data[1], data[2]];
  let distinct = false;
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== first[0] || data[i + 1] !== first[1] || data[i + 2] !== first[2]) { distinct = true; break; }
  }
  assert.ok(distinct, 'rendered pixels are not a single uniform colour');
});

test('generateOSMTexture matches the golden render hash (regression oracle)', async () => {
  const hashOnce = async () => {
    const { canvas } = await withSeededRandom(7, () => generateOSMTexture(makeTerrainData(), { outputSize: 96 }));
    return createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
  };
  const a = await hashOnce();
  const b = await hashOnce();
  assert.equal(a, b, 'identical input + seed → identical PNG bytes');
  assert.equal(a, GOLDEN_SHA256, 'render matches the pinned golden hash');
});
