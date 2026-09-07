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

// ── Chunk ownership + vertical registration (connectors) ───────────────────
import { compositeRouteGround, registerChunkGrounds } from '@mapng/route/routeTerrainComposite';

// Two 1000 m chunks 800 m apart (200 m overlap band), constant floors 500 and
// 503 — the kind of near-constant disagreement two independent bakes show.
const groundPair = () => {
  const a = fakeChunk(48.10, 11.60, 500);
  const mLng = 111320 * Math.cos((48.10 * Math.PI) / 180);
  const b = fakeChunk(48.10, 11.60 + 800 / mLng, 503);
  a.coverage = new Uint8Array(a.width * a.height).fill(1);
  b.coverage = new Uint8Array(b.width * b.height).fill(1);
  return { a, b, mLng };
};

test('composite: coverage blend puts the overlap floor between the two chunks', () => {
  const { a, b } = groundPair();
  const combined = buildCombinedRouteTerrain([a, b], { targetMetersPerPixel: 4, maxSize: 1024 });
  const cg = compositeRouteGround([a, b], combined, { featherM: 0 });
  const midLng = (a.bounds.east + b.bounds.west) / 2; // centre of the overlap band
  const gx = Math.round((midLng - combined.bounds.west) / (combined.bounds.east - combined.bounds.west) * (combined.width - 1));
  const gy = Math.round((combined.bounds.north - 48.10) / (combined.bounds.north - combined.bounds.south) * (combined.width - 1));
  const v = cg.heightMap[gy * combined.width + gx];
  assert.ok(Math.abs(v - 501.5) < 0.2, `blend ≈ 501.5, got ${v}`);
});

test('composite: ownership gives every cell ONE chunk\'s floor, crossing over on the bisector', () => {
  const { a, b, mLng } = groundPair();
  const combined = buildCombinedRouteTerrain([a, b], { targetMetersPerPixel: 4, maxSize: 1024 });
  const cg = compositeRouteGround([a, b], combined, { featherM: 0, ownershipFeatherM: 6 });
  const at = (lngOffM) => {
    const lng = 11.60 + lngOffM / mLng;
    const gx = Math.round((lng - combined.bounds.west) / (combined.bounds.east - combined.bounds.west) * (combined.width - 1));
    const gy = Math.round((combined.bounds.north - 48.10) / (combined.bounds.north - combined.bounds.south) * (combined.width - 1));
    return cg.heightMap[gy * combined.width + gx];
  };
  // bisector at 400 m east of chunk a's centre; 40 m either side is fully owned
  assert.ok(Math.abs(at(360) - 500) < 0.2, `a owns 360 m, got ${at(360)}`);
  assert.ok(Math.abs(at(440) - 503) < 0.2, `b owns 440 m, got ${at(440)}`);
});

test('registration: the chained offset seats chunk b on chunk a, and pairs are reported', () => {
  const { a, b } = groundPair();
  const reg = registerChunkGrounds([a, b]);
  assert.equal(reg.offsets[0], 0);
  assert.ok(Math.abs(reg.offsets[1] - (-3)) < 0.05, `chunk b lowered by 3 m, got ${reg.offsets[1]}`);
  assert.equal(reg.pairs.length, 1);
  assert.equal(reg.pairs[0].a, 0);
  assert.equal(reg.pairs[0].b, 1);
  assert.ok(reg.pairs[0].applied);
  assert.ok(reg.pairs[0].n >= 40);
});

test('registration: chunks without a mutual covered overlap inherit the reference offset', () => {
  const { a, b } = groundPair();
  b.coverage.fill(0); // chunk b saw no tiles in the overlap
  const reg = registerChunkGrounds([a, b]);
  assert.equal(reg.offsets[1], 0);
  assert.equal(reg.pairs[0].applied, false);
});
