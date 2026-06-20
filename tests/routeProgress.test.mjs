import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteProgress } from '../services/routeProgress.js';

test('starts all-pending with 0% and no active chunks', () => {
  const p = createRouteProgress(3);
  const s = p.snapshot();
  assert.equal(s.total, 3);
  assert.equal(s.completed, 0);
  assert.equal(s.overallPct, 0);
  assert.equal(s.activeCount, 0);
  assert.ok(s.chunks.every((c) => c.phase === 'pending' && c.pct === 0));
});

test('reveals concurrency via activeCount/activeIndices', () => {
  const p = createRouteProgress(4);
  p.setPhase(0, 'bake', 'baking');
  p.setPhase(1, 'bake', 'baking');
  const s = p.snapshot();
  assert.equal(s.activeCount, 2); // two chunks baking at once
  assert.deepEqual(s.activeIndices, [0, 1]);
});

test('bake fraction interpolates fill into the [bake, encode) band, monotonic', () => {
  let last = null;
  const p = createRouteProgress(2, (snap) => { last = snap; });
  p.setPhase(0, 'terrain');
  p.setPhase(0, 'bake');
  assert.equal(last.chunks[0].pct, 12); // bake floor
  p.setBakeFraction(0, 0.5);
  assert.equal(last.chunks[0].pct, Math.round(12 + 0.5 * (92 - 12))); // 52
  // never moves backwards
  p.setBakeFraction(0, 0.2);
  assert.equal(last.chunks[0].pct, 52);
});

test('done forces 100 and overallPct weights every chunk', () => {
  const p = createRouteProgress(2);
  p.setPhase(0, 'done');
  p.setPhase(1, 'bake');
  p.setBakeFraction(1, 0.5); // → 52
  const s = p.snapshot();
  assert.equal(s.completed, 1);
  assert.equal(s.chunks[0].pct, 100);
  assert.equal(s.overallPct, Math.round((100 + 52) / 2)); // 76
});

test('onUpdate fires immutable snapshots on each change', () => {
  const seen = [];
  const p = createRouteProgress(1, (snap) => seen.push(snap));
  p.setPhase(0, 'terrain');
  p.setPhase(0, 'done');
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]); // distinct objects
  assert.equal(seen[0].chunks[0].phase, 'terrain');
  assert.equal(seen[1].chunks[0].phase, 'done');
});
