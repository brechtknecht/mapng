import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScalarFieldGrid } from '@mapng/bake/scalarFieldGrid';

// SCENE_SIZE is 100; unitsPerMeter=1 → 1 scene unit == 1 metre, cells == cellM.
const UPM = 1;

test('per-cell median is robust to outliers', () => {
  const grid = createScalarFieldGrid({ cellM: 100, unitsPerMeter: UPM }); // 1x1 cell
  assert.equal(grid.cellsPerSide, 1);
  grid.add(0, 0, 5);
  grid.add(0, 0, 5);
  grid.add(0, 0, 5);
  grid.add(0, 0, 1000); // outlier
  const f = grid.build({ smoothPasses: 0 });
  assert.equal(f.sample(0, 0), 5, 'median ignores the spike');
});

test('constant field samples its value everywhere', () => {
  const grid = createScalarFieldGrid({ cellM: 10, unitsPerMeter: UPM });
  // fill a spread of cells with the same value
  for (let x = -45; x <= 45; x += 10) for (let z = -45; z <= 45; z += 10) grid.add(x, z, 3);
  const f = grid.build({ smoothPasses: 1 });
  for (const [x, z] of [[-40, -40], [0, 0], [40, 40], [12, -7]]) {
    assert.ok(Math.abs(f.sample(x, z) - 3) < 1e-3, `flat at (${x},${z})`);
  }
});

test('inpaint fills empty cells from neighbours', () => {
  const grid = createScalarFieldGrid({ cellM: 10, unitsPerMeter: UPM }); // 10x10 cells
  // Only fill two opposite corners; everything between must be inpainted, not NaN.
  grid.add(-45, -45, 0);
  grid.add(45, 45, 10);
  const f = grid.build({ smoothPasses: 0 });
  const mid = f.sample(0, 0);
  assert.ok(Number.isFinite(mid), 'no holes left');
  assert.ok(mid > 0 && mid < 10, `interpolated between corners, got ${mid}`);
});

test('empty grid degrades to the fallback constant', () => {
  const grid = createScalarFieldGrid({ cellM: 10, unitsPerMeter: UPM });
  const f = grid.build({ fallback: 7 });
  assert.equal(f.filledCount, 0);
  assert.equal(f.sample(3, 4), 7);
});

test('reproduces a linear ramp (the datum-residual case)', () => {
  const grid = createScalarFieldGrid({ cellM: 5, unitsPerMeter: UPM });
  // value = 0.1 * x  → a gentle west→east tilt, like an ellipsoid/geoid term
  for (let x = -48; x <= 48; x += 3) for (let z = -48; z <= 48; z += 6) grid.add(x, z, 0.1 * x);
  const f = grid.build({ smoothPasses: 1 });
  // interior sample should track the ramp within blur tolerance
  assert.ok(Math.abs(f.sample(20, 0) - 2.0) < 0.6, `ramp@20 ≈ 2, got ${f.sample(20, 0)}`);
  assert.ok(Math.abs(f.sample(-20, 0) + 2.0) < 0.6, `ramp@-20 ≈ -2, got ${f.sample(-20, 0)}`);
});
