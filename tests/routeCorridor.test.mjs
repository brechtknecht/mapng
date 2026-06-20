import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkRoute,
  polylineLengthMeters,
  squareBounds,
  haversineMeters,
  getCorridorTier,
  CHUNK_OVERLAP,
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

const inBounds = (p, b) =>
  p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;

test('returns [] for empty or single-point input', () => {
  assert.deepEqual(chunkRoute([], 'standard'), []);
  assert.deepEqual(chunkRoute([{ lat: 1, lng: 1 }], 'standard'), []);
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

test('consecutive chunks step by ~chunkSize*(1-overlap)', () => {
  const route = straightRoute(8000);
  const tier = getCorridorTier('standard');
  const chunks = chunkRoute(route, 'standard');
  const expectedStep = tier.chunkSizeM * (1 - CHUNK_OVERLAP);
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
