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

test('legacy solver: profile grades are clamped to a physical ceiling', () => {
  // A 12m raw step (two structure levels misread as one road) — after the
  // limiter no grade may exceed ~maxGradePct. (The whittaker solver has no
  // clamp: its curvature penalty spreads the step over the cutoff length.)
  const step = (col) => (col < 100 ? 40 : 52);
  const g = groundStub(() => 40, null, step);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g, { solver: 'legacy' });
  assert.ok(prof.stats.maxGradePct <= 26, `grade capped at ~25%, got ${prof.stats.maxGradePct}%`);
});

test('whittaker solver: a step in the raw min becomes a smooth ramp, not a kink', () => {
  const step = (col) => (col < 100 ? 40 : 52);
  const g = groundStub(() => 40, null, step);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  const r = prof.roads[0];
  assert.ok(prof.stats.maxGradePct < 45, `12 m step spread over the cutoff length, got ${prof.stats.maxGradePct}%`);
  // A curvature penalty rings slightly around a hard step; the ring must stay
  // far below anything a wheel feels (no dip deeper than 15 cm per sample).
  for (let i = 1; i < r.pts.length; i++) {
    assert.ok(r.pts[i].h >= r.pts[i - 1].h - 0.15, `no dip at ${r.pts[i].s}: ${r.pts[i - 1].h} → ${r.pts[i].h}`);
  }
  assert.ok(Math.abs(r.pts[0].h - 40) < 0.5 && Math.abs(r.pts[r.pts.length - 1].h - 52) < 0.5, 'levels reached at both ends');
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

test('an unobserved road end eases into the extracted ground instead of stamping a shelf', () => {
  // Coverage ends at col 150; beyond it the floor is DEM fallback 5m higher.
  // Legacy: the profile HOLDS the last trusted height and the carve tapers
  // out. Whittaker: the unobserved end relaxes to the extracted ground over
  // ~13 m and stamps at full strength — same outcome 30 m past coverage, no
  // 5 m shelf either way.
  const g = groundStub((col) => (col >= 150 ? 45 : 40), [150, 199]);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  assert.ok(prof.roads[0].resolved);
  carveRoadProfiles(prof, DATA, g);
  const heldEnd = g.heightMap[cellIdx(40, 0)]; // ~30m past the last trusted sample
  assert.ok(heldEnd > 44.5, `held end left untouched, got ${heldEnd.toFixed(2)}`);
  const body = g.heightMap[cellIdx(0, 0)];
  assert.ok(Math.abs(body - 40) < 0.3, `trusted body still carves, got ${body.toFixed(2)}`);
});

test('an unobserved road end is stamped but never reported as tile-covered', () => {
  // A chunk's corridor tail: the road runs on past coverage. The eased span
  // shapes the floor, but coveredMask must stay 0 there — a "covered" vote at
  // the tail would out-blend the neighbour chunk's observed road in the route
  // composite, and the terSnap must not seat the mesh on an eased floor.
  const g = groundStub((col) => (col >= 150 ? 45 : 40), [150, 199]);
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' })], DATA, g);
  assert.equal(prof.solver, 'whittaker');
  carveRoadProfiles(prof, DATA, g);
  assert.equal(g.coveredMask[cellIdx(0, 0)], 1, 'observed body is covered');
  assert.equal(g.coveredMask[cellIdx(38, 0)], 0, 'eased tail (col ~175, 25 m past coverage) stays uncovered');
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
  assert.equal(buildRoadProfiles([roadFeature({ highway: 'elevator' })], DATA, g), null,
    'an elevator is a shaft, not a road');
  assert.equal(buildRoadProfiles([roadFeature({ highway: 'construction' })], DATA, g), null);
  assert.equal(buildRoadProfiles([], DATA, g), null);
  assert.equal(buildRoadProfiles(null, DATA, g), null);
});

test('junction solve skips stacked geometry beyond the physical blend cap', () => {
  // Same crossing shape as the disagreement test but with a 20m gap — untagged
  // stacked geometry (parking deck over street). Easing 10m into each profile
  // over 25m of arc would exceed any physical grade: the solve must skip it,
  // while the step metric still reports it for the log.
  const heightMap = new Float32Array(N * N);
  const coveredMask = new Uint8Array(N * N).fill(1);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      heightMap[row * N + col] = (col >= 90 && col <= 110) ? 30 : 50;
      if (col >= 88 && col <= 112 && row >= 88 && row <= 112) coveredMask[row * N + col] = 0;
    }
  }
  const g = { heightMap, coveredMask };
  const ns = {
    type: 'road',
    tags: { highway: 'service' },
    geometry: [
      { lat: 5 / 111320, lng: 100 / 111320 },
      { lat: 195 / 111320, lng: 100 / 111320 },
    ],
  };
  const prof = buildRoadProfiles([roadFeature({ highway: 'primary' }), ns], DATA, g);
  const st = prof.stats;
  assert.equal(st.junctionClusters, 0, 'stacked crossing not "solved"');
  assert.equal(st.junctionMaxAdjM, 0, 'no correction applied');
  assert.ok(st.junctionStepMaxM > 10, `metric still reports it, got ${st.junctionStepMaxM}m`);
});

test('evenness telemetry: flat road scores ~zero roughness and no junction pairs', () => {
  const g = groundStub(() => 42);
  const prof = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, g);
  const st = prof.stats;
  assert.ok(st.roughnessRmsM < 0.005, `flat road is not wavy, got ${st.roughnessRmsM}m`);
  assert.equal(st.junctionPairs, 0, 'a single road has no cross-road pairs');
  assert.equal(st.junctionStepMaxM, 0);
  assert.equal(prof.roads[0].roughnessRmsM, prof.stats.roughnessRmsM);
});

test('junction step telemetry flags cross-road target disagreement', () => {
  // Ground: a 45m-deep column band inside a 50m plain. Coverage is punched out
  // in a box around the crossing, so BOTH roads bridge it — the EW road from
  // 50m plain to 50m plain (target ~50 over the crossing), the NS road along
  // the 45m band (target ~45). Same spot, ~5m of disagreement: exactly the
  // stepped-junction signature the carve blend can only ramp.
  const heightMap = new Float32Array(N * N);
  const coveredMask = new Uint8Array(N * N).fill(1);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      heightMap[row * N + col] = (col >= 90 && col <= 110) ? 45 : 50;
      if (col >= 88 && col <= 112 && row >= 88 && row <= 112) coveredMask[row * N + col] = 0;
    }
  }
  const g = { heightMap, coveredMask };
  const ns = {
    type: 'road',
    tags: { highway: 'primary' },
    geometry: [
      { lat: 5 / 111320, lng: 100 / 111320 },
      { lat: 195 / 111320, lng: 100 / 111320 },
    ],
  };
  // A: solve disabled — the raw ~5m disagreement is reported.
  const raw = buildRoadProfiles(
    [roadFeature({ highway: 'primary' }), ns], DATA, g, { junctionBlendM: 0 },
  );
  assert.ok(raw.roads.every((r) => r.resolved), 'both roads resolved');
  assert.ok(raw.stats.junctionPairs > 0, 'crossing detected');
  assert.ok(raw.stats.junctionStepMaxM > 3, `~5m disagreement reported, got ${raw.stats.junctionStepMaxM}m`);
  assert.ok(raw.stats.junctionStepMaxAt, 'worst junction is pinnable');
  assert.equal(raw.stats.junctionClusters, 0, 'solve off ⇒ no clusters');

  // B: joint solve on (default) — the two profiles agree at the crossing and
  // the residual step collapses; the correction eases in without new kinks.
  const solved = buildRoadProfiles([roadFeature({ highway: 'primary' }), ns], DATA, g);
  const st = solved.stats;
  assert.ok(st.junctionClusters > 0, 'junction clustered');
  assert.ok(st.junctionMaxAdjM > 1, `metres of correction applied, got ${st.junctionMaxAdjM}m`);
  assert.ok(st.junctionStepMaxM < 1,
    `solved step, got ${st.junctionStepMaxM}m (raw ${raw.stats.junctionStepMaxM}m)`);
  for (const r of solved.roads) {
    for (let i = 1; i < r.pts.length; i++) {
      const ds = Math.max(0.01, r.pts[i].s - r.pts[i - 1].s);
      const g2 = Math.abs(r.pts[i].h - r.pts[i - 1].h) / ds;
      assert.ok(g2 < 0.35, `no kink from the blend-in: grade ${(g2 * 100).toFixed(0)}% at s=${r.pts[i].s}`);
    }
  }
});

test('junction solve leaves parallel roads alone (no flattening of real grade)', () => {
  // Two E–W roads 4m apart, on a 5% west–east slope, seated 2m apart in height
  // (terrace street). The union-find chains their samples into one cluster for
  // the whole shared run — the parallel-run guard must reject it, or the
  // "consensus" would flatten both roads to one constant mean height.
  const heightMap = new Float32Array(N * N);
  const coveredMask = new Uint8Array(N * N).fill(1);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      heightMap[row * N + col] = col * 0.05 + (row < 100 ? 2 : 0);
    }
  }
  const g = { heightMap, coveredMask };
  const upper = {
    type: 'road',
    tags: { highway: 'residential' },
    geometry: [
      { lat: 98 / 111320, lng: 5 / 111320 },
      { lat: 98 / 111320, lng: 195 / 111320 },
    ],
  };
  const prof = buildRoadProfiles([roadFeature({ highway: 'residential' }), upper], DATA, g);
  assert.equal(prof.stats.junctionClusters, 0, 'parallel run rejected, no junction solved');
  for (const r of prof.roads) {
    const first = r.pts[0], last = r.pts[r.pts.length - 1];
    const rise = last.h - first.h;
    assert.ok(Math.abs(rise - 9.5) < 1, `5% grade preserved over 190m, got rise ${rise.toFixed(2)}m`);
  }
});

test('carve veto: a profile steeper than any road neither carves nor joins junctions', () => {
  // A "service" way that dives 1 m per metre from col 100 on — a garage ramp
  // read through the building above it. 100 % grade >> the 35 % veto.
  const ramp = groundStub((col) => (col < 100 ? 40 : 40 + (col - 100) * 1.0));
  const prof = buildRoadProfiles([roadFeature({ highway: 'service' })], DATA, ramp);
  const r = prof.roads[0];
  assert.ok(r.resolved, 'still resolved (kept for display/stats)');
  assert.ok(r.carveVeto && /grade/.test(r.carveVeto), `vetoed for grade, got ${r.carveVeto}`);
  assert.equal(prof.stats.vetoed, 1);
  assert.equal(prof.stats.vetoedRoads[0].highway, 'service');
  const cs = carveRoadProfiles(prof, DATA, ramp);
  assert.equal(cs.carvedCells, 0, 'a vetoed profile stamps nothing');
  // The same ground under a residential road is vetoed by grade as well — no
  // real road climbs 100 %.
  const res = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, ramp).roads[0];
  assert.ok(res.carveVeto, 'residential at 100 % grade is vetoed too');
  // A gentle 5 % slope is a road and carves.
  const gentle = groundStub((col) => 40 + col * 0.05);
  const ok = buildRoadProfiles([roadFeature({ highway: 'service' })], DATA, gentle);
  assert.equal(ok.roads[0].carveVeto, null);
  assert.ok(carveRoadProfiles(ok, DATA, gentle).carvedCells > 0);
});

test('carve veto: a mostly-interpolated service way is vetoed, an arterial road is not', () => {
  // Coverage punched out over 85 % of the road → trust ≈ 15 %.
  const sparse = groundStub(() => 42, [20, 180]);
  const svc = buildRoadProfiles([roadFeature({ highway: 'service' })], DATA, sparse).roads[0];
  assert.ok(svc.trustedPct < 25, `low trust, got ${svc.trustedPct}%`);
  assert.ok(svc.carveVeto && /trust/.test(svc.carveVeto), `service vetoed for trust, got ${svc.carveVeto}`);
  const res = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, sparse).roads[0];
  assert.equal(res.carveVeto, null, 'residential keeps carving on low trust (the route may run under trees)');
});

test('junction consensus: the higher-class road is the reference, the side road meets its grade', () => {
  // E–W road through the centre (roadFeature) crossing a N–S road at x≈0. The
  // ground reads 42 m everywhere except a 9-column band under the N–S road at
  // 44 m (a raised crossing / parked cars the side road profiled as its level).
  const ns = (tags) => ({ type: 'road', tags, geometry: [{ lat: 5 / 111320, lng: 100 / 111320 }, { lat: 195 / 111320, lng: 100 / 111320 }] });
  const ground = () => {
    const heightMap = new Float32Array(N * N), coveredMask = new Uint8Array(N * N).fill(1);
    for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) heightMap[row * N + col] = col >= 96 && col <= 104 ? 44 : 42;
    return { heightMap, coveredMask };
  };
  const centreOf = (r) => r.pts.reduce((best, p) => (Math.hypot(p.x, p.z) < Math.hypot(best.x, best.z) ? p : best), r.pts[0]);
  // residential (E–W, 42 m) × service (N–S, 44 m): the residential stays, the service comes down.
  let prof = buildRoadProfiles([roadFeature({ highway: 'residential' }), ns({ highway: 'service' })], DATA, ground());
  let [a, b] = prof.roads;
  assert.ok(prof.stats.junctionClusters >= 1, 'a junction was solved');
  assert.ok(centreOf(a).h < 42.35, `residential keeps ~42 m at the junction, got ${centreOf(a).h.toFixed(2)}`);
  assert.ok(Math.abs(centreOf(b).h - centreOf(a).h) < 0.3, `service meets the residential grade, got ${centreOf(b).h.toFixed(2)} vs ${centreOf(a).h.toFixed(2)}`);
  // Swap the classes: now the N–S residential (44 m) is the reference and the E–W service rises to it.
  prof = buildRoadProfiles([roadFeature({ highway: 'service' }), ns({ highway: 'residential' })], DATA, ground());
  [a, b] = prof.roads;
  assert.ok(Math.abs(centreOf(b).h - 44) < 0.15, `residential keeps 44 m, got ${centreOf(b).h.toFixed(2)}`);
  assert.ok(centreOf(a).h > 43.5, `service rises to the residential grade, got ${centreOf(a).h.toFixed(2)}`);
});

test('carve reports .ter-vs-profile residual over full-strength spans', () => {
  const g = groundStub(() => 42);
  const prof = buildRoadProfiles([roadFeature({ highway: 'residential' })], DATA, g);
  const cs = carveRoadProfiles(prof, DATA, g);
  assert.ok(cs.residualSamples > 30, `samples audited, got ${cs.residualSamples}`);
  assert.ok(cs.profileResidualRmsM < 0.05, `flat carve is faithful, got rms ${cs.profileResidualRmsM}m`);
  assert.ok(cs.profileResidualMaxM < 0.2, `no outlier cells, got max ${cs.profileResidualMaxM}m`);
});
