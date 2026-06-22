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
 * @param {number} [opts.cellM=6]              delta-field cell size (metres).
 *   Smaller = follows local ground better (measured: monotonic residual drop down
 *   to ~4 m on dense AOIs); 6 keeps enough samples/cell on sparse/rural AOIs.
 * @param {number} [opts.groundDistanceM=2.5]  tri counts as ground if its mean
 *   aboveTerrain is within ±this of the terrain (a BAND, not just an upper bound
 *   — subterranean horizontal geometry must be excluded or it poisons the field).
 *   This is also the correction CEILING: a residual larger than this isn't
 *   recognised as ground and won't be corrected. The single-point anchor already
 *   nulls the bulk offset at the AOI centre, so the residual across one bake AOI
 *   stays within this band in practice; widen it only if a bake floats by more.
 * @param {number} [opts.groundNormalThreshold=0.85] and is this near-horizontal.
 * @param {number} [opts.maxShiftM=15]         clamp on |D| so a bad cell can't
 *   teleport geometry; the real datum residual is well under this.
 * @param {number} [opts.smoothPasses=0]       delta-field blur passes. Default 0:
 *   field.sample already bilinearly interpolates between cell centres, so the
 *   applied shift is continuous WITHOUT blur. Extra passes measurably worsen the
 *   residual — they smear a cell's correction across real ground discontinuities
 *   (curbs, embankment edges, terrace steps), pushing already-accurate spots off.
 * @param {object} [opts.groundMask=null]      optional semantic road-coverage mask
 *   (groundMask.js: { sample(x,z)→w∈[0,1] }). Where w>0 AND the vertex is
 *   near-horizontal, its height is blended toward the DEM directly (full-res, NO
 *   ±groundDistanceM ceiling) — this is what flattens photogrammetry road wiggle
 *   and pulls down floaters the delta field's band leaves behind. w feathers the
 *   snap into the delta-field result at road edges so the mesh does not tear.
 * @param {number} [opts.roadEpsM=0.02]        metres above the DEM a fully-masked
 *   (w=1) vertex is seated, matching the road-surface offset / z-fight bias.
 * @returns {{ positions:Array<Float32Array|null>, vertsMoved:number,
 *   meshesMoved:number, cellsFilled:number, residualBefore:number,
 *   residualAfter:number }}
 *   positions[i] is a NEW array when mesh i moved, else null (caller keeps its own).
 */
export const conformTilesToFloor = (meshes, data, {
  cellM = 6,
  groundDistanceM = 2.5,
  groundNormalThreshold = 0.85,
  maxShiftM = 15,
  smoothPasses = 0,
  groundMask = null,
  roadEpsM = 0.02,
  diagnostics = false,
} = {}) => {
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  const upm = computeUnitsPerMeter(data); // metres-Y → scene units, to metricise normals
  const grid = createScalarFieldGrid({ cellM, unitsPerMeter: upm });

  // aboveTerrain for a vertex, in metres. terrain(x,z) is stored absolute, so
  // (sample − minH) puts it in the same above-datum frame as Y.
  const aboveTerrain = (x, y, z) => y - (sampleHeightAtScene(data, x, z) - minH);

  // --- Pass 1: collect ground-vertex residuals into the field ----------------
  // residualBefore/After are reported as MEAN ABSOLUTE residual (not signed) so
  // they're comparable: a signed mean cancels on real data and hides the spread.
  // For the mask snap we need a per-vertex "near-horizontal" flag that IGNORES
  // the band — a road floating beyond groundDistanceM is exactly the floater we
  // want to snap, yet its tris never enter the delta field. Marked here, used in
  // Pass 2. (Null/skipped entirely when no mask, keeping the fast path intact.)
  const horizFlags = groundMask
    ? meshes.map((m) => (m.positions ? new Uint8Array(m.positions.length / 3) : null))
    : null;

  let groundSamples = 0;
  let residualAbsSum = 0;
  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
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
      const inBand = Math.abs((a0 + a1 + a2) / 3) < groundDistanceM;
      // Fast path with no mask: band-rejected tris skip the normal entirely. With
      // a mask we still need the normal — a floating road tri is out of band but
      // IS a snap candidate.
      if (!groundMask && !inBand) continue;

      // near-horizontal? (normal computed in a metrically uniform space)
      const ay = y0 * upm, by = y1 * upm, cy = y2 * upm;
      const e1x = x1 - x0, e1y = by - ay, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = cy - ay, e2z = z2 - z0;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const isHoriz = nlen > 1e-12 && Math.abs(ny) / nlen > groundNormalThreshold;

      // Snap gate: near-horizontal regardless of band (this is what reaches the
      // floaters). Vertical facades / curb risers over a road pixel stay unflagged.
      if (groundMask && isHoriz) {
        const hf = horizFlags[mi];
        if (hf) { hf[i0] = 1; hf[i1] = 1; hf[i2] = 1; }
      }

      // Delta-field gate: ground sits in a BAND around the terrain —
      // |residual| < groundDistanceM, not just below the ceiling. Without the
      // lower bound, subterranean horizontal geometry (underpasses, courtyards,
      // canal/garage floors, photogrammetry junk far under the DEM) reads as
      // "ground" with a large NEGATIVE residual and drags the whole field down.
      // (stripGroundTris only needs the upper bound; a delta field needs both.)
      if (!inBand || !isHoriz) continue;

      // It's ground: each vertex's residual is a sample of D at its XZ.
      grid.add(x0, z0, a0);
      grid.add(x1, z1, a1);
      grid.add(x2, z2, a2);
      groundSamples += 3;
      residualAbsSum += Math.abs(a0) + Math.abs(a1) + Math.abs(a2);
    }
  }

  const field = grid.build({ smoothPasses, fallback: 0 });

  // Optional per-cell diagnostics (opt-in — normal bakes don't pay for it). Lets
  // the test lab show WHERE the residual stays / grows and whether that
  // correlates with cells that had no real ground samples (inpaint-guessed D).
  const nCells = field.cellsPerSide * field.cellsPerSide;
  const diag = diagnostics ? {
    coverage: field.filled,                  // 1 = had real ground samples
    afterAbsSum: new Float64Array(nCells),   // Σ|after residual| of ground verts
    beforeAbsSum: new Float64Array(nCells),  // Σ|before residual| of ground verts
    count: new Float64Array(nCells),         // ground verts per cell
    worsened: 0, improved: 0,                // ground verts whose |residual| grew / shrank
  } : null;

  // --- Pass 2: delta-field shift, then mask snap -----------------------------
  // Every vertex slides by D(x,z) — the smooth datum/ground correction. Where the
  // mask says a near-horizontal vertex is road (w>0), blend the result toward the
  // DEM directly: w=1 seats it on the floor (no ±band ceiling → floaters come
  // down, wiggle flattens), w feathers to 0 across the road edge so adjacent
  // off-road verts stay put and the mesh does not tear.
  let vertsMoved = 0, meshesMoved = 0, vertsSnapped = 0, maxFloatFixedM = 0;
  let postResidualSum = 0, postResidualCount = 0;
  const positions = meshes.map((m, mi) => {
    const p = m.positions;
    if (!p) return null;
    const hf = horizFlags ? horizFlags[mi] : null;
    const out = new Float32Array(p.length);
    out.set(p);
    let moved = false;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], z = p[i + 2];
      let d = field.sample(x, z);
      if (d > maxShiftM) d = maxShiftM; else if (d < -maxShiftM) d = -maxShiftM;
      const terr = sampleHeightAtScene(data, x, z) - minH;
      let newY = p[i + 1] - d;

      if (groundMask && hf && hf[i / 3]) {
        const w = groundMask.sample(x, z);
        if (w > 0) {
          const ySnap = terr + roadEpsM;
          newY = newY * (1 - w) + ySnap * w;
          if (w > 0.5) {
            vertsSnapped++;
            // float the smooth field could NOT correct (beyond its band) but the
            // snap did — the headline number for the floater fix.
            const floatBefore = Math.abs(p[i + 1] - terr);
            if (floatBefore >= groundDistanceM && floatBefore > maxFloatFixedM) {
              maxFloatFixedM = floatBefore;
            }
          }
        }
      }

      if (newY !== p[i + 1]) {
        out[i + 1] = newY;
        moved = true;
        vertsMoved++;
      }

      // residual of conformed ground (for the verification log line) — measured
      // over the SAME band that defined ground, so deep-below verts don't inflate it.
      const before = p[i + 1] - terr;
      if (Math.abs(before) < groundDistanceM) {
        const after = newY - terr;
        postResidualSum += Math.abs(after);
        postResidualCount++;
        if (diag) {
          const c = field.cellIndex(x, z);
          diag.afterAbsSum[c] += Math.abs(after);
          diag.beforeAbsSum[c] += Math.abs(before);
          diag.count[c] += 1;
          if (Math.abs(after) > Math.abs(before) + 1e-6) diag.worsened++;
          else if (Math.abs(after) < Math.abs(before) - 1e-6) diag.improved++;
        }
      }
    }
    if (moved) { meshesMoved++; return out; }
    return null;
  });

  return {
    positions,
    vertsMoved,
    meshesMoved,
    vertsSnapped,
    maxFloatFixedM,
    cellsFilled: field.filledCount,
    residualBefore: groundSamples ? residualAbsSum / groundSamples : 0,
    residualAfter: postResidualCount ? postResidualSum / postResidualCount : 0,
    // The built delta field, for inspection/visualisation (e.g. the test lab
    // heatmap). Read-only — callers must not mutate.
    fieldValues: field.values,
    fieldN: field.cellsPerSide,
    diag,
  };
};
