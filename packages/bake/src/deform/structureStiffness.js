/** @layer core */
// Structure stiffness — the SEMANTIC rigidity field of the deformation concept
// (docs/plan-deformation-stiffness.md). Rasterises OSM structure footprints
// (buildings, man-made structures) into a per-cell stiffness s∈[0,1] on the
// SAME grid the conform's delta field lives on:
//
//   s = 1  space may NOT deform here — the field solve (scalarFieldGrid, weighted
//          relaxation) keeps D locally constant, so the structure translates onto
//          the corrected floor as a RIGID block instead of being bent by the
//          field's cell-to-cell wobble (measured p95 ≈ 2 m/cell on urban AOIs —
//          the "no roof is straight" failure).
//   s = 0  terrain — deforms freely, byte-identical to the pre-stiffness conform.
//
// SEMANTIC ONLY by design: mesh geometry alone cannot tell a tree column beside
// the street from a building facade (field observation 2026-07-03 — street
// trees lit up as unmeasured cells in the bend heatmap exactly like buildings),
// so OSM is the sole authority on what is rigid. A geometric-evidence provider
// (for OSM↔photogrammetry misregistration) stays future work; the bufferM
// dilation below is the v1 mitigation for footprints sitting metres off the
// photogrammetry mesh.
//
// DOM-free and canvas-free (same constraint as groundMask.js / scalarFieldGrid.js)
// so it unit-tests in plain Node and runs identically in the browser bake and
// the headless worker. The polygon helpers mirror groundMask.js.

import { SCENE_SIZE } from '../googleBakeCore.js';
import { createMetricProjector } from '@mapng/geo';

const HALF = SCENE_SIZE / 2;

// A closed OSM polygon that is a rigid STRUCTURE. Deliberately tight and
// semantic: buildings and man-made constructions only — never vegetation,
// landuse, water or anything that may legitimately follow the terrain.
// Bridges are excluded: decks get their own profile-stitch handling and must
// keep following the (stitched) field.
const isStructureFeature = (t) => {
  if (!t) return false;
  if (t.bridge && t.bridge !== 'no') return false;
  if (t.building && t.building !== 'no') return true;
  if (t['building:part'] && t['building:part'] !== 'no') return true;
  if (t.man_made && t.man_made !== 'bridge' && t.man_made !== 'pier') return true;
  return false;
};

const smoothstep = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
};

const segDist = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
};

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

/**
 * Pick the structure footprints out of osmFeatures and project them into scene
 * XZ — the cheap, grid-independent half of the pipeline. The conform rasterises
 * the result onto whatever grid resolution its delta field uses.
 *
 * @param {Array<{geometry:Array<{lat,lng}>, holes?:Array, tags?:object}>} osmFeatures
 * @param {object} data  terrain (bounds, width, height) — the conform's `data`.
 * @returns {null | Array<{ring:Array<{x,z}>, holes:Array<Array<{x,z}>>}>}
 *   null when there are no structures (conform then behaves exactly as before).
 */
export const collectStructureRings = (osmFeatures, data) => {
  if (!Array.isArray(osmFeatures) || osmFeatures.length === 0) return null;
  if (!data || !data.bounds || !data.width || !data.height) return null;
  const project = createMetricProjector(data.bounds, data.width, data.height);
  // lat/lng → scene XZ, identical to groundMask.js so both semantic fields
  // (road snap mask, structure stiffness) live in the conform's frame.
  const toScene = (lat, lng) => {
    const p = project(lat, lng);
    return {
      x: (p.x / (data.width - 1)) * SCENE_SIZE - HALF,
      z: (p.y / (data.height - 1)) * SCENE_SIZE - HALF,
    };
  };
  const out = [];
  for (const f of osmFeatures) {
    if (!f || !Array.isArray(f.geometry) || f.geometry.length < 3) continue;
    if (!isStructureFeature(f.tags || {})) continue;
    out.push({
      ring: f.geometry.map((p) => toScene(p.lat, p.lng)),
      holes: Array.isArray(f.holes)
        ? f.holes.filter((h) => Array.isArray(h) && h.length >= 3).map((h) => h.map((p) => toScene(p.lat, p.lng)))
        : [],
    });
  }
  return out.length ? out : null;
};

/**
 * Rasterise structure rings into a stiffness grid (row-major n×n, the
 * scalarFieldGrid cell layout). Max-combined across structures.
 *
 *   s = 1                     inside the ring (minus holes) AND within bufferM
 *                             outside it — the buffer absorbs the typical
 *                             OSM↔photogrammetry registration offset so a
 *                             footprint a couple of metres off still covers
 *                             its actual mesh;
 *   s = smoothstep → 0        across featherM beyond the buffer — the soft rim
 *                             where the field solve is allowed to spend the
 *                             gradient it may not spend inside the structure.
 *
 * Courtyard holes keep s of the ring around them (a hole is still spanned by
 * the same rigid building), so they are NOT cut out — unlike the road mask,
 * where a hole means "no snap here".
 *
 * @param {Array<{ring,holes}>} rings  collectStructureRings output.
 * @param {object} opts
 * @param {number} opts.n              cells per side (the delta-field grid).
 * @param {number} opts.unitsPerMeter  scene units per metre.
 * @param {number} [opts.bufferM=3]    full-stiffness dilation outside the ring.
 * @param {number} [opts.featherM=6]   soft rim beyond the buffer.
 * @returns {Float32Array} n×n stiffness, 0 where no structure reaches.
 */
export const rasterizeStructureStiffness = (rings, { n, unitsPerMeter, bufferM = 3, featherM = 6 }) => {
  const s = new Float32Array(n * n);
  if (!rings || !rings.length) return s;
  const buffer = bufferM * unitsPerMeter;
  const feather = featherM * unitsPerMeter;
  const reach = buffer + feather;
  const toGrid = (v) => ((v + HALF) / SCENE_SIZE) * n;

  for (const { ring } of rings) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const cx0 = Math.max(0, Math.floor(toGrid(minX - reach)));
    const cx1 = Math.min(n - 1, Math.ceil(toGrid(maxX + reach)));
    const cz0 = Math.max(0, Math.floor(toGrid(minZ - reach)));
    const cz1 = Math.min(n - 1, Math.ceil(toGrid(maxZ + reach)));
    for (let cz = cz0; cz <= cz1; cz++) {
      const pz = ((cz + 0.5) / n) * SCENE_SIZE - HALF;
      for (let cx = cx0; cx <= cx1; cx++) {
        const i = cz * n + cx;
        if (s[i] >= 1) continue; // already fully rigid — skip the geometry tests
        const px = ((cx + 0.5) / n) * SCENE_SIZE - HALF;
        let w;
        if (pointInRing(px, pz, ring)) {
          w = 1;
        } else {
          const d = distToRing(px, pz, ring);
          if (d >= reach) continue;
          w = d <= buffer ? 1 : smoothstep((reach - d) / feather);
        }
        if (w > s[i]) s[i] = w;
      }
    }
  }
  return s;
};

