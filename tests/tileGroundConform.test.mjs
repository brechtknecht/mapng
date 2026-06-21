import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformTilesToFloor } from '../services/tileGroundConform.js';

// Flat terrain at height 0 → a vertex's metres-Y IS its residual above the floor.
// bounds chosen so the AOI is ~100 m wide ⇒ unitsPerMeter ≈ 1 (1 scene unit ≈ 1 m).
const DATA = {
  width: 2,
  height: 2,
  minHeight: 0,
  heightMap: new Float32Array([0, 0, 0, 0]),
  bounds: { south: 0, north: 100 / 111320, west: 0, east: 100 / 111320 },
};

// A small horizontal (vertical-normal) triangle centred near (cx,cz) at height y.
const horizTri = (cx, cz, y) => [cx, y, cz, cx + 1, y, cz, cx, y, cz + 1];

// Spatially-varying residual: a west→east tilt, like an ellipsoid/geoid datum
// term. Kept within groundDistanceM (2.5 m) so every ground tri is detected —
// the conform only recognises ground within that band of the terrain.
const residual = (x) => 1.5 + 0.015 * x; // ranges ~0.8 .. 2.2 over [-45,45]

test('seats ground on the floor and preserves building height', () => {
  const verts = [];
  const index = [];
  let v = 0;
  // A blanket of ground tris across the scene, each lifted by the local residual.
  for (let cx = -45; cx <= 45; cx += 6) {
    for (let cz = -45; cz <= 45; cz += 6) {
      verts.push(...horizTri(cx, cz, residual(cx)));
      index.push(v, v + 1, v + 2);
      v += 3;
    }
  }
  // A "building roof": horizontal tri 20 m above the LOCAL ground at (0,0).
  const roofStart = v;
  verts.push(...horizTri(0, 0, residual(0) + 20));
  index.push(v, v + 1, v + 2);
  v += 3;

  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  const r = conformTilesToFloor(soup, DATA);

  // Ground residual must collapse toward zero.
  assert.ok(r.residualBefore > 1.0, `precondition: ground was lifted (${r.residualBefore})`);
  assert.ok(r.residualAfter < 0.4, `ground now on the floor, got ${r.residualAfter}`);
  assert.ok(r.vertsMoved > 0 && r.meshesMoved === 1);

  const out = r.positions[0];
  // Roof Y after conform ≈ 20 (kept its 20 m above the now-corrected ground).
  const roofY = out[roofStart * 3 + 1];
  assert.ok(Math.abs(roofY - 20) < 0.6, `roof preserved at ~20 m, got ${roofY}`);

  // A sampled ground vertex should sit ≈ on the floor (Y ≈ 0).
  const groundY = out[1]; // first tri, first vertex Y
  assert.ok(Math.abs(groundY) < 0.6, `ground vertex on floor, got ${groundY}`);
});

test('disabled-equivalent: empty soup is a no-op', () => {
  const r = conformTilesToFloor([], DATA);
  assert.equal(r.vertsMoved, 0);
  assert.equal(r.meshesMoved, 0);
});

test('a pure roof with no ground samples is left essentially untouched', () => {
  // No ground tris at all → field degrades to fallback 0 → no shift.
  const verts = horizTri(0, 0, 30);
  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array([0, 1, 2]) }];
  const r = conformTilesToFloor(soup, DATA);
  assert.equal(r.cellsFilled, 0, 'no ground was detected');
  assert.equal(r.vertsMoved, 0, 'nothing to seat → no movement');
});
