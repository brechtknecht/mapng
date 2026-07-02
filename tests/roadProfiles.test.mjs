import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadProfiles } from '@mapng/bake/roadProfiles';

// 200 m AOI, 200×200 grid ⇒ 1 m/px, unitsPerMeter = 0.5 (mirrors groundMask.test).
const N = 200;
const DATA = {
  width: N,
  height: N,
  minHeight: 0,
  heightMap: new Float32Array(N * N), // DEM itself is unused by the profiles
  bounds: { south: 0, north: 200 / 111320, west: 0, east: 200 / 111320 },
};
const C_LAT = 100 / 111320; // centre latitude → scene Z ≈ 0

// A straight east–west road through the AOI centre (5 m .. 195 m).
const roadFeature = (tags) => ({
  type: 'road',
  tags,
  geometry: [
    { lat: C_LAT, lng: 5 / 111320 },
    { lat: C_LAT, lng: 195 / 111320 },
  ],
});

// Extracted-ground stub: heightMap from a per-column height fn, full coverage
// unless a column range is punched out.
const groundStub = (colH, uncoveredCols = null) => {
  const heightMap = new Float32Array(N * N);
  const coveredMask = new Uint8Array(N * N).fill(1);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      heightMap[row * N + col] = colH(col);
      if (uncoveredCols && col >= uncoveredCols[0] && col <= uncoveredCols[1]) {
        coveredMask[row * N + col] = 0;
      }
    }
  }
  return { heightMap, coveredMask };
};

test('flat trusted road → flat resolved profile in absolute metres', () => {
  const prof = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, groundStub(() => 42));
  assert.ok(prof, 'profile built');
  assert.equal(prof.roads.length, 1);
  const r = prof.roads[0];
  assert.ok(r.resolved, 'road resolved');
  assert.ok(r.trustedPct > 90, `mostly trusted, got ${r.trustedPct}%`);
  assert.ok(Math.abs(r.lengthM - 190) < 2, `length ~190m, got ${r.lengthM}`);
  for (const p of r.pts) assert.ok(Math.abs(p.h - 42) < 0.01, `flat at 42m, got ${p.h}`);
  assert.ok(prof.stats.maxGradePct < 0.1, `flat road has no grade, got ${prof.stats.maxGradePct}%`);
});

test('per-cell noise is smoothed along the road', () => {
  // ±0.8 m salt-and-pepper per column — the raw per-cell wobble signature.
  const noisy = groundStub((col) => 50 + (col % 2 === 0 ? 0.8 : -0.8));
  const prof = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, noisy);
  const r = prof.roads[0];
  // Ends are edge-clamped (median/gauss can't reach past them) so they keep more
  // noise; the interior is what the wheels ride.
  let maxDev = 0, maxDevEnds = 0;
  for (const p of r.pts) {
    const dev = Math.abs(p.h - 50);
    if (p.s > 15 && p.s < r.lengthM - 15) maxDev = Math.max(maxDev, dev);
    else maxDevEnds = Math.max(maxDevEnds, dev);
  }
  assert.ok(maxDev < 0.35, `1D smoothing tames the ±0.8m wobble, got interior max dev ${maxDev.toFixed(2)}m`);
  assert.ok(maxDevEnds < 0.8, `ends never exceed the raw noise, got ${maxDevEnds.toFixed(2)}m`);
});

test('untrusted span (underpass) is bridged ALONG the road, not read from the fallback floor', () => {
  // Floor: road level 40 everywhere, but the middle 30 m is DEM-fallback at 45
  // (the classic band-gated underpass) and marked uncovered.
  const g = groundStub((col) => (col >= 85 && col <= 115 ? 45 : 40), [85, 115]);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  const r = prof.roads[0];
  assert.ok(r.resolved);
  for (const p of r.pts) {
    assert.ok(Math.abs(p.h - 40) < 0.5,
      `profile stays at road level through the gap (s=${p.s.toFixed(0)}m), got ${p.h.toFixed(2)}`);
  }
  assert.ok(prof.stats.maxUntrustedGapM >= 25 && prof.stats.maxUntrustedGapM <= 45,
    `~30m gap reported, got ${prof.stats.maxUntrustedGapM}`);
});

test('bridge/tunnel ways are kept as throughStructure profiles, unresolved without anchors', () => {
  const g = groundStub(() => 40);
  const prof = buildRoadProfiles([
    roadFeature({ highway: 'primary', bridge: 'yes' }),
    roadFeature({ highway: 'primary', tunnel: 'yes' }),
    roadFeature({ highway: 'primary' }),
  ], DATA, g);
  assert.equal(prof.roads.length, 3);
  const [bridge, tunnel, plain] = prof.roads;
  assert.ok(bridge.throughStructure && !bridge.resolved, 'bridge: structure, no trusted anchors');
  assert.ok(tunnel.throughStructure && !tunnel.resolved, 'tunnel: structure, no trusted anchors');
  assert.ok(!plain.throughStructure && plain.resolved, 'plain road resolves normally');
  assert.equal(prof.stats.resolved, 1);
});

test('non-drivable ways and empty input yield no profiles', () => {
  const g = groundStub(() => 40);
  assert.equal(buildRoadProfiles([roadFeature({ highway: 'footway' })], DATA, g), null);
  assert.equal(buildRoadProfiles([], DATA, g), null);
  assert.equal(buildRoadProfiles(null, DATA, g), null);
});
