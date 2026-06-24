import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundMask } from '@mapng/bake/groundMask';

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

// ── Phase 2: flat-ground area polygons ──────────────────────────────────────
// A ~40 m square centred on the AOI, given as a lat/lng ring (the parser's shape).
const lngM = (m) => m / 111320; // metres → deg lng (cos≈1 at this latitude)
const C = 100 / 111320;          // AOI centre (lat == lng here) → scene (0,0)
const squareRing = () => {
  const c = C, h = lngM(20);
  return [
    { lat: c - h, lng: c - h }, { lat: c - h, lng: c + h },
    { lat: c + h, lng: c + h }, { lat: c + h, lng: c - h },
  ];
};
const areaFeature = (tags, extra = {}) => ({ type: 'landuse', tags, geometry: squareRing(), ...extra });

test('a parking polygon fills its interior with w≈1 and feathers outside', () => {
  const mask = buildGroundMask([areaFeature({ amenity: 'parking' })], DATA);
  assert.ok(mask, 'a parking area produces a mask');
  assert.ok(mask.sample(0, 0) > 0.95, `interior solid, got ${mask.sample(0, 0)}`);
  assert.ok(mask.sample(zM(10), zM(10)) > 0.9, `well inside is solid`);
  assert.ok(mask.sample(zM(40), zM(40)) < 0.05, `far outside is 0`);
});

test('a pedestrian area=yes is filled; a pedestrian LINE is not', () => {
  // Pedestrian areas arrive as type 'road' with a closed ring — must be filled.
  const area = buildGroundMask([{ type: 'road', tags: { highway: 'pedestrian', area: 'yes' }, geometry: squareRing() }], DATA);
  assert.ok(area && area.sample(0, 0) > 0.95, 'pedestrian area filled');
  // A pedestrian line (no area=yes) stays excluded.
  assert.equal(buildGroundMask([roadFeature({ highway: 'pedestrian' })], DATA), null);
});

test('buildings and bridged/tunnelled areas are never filled', () => {
  assert.equal(buildGroundMask([areaFeature({ building: 'yes', amenity: 'parking' })], DATA), null);
  assert.equal(buildGroundMask([areaFeature({ amenity: 'parking', bridge: 'yes' })], DATA), null);
  assert.equal(buildGroundMask([areaFeature({ amenity: 'parking', layer: '1' })], DATA), null);
});

test('a hole (e.g. a building in a parking lot) is punched out of the fill', () => {
  const c = C, hh = lngM(5);
  const hole = [
    { lat: c - hh, lng: c - hh }, { lat: c - hh, lng: c + hh },
    { lat: c + hh, lng: c + hh }, { lat: c + hh, lng: c - hh },
  ];
  const mask = buildGroundMask([areaFeature({ amenity: 'parking' }, { holes: [hole] })], DATA);
  assert.ok(mask.sample(0, 0) < 0.05, `hole centre is cut out, got ${mask.sample(0, 0)}`);
  assert.ok(mask.sample(zM(12), zM(12)) > 0.9, `outside the hole still filled`);
});
