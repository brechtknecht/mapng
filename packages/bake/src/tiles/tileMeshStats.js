/** @layer core */
// Read-only diagnostics for a baked Google 3D Tiles soup. Pure geometry +
// texture bookkeeping — NEVER mutates the input — used to decide the three
// quality workstreams (texture sharpness, floater/degenerate cleanup, and
// whether decimation is worth it) with REAL numbers instead of guesses.
//
// Why each metric earns its place:
//  - texture dims + atlas-clamp count: Google photogrammetry tiles are usually
//    256², packed at native size (googleTilesAssets.js). If nothing is being
//    downscaled to fit a 4096² sheet, an 8192² sheet buys ZERO sharpness — the
//    ceiling is LOD depth, not atlas size. This proves which world we're in.
//  - degenerate-tri fraction + duplicate-position ratio: the honest "tidy up"
//    surface — junk the index-rebuild passes (stripGroundTris) leave behind and
//    the weld headroom (mergeVertices would collapse).
//  - connected-component histogram + tiny-floater count: aerial photogrammetry
//    leaves disconnected blobs floating over streets. Tiny isolated components
//    are a strong floater proxy that needs no DEM lookup.

// Grid quantisation for the position weld / component union. Google tile
// vertices that coincide are bit-for-bit equal at the source, so a fine step
// unites true duplicates without merging distinct verts. Kept in NATIVE bake
// units (X/Z scene units, Y metres); span reporting converts to metres.
const QUANT = 1e4; // 0.1 mm-ish in scene units — safely below any real edge

// A component counts as a "tiny floater" when it is both few-tri AND small in
// every dimension. Both gates matter: a long thin real fence is few-tri but
// wide; a dense 1 m rock cluster is small but many-tri and probably real-ish.
const TINY_TRIS = 12;
const TINY_SPAN_M = 1.5;

/**
 * Analyse a baked tile soup. Pure — reads positions/index/texture dims, returns
 * a plain stats object. No THREE, no side effects.
 *
 * @param {Array<{positions: ArrayLike<number>, index?: ArrayLike<number>|null, texW?: number, texH?: number}>} soup
 *   VEC3 positions in FINAL bake space; index optional (null → sequential tris).
 * @param {object} [opts]
 *   @param {number} [opts.metersPerSceneUnit=1] X/Z scene-unit → metre factor
 *     (Y is already metres). Used only for span reporting, not the weld grid.
 *   @param {number} [opts.atlasSize=4096] atlas sheet size the packer targets.
 *   @param {number} [opts.atlasPad=16] per-cell padding (PAD=2*GUTTER) the
 *     packer reserves — a tile larger than atlasSize-2*atlasPad gets clamped
 *     (downscaled), which is the only way atlas size limits sharpness.
 * @returns {object} stats — see field comments below.
 */
export function analyzeTileSoup(soup, opts = {}) {
  const { metersPerSceneUnit = 1, atlasSize = 4096, atlasPad = 16 } = opts;
  const mxz = metersPerSceneUnit;

  // ---- texture stats -------------------------------------------------------
  const atlasInner = atlasSize - 2 * atlasPad;
  const texSizes = []; // max(w,h) per textured tile
  let untextured = 0;
  let clampedTiles = 0; // tiles whose texture must shrink to fit a sheet
  let texPixels = 0; // sum of w*h over textured tiles (source resolution budget)
  for (const m of soup) {
    const w = m.texW | 0;
    const h = m.texH | 0;
    if (w <= 0 || h <= 0) { untextured++; continue; }
    texSizes.push(Math.max(w, h));
    texPixels += w * h;
    if (w > atlasInner || h > atlasInner) clampedTiles++;
  }
  texSizes.sort((a, b) => a - b);
  const texDim = percentiles(texSizes);
  // Histogram bucketed by power-of-two-ish max dimension for a quick eyeball.
  const texHistogram = {};
  for (const s of texSizes) {
    const bucket = 1 << Math.ceil(Math.log2(Math.max(1, s)));
    texHistogram[bucket] = (texHistogram[bucket] || 0) + 1;
  }
  // Lower bound on 4096² sheets if every tile packed at native size + padding.
  const sheetArea = atlasSize * atlasSize;
  let paddedTexArea = 0;
  for (const m of soup) {
    const w = Math.min(m.texW | 0, atlasInner);
    const h = Math.min(m.texH | 0, atlasInner);
    if (w > 0 && h > 0) paddedTexArea += (w + 2 * atlasPad) * (h + 2 * atlasPad);
  }
  const minSheetsLowerBound = Math.max(1, Math.ceil(paddedTexArea / sheetArea));

  // ---- geometry: dup weld + degenerates + components -----------------------
  // Global position → slot id (unites duplicates across meshes/tiles).
  const slotOf = new Map();
  let slots = 0;
  const slotId = (x, y, z) => {
    const key = `${Math.round(x * QUANT)},${Math.round(y * QUANT)},${Math.round(z * QUANT)}`;
    let id = slotOf.get(key);
    if (id === undefined) { id = slots++; slotOf.set(key, id); }
    return id;
  };

  let totalVerts = 0;
  let totalTris = 0;
  let degenerateTris = 0;
  // Union-find over slots for connected components.
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const ensure = (id) => { while (parent.length <= id) parent.push(parent.length); };

  // First pass: map every vertex to a slot so degenerate detection can compare
  // slot ids (a tri with two coincident corners is degenerate topology).
  const vertSlot = soup.map((m) => {
    const p = m.positions;
    const n = p.length / 3;
    totalVerts += n;
    const ids = new Uint32Array(n);
    for (let i = 0, v = 0; v < n; i += 3, v++) {
      const id = slotId(p[i], p[i + 1], p[i + 2]);
      ensure(id);
      ids[v] = id;
    }
    return ids;
  });

  for (let s = 0; s < soup.length; s++) {
    const p = soup[s].positions;
    const idx = soup[s].index;
    const ids = vertSlot[s];
    const triCount = idx ? idx.length / 3 : p.length / 9;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3;
      const b = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      totalTris++;
      const sa = ids[a], sb = ids[b], sc = ids[c];
      // Degenerate: two corners weld to the same slot, or near-zero area.
      if (sa === sb || sb === sc || sa === sc || triAreaM2(p, a, b, c, mxz) < 1e-6) {
        degenerateTris++;
      }
      union(sa, sb);
      union(sb, sc);
    }
  }

  // ---- component aggregation ----------------------------------------------
  const comp = new Map(); // root → { tris, minX..maxZ }
  const bump = (root) => {
    let e = comp.get(root);
    if (!e) { e = { tris: 0, minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }; comp.set(root, e); }
    return e;
  };
  for (let s = 0; s < soup.length; s++) {
    const p = soup[s].positions;
    const idx = soup[s].index;
    const ids = vertSlot[s];
    const triCount = idx ? idx.length / 3 : p.length / 9;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx[t * 3] : t * 3;
      const root = find(ids[a]);
      const e = bump(root);
      e.tris++;
      for (const vi of [a, idx ? idx[t * 3 + 1] : t * 3 + 1, idx ? idx[t * 3 + 2] : t * 3 + 2]) {
        const x = p[vi * 3], y = p[vi * 3 + 1], z = p[vi * 3 + 2];
        if (x < e.minX) e.minX = x; if (x > e.maxX) e.maxX = x;
        if (y < e.minY) e.minY = y; if (y > e.maxY) e.maxY = y;
        if (z < e.minZ) e.minZ = z; if (z > e.maxZ) e.maxZ = z;
      }
    }
  }

  let tinyFloaters = 0;
  let tinyFloaterTris = 0;
  const compTriSizes = [];
  for (const e of comp.values()) {
    compTriSizes.push(e.tris);
    const spanX = (e.maxX - e.minX) * mxz;
    const spanY = e.maxY - e.minY;
    const spanZ = (e.maxZ - e.minZ) * mxz;
    const maxSpan = Math.max(spanX, spanY, spanZ);
    if (e.tris <= TINY_TRIS && maxSpan <= TINY_SPAN_M) {
      tinyFloaters++;
      tinyFloaterTris += e.tris;
    }
  }
  compTriSizes.sort((a, b) => a - b);

  const uniqueVerts = slots;
  const dupRatio = totalVerts > 0 ? 1 - uniqueVerts / totalVerts : 0;

  return {
    tiles: soup.length,
    texture: {
      textured: texSizes.length,
      untextured,
      dimP50: texDim.p50,
      dimP95: texDim.p95,
      dimMax: texDim.max,
      histogram: texHistogram,
      clampedTiles, // >0 means atlas size IS costing sharpness → 8192 helps
      megapixels: +(texPixels / 1e6).toFixed(1),
      minSheetsLowerBound,
    },
    geometry: {
      totalVerts,
      uniqueVerts,
      totalTris,
      degenerateTris,
      degenerateFrac: totalTris > 0 ? +(degenerateTris / totalTris).toFixed(4) : 0,
      dupRatio: +dupRatio.toFixed(4), // weld headroom mergeVertices would reclaim
    },
    components: {
      count: comp.size,
      tinyFloaters, // tiny + isolated → strong junk/floater proxy
      tinyFloaterTris,
      triSizeP50: percentiles(compTriSizes).p50,
      largest: compTriSizes.length ? compTriSizes[compTriSizes.length - 1] : 0,
    },
  };
}

/** One-line human summary for console.info / devLog. */
export function formatTileStats(st) {
  const t = st.texture;
  const g = st.geometry;
  const c = st.components;
  return (
    `[tile-stats] ${st.tiles} tiles | ` +
    `tex ${t.textured} (${t.untextured} bare) dim p50=${t.dimP50}/p95=${t.dimP95}/max=${t.dimMax}px ` +
    `clamped=${t.clampedTiles} ~${t.megapixels}MP ≥${t.minSheetsLowerBound}×4k sheets | ` +
    `geom ${g.totalVerts} verts (${g.uniqueVerts} uniq, dup ${(g.dupRatio * 100).toFixed(1)}%) ` +
    `${g.totalTris} tris (degen ${g.degenerateTris}, ${(g.degenerateFrac * 100).toFixed(2)}%) | ` +
    `comps ${c.count} (tiny floaters ${c.tinyFloaters}/${c.tinyFloaterTris} tris, largest ${c.largest})`
  );
}

// ---- helpers ---------------------------------------------------------------

function percentiles(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return { p50: 0, p95: 0, max: 0 };
  const at = (q) => sortedAsc[Math.min(n - 1, Math.floor(q * n))];
  return { p50: at(0.5), p95: at(0.95), max: sortedAsc[n - 1] };
}

// Triangle area in m², converting X/Z scene units to metres (Y already metres).
function triAreaM2(p, a, b, c, mxz) {
  const ax = p[a * 3] * mxz, ay = p[a * 3 + 1], az = p[a * 3 + 2] * mxz;
  const bx = p[b * 3] * mxz, by = p[b * 3 + 1], bz = p[b * 3 + 2] * mxz;
  const cx = p[c * 3] * mxz, cy = p[c * 3 + 1], cz = p[c * 3 + 2] * mxz;
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}
