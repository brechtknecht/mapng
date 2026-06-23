import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCombinedRouteTerrain, sampleHeightAt } from '@mapng/route/routeTerrainComposite';

// A small chunk terrain: constant elevation `h` over a square box centred at
// (lat,lng) of side ~`sizeM` metres.
function fakeChunk(lat, lng, h, sizeM = 1000, px = 64) {
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const halfLat = (sizeM / 2) / 111320;
  const halfLng = (sizeM / 2) / mPerDegLng;
  return {
    bounds: { north: lat + halfLat, south: lat - halfLat, east: lng + halfLng, west: lng - halfLng },
    width: px, height: px,
    heightMap: new Float32Array(px * px).fill(h),
    minHeight: h, maxHeight: h,
  };
}

test('sampleHeightAt returns the chunk elevation at its centre', () => {
  const c = fakeChunk(48.1, 11.6, 530);
  assert.ok(Math.abs(sampleHeightAt(c, 48.1, 11.6) - 530) < 1e-6);
});

test('combined terrain is square and spans the union bbox', () => {
  const terrains = [
    fakeChunk(48.10, 11.60, 520),
    fakeChunk(48.12, 11.63, 540),
  ];
  const out = buildCombinedRouteTerrain(terrains);
  assert.equal(out.width, out.height); // square
  assert.ok((out.width & (out.width - 1)) === 0, `width ${out.width} not power-of-two`);
  // bounds cover both chunks
  assert.ok(out.bounds.north >= 48.12);
  assert.ok(out.bounds.south <= 48.10);
  assert.ok(out.metersPerPixel > 0);
});

test('combined heightmap carries the chunk elevations and a low filler floor', () => {
  const terrains = [
    fakeChunk(48.10, 11.60, 520),
    fakeChunk(48.10, 11.62, 560), // same lat, offset east → both inside one row band
  ];
  const out = buildCombinedRouteTerrain(terrains, { targetMetersPerPixel: 4, maxSize: 1024 });
  // min reflects the filler floor (lowest datum), max reflects the higher chunk
  // (bilinear weights are FP, so the constant fields land within a hair of exact)
  assert.ok(Math.abs(out.minHeight - 520) < 1e-3, `minHeight ${out.minHeight}`);
  assert.ok(out.maxHeight >= 560 - 1);
  // a pixel at the higher chunk's centre samples ~560
  const { bounds, width, heightMap } = out;
  const gx = Math.round((11.62 - bounds.west) / (bounds.east - bounds.west) * (width - 1));
  const gy = Math.round((bounds.north - 48.10) / (bounds.north - bounds.south) * (width - 1));
  assert.ok(Math.abs(heightMap[gy * width + gx] - 560) < 5, `expected ~560, got ${heightMap[gy * width + gx]}`);
});
