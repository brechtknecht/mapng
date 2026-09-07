import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conformTilesToFloor } from '@mapng/bake/tileGroundConform';

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
    // +3 m: beyond groundDistanceM = 2.5 (invisible to the delta field) but inside
    // the FULL-snap zone (≤ maxSnapM − snapTaperM = 3.5 — the ceiling tapers, so a
    // floater at maxSnapM itself is deliberately left alone; see test below).
    verts.push(...horizTri(cx, 0, 3));
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
  assert.ok(r.maxFloatFixedM > 2.5, `reports the ~3 m float it fixed, got ${r.maxFloatFixedM}`);
  assert.ok(Math.abs(r.positions[0][1] - 0.02) < 0.05, `floater seated on floor, got ${r.positions[0][1]}`);
});

test('snap ceiling tapers: a floater at maxSnapM over real road surface is left alone', () => {
  // The overhang guard only applies where the column HAS a road surface — a
  // floater over a coverage hole is a glitch now (see the glitch-override
  // tests). Ground at 0.1 fills the cells; the 5 m floaters above it must
  // still be spared by the tapered ceiling.
  const verts = [], index = [];
  let v = 0;
  const floaterStart = [];
  for (let cx = -45; cx <= 45; cx += 6) {
    verts.push(...horizTri(cx, 0, 0.1)); // real road surface (in band)
    index.push(v, v + 1, v + 2); v += 3;
    floaterStart.push(v);
    verts.push(...horizTri(cx, 0, 5)); // exactly maxSnapM → gate weight 0
    index.push(v, v + 1, v + 2); v += 3;
  }
  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  const r = conformTilesToFloor(soup, DATA, { groundMask: stripMask(3) });
  assert.equal(r.glitchVertsFlattened, 0, 'filled cells: no glitch path');
  const out = r.positions[0];
  for (const fs of floaterStart) {
    const y = out[fs * 3 + 1];
    assert.ok(y > 4.5, `at-ceiling floater must not snap, got ${y}`);
  }
});

test('snap targets the heightMap it is given, not the datum (extracted-ground floor swap)', () => {
  // The route worker swaps the EXTRACTED tile ground in as the conform floor:
  // {...data, heightMap: extractedGround} with the ORIGINAL minHeight datum.
  // Floor at 2 m absolute over datum 0 — a wiggling road around it must seat on
  // floor + roadEpsM, NOT on the datum.
  const data = { ...DATA, heightMap: new Float32Array([2, 2, 2, 2]) };
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 3) {
    verts.push(...horizTri(cx, 0, 2 + 0.8 * Math.sin(cx * 0.5)));
    index.push(v, v + 1, v + 2); v += 3;
  }
  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  const r = conformTilesToFloor(soup, data, { groundMask: stripMask(3) });

  assert.ok(r.vertsSnapped > 0, 'road verts were snapped');
  const out = r.positions[0];
  for (let i = 1; i < out.length; i += 3) {
    assert.ok(Math.abs(out[i] - 2.02) < 0.05, `vertex seated on the 2 m floor, got ${out[i]}`);
  }
});

test('floorCoveredMask: no snap where the floor is fallback (underpass guard)', () => {
  // Same wiggling road as the flatten test, but the floor is marked untrusted
  // (DEM-fallback) everywhere — the snap must leave the road alone rather than
  // drag it onto a surface that never saw it (underpasses, viaducts).
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 3) {
    verts.push(...horizTri(cx, 0, 0.8 * Math.sin(cx * 0.5)));
    index.push(v, v + 1, v + 2); v += 3;
  }
  const mk = () => [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];

  const covered = new Uint8Array(DATA.width * DATA.height); // all 0 = untrusted
  const r = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3), floorCoveredMask: covered });
  assert.equal(r.vertsSnapped, 0, 'untrusted floor must not attract any snap');

  covered.fill(1); // all trusted → behaves like the plain masked conform
  const r2 = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3), floorCoveredMask: covered });
  assert.ok(r2.vertsSnapped > 0, 'fully trusted floor snaps as before');
  assert.ok(r2.residualAfter < 0.1, `wiggle flattened on trusted floor, got ${r2.residualAfter}`);
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
  // A vertical-plane tri over the masked strip, NEXT TO real road surface (the
  // ground tri fills the cell — without it the wall would be a glitch column
  // and flattened by design). The wall verts must stay put.
  const verts = [
    ...[-3, 0.1, 0, -2, 0.1, 0, -3, 0.1, 1], // road surface in the same cell
    0, 0, 0, 0, 5, 0, 1, 5, 0,               // wall: spans Y in the x=const plane
  ];
  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array([0, 1, 2, 3, 4, 5]) }];
  const r = conformTilesToFloor(soup, DATA, { groundMask: stripMask(3) });
  assert.equal(r.glitchVertsFlattened, 0, 'filled cell: wall is not a glitch');
  const out = r.positions[0] ?? verts;
  assert.ok(Math.abs(out[13] - 5) < 0.3, `wall top vert stays up, got ${out[13]}`);
  assert.ok(Math.abs(out[16] - 5) < 0.3, `wall top vert stays up, got ${out[16]}`);
});

test('corridor authority: everything below the clearance is seated on the floor, above it is kept', () => {
  // Road surface fills the cells; a 2 m floater (a car-sized blob, over the
  // worker's 2 m ceiling), a 4 m floater (a canopy) and a tall steep face
  // (legacy: wall-protected) share the masked strip.
  const verts = [
    ...horizTri(-6, 0, 0.1), ...horizTri(0, 0, 0.1), ...horizTri(6, 0, 0.1), // road surface
    ...horizTri(-6, 0, 2.0), // 2 m floater
    ...horizTri(6, 0, 4.0),  // 4 m floater
    0, 0, 0, 0, 5, 0, 1, 5, 0, // steep face 0..5 m
  ];
  const index = new Uint32Array([...Array(18).keys()]);
  const mk = () => [{ positions: new Float32Array(verts), index }];
  const legacy = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3), maxSnapM: 2, snapTaperM: 1 });
  // Legacy moves them only by the smooth delta field (in-band samples pull D
  // toward ~1 m here) — never onto the floor.
  const lo = legacy.positions[0] ?? verts;
  assert.ok(lo[9 * 3 + 1] > 0.5, `legacy: 2 m floater over the ceiling is not seated, got ${lo[9 * 3 + 1]}`);
  assert.ok(Math.abs(lo[15 * 3 + 1] - 0.02) > 0.1, `legacy: wall bottom is not seated, got ${lo[15 * 3 + 1]}`);

  const r = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3), maxSnapM: 2, snapTaperM: 1, corridorClearanceM: 2.5 });
  const out = r.positions[0];
  for (const vi of [9, 10, 11]) assert.ok(Math.abs(out[vi * 3 + 1] - 0.02) < 0.05, `2 m floater seated, got ${out[vi * 3 + 1]}`);
  for (const vi of [12, 13, 14]) assert.ok(out[vi * 3 + 1] > 3.5, `4 m floater kept (above clearance), got ${out[vi * 3 + 1]}`);
  assert.ok(Math.abs(out[15 * 3 + 1] - 0.02) < 0.05, `wall bottom seated on the floor, got ${out[15 * 3 + 1]}`);
  assert.ok(out[16 * 3 + 1] > 4.5 && out[17 * 3 + 1] > 4.5, 'wall top stays up');
  assert.equal(r.roadWallExcluded, 0, 'no wall exemptions inside the corridor');
});

// ── Field bend diagnostics (the "buildings morph" instrumentation) ─────────
// fieldGrad quantifies the cell-to-cell variation of D — the amount by which the
// per-vertex delta pass BENDS any rigid structure spanning those cells.

const blanket = (heightAt) => {
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 6) {
    for (let cz = -45; cz <= 45; cz += 6) {
      verts.push(...horizTri(cx, cz, heightAt(cx, cz)));
      index.push(v, v + 1, v + 2); v += 3;
    }
  }
  return [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
};

test('field bend: a constant residual reports ~zero bend', () => {
  const r = conformTilesToFloor(blanket(() => 1.5), DATA);
  assert.equal(r.fieldGrad.length, r.fieldN * r.fieldN);
  assert.ok(r.fieldGradP95M < 0.05, `flat field must not bend, got p95 ${r.fieldGradP95M}`);
});

test('field bend: cell-scale wobble is reported, not hidden', () => {
  // Alternate the ground residual ±0.5 m per 6 m column — the photogrammetry-noise
  // signature that bends buildings. p95 must surface it.
  const wobbly = (cx) => 1.5 + (Math.round(cx / 6) % 2 === 0 ? 0.5 : -0.5);
  const r = conformTilesToFloor(blanket(wobbly), DATA);
  assert.ok(r.fieldGradP95M > 0.3, `wobble must show in p95, got ${r.fieldGradP95M}`);
  assert.ok(r.fieldGradMaxM >= r.fieldGradP95M && r.fieldGradP95M >= r.fieldGradP50M, 'quantiles ordered');
});

test('measureOnly: builds the field + diagnostics but moves nothing', () => {
  const mk = () => blanket((cx) => residual(cx));
  const m = conformTilesToFloor(mk(), DATA, { measureOnly: true });
  assert.equal(m.vertsMoved, 0);
  assert.ok(m.positions.every((p) => p === null), 'no positions allocated/applied');
  assert.ok(m.cellsFilled > 0 && m.residualBefore > 1.0, 'field was still measured');
  assert.equal(m.fieldGrad.length, m.fieldN * m.fieldN);
  // Identical field to the full run — measure-only must not change what is measured.
  const full = conformTilesToFloor(mk(), DATA);
  assert.equal(m.fieldGradP95M, full.fieldGradP95M);
  assert.deepEqual(Array.from(m.fieldValues), Array.from(full.fieldValues));
});

// ── Structure stiffness (semantic building protection) ─────────────────────
// A footprint freezes the delta field locally constant, so the building
// translates rigidly instead of being bent by the field's cell-to-cell wobble.

const FOOTPRINT = [{ ring: [{ x: -15, z: -15 }, { x: 15, z: -15 }, { x: 15, z: 15 }, { x: -15, z: 15 }], holes: [] }];
const wobble = (cx) => 1.5 + (Math.round(cx / 6) % 2 === 0 ? 0.5 : -0.5);

// Wobbly ground everywhere EXCEPT under the footprint (buildings measure no
// ground), plus a flat roof 15 m up spanning the footprint.
const buildingScene = () => {
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 6) {
    for (let cz = -45; cz <= 45; cz += 6) {
      if (Math.abs(cx) <= 18 && Math.abs(cz) <= 18) continue; // no ground inside/near the building
      verts.push(...horizTri(cx, cz, wobble(cx)));
      index.push(v, v + 1, v + 2); v += 3;
    }
  }
  const roofStart = v;
  for (let cx = -12; cx <= 12; cx += 6) {
    for (let cz = -12; cz <= 12; cz += 6) {
      verts.push(...horizTri(cx, cz, 15));
      index.push(v, v + 1, v + 2); v += 3;
    }
  }
  return { soup: [{ positions: new Float32Array(verts), index: new Uint32Array(index) }], roofStart, roofEnd: v };
};

const roofSpread = (r, roofStart, roofEnd) => {
  const out = r.positions[0];
  let lo = Infinity, hi = -Infinity;
  for (let vi = roofStart; vi < roofEnd; vi++) {
    const y = out[vi * 3 + 1];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return hi - lo;
};

test('structures: the roof stays planar (rigid re-seat) where the bare field bends it', () => {
  const a = buildingScene();
  const bare = conformTilesToFloor(a.soup, DATA);
  const bareSpread = roofSpread(bare, a.roofStart, a.roofEnd);
  assert.ok(bareSpread > 0.4, `precondition: the wobbly field bends the roof, spread ${bareSpread}`);

  const b = buildingScene();
  const rigid = conformTilesToFloor(b.soup, DATA, { structures: FOOTPRINT });
  assert.equal(rigid.structureCount, 1);
  const rigidSpread = roofSpread(rigid, b.roofStart, b.roofEnd);
  assert.ok(rigidSpread < bareSpread / 3 && rigidSpread < 0.25,
    `roof re-seated rigidly: spread ${rigidSpread} (bare ${bareSpread})`);
});

test('structures: ground away from any footprint is byte-identical to the bare conform', () => {
  const a = buildingScene();
  const bare = conformTilesToFloor(a.soup, DATA);
  const b = buildingScene();
  const rigid = conformTilesToFloor(b.soup, DATA, { structures: FOOTPRINT });
  // Compare the ground blanket verts far outside the footprint+feather (|x|>30).
  const pa = bare.positions[0], pb = rigid.positions[0];
  let compared = 0;
  for (let i = 0; i < pa.length; i += 3) {
    if (Math.abs(pa[i]) <= 30 || Math.abs(pa[i + 2]) <= 30) continue;
    assert.equal(pb[i + 1], pa[i + 1], `far ground vert at ${pa[i]},${pa[i + 2]} unchanged`);
    compared++;
  }
  assert.ok(compared > 20, `enough far verts compared (${compared})`);
});

test('structures: the road snap is vetoed under a footprint', () => {
  // A wiggling masked road crossing the footprint: outside it snaps onto the
  // floor, inside the structure veto leaves it to the (frozen) delta field.
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 3) {
    verts.push(...horizTri(cx, 0, 0.8 * Math.sin(cx * 0.5)));
    index.push(v, v + 1, v + 2); v += 3;
  }
  const mk = () => [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  const r = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3), structures: FOOTPRINT });
  assert.ok(r.structSnapVetoed > 0, 'snap attempts under the footprint were vetoed');
  const rBare = conformTilesToFloor(mk(), DATA, { groundMask: stripMask(3) });
  assert.ok(r.vertsSnapped < rBare.vertsSnapped, 'fewer verts snapped than without structures');
});

test('short steep road-seam skirts snap flat; only TALL steep faces are wall-protected', () => {
  // Google road meshes carry short vertical seams/skirts that dip below the
  // visible road (LOD seals), plus steep micro-facets on every bump. Those are
  // steep but SHORT (Y-span < wallMinSpanM), so they must NOT self-protect as
  // "walls" — their verts snap onto the floor and the seam collapses flat.
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 6) { // road blanket at +0.5 (in band)
    verts.push(...horizTri(cx, 0, 0.5));
    index.push(v, v + 1, v + 2); v += 3;
  }
  // A short skirt inside the mask: near-vertical tri from road level down to
  // −0.7 m (span 1.2 m < wallMinSpanM 1.5) — the sub-road seal signature.
  const skirtStart = v;
  verts.push(0, 0.5, 0, 0, -0.7, 0, 0.4, -0.7, 0.1);
  index.push(v, v + 1, v + 2); v += 3;

  const soup = [{ positions: new Float32Array(verts), index: new Uint32Array(index) }];
  const r = conformTilesToFloor(soup, DATA, { groundMask: stripMask(3) });

  const out = r.positions[0];
  for (let k = 0; k < 3; k++) {
    const y = out[(skirtStart + k) * 3 + 1];
    assert.ok(Math.abs(y - 0.02) < 0.1, `skirt vert ${k} pulled onto the floor, got ${y}`);
  }
});

// ── Road-prior glitch override ───────────────────────────────────────────────
// Build a road blanket with a COVERAGE HOLE at the centre and a horizontal cap
// floating high above it — the anomaly signature: the glitch REPLACED the road,
// so its column has no ground-level surface, yet it floats far beyond maxSnapM
// where the old guards would protect it forever.
const glitchScene = (withRoadUnderCap) => {
  const verts = [], index = [];
  let v = 0;
  for (let cx = -45; cx <= 45; cx += 6) {
    for (let cz = -45; cz <= 45; cz += 6) {
      // hole: no ground tris within 9m of the origin (unless the control asks)
      if (!withRoadUnderCap && Math.abs(cx) < 9 && Math.abs(cz) < 9) continue;
      verts.push(...horizTri(cx, cz, 0.2));
      index.push(v, v + 1, v + 2); v += 3;
    }
  }
  // The blanket lattice (−45 + 6k) never lands on the origin, so the cap's
  // cell needs its road surface added explicitly for the overhang control.
  if (withRoadUnderCap) {
    verts.push(...horizTri(0, 0, 0.2));
    index.push(v, v + 1, v + 2); v += 3;
  }
  const capStart = v;
  verts.push(...horizTri(0, 0, 18)); // the glitch: 18m up, way past maxSnapM
  index.push(v, v + 1, v + 2); v += 3;
  return { soup: [{ positions: new Float32Array(verts), index: new Uint32Array(index) }], capStart };
};
const fullMask = { n: 1, coverage: new Float32Array(), sample: () => 1 };

test('glitch override: a spike over a road with no surface under it is flattened', () => {
  const { soup, capStart } = glitchScene(false);
  const r = conformTilesToFloor(soup, DATA, { groundMask: fullMask });
  assert.ok(r.glitchVertsFlattened >= 3, `cap verts flattened, got ${r.glitchVertsFlattened}`);
  assert.ok(Math.abs(r.glitchMaxFloatM - 18) < 0.5, `18m float recorded, got ${r.glitchMaxFloatM}`);
  const out = r.positions[0];
  for (let k = 0; k < 3; k++) {
    const y = out[(capStart + k) * 3 + 1];
    assert.ok(Math.abs(y - 0.02) < 0.15, `glitch vert ${k} seated on the floor, got ${y}`);
  }
});

test('glitch override: a legit overhang (road surface underneath) is preserved', () => {
  const { soup, capStart } = glitchScene(true); // road tris DO cover the cap's cell
  const r = conformTilesToFloor(soup, DATA, { groundMask: fullMask });
  assert.equal(r.glitchVertsFlattened, 0, 'overhang not treated as glitch');
  const out = r.positions[0];
  const y = out[capStart * 3 + 1];
  assert.ok(y > 15, `tree-crown/deck stays up, got ${y}`);
});

test('glitch override: glitchSnap=false restores the old ceiling behaviour', () => {
  const { soup, capStart } = glitchScene(false);
  const r = conformTilesToFloor(soup, DATA, { groundMask: fullMask, glitchSnap: false });
  assert.equal(r.glitchVertsFlattened, 0);
  const out = r.positions[0];
  const y = out ? out[capStart * 3 + 1] : 18;
  assert.ok(y > 15, `spike survives without the override, got ${y}`);
});
