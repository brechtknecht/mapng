// Semantic ground mask — rasterises OSM road polylines into a smooth per-(x,z)
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
import { createMetricProjector } from './geoUtils.js';

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

const smoothstep = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
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

  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;

  for (let cz = cz0; cz <= cz1; cz++) {
    const pz = ((cz + 0.5) / n) * SCENE_SIZE - HALF;
    for (let cx = cx0; cx <= cx1; cx++) {
      const px = ((cx + 0.5) / n) * SCENE_SIZE - HALF;
      // distance from cell centre to the segment
      let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + t * dx, qz = az + t * dz;
      const ddx = px - qx, ddz = pz - qz;
      const dist = Math.sqrt(ddx * ddx + ddz * ddz);
      const edge = dist - halfW;
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
 * Build a road-coverage mask for the conform.
 * @param {Array<{type:string, geometry:Array<{lat:number,lng:number}>, tags?:object}>} osmFeatures
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
  let segments = 0;

  for (const f of osmFeatures) {
    if (!f || f.type !== 'road' || !Array.isArray(f.geometry) || f.geometry.length < 2) continue;
    const t = f.tags || {};
    if (t.highway && EXCLUDE_HIGHWAY.has(t.highway)) continue;
    // Bridges / tunnels / stacked layers are legitimately off the DEM — snapping
    // them to the floor would be wrong, so they never enter the mask.
    if (t.bridge && t.bridge !== 'no') continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.layer != null && Number(t.layer) !== 0) continue;

    const halfWScene = (HALF_WIDTH_M[t.highway] ?? HALF_WIDTH_M.default) * upm;
    const reach = halfWScene + featherScene;

    let prev = toScene(f.geometry[0].lat, f.geometry[0].lng);
    for (let i = 1; i < f.geometry.length; i++) {
      const cur = toScene(f.geometry[i].lat, f.geometry[i].lng);
      stampSegment(coverage, n, prev.x, prev.z, cur.x, cur.z, halfWScene, featherScene, reach);
      prev = cur;
      segments++;
    }
  }
  if (segments === 0) return null;

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
