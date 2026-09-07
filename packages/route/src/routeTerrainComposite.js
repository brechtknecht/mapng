// Pure terrain compositing for the route → BeamNG level export. No DOM/WebGL
// deps, so it's unit-testable in Node (services/exportRouteLevel.js, which pulls
// in the full bake/level pipeline, is not).

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * DEG) || M_PER_DEG_LAT;
const nextPow2 = (n) => 2 ** Math.round(Math.log2(Math.max(1, n)));

/** Bilinearly sample a chunk terrain's absolute elevation at a lat/lng. */
export function sampleHeightAt(terrain, lat, lng) {
  const b = terrain.bounds;
  const u = (lng - b.west) / (b.east - b.west);
  const v = (b.north - lat) / (b.north - b.south); // heightMap rows are north-origin
  const w = terrain.width, h = terrain.height, hm = terrain.heightMap;
  const fx = Math.max(0, Math.min(w - 1, u * (w - 1)));
  const fy = Math.max(0, Math.min(h - 1, v * (h - 1)));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  const minH = terrain.minHeight ?? 0;
  const s = (i) => (hm[i] < -10000 ? minH : hm[i]);
  const h00 = s(y0 * w + x0), h10 = s(y0 * w + x1);
  const h01 = s(y1 * w + x0), h11 = s(y1 * w + x1);
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

/**
 * Resample the combined route terrain onto a chunk's own grid/bounds — the
 * heightMap a chunk should BAKE/CONFORM against so its Google tiles seat on the
 * surface the level actually drives on (the combined terrain), not on the chunk's
 * independently-fetched DEM. Where adjacent chunks' DEMs disagree (different
 * elevation tiles, or the coarser combined grid smoothing slopes) the two differ,
 * and conforming against the per-chunk DEM leaves the tiles floating vs combined.
 *
 * Returns just the heightMap (chunk.width × chunk.height); the caller keeps the
 * chunk's bounds/minHeight (datum) and texture canvases so placement via baseUp
 * stays consistent.
 *
 * @param {object} combined  buildCombinedRouteTerrain() result
 * @param {object} chunk     per-chunk TerrainData (bounds, width, height)
 * @returns {Float32Array}
 */
export function sampleCombinedHeightMap(combined, chunk) {
  const { bounds: b, width: w, height: h } = chunk;
  const out = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    const lat = b.north - (row / (h - 1)) * (b.north - b.south);
    for (let col = 0; col < w; col++) {
      const lng = b.west + (col / (w - 1)) * (b.east - b.west);
      out[row * w + col] = sampleHeightAt(combined, lat, lng);
    }
  }
  return out;
}

/**
 * Composite the per-chunk heightmaps into ONE square terrainData spanning the
 * route bbox. Off-corridor pixels (the bulk of a diagonal route's square box)
 * stay at a flat filler floor — they're hidden, the player stays on the road.
 *
 * @param {object[]} terrains  per-chunk TerrainData (with heightMap + bounds)
 * @returns {object} terrainData-shaped { bounds, width, height, heightMap, minHeight, maxHeight, metersPerPixel, osmFeatures }
 */
export function buildCombinedRouteTerrain(terrains, { targetMetersPerPixel = 2, maxSize = 4096 } = {}) {
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  for (const t of terrains) {
    north = Math.max(north, t.bounds.north); south = Math.min(south, t.bounds.south);
    east = Math.max(east, t.bounds.east); west = Math.min(west, t.bounds.west);
  }
  const centerLat = (north + south) / 2;
  const centerLng = (east + west) / 2;
  const mLng = mPerDegLng(centerLat);
  const widthM = (east - west) * mLng;
  const heightM = (north - south) * M_PER_DEG_LAT;
  const sideM = Math.max(widthM, heightM, 1);

  // Square the bounds around the centre (BeamNG TerrainBlock is square).
  const halfLat = (sideM / 2) / M_PER_DEG_LAT;
  const halfLng = (sideM / 2) / mLng;
  const bounds = {
    north: centerLat + halfLat, south: centerLat - halfLat,
    east: centerLng + halfLng, west: centerLng - halfLng,
  };

  const N = nextPow2(Math.min(maxSize, Math.max(256, Math.round(sideM / targetMetersPerPixel))));
  const squareSize = sideM / N;

  // Filler floor = lowest chunk datum, so off-corridor terrain sits below the
  // road rather than poking through it.
  const fillFloor = terrains.reduce((m, t) => Math.min(m, t.minHeight ?? 0), Infinity);
  const heightMap = new Float32Array(N * N).fill(fillFloor);
  let minHeight = fillFloor, maxHeight = fillFloor;

  // Blit each chunk over its pixel rect only (O(covered px), not O(N²·chunks)).
  for (const t of terrains) {
    const cb = t.bounds;
    const gx0 = Math.max(0, Math.floor((cb.west - bounds.west) / (bounds.east - bounds.west) * (N - 1)));
    const gx1 = Math.min(N - 1, Math.ceil((cb.east - bounds.west) / (bounds.east - bounds.west) * (N - 1)));
    const gy0 = Math.max(0, Math.floor((bounds.north - cb.north) / (bounds.north - bounds.south) * (N - 1)));
    const gy1 = Math.min(N - 1, Math.ceil((bounds.north - cb.south) / (bounds.north - bounds.south) * (N - 1)));
    for (let gy = gy0; gy <= gy1; gy++) {
      const lat = bounds.north - (gy / (N - 1)) * (bounds.north - bounds.south);
      for (let gx = gx0; gx <= gx1; gx++) {
        const lng = bounds.west + (gx / (N - 1)) * (bounds.east - bounds.west);
        if (lng < cb.west || lng > cb.east || lat < cb.south || lat > cb.north) continue;
        const hgt = sampleHeightAt(t, lat, lng);
        heightMap[gy * N + gx] = hgt;
        if (hgt < minHeight) minHeight = hgt;
        if (hgt > maxHeight) maxHeight = hgt;
      }
    }
  }

  return {
    bounds, width: N, height: N, heightMap,
    minHeight, maxHeight,
    metersPerPixel: squareSize,
    osmFeatures: [],
  };
}

/** Bilinear sample of an arbitrary per-cell field (north-origin grid) at lat/lng. */
function sampleField(field, bounds, w, h, lat, lng) {
  const u = (lng - bounds.west) / (bounds.east - bounds.west);
  const v = (bounds.north - lat) / (bounds.north - bounds.south);
  const fx = Math.max(0, Math.min(w - 1, u * (w - 1)));
  const fy = Math.max(0, Math.min(h - 1, v * (h - 1)));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  const a = field[y0 * w + x0], b = field[y0 * w + x1];
  const c = field[y1 * w + x0], d = field[y1 * w + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * Composite the per-chunk TILE-EXTRACTED grounds (extractTileGround output) onto
 * the combined route terrain so the BeamNG `.ter` drives on the bare-earth tile
 * ground along the whole corridor, with the DEM only as off-corridor filler.
 *
 * Because every route chunk bakes with the SAME sharedGroundOffsetM, the per-chunk
 * extracted grounds are already in one continuous absolute frame (the chunk
 * minHeight terms cancel — see docs/route-generation-plan.md datum math), so they
 * composite by absolute height directly and seams line up by construction.
 *
 *   - overlap (chunks overlap ~15%): coverage-WEIGHTED average, so neither chunk's
 *     edge artifacts win a hard seam.
 *   - corridor edge: a grassfire feather grows the ground value outward into the
 *     DEM over `featherM`, ramping the blend 1→0 so there is no cliff where the
 *     tile ribbon ends.
 *   - uncovered / off-corridor cells keep combined.heightMap (the DEM).
 *
 * Output grid == combined grid (same bounds/width). The CALLER keeps
 * combined.minHeight as the datum (tiles + placements are anchored to it); only
 * the heightMap is swapped. Returns groundMin/groundMax for the caller to widen
 * maxHeight if needed.
 *
 * @param {object[]} grounds   per-chunk { bounds, width, height, heightMap (abs m),
 *                             coverage?: Uint8Array|Float32Array (w*h, 0/1, 0..1 or 0/255) }
 * @param {object}   combined  buildCombinedRouteTerrain() result (the DEM fallback)
 * @param {object}   [opts]    { featherM } corridor-edge feather width in metres;
 *   { ownershipFeatherM } > 0 switches the overlap blend to CHUNK OWNERSHIP:
 *   every cell takes the floor of the chunk whose centre is nearest (Voronoi),
 *   crossing over to the neighbour within ±ownershipFeatherM of the bisector.
 *   The mesh is clipped on the same line (tiles/chunkOwnership.js), so the
 *   drive surface and the visible road switch chunk together instead of the
 *   .ter sitting between two independently baked floors across the whole
 *   overlap band. Where the owner has no coverage the coverage blend is the
 *   fallback, so holes in the owner are still filled by the neighbour.
 * @returns {{ heightMap: Float32Array, groundMin: number, groundMax: number, coverage: number }}
 */
export function compositeRouteGround(grounds, combined, { featherM = 12, ownershipFeatherM = 0 } = {}) {
  const N = combined.width;
  const { bounds, metersPerPixel } = combined;
  const dem = combined.heightMap;
  const lngSpan = bounds.east - bounds.west;
  const latSpan = bounds.north - bounds.south;

  const gAcc = new Float32Array(N * N); // Σ coverage·height
  const wAcc = new Float32Array(N * N); // Σ coverage  (overlap blend weight)
  const gOwn = new Float32Array(N * N); // Σ coverage·ownership·height
  const wOwn = new Float32Array(N * N); // Σ coverage·ownership
  let alpha = new Float32Array(N * N);  // peak coverage per cell, 0..1 (corridor mask)

  // Chunk centres (box centres) in metres for the ownership rule.
  const list = (grounds || []).filter((g) => g && g.heightMap);
  const centers = list.map((g) => ({ lat: (g.bounds.north + g.bounds.south) / 2, lng: (g.bounds.east + g.bounds.west) / 2 }));
  const mLng = mPerDegLng((bounds.north + bounds.south) / 2);
  const ownershipAt = (gi, lat, lng) => {
    if (!(ownershipFeatherM > 0) || centers.length < 2) return 1;
    const c = centers[gi];
    const dSelf = Math.hypot((lng - c.lng) * mLng, (lat - c.lat) * M_PER_DEG_LAT);
    let dOther = Infinity;
    for (let k = 0; k < centers.length; k++) {
      if (k === gi) continue;
      const d = Math.hypot((lng - centers[k].lng) * mLng, (lat - centers[k].lat) * M_PER_DEG_LAT);
      if (d < dOther) dOther = d;
    }
    const t = (dOther - dSelf) / (2 * ownershipFeatherM) + 0.5;
    return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
  };

  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi];
    const cb = g.bounds, gw = g.width, gh = g.height;
    // Coverage → 0..1. Accept 0/1, 0..1 floats, or 0/255 masks; absent ⇒ fully covered.
    const cov = g.coverage || null;
    let covScale = 1;
    if (cov) { let mx = 0; for (let i = 0; i < cov.length; i++) if (cov[i] > mx) mx = cov[i]; covScale = mx > 1 ? 1 / 255 : 1; }

    const gx0 = Math.max(0, Math.floor((cb.west - bounds.west) / lngSpan * (N - 1)));
    const gx1 = Math.min(N - 1, Math.ceil((cb.east - bounds.west) / lngSpan * (N - 1)));
    const gy0 = Math.max(0, Math.floor((bounds.north - cb.north) / latSpan * (N - 1)));
    const gy1 = Math.min(N - 1, Math.ceil((bounds.north - cb.south) / latSpan * (N - 1)));
    for (let gy = gy0; gy <= gy1; gy++) {
      const lat = bounds.north - (gy / (N - 1)) * latSpan;
      if (lat < cb.south || lat > cb.north) continue;
      for (let gx = gx0; gx <= gx1; gx++) {
        const lng = bounds.west + (gx / (N - 1)) * lngSpan;
        if (lng < cb.west || lng > cb.east) continue;
        const cv = cov ? Math.max(0, Math.min(1, sampleField(cov, cb, gw, gh, lat, lng) * covScale)) : 1;
        if (cv <= 0) continue;
        const idx = gy * N + gx;
        const h = sampleHeightAt(g, lat, lng);
        gAcc[idx] += cv * h;
        wAcc[idx] += cv;
        const ow = cv * ownershipAt(gi, lat, lng);
        if (ow > 0) { gOwn[idx] += ow * h; wOwn[idx] += ow; }
        if (cv > alpha[idx]) alpha[idx] = cv;
      }
    }
  }

  // Ground value where covered (NaN elsewhere): the OWNER's floor when
  // ownership is on (coverage blend as the fallback where the owner has none),
  // else the coverage-weighted blend.
  let gVal = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) {
    gVal[i] = wOwn[i] > 0 ? gOwn[i] / wOwn[i] : wAcc[i] > 0 ? gAcc[i] / wAcc[i] : NaN;
  }

  // Corridor-edge feather: grassfire-grow alpha + ground value outward into DEM
  // cells over featherCells passes, ramping alpha linearly 1→0 (no cliff).
  const featherCells = Math.max(0, Math.round((featherM || 0) / (metersPerPixel || 1)));
  if (featherCells > 0) {
    const step = 1 / (featherCells + 1);
    let aSrc = alpha, vSrc = gVal;
    let aDst = new Float32Array(N * N), vDst = new Float32Array(N * N);
    for (let pass = 0; pass < featherCells; pass++) {
      aDst.set(aSrc); vDst.set(vSrc);
      for (let gy = 0; gy < N; gy++) {
        for (let gx = 0; gx < N; gx++) {
          const idx = gy * N + gx;
          if (aSrc[idx] > 0) continue; // corridor or already-feathered cell
          let bestA = 0, bestV = NaN;
          for (let dy = -1; dy <= 1; dy++) {
            const ny = gy + dy; if (ny < 0 || ny >= N) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nx = gx + dx; if (nx < 0 || nx >= N) continue;
              const na = aSrc[ny * N + nx];
              if (na > bestA) { bestA = na; bestV = vSrc[ny * N + nx]; }
            }
          }
          const a = bestA - step;
          if (a > 0) { aDst[idx] = a; vDst[idx] = bestV; }
        }
      }
      const ta = aSrc; aSrc = aDst; aDst = ta;
      const tv = vSrc; vSrc = vDst; vDst = tv;
    }
    alpha = aSrc; gVal = vSrc;
  }

  // Composite: ground·alpha + DEM·(1−alpha) where covered/feathered, else DEM.
  const out = Float32Array.from(dem);
  let groundMin = Infinity, groundMax = -Infinity, covered = 0;
  for (let i = 0; i < N * N; i++) {
    const a = alpha[i];
    if (a > 0 && !Number.isNaN(gVal[i])) {
      const v = a * gVal[i] + (1 - a) * dem[i];
      out[i] = v;
      if (v < groundMin) groundMin = v;
      if (v > groundMax) groundMax = v;
      covered++;
    }
  }
  if (groundMin === Infinity) { groundMin = combined.minHeight; groundMax = combined.maxHeight; }
  return { heightMap: out, groundMin, groundMax, coverage: +(covered / (N * N)).toFixed(3) };
}

/** Coverage (0..1) of a chunk ground at lat/lng; 1 when the ground has no mask. */
const coverageAt = (g, lat, lng) => {
  const cov = g.coverage;
  if (!cov) return 1;
  let mx = g._covMax;
  if (mx == null) { mx = 0; for (let i = 0; i < cov.length; i++) if (cov[i] > mx) mx = cov[i]; g._covMax = mx; }
  const scale = mx > 1 ? 1 / 255 : 1;
  return Math.max(0, Math.min(1, sampleField(cov, g.bounds, g.width, g.height, lat, lng) * scale));
};

/**
 * Vertical registration of neighbouring chunk grounds. Two chunks bake the
 * same ground independently and can disagree by a near-constant offset in
 * their overlap (anchor / LOD / coverage differences). For each chunk (route
 * order) the previous overlapping chunk with the largest overlap is the
 * reference; the offset is the MEDIAN signed difference (reference − chunk)
 * over overlap samples both chunks cover, chained along the route so every
 * chunk lands in chunk 0's frame. Apply the offset to the chunk's ground AND
 * to its mesh placement — they were seated on each other in the bake.
 *
 * @param {Array<object|null>} grounds  per-chunk { bounds, width, height, heightMap, coverage? } (null = missing)
 * @param {object} [opts] { sampleN = 48 (grid per axis), minSamples = 40, maxOffsetM = 15 }
 * @returns {{ offsets: number[], pairs: Array<{a:number,b:number,n:number,medianDhM:number,offsetM:number,applied:boolean}> }}
 */
export function registerChunkGrounds(grounds, { sampleN = 48, minSamples = 40, maxOffsetM = 15 } = {}) {
  const n = grounds?.length ?? 0;
  const offsets = new Array(n).fill(0);
  const pairs = [];
  for (let i = 1; i < n; i++) {
    const B = grounds[i];
    if (!B?.heightMap || !B.bounds) continue;
    let best = null;
    for (let j = i - 1; j >= 0; j--) {
      const A = grounds[j];
      if (!A?.heightMap || !A.bounds) continue;
      const west = Math.max(A.bounds.west, B.bounds.west), east = Math.min(A.bounds.east, B.bounds.east);
      const south = Math.max(A.bounds.south, B.bounds.south), north = Math.min(A.bounds.north, B.bounds.north);
      if (east <= west || north <= south) continue;
      const area = (east - west) * (north - south);
      if (!best || area > best.area) best = { j, area, west, east, south, north };
    }
    if (!best) continue;
    const A = grounds[best.j];
    const ds = [];
    for (let r = 0; r < sampleN; r++) {
      const lat = best.north - ((r + 0.5) / sampleN) * (best.north - best.south);
      for (let c = 0; c < sampleN; c++) {
        const lng = best.west + ((c + 0.5) / sampleN) * (best.east - best.west);
        if (coverageAt(A, lat, lng) < 0.99 || coverageAt(B, lat, lng) < 0.99) continue;
        const hA = sampleHeightAt(A, lat, lng) + offsets[best.j];
        const hB = sampleHeightAt(B, lat, lng);
        if (Number.isFinite(hA) && Number.isFinite(hB)) ds.push(hA - hB);
      }
    }
    ds.sort((x, y) => x - y);
    const median = ds.length ? ds[ds.length >> 1] : 0;
    const applied = ds.length >= minSamples && Math.abs(median) <= maxOffsetM;
    offsets[i] = applied ? median : offsets[best.j];
    pairs.push({ a: best.j, b: i, n: ds.length, medianDhM: median, offsetM: offsets[i], applied });
  }
  return { offsets, pairs };
}
