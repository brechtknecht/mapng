import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkRoute,
  polylineLengthMeters,
  squareBounds,
  haversineMeters,
  getCorridorTier,
  resolveChunkSizeM,
  routeOverlapM,
} from '../services/routeCorridor.js';

// Build a straight west→east polyline of given length (m) at a latitude.
function straightRoute(lengthM, lat = 48.137, lng0 = 11.575, steps = 50) {
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const totalDegLng = lengthM / mPerDegLng;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    pts.push({ lat, lng: lng0 + (totalDegLng * i) / steps });
  }
  return pts;
}

// Build a 45° diagonal (NE-bound) polyline of given length — the worst case for
// axis-aligned boxes stepped along the route.
function diagonalRoute(lengthM, lat0 = 48.10, lng0 = 11.55, steps = 80) {
  const compM = lengthM / Math.SQRT2; // per-axis ground distance
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    pts.push({ lat: lat0 + (compM * f) / mPerDegLat, lng: lng0 + (compM * f) / mPerDegLng });
  }
  return pts;
}

const inBounds = (p, b) =>
  p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;

test('returns [] for empty or single-point input', () => {
  assert.deepEqual(chunkRoute([], 'standard'), []);
  assert.deepEqual(chunkRoute([{ lat: 1, lng: 1 }], 'standard'), []);
});

test('resolveChunkSizeM: falls back to the tier default, clamps to fit the corridor', () => {
  // No / invalid override → tier default.
  assert.equal(resolveChunkSizeM('standard', null), getCorridorTier('standard').chunkSizeM);
  assert.equal(resolveChunkSizeM('standard', 0), 1024);
  assert.equal(resolveChunkSizeM('fine', NaN), 2048);
  // Valid override decouples from the tier.
  assert.equal(resolveChunkSizeM('standard', 4096), 4096);
  assert.equal(resolveChunkSizeM('draft', 512), 512);
  // Too small to contain the corridor → floored at 2× half-width.
  assert.equal(resolveChunkSizeM('ultra', 512), 1000); // ultra half-width 500 → min 1000
});

test('chunkRoute honours the chunk-size override (smaller box → more chunks)', () => {
  const route = straightRoute(5000);
  const dflt = chunkRoute(route, 'standard');            // 1024 m boxes
  const big = chunkRoute(route, 'standard', 4096);       // 4096 m boxes
  const small = chunkRoute(route, 'standard', 512);      // 512 m boxes
  assert.ok(big.length < dflt.length, `${big.length} !< ${dflt.length}`);
  assert.ok(small.length > dflt.length, `${small.length} !> ${dflt.length}`);
  // The override sets the actual box extent.
  const c = big[0];
  const widthM = (c.bounds.east - c.bounds.west) * 111320 * Math.cos((c.center.lat * Math.PI) / 180);
  assert.ok(Math.abs(widthM - 4096) < 5, `box width ${widthM} ≉ 4096`);
});

test('a diagonal route is fully covered and not over-chunked', () => {
  const route = diagonalRoute(6000);
  const chunks = chunkRoute(route, 'standard'); // 1024 m boxes
  // every vertex covered (no centerline gap on the 45° worst case)
  for (const p of route) {
    assert.ok(chunks.some((c) => inBounds(p, c.bounds)), `vertex ${p.lat},${p.lng} uncovered`);
  }
  // A 6 km diagonal needs ~ length / (chunkSize - overlap) boxes, NOT the
  // length / (per-axis step) the old arc-length method produced. Sanity-cap it.
  assert.ok(chunks.length <= 9, `expected a lean diagonal chain, got ${chunks.length}`);
});

test('a hairpin does not spawn near-coincident boxes', () => {
  // Out 1.2 km then back almost on top of itself — fits within ~one 2048 box.
  const out = straightRoute(1200, 48.2, 11.6, 24);
  const back = out.slice().reverse().map((p) => ({ lat: p.lat + 0.0002, lng: p.lng }));
  const chunks = chunkRoute([...out, ...back], 'fine'); // 2048 m boxes
  // 2.4 km of arc folded into a ~1.2 km footprint → only a couple of boxes,
  // not the ~3+ the arc-length stepping would have dropped on top of each other.
  assert.ok(chunks.length <= 2, `hairpin over-chunked: ${chunks.length} boxes`);
  for (const p of [...out, ...back]) {
    assert.ok(chunks.some((c) => inBounds(p, c.bounds)), 'hairpin vertex uncovered');
  }
});

test('a route shorter than one chunk yields a single centred chunk', () => {
  const route = straightRoute(200); // 200 m, well under 1024 m chunk
  const chunks = chunkRoute(route, 'standard');
  assert.equal(chunks.length, 1);
  assert.ok(inBounds(chunks[0].center, chunks[0].bounds));
  assert.ok(chunks[0].segment.length > 0);
});

test('a long route is covered by the union of chunk boxes', () => {
  const route = straightRoute(5000); // 5 km
  const chunks = chunkRoute(route, 'standard');
  assert.ok(chunks.length >= 4, `expected several chunks, got ${chunks.length}`);

  // every polyline vertex lands in at least one chunk box (full coverage)
  for (const p of route) {
    assert.ok(
      chunks.some((c) => inBounds(p, c.bounds)),
      `point ${p.lng} not covered by any chunk`
    );
  }

  // first chunk near the start, last near the end
  assert.ok(haversineMeters(chunks[0].center, route[0]) < 1024);
  assert.ok(haversineMeters(chunks.at(-1).center, route.at(-1)) < 1024);
});

test('consecutive chunks step by chunkSize minus the coverage-aware overlap (straight axis route)', () => {
  const route = straightRoute(8000);
  const tier = getCorridorTier('standard');
  const chunks = chunkRoute(route, 'standard');
  const expectedStep = tier.chunkSizeM - routeOverlapM(tier.chunkSizeM, tier.halfWidthM);
  // interior gaps (skip the final clamped-to-end chunk)
  for (let i = 1; i < chunks.length - 1; i++) {
    const gap = haversineMeters(chunks[i - 1].center, chunks[i].center);
    assert.ok(
      Math.abs(gap - expectedStep) < expectedStep * 0.1,
      `gap ${gap.toFixed(0)} != ~${expectedStep.toFixed(0)}`
    );
  }
});

test('squareBounds produces an ~square box of the requested size', () => {
  const c = { lat: 48.137, lng: 11.575 };
  const b = squareBounds(c, 1000);
  const widthM = haversineMeters({ lat: c.lat, lng: b.west }, { lat: c.lat, lng: b.east });
  const heightM = haversineMeters({ lat: b.south, lng: c.lng }, { lat: b.north, lng: c.lng });
  assert.ok(Math.abs(widthM - 1000) < 5, `width ${widthM}`);
  assert.ok(Math.abs(heightM - 1000) < 5, `height ${heightM}`);
});

test('polylineLengthMeters matches a known straight length', () => {
  const route = straightRoute(3000);
  assert.ok(Math.abs(polylineLengthMeters(route) - 3000) < 5);
});
