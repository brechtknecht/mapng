import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRouteFrame } from '@mapng/route/routeStitch';
import { haversineMeters } from '@mapng/route/routeCorridor';

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const upm = 100 / 1024; // ~0.0977, a typical 1024 m chunk

// helper: a point `eastM` east and `northM` north of a base
function offsetPoint(base, eastM, northM) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(base.lat * DEG);
  return { lat: base.lat + northM / M_PER_DEG_LAT, lng: base.lng + eastM / mPerDegLng };
}

test('empty input yields an empty frame', () => {
  const f = computeRouteFrame([], 1024);
  assert.equal(f.anchor, null);
  assert.deepEqual(f.placements, []);
});

test('first chunk is the anchor at the origin', () => {
  const base = { lat: 48.0, lng: 11.0 };
  const f = computeRouteFrame([{ center: base, unitsPerMeter: upm }], 1024);
  assert.equal(f.anchor.lat, base.lat);
  assert.equal(f.anchor.lng, base.lng);
  const t = f.placements[0].translationM;
  assert.equal(t.x, 0);
  assert.equal(t.y, 0);
  assert.equal(t.z, 0); // assert.equal uses ==, so -0 == 0 passes (and it serializes as 0)
  assert.equal(f.placements[0].offsetEastM, 0);
  assert.equal(f.placements[0].offsetNorthM, 0);
});

test('east → +X, north → -Z, with correct magnitudes', () => {
  const base = { lat: 48.0, lng: 11.0 };
  const east = offsetPoint(base, 1000, 0);
  const north = offsetPoint(base, 0, 1000);
  const f = computeRouteFrame(
    [
      { center: base, unitsPerMeter: upm },
      { center: east, unitsPerMeter: upm },
      { center: north, unitsPerMeter: upm },
    ],
    1024,
  );
  // east chunk
  assert.ok(Math.abs(f.placements[1].translationM.x - 1000) < 1, `x=${f.placements[1].translationM.x}`);
  assert.ok(Math.abs(f.placements[1].translationM.z) < 1);
  // north chunk → negative Z
  assert.ok(Math.abs(f.placements[2].translationM.z + 1000) < 1, `z=${f.placements[2].translationM.z}`);
  assert.ok(Math.abs(f.placements[2].translationM.x) < 1);
});

test('uniform scale is 1/unitsPerMeter', () => {
  const f = computeRouteFrame([{ center: { lat: 48, lng: 11 }, unitsPerMeter: upm }], 1024);
  assert.ok(Math.abs(f.placements[0].scale - 1 / upm) < 1e-9);
});

test('placement distance matches geographic distance between centers', () => {
  const base = { lat: 48.0, lng: 11.0 };
  const c1 = offsetPoint(base, 700, 500);
  const f = computeRouteFrame([{ center: base, unitsPerMeter: upm }, { center: c1, unitsPerMeter: upm }], 1024);
  const t = f.placements[1].translationM;
  const placedDist = Math.hypot(t.x, t.z);
  const geoDist = haversineMeters(base, c1);
  assert.ok(Math.abs(placedDist - geoDist) < 2, `placed ${placedDist} vs geo ${geoDist}`);
});

test('minHeight lifts chunks to absolute elevation, anchored at the first', () => {
  const base = { lat: 48.0, lng: 11.0 };
  const f = computeRouteFrame(
    [
      { center: base, unitsPerMeter: upm, minHeight: 500 },
      { center: offsetPoint(base, 1000, 0), unitsPerMeter: upm, minHeight: 530 },
    ],
    1024,
  );
  assert.equal(f.placements[0].translationM.y, 0); // anchor at 0
  assert.ok(Math.abs(f.placements[1].translationM.y - 30) < 1e-9, `y=${f.placements[1].translationM.y}`);
});

test('world bounds include the box half-extent around every chunk', () => {
  const base = { lat: 48.0, lng: 11.0 };
  const east = offsetPoint(base, 2000, 0);
  const f = computeRouteFrame(
    [{ center: base, unitsPerMeter: upm }, { center: east, unitsPerMeter: upm }],
    1024,
  );
  assert.ok(Math.abs(f.worldBoundsM.minX + 512) < 1, `minX=${f.worldBoundsM.minX}`);
  assert.ok(Math.abs(f.worldBoundsM.maxX - (2000 + 512)) < 1, `maxX=${f.worldBoundsM.maxX}`);
  assert.ok(Math.abs(f.worldBoundsM.widthM - (2000 + 1024)) < 1);
});
