/** @layer core */
// Cross-tile seam handling on assembled triangle soup: weldSeams (LOD-agnostic
// per-XZ ground consensus that closes tile-edge seams while protecting walls)
// and stripGroundTris (drop near-flat tris near the .ter so the heightmap shows
// through). Pure / DOM-free — imported by both the browser bake and the headless
// node worker. Extracted from googleBakeCore.js (docs/refactor/06 step 2);
// googleBakeCore re-exports both. Covered by tests/weldSeams + stripGroundTris.

import { SCENE_SIZE, computeUnitsPerMeter } from '../scene/sceneFrame.js';
import { sampleHeightAtScene } from '../scene/sceneSample.js';

/**
 * Close tile seams by WELDING, not deleting — the root-cause alternative to
 * stripSeamRisers. Works for ANY two overlapping tiles, same LOD or different
 * (the in-AOI mass of a small bake is all the SAME finest LOD, so a finer-only
 * weld did nothing — this is why it must be LOD-agnostic).
 *
 * The riser exists because two overlapping tiles disagree slightly about the
 * ground height at their shared boundary, standing the step up as a short wall.
 * Instead of guessing "is this triangle a wall?" (the 8 magic thresholds of
 * stripSeamRisers), build a per-XZ-cell ground CONSENSUS and pull every vertex
 * onto its own cell's consensus:
 *   • a strictly finer cell      → coarse vertex yields to the finer ground
 *   • a same-LOD multi-tile cell → both tiles meet at the shared mean
 * Both tiles' verts in one cell resolve to the IDENTICAL mean, so they meet
 * exactly and the pass is idempotent (re-welding is a no-op).
 *
 * Three gates keep REAL geometry intact — the failure mode that made an earlier
 * cut eat building walls:
 *   • cohereM   — a cell only welds if its ground spans ≤ this (a real step,
 *                 e.g. plaza-vs-street, has a big spread → left alone)
 *   • maxRiserM — a vertex more than this ABOVE the local ground floor is a
 *                 wall/façade, never a ground-level riser → never moved
 *   • bandM     — a vertex only moves to ground within this vertical reach
 * All three sit above seam disagreement (decimetres) and below real walls
 * (metres); they're env-tunable in the worker.
 *
 * Pure and DOM-free, like stripSeamRisers, so preview and headless export weld
 * identically. Does NOT mutate inputs — returns a new position array per moved
 * mesh (null when a mesh didn't move).
 *
 * @param {Array<{positions:ArrayLike<number>, index:ArrayLike<number>, lod:number}>} meshes
 *   positions are [sceneX, metersY, sceneZ]; `lod` is the owning tile's
 *   geometricError (SMALLER = finer). index is required to find ground tris.
 * @param {object} opts
 * @returns {{ positions: Array<Float32Array|null>, meshesMoved:number, vertsMoved:number }}
 */
export const weldSeams = (meshes, opts = {}) => {
  const {
    unitsPerMeter,            // scene units per metre (X/Z) — REQUIRED to metricise
    cellM = 1.0,              // height-field cell size (m)
    // The discriminator between a SEAM (close to weld) and a REAL feature
    // (leave). A vertex welds ONLY when all three hold, which is what keeps
    // building walls / curbs intact while still closing tile seams:
    //   • bandM    — it's within this of the target ground (vertical reach)
    //   • cohereM  — the target cell's own ground spans ≤ this (not a real step)
    //   • maxRiserM— it sits ≤ this ABOVE the local ground (a riser is a
    //                ground-level thing; a wall rises well above and is skipped)
    // All three sit ABOVE typical seam disagreement (decimetres) and BELOW real
    // walls (metres). Env-tunable in the worker (MAPNG_WELD_BAND_M /
    // MAPNG_WELD_COHERE_M / MAPNG_WELD_MAX_RISER_M).
    bandM = 1.5,
    cohereM = 1.5,
    maxRiserM = 2.5,
    groundNormalY = 0.85,     // |n.y| above this counts a triangle as ground
  } = opts;
  if (!unitsPerMeter || !Number.isFinite(unitsPerMeter)) {
    throw new Error('weldSeams: unitsPerMeter required');
  }
  // Keep the height-field grid bounded no matter the AOI size: a multi-km
  // ultra AOI at a 1 m cell would blow V8's Map cap. Grow the cell so
  // cells-per-axis stays well under the limit (large AOIs ride coarser tiles,
  // so a metre or three of cell makes no visible difference to the weld).
  const metricExtent = SCENE_SIZE / unitsPerMeter; // AOI width in metres
  const effCellM = Math.max(cellM, metricExtent / 2000);
  const invUpm = 1 / unitsPerMeter; // scene units → metres
  const invCell = 1 / effCellM;
  const keyOf = (gx, gz) => (gx + 1e6) * 4e6 + (gz + 1e6);

  // --- Pass A: per-cell ground consensus. A cell keeps the FINEST lod it sees
  //     and the mean / min / max Y of the ground samples AT that finest lod,
  //     plus whether ≥2 distinct tiles contribute there. This is what makes the
  //     weld LOD-agnostic: two SAME-LOD tiles overlapping at a seam both land in
  //     the cell, so Pass B can snap them to their shared mean — which is the
  //     case stripSeamRisers handled and the earlier finer-only weld missed.
  //     Samples coarser than a cell's finest are dropped (a coarse vertex welds
  //     to the finer cell it sits in, never the reverse).
  const grid = new Map();
  const addGround = (xm, zm, y, lod, tile) => {
    const k = keyOf(Math.floor(xm * invCell), Math.floor(zm * invCell));
    let c = grid.get(k);
    // allMinY tracks the lowest ground at this XZ across EVERY lod — the local
    // ground floor used to protect tall structures (a vertex far above it is a
    // wall, not a riser, and is never welded).
    if (!c) { grid.set(k, { lod, sumY: y, cnt: 1, minY: y, maxY: y, allMinY: y, tile0: tile, multi: false }); return; }
    if (y < c.allMinY) c.allMinY = y;
    if (lod < c.lod) { c.lod = lod; c.sumY = y; c.cnt = 1; c.minY = y; c.maxY = y; c.tile0 = tile; c.multi = false; }
    else if (lod === c.lod) {
      c.sumY += y; c.cnt++;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (tile !== c.tile0) c.multi = true;
    }
  };
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const p = m.positions, idx = m.index, lod = m.lod;
    if (!idx || !p) continue;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ax = p[a] * invUpm, ay = p[a + 1], az = p[a + 2] * invUpm;
      const bx = p[b] * invUpm, by = p[b + 1], bz = p[b + 2] * invUpm;
      const cx = p[c] * invUpm, cy = p[c + 1], cz = p[c + 2] * invUpm;
      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nlen < 1e-12) continue;
      if (Math.abs(ny) / nlen > groundNormalY) {
        addGround(ax, az, ay, lod, mi);
        addGround(bx, bz, by, lod, mi);
        addGround(cx, cz, cy, lod, mi);
      }
    }
  }

  // --- Pass B: snap each vertex onto the authoritative ground at its XZ.
  //   • a strictly finer cell (lod < own)        → snap (coarse yields to fine)
  //   • a same-LOD cell shared with another tile  → snap (both sides meet at mean)
  //   • a single-tile own-LOD cell (interior)     → leave
  //   • an INCOHERENT cell (spread > cohereM)      → leave (a real wall/step)
  //   • a vertex > bandM from the ground           → leave (façade / roof edge)
  const positions = new Array(meshes.length).fill(null);
  let meshesMoved = 0, vertsMoved = 0;
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const p = m.positions, lod = m.lod;
    if (!p) continue;
    const vCount = p.length / 3;
    let copy = null;
    for (let vi = 0; vi < vCount; vi++) {
      const xm = p[vi * 3] * invUpm, ym = p[vi * 3 + 1], zm = p[vi * 3 + 2] * invUpm;
      // OWN cell only. Both tiles' verts in a shared boundary cell resolve to
      // the IDENTICAL mean, so they meet exactly and the pass is idempotent
      // (interior verts sit in single-tile cells and never move).
      const c = grid.get(keyOf(Math.floor(xm * invCell), Math.floor(zm * invCell)));
      if (!c) continue;
      if (c.lod > lod) continue;                  // cell's ground is coarser than me → not authoritative
      if (c.maxY - c.minY > cohereM) continue;    // cell straddles a real step → preserve it
      // own-LOD, single-tile cell = interior of my own surface → never weld
      if (c.lod === lod && !c.multi && c.tile0 === mi) continue;
      // Protect tall structure: a vertex more than maxRiserM above the local
      // ground floor is a wall/façade, not a ground-level seam riser.
      if (ym - c.allMinY > maxRiserM) continue;
      const my = c.sumY / c.cnt;
      if (Math.abs(my - ym) > bandM) continue;    // too far to be the same surface
      if (my !== ym) {
        if (!copy) copy = Float32Array.from(p);
        copy[vi * 3 + 1] = my;
        vertsMoved++;
      }
    }
    if (copy) { positions[mi] = copy; meshesMoved++; }
  }

  return { positions, meshesMoved, vertsMoved };
};

/**
 * Ground strip as a STANDALONE pass over assembled triangle soup — the same
 * "drop near-flat tris within groundDistanceM of the mapng terrain" logic that
 * used to live inside createTileMeshTransformer, lifted out so it can run AFTER
 * the seam weld.
 *
 * Why the move matters (the street-seam fix): when the strip ran inside the
 * transform, it deleted the street surface BEFORE the weld, so on streets the
 * weld had no ground left to snap the tile-edge risers onto and the little
 * walls survived on the bare terrain. Order is now
 *   transform (keep ground) → weld (risers fall onto the street) → strip ground
 * so the flattened risers are removed together with the street they sat on.
 *
 * Pure / DOM-free. Returns new index arrays (same ref when nothing removed).
 *
 * @param {Array<{positions:ArrayLike<number>, index:ArrayLike<number>}>} meshes
 *   positions are [sceneX, metersY, sceneZ].
 */
export const stripGroundTris = (meshes, data, {
  groundNormalThreshold = 0.85,
  groundDistanceM = 2.5,
} = {}) => {
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  const upm = computeUnitsPerMeter(data); // metres-Y → scene units, to metricise the normal
  let removed = 0, total = 0;
  const indices = meshes.map((m) => {
    const p = m.positions, idx = m.index;
    if (!idx || !p) return m.index;
    const out = [];
    let changed = false;
    for (let t = 0; t < idx.length; t += 3) {
      total++;
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const x0 = p[i0 * 3], y0 = p[i0 * 3 + 1], z0 = p[i0 * 3 + 2];
      const x1 = p[i1 * 3], y1 = p[i1 * 3 + 1], z1 = p[i1 * 3 + 2];
      const x2 = p[i2 * 3], y2 = p[i2 * 3 + 1], z2 = p[i2 * 3 + 2];
      const a0 = y0 - (sampleHeightAtScene(data, x0, z0) - minH);
      const a1 = y1 - (sampleHeightAtScene(data, x1, z1) - minH);
      const a2 = y2 - (sampleHeightAtScene(data, x2, z2) - minH);
      if ((a0 + a1 + a2) / 3 < groundDistanceM) {
        const ay = y0 * upm, by = y1 * upm, cy = y2 * upm;
        const e1x = x1 - x0, e1y = by - ay, e1z = z1 - z0;
        const e2x = x2 - x0, e2y = cy - ay, e2z = z2 - z0;
        const nx = e1y * e2z - e1z * e2y;
        const ny = e1z * e2x - e1x * e2z;
        const nz = e1x * e2y - e1y * e2x;
        const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (nlen > 1e-12 && Math.abs(ny) / nlen > groundNormalThreshold) { removed++; changed = true; continue; }
      }
      out.push(i0, i1, i2);
    }
    if (!changed) return idx;
    if (idx instanceof Uint32Array) return Uint32Array.from(out);
    if (idx instanceof Uint16Array) return Uint16Array.from(out);
    return out;
  });
  return { indices, removed, total };
};
