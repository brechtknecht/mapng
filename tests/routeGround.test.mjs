import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositeRouteGround } from '@mapng/route/routeTerrainComposite';

const LAT = 48.1, LNG = 11.6;
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// A flat combined DEM: `h` everywhere over a square box of side `sizeM` metres.
function fakeCombined(h, sizeM = 1000, N = 96) {
  const halfLat = (sizeM / 2) / M_PER_DEG_LAT;
  const halfLng = (sizeM / 2) / mPerDegLng(LAT);
  return {
    bounds: { north: LAT + halfLat, south: LAT - halfLat, east: LNG + halfLng, west: LNG - halfLng },
    width: N, height: N,
    heightMap: new Float32Array(N * N).fill(h),
    minHeight: h, maxHeight: h,
    metersPerPixel: sizeM / N,
  };
}

// An extracted ground: constant abs height `h` over a `sizeM` box centred at
// (lat,lng), `cov` per-cell coverage (number → uniform, or pass a builder).
function fakeGround(lat, lng, h, sizeM, { px = 64, cov = 1, covType = Float32Array } = {}) {
  const halfLat = (sizeM / 2) / M_PER_DEG_LAT;
  const halfLng = (sizeM / 2) / mPerDegLng(lat);
  const coverage = cov == null ? null : new covType(px * px).fill(cov);
  return {
    bounds: { north: lat + halfLat, south: lat - halfLat, east: lng + halfLng, west: lng - halfLng },
    width: px, height: px,
    heightMap: new Float32Array(px * px).fill(h),
    minHeight: h, maxHeight: h,
    coverage,
  };
}

// combined grid index nearest a lat/lng.
function idxAt(c, lat, lng) {
  const gx = Math.round((lng - c.bounds.west) / (c.bounds.east - c.bounds.west) * (c.width - 1));
  const gy = Math.round((c.bounds.north - lat) / (c.bounds.north - c.bounds.south) * (c.height - 1));
  return gy * c.width + gx;
}

test('empty grounds → DEM unchanged', () => {
  const combined = fakeCombined(100);
  const out = compositeRouteGround([], combined, { featherM: 0 });
  assert.equal(out.coverage, 0);
  assert.ok(out.heightMap.every((v) => Math.abs(v - 100) < 1e-6));
});

test('covered corridor takes the ground; off-corridor keeps the DEM', () => {
  const combined = fakeCombined(100);
  const ground = fakeGround(LAT, LNG, 105, 400); // central 400m strip, fully covered
  const out = compositeRouteGround([ground], combined, { featherM: 0 });

  // centre of the ground bbox → ground height
  assert.ok(Math.abs(out.heightMap[idxAt(combined, LAT, LNG)] - 105) < 1e-2, 'centre should be ground 105');
  // a corner of the combined box, far outside the ground → DEM
  const corner = out.heightMap[idxAt(combined, combined.bounds.south + 1e-4, combined.bounds.west + 1e-4)];
  assert.ok(Math.abs(corner - 100) < 1e-2, `corner should be DEM 100, got ${corner}`);
  // no value escapes the [DEM, ground] envelope
  assert.ok(out.heightMap.every((v) => v >= 100 - 1e-3 && v <= 105 + 1e-3));
  assert.ok(out.groundMax <= 105 + 1e-3 && out.groundMax >= 105 - 1e-2);
});

test('overlap blends by coverage-weighted average', () => {
  const combined = fakeCombined(100);
  // two grounds overlapping in the middle, heights 105 and 109, equal coverage
  const a = fakeGround(LAT, LNG - 0.0015, 105, 500);
  const b = fakeGround(LAT, LNG + 0.0015, 109, 500);
  const out = compositeRouteGround([a, b], combined, { featherM: 0 });
  // dead centre lies in both bboxes → average 107
  const v = out.heightMap[idxAt(combined, LAT, LNG)];
  assert.ok(Math.abs(v - 107) < 0.5, `overlap should average to ~107, got ${v}`);
});

test('corridor edge feathers ground→DEM with no cliff', () => {
  const combined = fakeCombined(100, 1000, 128);
  const ground = fakeGround(LAT, LNG, 110, 300);
  const featherM = 60; // ~7-8 cells at this resolution
  const out = compositeRouteGround([ground], combined, { featherM });

  // walk a row eastward from centre to the box edge; collect samples
  const gyC = Math.round((combined.bounds.north - LAT) / (combined.bounds.north - combined.bounds.south) * (combined.height - 1));
  const row = [];
  for (let gx = 0; gx < combined.width; gx++) row.push(out.heightMap[gyC * combined.width + gx]);
  const half = Math.floor(combined.width / 2);
  const tail = row.slice(half); // centre → east edge, should be non-increasing 110→100

  // monotonic (within fp noise) and bounded
  for (let i = 1; i < tail.length; i++) {
    assert.ok(tail[i] <= tail[i - 1] + 1e-3, `not monotone at ${i}: ${tail[i - 1]}→${tail[i]}`);
  }
  // a real ramp exists: at least one cell strictly between DEM and ground (not a cliff)
  const between = tail.filter((v) => v > 100.5 && v < 109.5).length;
  assert.ok(between >= 3, `expected a feather band, got ${between} intermediate cells`);
  // ends meet the two surfaces
  assert.ok(Math.abs(tail[0] - 110) < 0.5, `centre ${tail[0]}`);
  assert.ok(Math.abs(tail[tail.length - 1] - 100) < 0.5, `edge ${tail[tail.length - 1]}`);
});

test('accepts a 0/255 Uint8 coverage mask', () => {
  const combined = fakeCombined(100);
  const ground = fakeGround(LAT, LNG, 105, 400, { cov: 255, covType: Uint8Array });
  const out = compositeRouteGround([ground], combined, { featherM: 0 });
  assert.ok(Math.abs(out.heightMap[idxAt(combined, LAT, LNG)] - 105) < 1e-2);
});

test('missing coverage ⇒ fully covered over the bbox', () => {
  const combined = fakeCombined(100);
  const ground = fakeGround(LAT, LNG, 105, 400, { cov: null });
  const out = compositeRouteGround([ground], combined, { featherM: 0 });
  assert.ok(Math.abs(out.heightMap[idxAt(combined, LAT, LNG)] - 105) < 1e-2);
});
