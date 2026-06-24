/** @layer core */
// Legacy heuristic LOD-seam "riser" strip (gated OFF by default; weldSeams is the
// root-cause replacement). Pure / DOM-free, operates on flat triangle soup.
// Extracted from googleBakeCore.js (docs/refactor/06 step 2); googleBakeCore
// re-exports it.

/**
 * Remove LOD-transition "seam risers" from an assembled multi-tile mesh.
 *
 * The brown grid of little vertical walls over flat terrain is NOT renderer
 * skirts (3d-tiles-renderer generates none) — it's real reconstructed
 * tile-edge geometry. Where a finely-refined tile's boundary meets a coarser
 * neighbour whose photogrammetric surface sits at a slightly different height,
 * the boundary triangles stand up as a short near-vertical wall (a "riser").
 * The bake stitches mixed LOD levels across the whole AOI, so risers form a
 * grid. A PER-TILE test cannot see across the boundary and so cannot tell a
 * riser from a building facade — only this cross-tile pass can.
 *
 * Decision: a triangle is deleted iff ALL hold —
 *   (1) near-VERTICAL                         (|n.y| < verticalNormalY)
 *   (2) SHORT                                 (own vertical extent ≤ riserMaxHeightM)
 *   (3) FLAT GROUND ON BOTH SIDES at the      (within bandM of the triangle's
 *       triangle's top height, ≥1 cross-tile   TOP, one hit on each side of its
 *                                              plane, ≥1 from a DIFFERENT tile)
 *   (4) NO real drop-off nearby               (no other-tile ground > dropM
 *                                              below the triangle's base)
 *   (5) base sits ≈ at local ground           (base ≤ min nearby ground + slack)
 * A facade has building mass (not flat ground) on its inner side → (3) fails →
 * KEPT. A cliff / embankment / bridge / building base has a genuinely lower
 * surface → (4) fails → KEPT. A riser bridges two co-planar grounds → deleted.
 * Heights are compared RELATIVE to the triangle's own top (never an absolute
 * datum), so it is slope-tolerant and immune to the centre-anchor drift.
 *
 * Removing a riser exposes the neighbours' own ground triangles underneath
 * (Google tiles overlap ~2 m; see footprintRect), so no hole is left — no
 * re-welding needed.
 *
 * Pure and DOM-free: operates on flat triangle soup so the browser preview and
 * the headless export run the IDENTICAL strip.
 *
 * @param {Array<{positions:Float32Array, index:ArrayLike<number>, groupId:number}>} meshes
 *   one entry per source mesh. positions are [sceneX, metersY, sceneZ]; groupId
 *   is the OWNING TILE id (triangles sharing a groupId never neighbour-probe
 *   each other, so a tile's own internal detail is never mistaken for ground).
 * @param {object} opts
 * @returns {{ indices: Array<ArrayLike<number>>, removed:number, candidates:number, deletedCentroids:number[][] }}
 *   `indices[i]` is the surviving index for meshes[i] (same ref if unchanged).
 */
export const stripSeamRisers = (meshes, opts = {}) => {
  const {
    unitsPerMeter,            // scene units per metre (X/Z) — REQUIRED to metricise
    verticalNormalY = 0.40,   // gate 1: steeper than this counts as a wall
    riserMaxHeightM = 3.0,    // gate 2: taller faces are real (facades/embankments)
    groundNormalY = 0.85,     // a neighbour triangle flatter than this is "ground"
    neighborProbeM = 2.5,     // gate 3/4 horizontal search radius (> ~2 m tile overlap)
    bandM = 1.5,              // gate 3: "same height as my top" tolerance
    dropM = 2.0,              // gate 4: a real lower surface this far below my base ⇒ keep
    cellM = 4.0,              // spatial hash cell size
    baseAboveGroundM = 0.5,   // gate 5: base must sit ≈ at the local ground
    collectCentroids = false, // debug: return deleted-triangle centroids
  } = opts;
  if (!unitsPerMeter || !Number.isFinite(unitsPerMeter)) {
    throw new Error('stripSeamRisers: unitsPerMeter required');
  }
  const invUpm = 1 / unitsPerMeter; // scene units → metres
  const invCell = 1 / cellM;
  // Collision-free integer cell key (grid coords well within ±1e6 for any AOI).
  const keyOf = (gx, gz) => (gx + 1e6) * 4e6 + (gz + 1e6);

  // --- Pass A: classify every triangle. Bin ground-triangle centroids into the
  //     spatial hash; record near-vertical short triangles as riser candidates.
  const grid = new Map(); // key → { x:[], z:[], y:[], g:[] } (metres)
  const addGround = (xm, zm, ym, g) => {
    const k = keyOf(Math.floor(xm * invCell), Math.floor(zm * invCell));
    let cell = grid.get(k);
    if (!cell) { cell = { x: [], z: [], y: [], g: [] }; grid.set(k, cell); }
    cell.x.push(xm); cell.z.push(zm); cell.y.push(ym); cell.g.push(g);
  };
  // Candidates, struct-of-arrays to avoid millions of objects.
  const cMesh = [], cTri = [], cX = [], cZ = [], cBase = [], cTop = [], cNX = [], cNZ = [], cG = [];

  for (let mi = 0; mi < meshes.length; mi++) {
    const m = meshes[mi];
    const p = m.positions, idx = m.index, g = m.groupId;
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
      if (nlen < 1e-12) continue; // degenerate
      const absNy = Math.abs(ny) / nlen;
      const cenX = (ax + bx + cx) / 3, cenZ = (az + bz + cz) / 3;
      if (absNy > groundNormalY) {
        addGround(cenX, cenZ, (ay + by + cy) / 3, g);
      } else if (absNy < verticalNormalY) {
        const minY = ay < by ? (ay < cy ? ay : cy) : (by < cy ? by : cy);
        const maxY = ay > by ? (ay > cy ? ay : cy) : (by > cy ? by : cy);
        if (maxY - minY <= riserMaxHeightM) {
          const hlen = Math.sqrt(nx * nx + nz * nz);
          if (hlen > 1e-9) {
            cMesh.push(mi); cTri.push(t); cX.push(cenX); cZ.push(cenZ);
            cBase.push(minY); cTop.push(maxY); cNX.push(nx / hlen); cNZ.push(nz / hlen); cG.push(g);
          }
        }
      }
    }
  }

  // --- Pass B: evaluate each candidate against the ground grid.
  const probe2 = neighborProbeM * neighborProbeM;
  const delByMesh = new Array(meshes.length).fill(null);
  let removed = 0;
  const centroids = [];

  for (let i = 0; i < cMesh.length; i++) {
    const cxm = cX[i], czm = cZ[i], topY = cTop[i], baseY = cBase[i], nX = cNX[i], nZ = cNZ[i], g = cG[i];
    // sawPos/sawNeg: flat ground near my top on each side of my plane.
    // crossTile: at least one of those contributing grounds is a DIFFERENT tile
    // (the LOD-seam signature — an internal crease within one tile is kept).
    let sawPos = false, sawNeg = false, dropOff = false, crossTile = false, minGroundY = Infinity;
    const gx0 = Math.floor((cxm - neighborProbeM) * invCell), gx1 = Math.floor((cxm + neighborProbeM) * invCell);
    const gz0 = Math.floor((czm - neighborProbeM) * invCell), gz1 = Math.floor((czm + neighborProbeM) * invCell);
    for (let gx = gx0; gx <= gx1 && !dropOff; gx++) {
      for (let gz = gz0; gz <= gz1 && !dropOff; gz++) {
        const cell = grid.get(keyOf(gx, gz));
        if (!cell) continue;
        const xs = cell.x, zs = cell.z, ys = cell.y, gg = cell.g;
        for (let j = 0; j < xs.length; j++) {
          const dx = xs[j] - cxm, dz = zs[j] - czm;
          if (dx * dx + dz * dz > probe2) continue;
          const hy = ys[j];
          if (hy < minGroundY) minGroundY = hy;
          // A genuinely lower surface from ANY tile (incl. my own — e.g. a wall
          // standing on a roof above the street) means I top a real feature ⇒ keep.
          if (hy < baseY - dropM) { dropOff = true; break; }
          if (hy <= topY + bandM && hy >= topY - bandM) {
            const side = dx * nX + dz * nZ;
            if (side > 0.05) { sawPos = true; if (gg[j] !== g) crossTile = true; }
            else if (side < -0.05) { sawNeg = true; if (gg[j] !== g) crossTile = true; }
          }
        }
      }
    }
    if (!dropOff && sawPos && sawNeg && crossTile && baseY <= minGroundY + baseAboveGroundM) {
      const mi = cMesh[i];
      let del = delByMesh[mi];
      if (!del) { del = delByMesh[mi] = new Set(); }
      del.add(cTri[i]);
      removed++;
      if (collectCentroids && centroids.length < 4000) centroids.push([cxm, topY, czm]);
    }
  }

  // --- Rebuild surviving indices, preserving the original index type.
  const indices = meshes.map((m, mi) => {
    const del = delByMesh[mi];
    if (!del || del.size === 0) return m.index;
    const idx = m.index;
    const out = [];
    for (let t = 0; t < idx.length; t += 3) {
      if (del.has(t)) continue;
      out.push(idx[t], idx[t + 1], idx[t + 2]);
    }
    if (idx instanceof Uint32Array) return Uint32Array.from(out);
    if (idx instanceof Uint16Array) return Uint16Array.from(out);
    return out;
  });

  return { indices, removed, candidates: cMesh.length, deletedCentroids: centroids };
};
