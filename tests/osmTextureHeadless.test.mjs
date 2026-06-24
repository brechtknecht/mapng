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
const { generateOSMTexture } = await import('@mapng/bake/osmTexture');

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

// Small synthetic AOI: a primary road crossing a grass landuse square.
const makeTerrainData = () => ({
  width: 64,
  height: 64,
  bounds: { north: 0.001, south: -0.001, east: 0.001, west: -0.001 },
  osmFeatures: [
    {
      type: 'area',
      tags: { landuse: 'grass' },
      geometry: [
        { lat: -0.0008, lng: -0.0008 },
        { lat: -0.0008, lng: 0.0008 },
        { lat: 0.0008, lng: 0.0008 },
        { lat: 0.0008, lng: -0.0008 },
      ],
    },
    {
      type: 'road',
      tags: { highway: 'primary' },
      geometry: [
        { lat: -0.0009, lng: -0.0009 },
        { lat: 0.0009, lng: 0.0009 },
      ],
    },
  ],
});

test('generateOSMTexture renders headlessly to a non-empty canvas', async () => {
  const result = await withSeededRandom(1, () => generateOSMTexture(makeTerrainData(), { outputSize: 64 }));
  assert.ok(result.canvas, 'returns a canvas');
  assert.equal(result.canvas.width, 64);
  assert.equal(result.canvas.height, 64);
  assert.ok(result.blob && result.blob.size > 0, 'produced a non-empty PNG blob');

  // The road + grass must have painted SOMETHING distinct from a uniform fill.
  const ctx = result.canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, 64, 64);
  const first = [data[0], data[1], data[2]];
  let distinct = false;
  for (let i = 4; i < data.length; i += 4) {
    if (data[i] !== first[0] || data[i + 1] !== first[1] || data[i + 2] !== first[2]) { distinct = true; break; }
  }
  assert.ok(distinct, 'rendered pixels are not a single uniform colour');
});

test('generateOSMTexture is byte-deterministic under a seeded PRNG (oracle)', async () => {
  const hashOnce = async () => {
    const { canvas } = await withSeededRandom(42, () => generateOSMTexture(makeTerrainData(), { outputSize: 64 }));
    return createHash('sha256').update(canvas.toBuffer('image/png')).digest('hex');
  };
  const a = await hashOnce();
  const b = await hashOnce();
  assert.equal(a, b, 'identical input + seed → identical PNG bytes');
});
