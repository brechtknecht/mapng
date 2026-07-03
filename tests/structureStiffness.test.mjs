import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectStructureRings, rasterizeStructureStiffness } from '@mapng/bake/deform/structureStiffness';

// ~100 m AOI ⇒ unitsPerMeter ≈ 1 (same frame as tileGroundConform.test.mjs).
const DATA = {
  width: 2,
  height: 2,
  minHeight: 0,
  heightMap: new Float32Array([0, 0, 0, 0]),
  bounds: { south: 0, north: 100 / 111320, west: 0, east: 100 / 111320 },
};

// lat/lng roughly centred in the AOI, offset by metres.
const ll = (eastM, northM) => ({ lat: (northM / 111320), lng: (eastM / 111320) });
const squareGeom = (cx, cz, halfM) => [
  ll(cx - halfM, cz - halfM), ll(cx + halfM, cz - halfM),
  ll(cx + halfM, cz + halfM), ll(cx - halfM, cz + halfM),
];

test('collectStructureRings keeps buildings/man_made, rejects ground/vegetation/bridges', () => {
  const rings = collectStructureRings([
    { geometry: squareGeom(50, 50, 10), tags: { building: 'yes' } },
    { geometry: squareGeom(30, 30, 5), tags: { man_made: 'water_tower' } },
    { geometry: squareGeom(20, 20, 5), tags: { natural: 'wood' } },          // vegetation — never rigid
    { geometry: squareGeom(60, 60, 5), tags: { amenity: 'parking' } },       // flat ground — road mask's job
    { geometry: squareGeom(70, 70, 5), tags: { building: 'yes', bridge: 'yes' } }, // deck handling wins
    { type: 'road', geometry: [ll(0, 0), ll(90, 90)], tags: { highway: 'residential' } },
  ], DATA);
  assert.equal(rings.length, 2, 'building + man_made only');
});

test('collectStructureRings returns null when nothing qualifies', () => {
  assert.equal(collectStructureRings([{ type: 'road', geometry: [ll(0, 0), ll(9, 9)], tags: {} }], DATA), null);
  assert.equal(collectStructureRings([], DATA), null);
});

test('rasterize: rigid core incl. buffer, feathered rim, zero far away', () => {
  // Square footprint ±15 scene units around the origin, on a fine grid so the
  // buffer/feather bands resolve.
  const ring = [{ x: -15, z: -15 }, { x: 15, z: -15 }, { x: 15, z: 15 }, { x: -15, z: 15 }];
  const n = 100; // 1 unit/cell over the 100-unit scene
  const s = rasterizeStructureStiffness([{ ring, holes: [] }], { n, unitsPerMeter: 1, bufferM: 3, featherM: 6 });
  const at = (x, z) => s[Math.floor(((z + 50) / 100) * n) * n + Math.floor(((x + 50) / 100) * n)];
  assert.equal(at(0, 0), 1, 'core is fully rigid');
  assert.equal(at(16.5, 0), 1, 'buffer band (misregistration guard) is fully rigid');
  const rim = at(21, 0); // ~3 units into the 6-unit feather
  assert.ok(rim > 0 && rim < 1, `feather rim is graded, got ${rim}`);
  assert.equal(at(40, 0), 0, 'far cells untouched');
});

test('rasterize: courtyard holes stay rigid (the building spans them)', () => {
  const ring = [{ x: -20, z: -20 }, { x: 20, z: -20 }, { x: 20, z: 20 }, { x: -20, z: 20 }];
  const hole = [{ x: -5, z: -5 }, { x: 5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 }];
  const n = 100;
  const s = rasterizeStructureStiffness([{ ring, holes: [hole] }], { n, unitsPerMeter: 1 });
  assert.equal(s[Math.floor(0.5 * n) * n + Math.floor(0.5 * n)], 1, 'courtyard centre still rigid');
});
