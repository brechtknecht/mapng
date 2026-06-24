import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSyntheticRoute, analyzeRoute } from '../tools/testlab/routeScene.mjs';

// Mean (not max) per-chunk residual vs the COMBINED terrain — the surface the
// car drives on. Max is dominated by edge-resampling noise between the fine
// per-chunk DEM and the coarser combined grid; mean captures a real lift.
const worstMean = (r) => Math.max(...r.perChunk.map((c) => c.meanAbsResidualM));

test('baseline: matching DEMs, uniform geoid → every chunk seats on the floor', () => {
  const route = buildSyntheticRoute({ nChunks: 3, biasPerChunk: [0, 0, 0], geoidPerChunk: [-32, -32, -32] });
  const r = analyzeRoute(route, { conformMode: 'perChunk' });
  assert.ok(worstMean(r) < 0.15, `all chunks seated, worst mean ${worstMean(r).toFixed(3)} m`);
});

test('shared-anchor geoid drift is fully absorbed by the per-chunk conform', () => {
  // Later chunks bake with chunk 0's anchor, so without the conform they float
  // by the geoid drift. The conform must remove it (uniform within a chunk, in band).
  const route = buildSyntheticRoute({ nChunks: 4, geoidPerChunk: [-32, -32.8, -33.6, -34.4] });
  const off = analyzeRoute(route, { conformMode: 'off' });
  const on = analyzeRoute(route, { conformMode: 'perChunk' });
  assert.ok(worstMean(off) > 1.0, `precondition: drift floats chunks without conform (${worstMean(off).toFixed(2)} m)`);
  assert.ok(worstMean(on) < 0.3, `conform absorbs the drift, worst mean ${worstMean(on).toFixed(3)} m`);
});

test('per-chunk DEM disagreement leaves a seam lift the per-chunk conform cannot fix', () => {
  // Adjacent chunks' DEMs differ by ~1 m (different elevation tiles / resampling).
  // The conform seats each chunk on its OWN terrain, but the combined terrain
  // (driven on) blits chunks in order, so overlap regions take a neighbour's
  // height → a residual vs the combined surface. This is the reported symptom.
  const route = buildSyntheticRoute({ nChunks: 3, biasPerChunk: [0, 1.0, -0.5], overlapFrac: 0.2 });
  const perChunk = analyzeRoute(route, { conformMode: 'perChunk' });
  assert.ok(worstMean(perChunk) > 0.35, `reproduces the lift, worst mean ${worstMean(perChunk).toFixed(2)} m`);

  // The fix: conform each chunk against the COMBINED terrain instead of its own.
  const combined = analyzeRoute(route, { conformMode: 'combined' });
  assert.ok(worstMean(combined) < 0.2, `conforming vs combined removes the lift, worst mean ${worstMean(combined).toFixed(3)} m`);
});

test('the conform is doing the work: turning it off regresses the drift case', () => {
  const route = buildSyntheticRoute({ nChunks: 3, geoidPerChunk: [-32, -33, -34] });
  const off = analyzeRoute(route, { conformMode: 'off' });
  const on = analyzeRoute(route, { conformMode: 'perChunk' });
  assert.ok(worstMean(off) > worstMean(on) + 0.5, `conform clearly improves seating (${worstMean(off).toFixed(2)} → ${worstMean(on).toFixed(2)} m)`);
});
