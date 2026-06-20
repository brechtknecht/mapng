import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weldSeams } from '../services/googleBakeCore.js';

// positions are [sceneX, metersY, sceneZ]; with unitsPerMeter = 1 the scene
// X/Z axes ARE metres, so the numbers read directly.
const UPM = { unitsPerMeter: 1 };

// A flat ground quad at height y spanning [x0,x0+1]×[0,1], as two triangles.
const groundQuad = (x0, y, lod) => ({
  positions: new Float32Array([
    x0, y, 0, x0 + 1, y, 0, x0 + 1, y, 1, x0, y, 1,
  ]),
  index: new Uint16Array([0, 1, 2, 0, 2, 3]),
  lod,
});

test('cross-LOD: coarse ground snaps onto the finer ground, façade preserved', () => {
  const fine = {
    positions: new Float32Array([3, 0, 0, 4, 0, 0, 4, 0, 1]),
    index: new Uint16Array([0, 1, 2]),
    lod: 2,
  };
  const coarse = {
    // v0: ground 0.5 m above the finer ground in the overlap → snaps to 0
    // v1: a façade vertex 10 m up at the same XZ              → must stay
    // v2: far away, no finer ground beneath it                → must stay
    positions: new Float32Array([3, 0.5, 0, 3, 10, 0, 20, 0.5, 20]),
    index: new Uint16Array([0, 1, 2]),
    lod: 16,
  };
  const { positions } = weldSeams([fine, coarse], UPM);
  assert.equal(positions[0], null, 'the finest mesh is never moved');
  assert.ok(positions[1], 'the coarse mesh moved');
  assert.ok(Math.abs(positions[1][1] - 0) < 1e-6, 'seam vertex snapped onto the finer ground');
  assert.equal(positions[1][4], 10, 'façade vertex is untouched');
  assert.equal(positions[1][7], 0.5, 'vertex with no finer ground beneath it is untouched');
});

test('same-LOD seam: two equal-LOD tiles close the gap (the real bug)', () => {
  // Two same-LOD quads overlapping in column x∈[1,2], one at y=0, one at y=0.6 —
  // exactly the riser the logs showed (all in-AOI tiles ge≈2).
  const a = groundQuad(0, 0.0, 4);
  const b = groundQuad(1, 0.6, 4);
  const { positions, meshesMoved, vertsMoved } = weldSeams([a, b], UPM);
  assert.equal(meshesMoved, 2, 'both same-LOD tiles weld');
  assert.ok(vertsMoved > 0);
  // a rises from 0, b drops from 0.6 — the original 0.6 m step shrinks toward 0
  const aShared = positions[0][4]; // a's vertex at x=1
  const bShared = positions[1][1]; // b's vertex at x=1
  assert.ok(aShared > 0 && aShared < 0.6, 'a moved up toward the seam');
  assert.ok(bShared > 0 && bShared < 0.6, 'b moved down toward the seam');
  assert.ok(Math.abs(aShared - bShared) < 0.6, 'the step shrank');
});

test('tall building wall is NOT welded away (the regression)', () => {
  // A street tile and a building tile that share the same XZ at ground; the
  // building has a tall wall rising to a roof. Welding must leave the wall.
  const street = groundQuad(0, 0.0, 4); // covers x[0,1]
  const building = {
    // wall going up at x≈1 (vertical), plus a roof quad at y=12 over x[1,2]
    positions: new Float32Array([
      // wall verts (a near-vertical strip at x=1): base→top
      1, 0.1, 0, 1, 4, 0, 1, 8, 0, 1, 12, 0,
      // roof quad
      1, 12, 0, 2, 12, 0, 2, 12, 1, 1, 12, 1,
    ]),
    index: new Uint16Array([0, 1, 4, 1, 2, 4, 4, 5, 6, 4, 6, 7]),
    lod: 4,
  };
  const { positions } = weldSeams([street, building], UPM);
  const b = positions[1];
  // null ⇒ the building mesh was left entirely untouched (ideal). Otherwise the
  // wall/roof vertices must be unchanged.
  if (b) {
    assert.ok(Math.abs(b[4] - 4) < 1e-6, 'mid-wall vertex at 4 m stays');   // v1.y
    assert.ok(Math.abs(b[7] - 8) < 1e-6, 'upper-wall vertex at 8 m stays'); // v2.y
    assert.ok(Math.abs(b[10] - 12) < 1e-6, 'roof vertex at 12 m stays');    // v3.y
  }
});

test('real step preserved: a 3 m wall between two same-LOD tiles is NOT flattened', () => {
  const plaza = groundQuad(1, 3.0, 4);
  const street = groundQuad(0, 0.0, 4);
  const { positions } = weldSeams([plaza, street], UPM);
  if (positions[0]) for (let i = 1; i < positions[0].length; i += 3) {
    assert.ok(Math.abs(positions[0][i] - 3.0) < 1e-6, 'plaza stays at 3 m');
  }
  if (positions[1]) for (let i = 1; i < positions[1].length; i += 3) {
    assert.ok(Math.abs(positions[1][i] - 0.0) < 1e-6, 'street stays at 0 m');
  }
});

test('non-overlapping same-LOD tiles do nothing', () => {
  const a = groundQuad(0, 0.0, 4);
  const b = groundQuad(10, 0.3, 4);
  const { meshesMoved, vertsMoved } = weldSeams([a, b], UPM);
  assert.equal(meshesMoved, 0);
  assert.equal(vertsMoved, 0);
});

test('idempotent — re-welding already-welded output is a no-op', () => {
  const a = groundQuad(0, 0.0, 4);
  const b = groundQuad(1, 0.6, 4);
  const first = weldSeams([a, b], UPM);
  assert.ok(first.vertsMoved > 0, 'first pass moves something');
  const a2 = { ...a, positions: first.positions[0] ?? a.positions };
  const b2 = { ...b, positions: first.positions[1] ?? b.positions };
  const second = weldSeams([a2, b2], UPM);
  assert.equal(second.vertsMoved, 0, 'second pass is a no-op');
});
