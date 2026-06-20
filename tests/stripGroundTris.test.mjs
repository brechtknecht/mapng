import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripGroundTris } from '../services/googleBakeCore.js';

// Flat terrain at height 0, so a vertex's metres-Y == its height above terrain.
const DATA = {
  width: 2,
  height: 2,
  minHeight: 0,
  heightMap: new Float32Array([0, 0, 0, 0]),
  bounds: { north: 48.001, south: 48.0, east: 11.001, west: 11.0 },
};

const tri = (positions) => ({ positions: new Float32Array(positions), index: new Uint16Array([0, 1, 2]) });

test('strips a near-flat tri at terrain level', () => {
  const flat = tri([0, 0, 0, 2, 0, 0, 2, 0, 2]); // horizontal at y=0
  const { indices, removed, total } = stripGroundTris([flat], DATA);
  assert.equal(total, 1);
  assert.equal(removed, 1);
  assert.equal(indices[0].length, 0, 'the ground tri is gone');
});

test('keeps an elevated flat roof (above groundDistanceM)', () => {
  const roof = tri([0, 10, 0, 2, 10, 0, 2, 10, 2]); // horizontal at y=10
  const { indices, removed } = stripGroundTris([roof], DATA);
  assert.equal(removed, 0);
  assert.equal(indices[0].length, 3, 'roof survives');
});

test('keeps a vertical wall near terrain (not near-flat)', () => {
  const wall = tri([0, 0, 0, 0, 3, 0, 0, 0, 2]); // vertical, normal is horizontal
  const { indices, removed } = stripGroundTris([wall], DATA);
  assert.equal(removed, 0);
  assert.equal(indices[0].length, 3, 'wall survives');
});
