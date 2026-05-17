import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampPolygonZRange,
  validateJunctionPolygon,
  mergeJunctionClusters,
  JUNCTION_POLYGON_Z_CLAMP_RANGE_M,
} from '../services/junctionGeometry.js';

// ─── clampPolygonZRange ───────────────────────────────────────────────────

test('clampPolygonZRange leaves a flat polygon untouched', () => {
  const flat = [[0, 0, 10], [1, 0, 10], [1, 1, 10], [0, 1, 10]];
  const out = clampPolygonZRange(flat, 1.0);
  for (let i = 0; i < flat.length; i++) {
    assert.deepEqual(out[i], flat[i]);
  }
});

test('clampPolygonZRange pulls a Z spike back into the median band', () => {
  // Three vertices near z=10, one wild spike at z=80 — exactly the pyramid
  // pathology in the screenshot.
  const spiked = [[0, 0, 10], [1, 0, 10.1], [1, 1, 9.9], [0, 1, 80]];
  const out = clampPolygonZRange(spiked, 1.0);
  let minZ = Infinity, maxZ = -Infinity;
  for (const v of out) {
    if (v[2] < minZ) minZ = v[2];
    if (v[2] > maxZ) maxZ = v[2];
  }
  assert.ok(maxZ - minZ <= 1.0 + 1e-9, `range should be <= 1.0, got ${maxZ - minZ}`);
  // XY untouched.
  for (let i = 0; i < spiked.length; i++) {
    assert.equal(out[i][0], spiked[i][0]);
    assert.equal(out[i][1], spiked[i][1]);
  }
});

test('clampPolygonZRange tolerates a non-finite Z by ignoring it for the median', () => {
  const polygon = [[0, 0, 10], [1, 0, 10], [1, 1, 10], [0, 1, Number.NaN]];
  const out = clampPolygonZRange(polygon, 1.0);
  // The NaN vertex's Z will be clamped against finite-median bounds, producing NaN
  // through Math.max/min — that's fine; validateJunctionPolygon catches it next.
  // What matters is the finite vertices retain their Z within the band.
  for (let i = 0; i < 3; i++) assert.equal(out[i][2], 10);
});

test('clampPolygonZRange uses the documented default range', () => {
  const polygon = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 100]];
  const out = clampPolygonZRange(polygon);
  let zs = out.map((v) => v[2]);
  const range = Math.max(...zs) - Math.min(...zs);
  assert.ok(range <= JUNCTION_POLYGON_Z_CLAMP_RANGE_M + 1e-9);
});

// ─── validateJunctionPolygon ──────────────────────────────────────────────

test('validateJunctionPolygon accepts a well-formed flat square', () => {
  const square = [[0, 0, 5], [3, 0, 5], [3, 3, 5], [0, 3, 5]];
  const verdict = validateJunctionPolygon(square);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.area, 9);
  assert.equal(verdict.zRange, 0);
});

test('validateJunctionPolygon rejects too-few-vertices', () => {
  assert.deepEqual(validateJunctionPolygon([[0, 0, 0], [1, 0, 0]]), { ok: false, reason: 'too_few_vertices' });
  assert.deepEqual(validateJunctionPolygon(null), { ok: false, reason: 'too_few_vertices' });
});

test('validateJunctionPolygon rejects non-finite coordinates', () => {
  const v = validateJunctionPolygon([[0, 0, 0], [1, 0, Number.NaN], [1, 1, 0]]);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'non_finite');
});

test('validateJunctionPolygon rejects polygons with zero area', () => {
  const collinear = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  const v = validateJunctionPolygon(collinear);
  assert.equal(v.ok, false);
  // Could trip edge_too_short or area_too_small depending on ordering; both are valid rejections.
  assert.ok(v.reason === 'area_too_small' || v.reason === 'edge_too_short');
});

test('validateJunctionPolygon rejects polygons with tiny edges', () => {
  // Two near-duplicate consecutive vertices.
  const polygon = [[0, 0, 0], [0.001, 0, 0], [3, 0, 0], [3, 3, 0]];
  const v = validateJunctionPolygon(polygon);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'edge_too_short');
});

test('validateJunctionPolygon rejects polygons whose Z spread is too wide', () => {
  // 5 m Z spread — well past JUNCTION_MERGE_MAX_Z_RANGE_M of 1.5.
  const polygon = [[0, 0, 0], [3, 0, 0], [3, 3, 5], [0, 3, 5]];
  const v = validateJunctionPolygon(polygon);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'z_range_too_large');
});

test('validateJunctionPolygon rejects polygons whose bbox is absurdly large', () => {
  const polygon = [[0, 0, 0], [500, 0, 0], [500, 500, 0], [0, 500, 0]];
  const v = validateJunctionPolygon(polygon);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'bbox_too_large');
});

// ─── mergeJunctionClusters integration ────────────────────────────────────

test('mergeJunctionClusters applies the Z clamp to single-member output', () => {
  // Single junction with a Z spike — must not survive into the prism.
  const spiked = {
    position: [0, 0, 10],
    polygon: [[0, 0, 10], [3, 0, 10], [3, 3, 10], [0, 3, 50]],
  };
  const [merged] = mergeJunctionClusters([spiked]);
  const zs = merged.polygon.map((v) => v[2]);
  assert.ok(Math.max(...zs) - Math.min(...zs) <= JUNCTION_POLYGON_Z_CLAMP_RANGE_M + 1e-9);
});

test('mergeJunctionClusters merges polygons whose bboxes overlap even when centroids are far apart', () => {
  // A small OSM-style junction at (0,0) and a big raster-gap patch whose
  // centroid is 18 m away but whose footprint reaches back to (1,1).
  // Centroid distance > 15 m so the old rule wouldn't have merged them.
  const osmJunction = {
    position: [0, 0, 5],
    polygon: [[-2, -2, 5], [2, -2, 5], [2, 2, 5], [-2, 2, 5]],
  };
  const gapPatch = {
    position: [18, 18, 5],
    polygon: [[1, 1, 5], [25, 1, 5], [25, 25, 5], [1, 25, 5]],
  };
  const merged = mergeJunctionClusters([osmJunction, gapPatch]);
  assert.equal(merged.length, 1, 'overlapping footprints should produce one merged polygon');
});

test('mergeJunctionClusters keeps overpass clusters separate (Z spread)', () => {
  // Two polygons whose bboxes overlap but whose Z spread exceeds the merge cap.
  // They should NOT be merged into one polygon — that's the layered-overpass case.
  const ground = {
    position: [0, 0, 0],
    polygon: [[-2, -2, 0], [2, -2, 0], [2, 2, 0], [-2, 2, 0]],
  };
  const bridge = {
    position: [0, 0, 10],
    polygon: [[-2, -2, 10], [2, -2, 10], [2, 2, 10], [-2, 2, 10]],
  };
  const merged = mergeJunctionClusters([ground, bridge]);
  assert.equal(merged.length, 2);
});
