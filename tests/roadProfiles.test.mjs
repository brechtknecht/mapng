import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadProfiles, carveRoadProfiles } from '@mapng/bake/roadProfiles';

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
// unless a column range is punched out. Optional rawColH fills rawMinHeightMap
// (the unfiltered per-cell min the profiles prefer).
const groundStub = (colH, uncoveredCols = null, rawColH = null) => {
  const heightMap = new Float32Array(N * N);
  const coveredMask = new Uint8Array(N * N).fill(1);
  const rawMinHeightMap = rawColH ? new Float32Array(N * N) : null;
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      heightMap[row * N + col] = colH(col);
      if (rawMinHeightMap) rawMinHeightMap[row * N + col] = rawColH(col);
      if (uncoveredCols && col >= uncoveredCols[0] && col <= uncoveredCols[1]) {
        coveredMask[row * N + col] = 0;
      }
    }
  }
  return rawMinHeightMap ? { heightMap, coveredMask, rawMinHeightMap } : { heightMap, coveredMask };
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
  ], DATA, g);
  assert.equal(prof.roads.length, 2);
  const [bridge, tunnel] = prof.roads;
  assert.ok(bridge.throughStructure && !bridge.resolved, 'bridge: structure, no trusted anchors');
  assert.ok(tunnel.throughStructure && !tunnel.resolved, 'tunnel: structure, no trusted anchors');
  assert.equal(prof.stats.resolved, 0);
  // A plain road AWAY from any structure footprint resolves normally. (A road
  // coincident with a bridge would rightly be demoted — the deck covers it.)
  const plain = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g).roads[0];
  assert.ok(!plain.throughStructure && plain.resolved, 'plain road resolves normally');
});

test('profile reads the RAW min, not the pit-filled filtered ground (covered underpass)', () => {
  // The Area-1 failure mode: the pit-lift fills the underpass dip INSIDE
  // covered cells — filtered ground flat at 45, but the raw per-cell min still
  // descends to 40. The profile must follow the raw dip; carving it then
  // restores the underpass the filters erased.
  const dip = (col) => {
    if (col < 70 || col > 130) return 45;
    const t = 1 - Math.abs(col - 100) / 30; // V down to 40 at col 100
    return 45 - 5 * t;
  };
  const g = groundStub(() => 45, null, dip);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  const r = prof.roads[0];
  const mid = r.pts.reduce((best, p) => (Math.abs(p.s - r.lengthM / 2) < Math.abs(best.s - r.lengthM / 2) ? p : best));
  assert.ok(mid.h < 42.5, `profile descends into the raw dip, got ${mid.h.toFixed(2)} at mid`);

  carveRoadProfiles(prof, DATA, g);
  const centre = g.heightMap[cellIdx(0, 0)];
  assert.ok(centre < 42.5, `carve restores the dip in the filtered ground, got ${centre.toFixed(2)}`);
});

test('under a bridge footprint the deck reading is demoted — profile goes THROUGH', () => {
  // Underpass anatomy: the road descends (ramps trusted), but under the deck
  // the band gate removed the real road and the raw min reads the DECK at
  // surface level (45). A north–south bridge way crosses at the centre; its
  // footprint must demote those samples so the bottom interpolates between the
  // ramp ends instead of climbing onto the deck.
  const rampAndDeck = (col) => {
    if (col < 70 || col > 130) return 45;            // surface streets
    if (col >= 92 && col <= 108) return 45;          // DECK reading (band-gated road)
    const t = 1 - Math.abs(col - 100) / 30;          // ramps descending toward 40
    return 45 - 5 * t;
  };
  const bridge = {
    type: 'road',
    tags: { highway: 'secondary', bridge: 'yes' },
    // North–south way crossing the E–W road at its midpoint (lng = 100 m).
    geometry: [
      { lat: 20 / 111320, lng: 100 / 111320 },
      { lat: 180 / 111320, lng: 100 / 111320 },
    ],
  };
  const g = groundStub(() => 45, null, rampAndDeck);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' }), bridge], DATA, g);
  const road = prof.roads.find((r) => !r.throughStructure);
  const mid = road.pts.reduce((best, p) => (Math.abs(p.s - road.lengthM / 2) < Math.abs(best.s - road.lengthM / 2) ? p : best));
  assert.ok(mid.h < 42.5, `profile passes under the deck (got ${mid.h.toFixed(2)} at mid — deck would be ~45)`);
  assert.ok(prof.stats.maxUntrustedGapM >= 15, `deck span was bridged (gap ${prof.stats.maxUntrustedGapM}m)`);
});

test('structure-bottom junk in the raw min is rejected, not followed (bridge abutment)', () => {
  // A 10m-deep junk trench (wall bottoms) crossing the road over ~3 columns —
  // survives cross-median taps (same columns), must die to outlier rejection.
  const junk = (col) => (col >= 99 && col <= 101 ? 30 : 40);
  const g = groundStub(() => 40, null, junk);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  const r = prof.roads[0];
  for (const p of r.pts) {
    assert.ok(p.h > 38.5, `profile never follows the junk trench (s=${p.s.toFixed(0)}), got ${p.h.toFixed(2)}`);
  }
});

test('profile grades are clamped to a physical ceiling', () => {
  // A 12m raw step (two structure levels misread as one road) — after the
  // limiter no grade may exceed ~maxGradePct.
  const step = (col) => (col < 100 ? 40 : 52);
  const g = groundStub(() => 40, null, step);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  assert.ok(prof.stats.maxGradePct <= 26, `grade capped at ~25%, got ${prof.stats.maxGradePct}%`);
});

test('a near-duplicate endpoint sample cannot report an absurd grade', () => {
  // The resampler appends the true endpoint even sub-mm past the last regular
  // sample; the grade stat must use the limiter's 1cm spacing floor instead of
  // dividing a limiter-approved (~mm) step by the sub-mm true ds.
  const road = {
    type: 'road',
    tags: { highway: 'primary' },
    geometry: [
      { lat: C_LAT, lng: 5 / 111320 },
      { lat: C_LAT, lng: 195.0004 / 111320 }, // 0.4mm past the last 5m sample
    ],
  };
  const g = groundStub((col) => 40 + col * 0.1); // uniform 10% grade
  const prof = buildRoadProfiles([road], DATA, g);
  assert.ok(prof.stats.maxGradePct <= 26,
    `grade stat capped at the physical ceiling, got ${prof.stats.maxGradePct}%`);
});

test('stats carry worst-road diagnostics with scene positions', () => {
  const g = groundStub(() => 42);
  const prof = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, g);
  const wt = prof.stats.worstTrust;
  assert.ok(wt && wt.highway === 'residential' && wt.pct > 90, 'least-trusted road reported');
  assert.ok(Number.isFinite(wt.x) && Number.isFinite(wt.z), 'position is scene coords');
});

test('bridge profiles stitch between abutment anchors of resolved roads', () => {
  // Short bridge crossing the resolved E–W road: both endpoints within the
  // 15m join radius of resolved samples → stitched flat at the road height.
  const bridge = {
    type: 'road',
    tags: { highway: 'secondary', bridge: 'yes' },
    geometry: [
      { lat: 90 / 111320, lng: 60 / 111320 },
      { lat: 110 / 111320, lng: 60 / 111320 },
    ],
  };
  const g = groundStub(() => 45);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' }), bridge], DATA, g);
  const b = prof.roads.find((r) => r.throughStructure);
  assert.ok(b.stitched && b.resolved, 'bridge stitched from abutment anchors');
  for (const p of b.pts) assert.ok(Math.abs(p.h - 45) < 0.2, `deck line at road height, got ${p.h.toFixed(2)}`);
  assert.equal(prof.stats.stitched, 1);
});

test('roadFilter stamps stitched decks into a transient deck floor', () => {
  const g = groundStub(() => 45);
  g.coveredMask.fill(0);
  const st = carveRoadProfiles(profileAt(52, { throughStructure: true }), DATA, g, {
    roadFilter: (r) => r.throughStructure && r.resolved,
    featherM: 2,
  });
  assert.ok(st.carvedCells > 0, 'deck stamped');
  assert.ok(Math.abs(g.heightMap[cellIdx(0, 0)] - 52) < 0.1,
    `deck floor at profile height, got ${g.heightMap[cellIdx(0, 0)]}`);
  assert.equal(g.coveredMask[cellIdx(0, 0)], 1, 'deck cells trusted for the snap');
});

// ── carve ────────────────────────────────────────────────────────────────────
// A hand-built profile along z=0 (scene x −40..40 = 160 m), constant height.
const profileAt = (h, flags = {}) => ({
  roads: [{
    resolved: true, throughStructure: false, halfWidthM: 4, ...flags,
    pts: [{ x: -40, z: 0, s: 0, h }, { x: 40, z: 0, s: 160, h }],
  }],
});
const cellIdx = (sx, sz) => {
  const col = Math.round(((sx + 50) / 100) * (N - 1));
  const row = Math.round(((sz + 50) / 100) * (N - 1));
  return row * N + col;
};

test('carve pulls the corridor onto the profile (underpass restored), off-road untouched', () => {
  // The pit-lift/band-gate failure mode: real road at 40, but the extracted
  // ground filled the dip at 45. The profile knows better — carve restores it.
  const g = groundStub(() => 45);
  g.coveredMask.fill(0); // even a fully-untrusted floor gets the carved corridor
  const st = carveRoadProfiles(profileAt(40), DATA, g);

  assert.ok(st.carvedCells > 0, 'cells were carved');
  assert.ok(Math.abs(g.heightMap[cellIdx(0, 0)] - 40) < 0.1,
    `centreline at profile height, got ${g.heightMap[cellIdx(0, 0)]}`);
  assert.equal(g.heightMap[cellIdx(0, 15)], 45, 'off-road (30m out) untouched');
  const feather = g.heightMap[cellIdx(0, 2.75)]; // ~5.5m out: inside the 4..7m blend band
  assert.ok(feather > 40.5 && feather < 44.5, `feather blends, got ${feather}`);
  assert.equal(g.coveredMask[cellIdx(0, 0)], 1, 'carriageway cells become trusted for the snap');
  assert.equal(g.coveredMask[cellIdx(0, 15)], 0, 'off-road trust untouched');
});

test('bridges/tunnels and unresolved roads never carve', () => {
  const g1 = groundStub(() => 45);
  const s1 = carveRoadProfiles(profileAt(40, { throughStructure: true }), DATA, g1);
  assert.equal(s1.carvedCells, 0);
  assert.equal(g1.heightMap[cellIdx(0, 0)], 45);

  const g2 = groundStub(() => 45);
  const s2 = carveRoadProfiles(profileAt(40, { resolved: false }), DATA, g2);
  assert.equal(s2.carvedCells, 0);
});

test('carve shift is clamped to maxCarveM', () => {
  const g = groundStub(() => 60); // 20m above the profile — clearly bogus
  carveRoadProfiles(profileAt(40), DATA, g, { maxCarveM: 10 });
  assert.ok(Math.abs(g.heightMap[cellIdx(0, 0)] - 50) < 0.1,
    `shift capped at 10m, got ${g.heightMap[cellIdx(0, 0)]}`);
});

test('crossing roads with disagreeing profiles blend at the junction — no stepped patchwork', () => {
  // Road A (E–W, 40m) was gap-bridged too low; road B (N–S, 44m) is trusted.
  // Max-weight-wins carved a 4m step at A's corridor edge (weight noise picked
  // a different winner per cell); the blend must ramp one into the other.
  const g = groundStub(() => 45);
  g.coveredMask.fill(0);
  carveRoadProfiles({
    roads: [
      { resolved: true, throughStructure: false, halfWidthM: 4,
        pts: [{ x: -40, z: 0, s: 0, h: 40 }, { x: 40, z: 0, s: 160, h: 40 }] },
      { resolved: true, throughStructure: false, halfWidthM: 4,
        pts: [{ x: 0, z: -40, s: 0, h: 44 }, { x: 0, z: 40, s: 160, h: 44 }] },
    ],
  }, DATA, g);
  const centre = g.heightMap[cellIdx(0, 0)];
  assert.ok(Math.abs(centre - 42) < 0.3, `junction blends to the midpoint, got ${centre.toFixed(2)}`);
  // Walk the N–S carriageway away from the junction: 42 → 44 must ramp across
  // A's corridor+feather without a hard cell-to-cell step.
  let prev = centre, maxStep = 0;
  for (let z = 0.5; z <= 16; z += 0.5) {
    const h = g.heightMap[cellIdx(0, z)];
    maxStep = Math.max(maxStep, Math.abs(h - prev));
    prev = h;
  }
  // The 4m disagreement now spreads across A's carriageway+feather; the
  // steepest per-cell step sits mid-feather (~1m/cell for a 3m feather) —
  // max-wins put the whole 4m into ONE cell edge.
  assert.ok(maxStep < 1.5, `no stepped patchwork along the crossing road, got ${maxStep.toFixed(2)}m step`);
  assert.ok(Math.abs(prev - 44) < 0.1, `clear of the junction B owns its height, got ${prev.toFixed(2)}`);
});

test('a held (untrusted) road end tapers out of the carve instead of stamping a shelf', () => {
  // Coverage ends at col 150; beyond it the floor is DEM fallback 5m higher.
  // The profile HOLDS the last trusted height (40) through the uncovered end —
  // pure extrapolation, which must fade out instead of carving a 5m shelf.
  const g = groundStub((col) => (col >= 150 ? 45 : 40), [150, 199]);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  assert.ok(prof.roads[0].resolved);
  carveRoadProfiles(prof, DATA, g);
  const heldEnd = g.heightMap[cellIdx(40, 0)]; // ~30m past the last trusted sample
  assert.ok(heldEnd > 44.5, `held end left untouched, got ${heldEnd.toFixed(2)}`);
  const body = g.heightMap[cellIdx(0, 0)];
  assert.ok(Math.abs(body - 40) < 0.3, `trusted body still carves, got ${body.toFixed(2)}`);
});

test('interior bridged spans (underpasses) keep full carve strength despite the end taper', () => {
  // Same shape as the underpass test but run through the CARVE: the untrusted
  // middle is bracketed by trusted anchors, so it is interpolation, not a held
  // end — the taper must not touch it.
  const g = groundStub((col) => (col >= 85 && col <= 115 ? 45 : 40), [85, 115]);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  carveRoadProfiles(prof, DATA, g);
  const mid = g.heightMap[cellIdx(0, 0)]; // centre of the bridged span
  assert.ok(Math.abs(mid - 40) < 0.5, `bridged underpass fully carved, got ${mid.toFixed(2)}`);
});

test('non-drivable ways and empty input yield no profiles', () => {
  const g = groundStub(() => 40);
  assert.equal(buildRoadProfiles([roadFeature({ highway: 'footway' })], DATA, g), null);
  assert.equal(buildRoadProfiles([], DATA, g), null);
  assert.equal(buildRoadProfiles(null, DATA, g), null);
});
