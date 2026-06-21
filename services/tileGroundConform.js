// S2 — Delta-field conform: seat the Google tile mesh onto the mapng .ter floor.
//
// The single-point vertical anchor (probeGroundAltitude → groundOffset) lifts
// Google's ground onto the DEM at ONE reference point. Everywhere else the
// residual `aboveTerrain = Y − terrain(x,z)` drifts — Google's photogrammetric
// ground shape ≠ the DEM shape, plus a slowly varying ellipsoid↔geoid datum
// term. A global z-offset slider cannot fix a spatially varying residual.
//
// This pass measures that residual where Google actually HAS ground (the same
// near-flat, near-terrain tris stripGroundTris removes), builds a smooth field
// D(x,z) from it, and subtracts D from EVERY vertex. Ground verts land on the
// floor (residual → 0); a building's verts all shift by the same local D, so the
// building keeps its height ABOVE the now-corrected ground — structure preserved,
// no flattening.
//
// Runs as a soup pass AFTER weldSeams (consistent ground) and BEFORE
// stripGroundTris (needs the ground tris present to measure D). Pure / DOM-free;
// the browser bake and headless worker call the identical function. Mirrors the
// weldSeams return shape so the orchestrators write positions back the same way.

import { sampleHeightAtScene, computeUnitsPerMeter } from './googleBakeCore.js';
import { createScalarFieldGrid } from './scalarFieldGrid.js';

/**
 * @param {Array<{positions:ArrayLike<number>, index:ArrayLike<number>}>} meshes
 *   positions are [sceneX, metersY, sceneZ]; metersY is above the .ter datum.
 * @param {object} data  mapng terrain (heightMap, width, height, minHeight, bounds).
 * @param {object} [opts]
 * @param {number} [opts.cellM=8]              delta-field cell size (metres).
 * @param {number} [opts.groundDistanceM=2.5]  tri counts as ground if its mean
 *   aboveTerrain is below this (matches stripGroundTris). This is also the
 *   correction CEILING: a residual larger than this isn't recognised as ground
 *   and won't be corrected. The single-point anchor already nulls the bulk
 *   offset at the AOI centre, so the residual across one bake AOI stays within
 *   this band in practice; widen it only if a bake floats by more than ~2.5 m.
 * @param {number} [opts.groundNormalThreshold=0.85] and is this near-horizontal.
 * @param {number} [opts.maxShiftM=15]         clamp on |D| so a bad cell can't
 *   teleport geometry; the real datum residual is well under this.
 * @param {number} [opts.smoothPasses=2]       delta-field blur passes.
 * @returns {{ positions:Array<Float32Array|null>, vertsMoved:number,
 *   meshesMoved:number, cellsFilled:number, residualBefore:number,
 *   residualAfter:number }}
 *   positions[i] is a NEW array when mesh i moved, else null (caller keeps its own).
 */
export const conformTilesToFloor = (meshes, data, {
  cellM = 8,
  groundDistanceM = 2.5,
  groundNormalThreshold = 0.85,
  maxShiftM = 15,
  smoothPasses = 2,
} = {}) => {
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  const upm = computeUnitsPerMeter(data); // metres-Y → scene units, to metricise normals
  const grid = createScalarFieldGrid({ cellM, unitsPerMeter: upm });

  // aboveTerrain for a vertex, in metres. terrain(x,z) is stored absolute, so
  // (sample − minH) puts it in the same above-datum frame as Y.
  const aboveTerrain = (x, y, z) => y - (sampleHeightAtScene(data, x, z) - minH);

  // --- Pass 1: collect ground-vertex residuals into the field ----------------
  let groundSamples = 0;
  let residualSum = 0;
  for (const m of meshes) {
    const p = m.positions, idx = m.index;
    if (!p || !idx) continue;
    for (let t = 0; t < idx.length; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const x0 = p[i0 * 3], y0 = p[i0 * 3 + 1], z0 = p[i0 * 3 + 2];
      const x1 = p[i1 * 3], y1 = p[i1 * 3 + 1], z1 = p[i1 * 3 + 2];
      const x2 = p[i2 * 3], y2 = p[i2 * 3 + 1], z2 = p[i2 * 3 + 2];

      const a0 = aboveTerrain(x0, y0, z0);
      const a1 = aboveTerrain(x1, y1, z1);
      const a2 = aboveTerrain(x2, y2, z2);
      if ((a0 + a1 + a2) / 3 >= groundDistanceM) continue; // not near the floor

      // near-horizontal? (normal computed in a metrically uniform space)
      const ay = y0 * upm, by = y1 * upm, cy = y2 * upm;
      const e1x = x1 - x0, e1y = by - ay, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = cy - ay, e2z = z2 - z0;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(nlen > 1e-12 && Math.abs(ny) / nlen > groundNormalThreshold)) continue;

      // It's ground: each vertex's residual is a sample of D at its XZ.
      grid.add(x0, z0, a0);
      grid.add(x1, z1, a1);
      grid.add(x2, z2, a2);
      groundSamples += 3;
      residualSum += a0 + a1 + a2;
    }
  }

  const field = grid.build({ smoothPasses, fallback: 0 });

  // --- Pass 2: shift every vertex down by D(x,z) -----------------------------
  let vertsMoved = 0, meshesMoved = 0;
  let postResidualSum = 0, postResidualCount = 0;
  const positions = meshes.map((m) => {
    const p = m.positions;
    if (!p) return null;
    const out = new Float32Array(p.length);
    out.set(p);
    let moved = false;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], z = p[i + 2];
      let d = field.sample(x, z);
      if (d > maxShiftM) d = maxShiftM; else if (d < -maxShiftM) d = -maxShiftM;
      if (d !== 0) {
        out[i + 1] = p[i + 1] - d;
        moved = true;
        vertsMoved++;
      }
      // residual of conformed ground (for the verification log line)
      const before = p[i + 1] - (sampleHeightAtScene(data, x, z) - minH);
      if (before < groundDistanceM) {
        postResidualSum += Math.abs(out[i + 1] - (sampleHeightAtScene(data, x, z) - minH));
        postResidualCount++;
      }
    }
    if (moved) { meshesMoved++; return out; }
    return null;
  });

  return {
    positions,
    vertsMoved,
    meshesMoved,
    cellsFilled: field.filledCount,
    residualBefore: groundSamples ? residualSum / groundSamples : 0,
    residualAfter: postResidualCount ? postResidualSum / postResidualCount : 0,
  };
};
