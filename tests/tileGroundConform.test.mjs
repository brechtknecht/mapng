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

// ── Road-mask snap ─────────────────────────────────────────────────────────
// A stub mask covering the strip |z| ≤ zMax (sample → 1 inside, 0 outside). The
// real rasteriser is exercised in groundMask.test.mjs; here we test the conform's
// blend/gate in isolation. horizTri lays its verts at z=cz and z=cz+1.
const stripMask = (zMax) => ({ n: 1, coverage: new Float32Array(), sample: (_x, z) => (Math.abs(z) <= zMax ? 1 : 0) });

test('road mask flattens wiggling ground onto the DEM', () => {
  // Flat DEM at 0; a row of horizontal road tris near z≈0, each lifted by a
  // sinusoidal "wiggle" within the ±2.5 m band the delta field can't flatten.
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 3) {
    verts.push(...horizTri(cx, 0, 0.8 * Math.sin(cx * 0.5)));
    index.push(v, v + 1, v + 2); v += 3;
  }
  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  const r = conformTilesToFloor(soup, DATA, { groundMask: stripMask(3) });

  assert.ok(r.vertsSnapped > 0, 'road verts were snapped');
  assert.ok(r.residualAfter < 0.1, `wiggle flattened, got ${r.residualAfter}`);
  const out = r.positions[0];
  for (let i = 1; i < out.length; i += 3) {
    assert.ok(Math.abs(out[i] - 0.02) < 0.05, `vertex seated on floor, got ${out[i]}`);
  }
});

test('road mask pulls down floaters beyond the ±band the delta field ignores', () => {
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 6) {
    verts.push(...horizTri(cx, 0, 5)); // +5 m, well beyond groundDistanceM = 2.5
    index.push(v, v + 1, v + 2); v += 3;
  }
  const mk = () => [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];

  // Without the mask the delta field never sees these tris (out of band) → untouched.
  const bare = conformTilesToFloor(mk(), DATA);
  assert.equal(bare.cellsFilled, 0, 'out-of-band tris contribute no field samples');
  assert.equal(bare.vertsMoved, 0, 'floaters stay floating without the mask');

  // With the mask they snap straight onto the DEM.
  const r = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3) });
  assert.ok(r.vertsSnapped > 0, 'floaters were snapped');
  assert.ok(r.maxFloatFixedM > 4.5, `reports the ~5 m float it fixed, got ${r.maxFloatFixedM}`);
  assert.ok(Math.abs(r.positions[0][1] - 0.02) < 0.05, `floater seated on floor, got ${r.positions[0][1]}`);
});

test('mask leaves off-road geometry byte-identical to the no-mask conform', () => {
  // Ground blanket within band (delta field acts) + a roof; mask covers nothing.
  const build = () => {
    const verts = [], index = [];
    let v = 0;
    for (let cx = -45; cx <= 45; cx += 6) {
      for (let cz = -45; cz <= 45; cz += 6) {
        verts.push(...horizTri(cx, cz, residual(cx)));
        index.push(v, v + 1, v + 2); v += 3;
      }
    }
    verts.push(...horizTri(0, 0, residual(0) + 20));
    index.push(v, v + 1, v + 2);
    return [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  };
  const a = conformTilesToFloor(build(), DATA);
  const b = conformTilesToFloor(build(), DATA, { groundMask: stripMask(-1) }); // covers nothing
  assert.deepEqual(Array.from(b.positions[0]), Array.from(a.positions[0]));
});

test('mask does not snap non-horizontal verts over a road (walls / curb risers)', () => {
  // A vertical-plane tri floating over the masked strip: normal is horizontal, so
  // it must NOT be flagged as ground — no snap, no movement (field is empty).
  const verts = [0, 0, 0, 0, 5, 0, 1, 5, 0]; // spans Y in the x=const plane
  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array([0, 1, 2]) }];
  const r = conformTilesToFloor(soup, DATA, { groundMask: stripMask(3) });
  assert.equal(r.vertsSnapped, 0, 'vertical face is not a snap candidate');
  assert.equal(r.vertsMoved, 0, 'nothing moved');
});
