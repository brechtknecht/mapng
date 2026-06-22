import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundMask } from '../services/groundMask.js';

// 200 m AOI ⇒ unitsPerMeter = SCENE_SIZE(100) / 200 = 0.5 scene units per metre.
// heightMap is unused by the mask (it only rasterises OSM polylines).
const DATA = {
  width: 200,
  height: 200,
  minHeight: 0,
  heightMap: new Float32Array(0),
  bounds: { south: 0, north: 200 / 111320, west: 0, east: 200 / 111320 },
};
const C_LAT = 100 / 111320; // centre latitude → scene Z ≈ 0
const UPM = 0.5;
const zM = (m) => m * UPM; // metres → scene Z

// A straight east–west road through the AOI centre.
const roadFeature = (tags) => ({
  type: 'road',
  tags,
  geometry: [
    { lat: C_LAT, lng: 5 / 111320 },
    { lat: C_LAT, lng: 195 / 111320 },
  ],
});

test('road centreline reads w≈1, feathers to 0 past the carriageway', () => {
  const mask = buildGroundMask([roadFeature({ highway: 'residential' })], DATA);
  assert.ok(mask, 'a residential road produces a mask');

  // residential half-width = 4 m, feather = 3 m → solid to 4 m, zero beyond 7 m.
  assert.ok(mask.sample(0, 0) > 0.95, `centreline solid, got ${mask.sample(0, 0)}`);
  assert.ok(mask.sample(0, zM(3)) > 0.9, `inside carriageway, got ${mask.sample(0, zM(3))}`);
  const mid = mask.sample(0, zM(5.5)); // halfway through the feather
  assert.ok(mid > 0.15 && mid < 0.85, `feather mid in (0,1), got ${mid}`);
  assert.ok(mask.sample(0, zM(10)) < 0.05, `well outside is 0, got ${mask.sample(0, zM(10))}`);
});

test('carriageway width scales with highway class', () => {
  const res = buildGroundMask([roadFeature({ highway: 'residential' })], DATA);
  const mot = buildGroundMask([roadFeature({ highway: 'motorway' })], DATA);
  // 10 m off-centre: outside a 4 m residential road, inside a 12 m motorway.
  assert.ok(res.sample(0, zM(10)) < 0.05, `residential narrow, got ${res.sample(0, zM(10))}`);
  assert.ok(mot.sample(0, zM(10)) > 0.9, `motorway wide, got ${mot.sample(0, zM(10))}`);
});

test('bridges, tunnels and stacked layers are excluded (never snapped to the DEM)', () => {
  assert.equal(buildGroundMask([roadFeature({ highway: 'residential', bridge: 'yes' })], DATA), null);
  assert.equal(buildGroundMask([roadFeature({ highway: 'residential', tunnel: 'yes' })], DATA), null);
  assert.equal(buildGroundMask([roadFeature({ highway: 'residential', layer: '1' })], DATA), null);
  // bridge=no is a real surface road and must still mask.
  assert.ok(buildGroundMask([roadFeature({ highway: 'residential', bridge: 'no' })], DATA));
});

test('non-drivable ways and empty input yield no mask', () => {
  assert.equal(buildGroundMask([roadFeature({ highway: 'footway' })], DATA), null);
  assert.equal(buildGroundMask([], DATA), null);
  assert.equal(buildGroundMask(null, DATA), null);
  // a building (not a road) is ignored.
  assert.equal(buildGroundMask([{ type: 'building', geometry: [{ lat: C_LAT, lng: 0 }] }], DATA), null);
});
