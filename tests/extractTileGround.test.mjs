import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTileGroundFromSoup } from '@mapng/bake/ground/extractTileGround';

// Mirror createTileMeshTransformer's output frame: X/Z in scene units [-50,50],
// Y in METRES above the .ter datum. The worker hands these record buffers to
// extractTileGroundFromSoup, so this is the exact contract under test.
const LAT = 48.1, LNG = 11.6;
const M_PER_DEG_LAT = 111320;

function flatTerrain(datumM, sizeM = 1000, N = 128) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
  const halfLat = (sizeM / 2) / M_PER_DEG_LAT;
  const halfLng = (sizeM / 2) / mPerDegLng;
  return {
    bounds: { north: LAT + halfLat, south: LAT - halfLat, east: LNG + halfLng, west: LNG - halfLng },
    width: N, height: N,
    heightMap: new Float32Array(N * N).fill(datumM), // DEM surface == datum
    minHeight: datumM, maxHeight: datumM,
  };
}

// A flat quad at height `yM` metres covering scene X/Z ∈ [-r, r].
function quad(r, yM) {
  return {
    positions: new Float32Array([
      -r, yM, -r, r, yM, -r, r, yM, r, -r, yM, r,
    ]),
    index: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// nearest grid index for a scene X/Z in the width×height field (north-origin:
// scene +Z → increasing row, matching buildTileHeightField).
function cellAtScene(N, sx, sz) {
  const col = Math.round(((sx + 50) / 100) * (N - 1));
  const row = Math.round(((sz + 50) / 100) * (N - 1));
  return row * N + col;
}

test('soup ground: covered cells take the road height in absolute metres', () => {
  const datum = 100;
  const terrain = flatTerrain(datum);
  // road 5 m above the datum over the central 60 m of the 100 m scene
  const g = extractTileGroundFromSoup([quad(30, 5)], terrain, { postId: null });

  assert.equal(g.width, terrain.width);
  assert.equal(g.height, terrain.height);
  assert.ok(g.coveredMask instanceof Uint8Array);

  const N = terrain.width;
  const cIdx = cellAtScene(N, 0, 0);
  // centre is covered, ground sits at datum + 5 m (frame + datum carried through)
  assert.equal(g.coveredMask[cIdx], 1, 'centre cell must be covered');
  assert.ok(Math.abs(g.heightMap[cIdx] - (datum + 5)) < 2,
    `centre ground ${g.heightMap[cIdx]} should be ~${datum + 5}`);
  assert.ok(g.heightMap[cIdx] > datum + 2, 'centre must be clearly above the DEM datum, not collapsed');
});

test('soup ground: uncovered cells fall back to the DEM datum', () => {
  const datum = 100;
  const terrain = flatTerrain(datum);
  const g = extractTileGroundFromSoup([quad(30, 5)], terrain, { postId: null });
  const N = terrain.width;
  const corner = g.coveredMask[cellAtScene(N, -49, -49)] === 0
    ? g.heightMap[cellAtScene(N, -49, -49)] : NaN;
  assert.equal(g.coveredMask[cellAtScene(N, -49, -49)], 0, 'corner must be uncovered');
  assert.ok(Math.abs(corner - datum) < 0.5, `uncovered corner ${corner} should be DEM datum ${datum}`);
});

test('soup ground: coverage ratio ~ the quad fraction', () => {
  const terrain = flatTerrain(100);
  const g = extractTileGroundFromSoup([quad(30, 5)], terrain, { postId: null });
  // a 60×60 quad over a 100×100 scene ≈ 0.36 covered
  assert.ok(g.coverage > 0.2 && g.coverage < 0.55, `coverage ${g.coverage} out of expected band`);
});

// A quad with per-corner heights (x0<x1 span on X, z0<z1 on Z), for ramps/walls.
function quadXZ(x0, x1, z0, z1, y00, y10, y11, y01) {
  return {
    positions: new Float32Array([
      x0, y00, z0, x1, y10, z0, x1, y11, z1, x0, y01, z1,
    ]),
    index: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// ~1 m cells (250 m AOI, 250 px terrain) so sub-street junk spans real cells,
// like a chunk .ter does — the coarse 128-over-1000m grid of the tests above
// would despike a 2 m feature by accident.
const FINE = () => flatTerrain(100, 250, 250);
const FINE_UPM = 100 / 250; // scene units per metre at sizeM=250

test('steep-walled shallow trench must not drag the ground below the road (normal gate)', () => {
  const terrain = FINE();
  const roadY = 2;
  const road = quad(30, roadY);
  // A V-trench cut 1.8 m below the road: two near-vertical walls (0.9 m run,
  // 1.8 m drop ≈ 63°), 40 m long — the facade-skirt / LOD-seam signature. Too
  // shallow for liftDownSpikes (pitDropM = 2), too wide for the median despike.
  const run = 0.9 * FINE_UPM, len = 20 * FINE_UPM;
  const west = quadXZ(-run, 0, -len, len, roadY, roadY - 1.8, roadY - 1.8, roadY);
  const east = quadXZ(0, run, -len, len, roadY - 1.8, roadY, roadY, roadY - 1.8);

  const g = extractTileGroundFromSoup([road, west, east], terrain, { postId: null });
  const N = terrain.width;
  const trenchCell = cellAtScene(N, 0, 0);
  assert.ok(Math.abs(g.heightMap[trenchCell] - (100 + roadY)) < 0.5,
    `ground over the trench ${g.heightMap[trenchCell]} should stay at road level ~${100 + roadY}`);

  // Sanity: with the gate disabled the trench DOES capture the min — this is
  // the exact mechanism behind the tiles-float-above-.ter gaps.
  // A single isolated trench only dips a few dm ungated (cell centres sample
  // partway down the walls, and PMF's despike claws part of it back) — real
  // streets carry this junk densely along every frontage, so the dips stack.
  const ungated = extractTileGroundFromSoup([road, west, east], terrain, { postId: null, minNormalY: 0 });
  assert.ok(ungated.heightMap[trenchCell] < 100 + roadY - 0.3,
    `without the normal gate the trench should pull the ground down (got ${ungated.heightMap[trenchCell]})`);
});

test('wide horizontal slab far below the DEM is rejected (band gate)', () => {
  const terrain = FINE();
  const roadY = 2;
  const road = quad(30, roadY);
  // A flat 30 m slab 5 m below the DEM (basement floor / sunken junk):
  // horizontal, so the normal gate keeps it; wider than pitWidthM, so
  // liftDownSpikes can't fix it — only the band gate stands in its way.
  const slab = quad(15 * FINE_UPM, -5);

  const g = extractTileGroundFromSoup([road, slab], terrain, { postId: null });
  const N = terrain.width;
  const cIdx = cellAtScene(N, 0, 0);
  assert.ok(Math.abs(g.heightMap[cIdx] - (100 + roadY)) < 0.5,
    `ground over the slab ${g.heightMap[cIdx]} should stay at road level ~${100 + roadY}`);

  const ungated = extractTileGroundFromSoup([road, slab], terrain, { postId: null, belowBandM: 50 });
  assert.ok(ungated.heightMap[cIdx] < 100 + roadY - 3,
    `with the band opened up the slab should capture the min (got ${ungated.heightMap[cIdx]})`);
});

test('sloped road survives both gates', () => {
  const terrain = FINE();
  // 13 % grade: y ramps 0 → 8 m across a 60 m-wide road strip (in band below,
  // near-horizontal — neither gate may touch it).
  const r = 30 * FINE_UPM;
  const ramp = quadXZ(-r, r, -r, r, 1, 9, 9, 1);
  const g = extractTileGroundFromSoup([ramp], terrain, { postId: null });
  const N = terrain.width;
  const mid = cellAtScene(N, 0, 0);
  assert.equal(g.coveredMask[mid], 1, 'ramp centre must be covered');
  assert.ok(Math.abs(g.heightMap[mid] - 105) < 1,
    `ramp centre ${g.heightMap[mid]} should be ~105 (datum + 5)`);
});

test('empty soup → fully uncovered, all DEM', () => {
  const datum = 100;
  const terrain = flatTerrain(datum, 1000, 64);
  const g = extractTileGroundFromSoup([], terrain, { postId: null });
  assert.equal(g.coverage, 0);
  assert.ok(g.heightMap.every((v) => Math.abs(v - datum) < 0.5));
});
