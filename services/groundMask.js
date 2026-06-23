// Semantic ground mask — rasterises OSM road polylines AND flat-ground area
// polygons (parking, plazas, pedestrian areas) into a smooth per-(x,z)
// coverage field w∈[0,1] over the Google-bake SCENE plane (X/Z in scene units,
// [-SCENE_SIZE/2, +SCENE_SIZE/2]). tileGroundConform uses it to SNAP geometry it
// KNOWS is flat ground (roads) onto the DEM at full resolution — flattening
// photogrammetry wiggle and pulling down floaters that the smooth delta field's
// ±band classifier never corrects.
//
// Why a fresh rasteriser and not batchExports.generateRoadMaskBlob: the conform
// runs in the headless sidecar worker too, where there is NO canvas. This module
// is canvas-free (proj4 via geoUtils only), so it unit-tests in plain Node and
// runs identically in the browser bake and the worker — same constraint
// scalarFieldGrid.js already satisfies.

import { SCENE_SIZE, computeUnitsPerMeter } from './googleBakeCore.js';
import { createMetricProjector } from '@mapng/geo';

const HALF = SCENE_SIZE / 2;

// Highway classes that are NOT drivable flat ground — never snap them.
const EXCLUDE_HIGHWAY = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway', 'corridor',
]);

// Per-class carriageway HALF-width in metres (full road ≈ 2×). Replaces
// generateRoadMaskBlob's fixed 8 px stamp so the mask tracks the real footprint.
const HALF_WIDTH_M = {
  motorway: 12, trunk: 10, primary: 8, secondary: 6, tertiary: 5,
  residential: 4, unclassified: 4, living_street: 4, service: 3,
  default: 4,
};

// Closed OSM polygons that ARE flat man-made ground — snappable like roads. Tag-
// based (NOT feature.type, which buckets parking under "landuse" and pedestrian
// areas under "road"). Deliberately tight: clearly-paved/flat ground only, never
// buildings, water, grass, or anything that could legitimately slope.
const isFlatGroundArea = (t) => {
  if (!t || t.building) return false;
  if (t.amenity === 'parking') return true;
  if (t.place === 'square') return true;
  if (t['area:highway']) return true;
  if (t.area === 'yes' && (
    t.highway === 'pedestrian' || t.highway === 'footway' ||
    t.highway === 'living_street' || t.highway === 'service'
  )) return true;
  return false;
};

const smoothstep = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};

// Distance from point (px,pz) to segment a→b (scene units).
const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx, qz = az + t * dz;
  return Math.hypot(px - qx, pz - qz);
};

// Even-odd ray cast — is (px,pz) inside the closed ring of {x,z} points?
const pointInRing = (px, pz, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
    if (((zi > pz) !== (zj > pz)) && (px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
};

const distToRing = (px, pz, ring) => {
  let min = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = segDist(px, pz, ring[j].x, ring[j].z, ring[i].x, ring[i].z);
    if (d < min) min = d;
  }
  return min;
};

// Fill a polygon area into the coverage grid: w=1 inside the outer ring (minus any
// holes), smoothstepping to 0 over `feather` scene units OUTSIDE the boundary so
// the snap blends into the surrounding delta-field result. ring/holes are {x,z}.
const stampPolygon = (cov, n, ring, holes, feather) => {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  const toGrid = (s) => ((s + HALF) / SCENE_SIZE) * n;
  const cx0 = Math.max(0, Math.floor(toGrid(minX - feather)));
  const cx1 = Math.min(n - 1, Math.ceil(toGrid(maxX + feather)));
  const cz0 = Math.max(0, Math.floor(toGrid(minZ - feather)));
  const cz1 = Math.min(n - 1, Math.ceil(toGrid(maxZ + feather)));

  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = ((cz + 0.5) / n) * SCENE_SIZE - HALF;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = ((cx + 0.5) / n) * SCENE_SIZE - HALF;
      let w;
      if (pointInRing(px, pz, ring)) {
        let inHole = false;
        for (const h of holes) { if (pointInRing(px, pz, h)) { inHole = true; break; } }
        if (inHole) continue; // building/courtyard cut out — leave to the delta field
        w = 1;
      } else {
        const d = distToRing(px, pz, ring);
        if (d >= feather) continue;
        w = smoothstep((feather - d) / feather);
      }
      const i = cz * n + cx;
      if (w > cov[i]) cov[i] = w;
    }
  }
};

// Stamp one road segment into the coverage grid: every cell whose centre is
// within (halfW + feather) scene units of the segment gets w = 1 inside the
// carriageway, smoothstepping to 0 across the feather band. max-combined so
// overlapping segments don't darken each other.
const stampSegment = (cov, n, ax, az, bx, bz, halfW, feather, reach) => {
  const toGrid = (s) => ((s + HALF) / SCENE_SIZE) * n;
  let cx0 = Math.floor(toGrid(Math.min(ax, bx) - reach));
  let cx1 = Math.ceil(toGrid(Math.max(ax, bx) + reach));
  let cz0 = Math.floor(toGrid(Math.min(az, bz) - reach));
  let cz1 = Math.ceil(toGrid(Math.max(az, bz) + reach));
  cx0 = Math.max(0, cx0); cz0 = Math.max(0, cz0);
  cx1 = Math.min(n - 1, cx1); cz1 = Math.min(n - 1, cz1);

  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = ((cz + 0.5) / n) * SCENE_SIZE - HALF;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = ((cx + 0.5) / n) * SCENE_SIZE - HALF;
      const edge = segDist(px, pz, ax, az, bx, bz) - halfW;
      let w;
      if (edge <= 0) w = 1;
      else if (edge >= feather) continue;
      else w = smoothstep((feather - edge) / feather);
      const i = cz * n + cx;
      if (w > cov[i]) cov[i] = w;
    }
  }
};

/**
 * Build a ground-coverage mask for the conform (roads + flat-ground areas).
 * @param {Array<{type:string, geometry:Array<{lat:number,lng:number}>, holes?:Array, tags?:object}>} osmFeatures
 * @param {object} data  terrain (bounds, width, height) — the same object the conform gets.
 * @param {object} [opts]
 * @param {number} [opts.featherM=3]  soft-edge width (metres) beyond the carriageway,
 *   so the snap blends into the surrounding delta-field result without tearing the mesh.
 * @param {number} [opts.cellM]  mask cell size (metres). Default ≈ the DEM raster
 *   (~1 m/px), capped at 2048 cells/side so a large corridor AOI can't blow up memory.
 * @returns {null | { sample(x:number, z:number):number, n:number, coverage:Float32Array }}
 *   null when there are no snappable roads — caller falls back to the delta field alone.
 */
export const buildGroundMask = (osmFeatures, data, { featherM = 3, cellM } = {}) => {
  if (!Array.isArray(osmFeatures) || osmFeatures.length === 0) return null;
  if (!data || !data.bounds || !data.width || !data.height) return null;

  const upm = computeUnitsPerMeter(data); // scene units per metre (for X/Z)
  const defaultN = Math.max(data.width, data.height) || 256;
  const n = Math.max(1, Math.min(2048, cellM
    ? Math.round(SCENE_SIZE / (cellM * upm))
    : defaultN));

  const project = createMetricProjector(data.bounds, data.width, data.height);
  // lat/lng → scene XZ, identical to export3d.latLngToScene so the mask lines up
  // with sampleHeightAtScene's frame.
  const toScene = (lat, lng) => {
    const p = project(lat, lng);
    return {
      x: (p.x / (data.width - 1)) * SCENE_SIZE - HALF,
      z: (p.y / (data.height - 1)) * SCENE_SIZE - HALF,
    };
  };

  const coverage = new Float32Array(n * n);
  const featherScene = featherM * upm;
  let stamped = 0;

  for (const f of osmFeatures) {
    if (!f || !Array.isArray(f.geometry)) continue;
    const t = f.tags || {};
    // Bridges / tunnels / stacked layers are legitimately off the DEM — snapping
    // them to the floor would be wrong, so they never enter the mask (roads OR areas).
    if (t.bridge && t.bridge !== 'no') continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer != null && Number(t.layer) !== 0) continue;

    // Flat ground AREA (parking, plaza, pedestrian area) — fill the polygon.
    // Checked first: a pedestrian area arrives as type 'road' with a closed ring,
    // and must be filled, not stamped as a centreline.
    if (isFlatGroundArea(t) && f.geometry.length >= 3) {
      const ring = f.geometry.map((p) => toScene(p.lat, p.lng));
      const holes = Array.isArray(f.holes)
        ? f.holes.filter((h) => Array.isArray(h) && h.length >= 3).map((h) => h.map((p) => toScene(p.lat, p.lng)))
        : [];
      stampPolygon(coverage, n, ring, holes, featherScene);
      stamped++;
      continue;
    }

    // Drivable ROAD line — stamp each segment with its carriageway width.
    if (f.type === 'road' && f.geometry.length >= 2) {
      if (t.highway && EXCLUDE_HIGHWAY.has(t.highway)) continue;
      const halfWScene = (HALF_WIDTH_M[t.highway] ?? HALF_WIDTH_M.default) * upm;
      const reach = halfWScene + featherScene;
      let prev = toScene(f.geometry[0].lat, f.geometry[0].lng);
      for (let i = 1; i < f.geometry.length; i++) {
        const cur = toScene(f.geometry[i].lat, f.geometry[i].lng);
        stampSegment(coverage, n, prev.x, prev.z, cur.x, cur.z, halfWScene, featherScene, reach);
        prev = cur;
        stamped++;
      }
    }
  }
  if (stamped === 0) return null;

  // bilinear read on cell centres, edge-clamped (mirrors scalarFieldGrid.sample).
  const sample = (x, z) => {
    const fx = ((x + HALF) / SCENE_SIZE) * n - 0.5;
    const fz = ((z + HALF) / SCENE_SIZE) * n - 0.5;
    const x0 = Math.min(n - 1, Math.max(0, Math.floor(fx)));
    const z0 = Math.min(n - 1, Math.max(0, Math.floor(fz)));
    const x1 = Math.min(n - 1, x0 + 1);
    const z1 = Math.min(n - 1, z0 + 1);
    const tx = Math.min(1, Math.max(0, fx - x0));
    const tz = Math.min(1, Math.max(0, fz - z0));
    const v00 = coverage[z0 * n + x0];
    const v10 = coverage[z0 * n + x1];
    const v01 = coverage[z1 * n + x0];
    const v11 = coverage[z1 * n + x1];
    return (
      v00 * (1 - tx) * (1 - tz) +
      v10 * tx * (1 - tz) +
      v01 * (1 - tx) * tz +
      v11 * tx * tz
    );
  };

  return { sample, n, coverage };
};
