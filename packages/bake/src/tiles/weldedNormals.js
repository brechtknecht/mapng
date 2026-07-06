/** @layer core */
// Position-welded smooth normals across a SET of tile meshes.
//
// Google tile geometries duplicate vertices at UV seams and tile borders, so
// per-geometry normal computation leaves every duplicate with an un-averaged
// normal — a hard shading edge along each seam once BeamNG's directional sun
// hits the mesh (the preview's soft image-based lighting hides them, which is
// why the preview looks smooth over the same geometry). Accumulating
// area-weighted face normals into a shared position grid smooths across ALL
// seams: within a tile, between tiles, and across the ≤60k-vert chunk-merge
// boundaries that per-chunk computation can't see.
//
// Not related to weldSeams (tileSeamWeld.js), which MOVES positions to close
// cross-LOD gaps — this only produces normals and never touches geometry.

// 2^17 grid steps per axis: a single float64 key stays exact (< 2^51) and the
// weld map holds plain numbers instead of strings (ultra exports reach tens
// of millions of vertices).
const GRID = 131072;

/**
 * @param {Array<{positions: Float32Array, index?: ArrayLike<number>|null}>} entries
 *   VEC3 positions in their FINAL space (post scale/offset); entries without
 *   an index are read as sequential triangles.
 * @returns {Float32Array[]} one unit-VEC3 normal array per entry, aligned to
 *   its positions.
 */
export function computeWeldedNormals(entries) {
  // ---- weld grid over the joint AABB ---------------------------------------
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const { positions } of entries) {
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
      if (positions[i + 2] < minZ) minZ = positions[i + 2];
      if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
    }
  }
  if (!Number.isFinite(minX)) {
    return entries.map(({ positions }) => new Float32Array(positions.length));
  }
  // ≥1 cm weld step; wider only when the AABB outgrows the grid (>~1.3 km) —
  // photogrammetry triangles are far coarser than either.
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const step = Math.max(0.01, span / (GRID - 2));
  const inv = 1 / step;

  // ---- pass 1: vertex → weld slot ------------------------------------------
  const slotOf = new Map(); // grid key → slot
  const ids = entries.map(({ positions }) => new Uint32Array(positions.length / 3));
  let slots = 0;
  for (let e = 0; e < entries.length; e++) {
    const positions = entries[e].positions;
    const out = ids[e];
    for (let i = 0, v = 0; i < positions.length; i += 3, v++) {
      const key = (Math.round((positions[i] - minX) * inv) * GRID
        + Math.round((positions[i + 1] - minY) * inv)) * GRID
        + Math.round((positions[i + 2] - minZ) * inv);
      let id = slotOf.get(key);
      if (id === undefined) {
        id = slots++;
        slotOf.set(key, id);
      }
      out[v] = id;
    }
  }
  slotOf.clear();

  // ---- pass 2: accumulate area-weighted face normals per slot --------------
  // The unnormalised cross product weighs each face by its area, so slivers
  // and skirt flaps can't dominate a border vertex.
  const acc = new Float32Array(slots * 3);
  for (let e = 0; e < entries.length; e++) {
    const { positions, index } = entries[e];
    const eid = ids[e];
    const triCount = ((index ? index.length : positions.length / 3) / 3) | 0;
    for (let t = 0; t < triCount; t++) {
      const va = index ? index[t * 3] : t * 3;
      const vb = index ? index[t * 3 + 1] : t * 3 + 1;
      const vc = index ? index[t * 3 + 2] : t * 3 + 2;
      const a = va * 3, b = vb * 3, c = vc * 3;
      const abx = positions[b] - positions[a];
      const aby = positions[b + 1] - positions[a + 1];
      const abz = positions[b + 2] - positions[a + 2];
      const acx = positions[c] - positions[a];
      const acy = positions[c + 1] - positions[a + 1];
      const acz = positions[c + 2] - positions[a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      let s = eid[va] * 3;
      acc[s] += nx; acc[s + 1] += ny; acc[s + 2] += nz;
      s = eid[vb] * 3;
      acc[s] += nx; acc[s + 1] += ny; acc[s + 2] += nz;
      s = eid[vc] * 3;
      acc[s] += nx; acc[s + 1] += ny; acc[s + 2] += nz;
    }
  }

  // ---- pass 3: normalise back onto every vertex ----------------------------
  return entries.map(({ positions }, e) => {
    const eid = ids[e];
    const normals = new Float32Array(positions.length);
    for (let v = 0; v < eid.length; v++) {
      const s = eid[v] * 3;
      let nx = acc[s], ny = acc[s + 1], nz = acc[s + 2];
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-12) {
        nx /= len; ny /= len; nz /= len;
      } else {
        nx = 0; ny = 1; nz = 0; // degenerate/unreferenced vertex — face up
      }
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
    }
    return normals;
  });
}
