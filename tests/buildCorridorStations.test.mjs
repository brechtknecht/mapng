// Unit tests for buildCorridorStations — the route-corridor station builder
// that replaces buildSweepStations' box-covering obliques + grid in route mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCorridorStations } from '@mapng/bake/googleBakeCore';

// Minimal frame stub: a flat ENU basis centred at (0,0). horiz(e,n) just maps
// to a vector so we can count/inspect stations without a real ellipsoid.
const makeParams = (over = {}) => ({
  centerLat: 0,
  centerLng: 0,
  metersPerDegree: 111320, // cos(0) === 1
  extentM: 1024,
  horiz: (e, n) => new THREE.Vector3(e, 0, n),
  upDir: new THREE.Vector3(0, 1, 0),
  groundAltAt: () => 0,
  halfWidthM: 150,
  ...over,
});

// A straight eastbound segment ~556 m long, vertices every ~111 m.
const straightSegment = () =>
  [0, 0.001, 0.002, 0.003, 0.004, 0.005].map((lng) => ({ lat: 0, lng }));

test('degenerate segment (<2 points) yields no stations', () => {
  assert.deepEqual(buildCorridorStations([], makeParams()), []);
  assert.deepEqual(buildCorridorStations([{ lat: 0, lng: 0 }], makeParams()), []);
});

test('tight corridor (ringCount 0) places one on-route station per sample', () => {
  // spacing 110, carry 55 → samples at 55,165,275,385,495 m → 5 samples.
  const stations = buildCorridorStations(straightSegment(), makeParams({ halfWidthM: 50 }));
  assert.equal(stations.length, 5);
  assert.ok(stations.every((s) => s.viz.kind === 'road'));
  assert.ok(stations.every((s) => /^corridor-\d+$/.test(s.label)));
});

test('wide corridor adds lateral rings on both sides', () => {
  // halfWidth 500 → ringCount = round(500/160) = 3 → 1 + 2*3 = 7 per sample.
  const stations = buildCorridorStations(straightSegment(), makeParams({ halfWidthM: 500 }));
  assert.equal(stations.length, 5 * 7);
  assert.ok(stations.some((s) => /-L\d$/.test(s.label)));
  assert.ok(stations.some((s) => /-R\d$/.test(s.label)));
});

test('lateral stations outside the AOI box are dropped', () => {
  // Centred segment (e ∈ [-278, +278]) so every on-route sample stays inside a
  // half = 256 m box; the wide corridor's ring offsets are 142/283/425 m, so
  // only ring 1 (±142) survives → per sample on-route + 2 ring-1 = 3.
  const centred = [-0.0025, -0.0015, -0.0005, 0.0005, 0.0015, 0.0025]
    .map((lng) => ({ lat: 0, lng }));
  const stations = buildCorridorStations(
    centred,
    makeParams({ halfWidthM: 500, extentM: 512 }),
  );
  assert.equal(stations.length, 5 * 3);
});

test('stations carry a usable offset/target derived from groundAltAt', () => {
  const stations = buildCorridorStations(straightSegment(), makeParams({
    halfWidthM: 50,
    groundAltAt: () => 10,
    altitudeM: 30,
  }));
  // offset = horiz(e,n) + up*(ground + altitude) → y === 40.
  assert.ok(stations.every((s) => s.offset.y === 40));
  // target sits at ground (y === 10), aimed down-route.
  assert.ok(stations.every((s) => s.target.y === 10));
});
