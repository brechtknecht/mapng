/** @layer core */
// DEM re-seat onto the tile road surface (route mode).
//
// The route bakes every chunk with ONE shared vertical anchor, so the tiles of
// all chunks form one continuous mesh in absolute metres. The chunk's DEM,
// however, disagrees with that mesh by an amount that VARIES along the route
// (global DEM error, geoid undulation, the anchor probe's own error at chunk
// 0). Measured on a flat Berlin route: +0.2, +0.3, −4.4, −2.6 m for four
// consecutive chunks. Every DEM-relative pass downstream (conform band,
// extraction belowBand gate, DEM fallback, road profiles) then rejects the real
// street wherever the DEM sits more than the band above it, and the chunk's
// floor lands on the DEM, metres above the visible road.
//
// The earlier estimator (shared − natural anchor, i.e. the 5th-percentile tile
// probe at the chunk CENTRE) is a single-point measurement: at one chunk it
// read a railway cut 6.4 m below the street and re-seated the DEM 6.7 m too
// low. This module estimates the offset ROBUSTLY over the whole corridor: the
// median of (per-cell tile minimum − DEM) over carriageway cells of the OSM
// road mask. Pure / DOM-free.
import { SCENE_SIZE, computeUnitsPerMeter } from '../scene/sceneFrame.js';
import { sampleHeightAtScene } from '../scene/sceneSample.js';

/**
 * Estimate the vertical offset between the transformed tile soup and the DEM.
 *
 * @param {Array<{positions:Float32Array, index?:ArrayLike<number>|null}>} soup
 *   transformed tile records: X/Z scene units, Y metres above data.minHeight.
 *   Only indexed vertices count (strip / clip passes rewrite the index).
 * @param {object} data  TerrainData (bounds, width, height, heightMap, minHeight)
 * @param {object} [opts]
 * @param {{sample:(x:number,z:number)=>number}|null} [opts.roadMask]  OSM ground
 *   mask (groundMask.buildGroundMask); cells with sample ≥ roadMaskMin count.
 *   null → every covered cell counts (weaker: buildings are in the sample, but
 *   the per-cell MIN and the median still favour the ground).
 * @param {number} [opts.roadMaskMin=0.99]
 * @param {(x:number,z:number)=>boolean|null} [opts.cellFilter]  extra spatial gate in
 *   scene coordinates (route mode: cells inside the route corridor only — the
 *   .ter drive surface is what has to sit on the tiles; side streets far from
 *   the route, sunken yards or a stadium pit must not vote).
 * @param {number} [opts.cellM=2]      analysis cell size (metres)
 * @param {number} [opts.maxAbsM=15]   discard cells whose |tile − DEM| exceeds this (junk)
 * @param {number} [opts.minCells=150] below this many cells the estimate is void
 * @returns {{ offsetM: number|null, n: number, p05: number, p50: number, p95: number }}
 *   offsetM = median(tileMin − DEM) → ADD it to the DEM to seat it on the road.
 */
export const estimateTileDemOffset = (soup, data, {
  roadMask = null,
  roadMaskMin = 0.99,
  cellFilter = null,
  cellM = 2,
  maxAbsM = 15,
  minCells = 150,
} = {}) => {
  const upm = computeUnitsPerMeter(data) || 1;
  const cellU = cellM * upm;
  const half = SCENE_SIZE / 2;
  const C = Math.max(1, Math.ceil(SCENE_SIZE / cellU));
  const minY = rasterizeSurfaceMin(soup, C, cellU, half);
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;

  const ds = [];
  for (let cz = 0; cz < C; cz++) {
    for (let cx = 0; cx < C; cx++) {
      const t = minY[cz * C + cx];
      if (t === Infinity) continue;
      const x = (cx + 0.5) * cellU - half, z = (cz + 0.5) * cellU - half;
      if (cellFilter && !cellFilter(x, z)) continue;
      if (roadMask && !(roadMask.sample(x, z) >= roadMaskMin)) continue;
      const dem = sampleHeightAtScene(data, x, z) - minH;
      const d = t - dem;
      if (!Number.isFinite(d) || Math.abs(d) > maxAbsM) continue;
      ds.push(d);
    }
  }
  ds.sort((a, b) => a - b);
  const q = (p) => (ds.length ? ds[Math.min(ds.length - 1, Math.floor(p * ds.length))] : NaN);
  const p50 = q(0.5);
  return { offsetM: ds.length >= minCells ? p50 : null, n: ds.length, p05: q(0.05), p25: q(0.25), p50, p75: q(0.75), p95: q(0.95) };
};

/**
 * Per-cell minimum of the tile SURFACE (C×C grid over the scene plane, Y in
 * metres above datum). Rasterises triangles, not just vertices: road triangles
 * are large and flat, so vertex sampling would leave most road cells empty
 * while densely tessellated junk fills its cells.
 */
const rasterizeSurfaceMin = (soup, C, cellU, half) => {
  const minY = new Float32Array(C * C).fill(Infinity);
  const toCell = (v) => (v + half) / cellU - 0.5; // cell-centre coordinates
  for (const m of soup || []) {
    const p = m.positions;
    if (!p) continue;
    const idx = m.index;
    const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(p.length / 9);
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ax = toCell(p[i0 * 3]), ay = p[i0 * 3 + 1], az = toCell(p[i0 * 3 + 2]);
      const bx = toCell(p[i1 * 3]), by = p[i1 * 3 + 1], bz = toCell(p[i1 * 3 + 2]);
      const cx = toCell(p[i2 * 3]), cy = p[i2 * 3 + 1], cz = toCell(p[i2 * 3 + 2]);
      const denom = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(denom) < 1e-9) continue; // vertical sliver / degenerate
      const invDen = 1 / denom;
      let x0 = Math.ceil(Math.min(ax, bx, cx)), x1 = Math.floor(Math.max(ax, bx, cx));
      let z0 = Math.ceil(Math.min(az, bz, cz)), z1 = Math.floor(Math.max(az, bz, cz));
      if (x0 < 0) x0 = 0; if (x1 > C - 1) x1 = C - 1; if (z0 < 0) z0 = 0; if (z1 > C - 1) z1 = C - 1;
      if (x0 > x1 || z0 > z1) {
        // Triangle smaller than a cell: fall back to its vertices.
        for (const [vx, vy, vz] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
          const ix = Math.round(vx), iz = Math.round(vz);
          if (ix < 0 || ix >= C || iz < 0 || iz >= C) continue;
          const i = iz * C + ix;
          if (vy < minY[i]) minY[i] = vy;
        }
        continue;
      }
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const wa = ((bz - cz) * (ix - cx) + (cx - bx) * (iz - cz)) * invDen;
          const wb = ((cz - az) * (ix - cx) + (ax - cx) * (iz - cz)) * invDen;
          const wc = 1 - wa - wb;
          if (wa < -1e-4 || wb < -1e-4 || wc < -1e-4) continue;
          const y = wa * ay + wb * by + wc * cy;
          const i = iz * C + ix;
          if (y < minY[i]) minY[i] = y;
        }
      }
    }
  }
  return minY;
};

/**
 * Cell filter for the route corridor: true within `halfWidthM` of the corridor
 * polyline (lat/lng points), evaluated in the chunk's scene frame via the same
 * metric projection the tile transform uses.
 * @param {Array<{lat:number,lng:number}>} segment
 * @param {object} data      chunk TerrainData (bounds, width, height)
 * @param {number} halfWidthM
 * @param {(lat:number,lng:number)=>{x:number,y:number}} project  createMetricProjector(data.bounds, data.width, data.height)
 */
export const corridorCellFilter = (segment, data, halfWidthM, project) => {
  if (!Array.isArray(segment) || segment.length < 2 || !(halfWidthM > 0)) return null;
  const half = SCENE_SIZE / 2;
  const pts = segment.map((p) => {
    const q = project(p.lat, p.lng);
    return { x: (q.x / (data.width - 1)) * SCENE_SIZE - half, z: (q.y / (data.height - 1)) * SCENE_SIZE - half };
  });
  const reach = halfWidthM * (computeUnitsPerMeter(data) || 1);
  const reach2 = reach * reach;
  return (x, z) => {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz || 1e-12;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (a.x + t * dx), ez = z - (a.z + t * dz);
      if (ex * ex + ez * ez <= reach2) return true;
    }
    return false;
  };
};

/**
 * Route polyline in scene coordinates plus arc-length parametrisation.
 * @returns {{ pts:Array<{x:number,z:number,s:number}>, length:number,
 *   project:(x:number,z:number)=>{s:number,dist:number} }|null}
 */
export const sceneRouteLine = (segment, data, project) => {
  if (!Array.isArray(segment) || segment.length < 2) return null;
  const half = SCENE_SIZE / 2;
  const upm = computeUnitsPerMeter(data) || 1;
  const pts = [];
  let s = 0;
  for (let i = 0; i < segment.length; i++) {
    const q = project(segment[i].lat, segment[i].lng);
    const p = { x: (q.x / (data.width - 1)) * SCENE_SIZE - half, z: (q.y / (data.height - 1)) * SCENE_SIZE - half, s: 0 };
    if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) / upm; // metres
    p.s = s;
    pts.push(p);
  }
  const projectPoint = (x, z) => {
    let best = { s: 0, dist: Infinity };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L2 = dx * dx + dz * dz || 1e-12;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (a.x + t * dx), ez = z - (a.z + t * dz);
      const dist = Math.hypot(ex, ez) / upm;
      if (dist < best.dist) best = { s: a.s + t * (b.s - a.s), dist };
    }
    return best;
  };
  return { pts, length: s, project: projectPoint };
};

/**
 * ALONG-ROUTE offset field: the DEM error is not constant inside a chunk — on
 * the measured route it went from +1.0 m to −6.0 m within one 512 m chunk (a
 * railway cut the 30 m DEM does not resolve), so a constant shift left 140 m of
 * road 6 m under the DEM band and the floor on the DEM. Estimate the offset as
 * a running median along the route line (window `windowM`, step `stepM`) over
 * the same corridor carriageway cells, interpolate gaps, hold the ends, and
 * return offsetAt(x, z): the along-route value at the cell's nearest route
 * point within `fullWidthM` of the line, blending to the chunk-constant median
 * by `fadeWidthM` (off-corridor DEM is filler only).
 *
 * @returns {{ offsetAt:(x:number,z:number)=>number, constantM:number|null,
 *   minM:number, maxM:number, n:number, windows:number, windowsValid:number }|null}
 *   null when even the constant estimate is void (caller keeps the DEM).
 */
export const estimateTileDemOffsetField = (soup, data, {
  route,                 // sceneRouteLine() result (required)
  roadMask = null,
  roadMaskMin = 0.99,
  corridorHalfWidthM = 12,
  cellM = 2,
  maxAbsM = 15,
  minCells = 150,
  windowM = 60,
  stepM = 10,
  minCellsWindow = 25,
  fullWidthM = 50,
  fadeWidthM = 100,
} = {}) => {
  if (!route) return null;
  const upm = computeUnitsPerMeter(data) || 1;
  const cellU = cellM * upm;
  const half = SCENE_SIZE / 2;
  const C = Math.max(1, Math.ceil(SCENE_SIZE / cellU));
  const minY = rasterizeSurfaceMin(soup, C, cellU, half);
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;

  const samples = []; // { s, d }
  for (let cz = 0; cz < C; cz++) {
    for (let cx = 0; cx < C; cx++) {
      const t = minY[cz * C + cx];
      if (t === Infinity) continue;
      const x = (cx + 0.5) * cellU - half, z = (cz + 0.5) * cellU - half;
      const pr = route.project(x, z);
      if (pr.dist > corridorHalfWidthM) continue;
      if (roadMask && !(roadMask.sample(x, z) >= roadMaskMin)) continue;
      const d = t - (sampleHeightAtScene(data, x, z) - minH);
      if (!Number.isFinite(d) || Math.abs(d) > maxAbsM) continue;
      samples.push({ s: pr.s, d });
    }
  }
  if (samples.length < minCells) return null;
  samples.sort((a, b) => a.s - b.s);
  const median = (arr) => { const v = Float64Array.from(arr).sort(); return v[v.length >> 1]; };
  const constantM = median(samples.map((q) => q.d));

  // Running median per window along s.
  const nWin = Math.max(1, Math.floor(route.length / stepM) + 1);
  const winS = new Float64Array(nWin), winV = new Float64Array(nWin).fill(NaN);
  let lo = 0, hi = 0, valid = 0;
  for (let w = 0; w < nWin; w++) {
    const s = w * stepM;
    winS[w] = s;
    while (lo < samples.length && samples[lo].s < s - windowM / 2) lo++;
    while (hi < samples.length && samples[hi].s <= s + windowM / 2) hi++;
    if (hi - lo >= minCellsWindow) { winV[w] = median(samples.slice(lo, hi).map((q) => q.d)); valid++; }
  }
  if (!valid) {
    return { offsetAt: () => constantM, constantM, minM: constantM, maxM: constantM, n: samples.length, windows: nWin, windowsValid: 0 };
  }
  // Interpolate gaps, hold the ends.
  let first = -1, last = -1;
  for (let w = 0; w < nWin; w++) if (!Number.isNaN(winV[w])) { if (first < 0) first = w; last = w; }
  for (let w = 0; w < first; w++) winV[w] = winV[first];
  for (let w = last + 1; w < nWin; w++) winV[w] = winV[last];
  for (let w = first; w <= last; w++) {
    if (!Number.isNaN(winV[w])) continue;
    let e = w; while (Number.isNaN(winV[e])) e++;
    const a = winV[w - 1], b = winV[e], span = e - (w - 1);
    for (let k = w; k < e; k++) winV[k] = a + ((k - (w - 1)) / span) * (b - a);
    w = e;
  }
  let minM = Infinity, maxM = -Infinity;
  for (let w = 0; w < nWin; w++) { if (winV[w] < minM) minM = winV[w]; if (winV[w] > maxM) maxM = winV[w]; }
  const alongAt = (s) => {
    const f = Math.max(0, Math.min(nWin - 1, s / stepM));
    const w0 = Math.floor(f), w1 = Math.min(nWin - 1, w0 + 1), t = f - w0;
    return winV[w0] * (1 - t) + winV[w1] * t;
  };
  const offsetAt = (x, z) => {
    const pr = route.project(x, z);
    const v = alongAt(pr.s);
    if (pr.dist <= fullWidthM) return v;
    const t = Math.min(1, (pr.dist - fullWidthM) / Math.max(1e-6, fadeWidthM));
    const sm = t * t * (3 - 2 * t);
    return v * (1 - sm) + constantM * sm;
  };
  return { offsetAt, constantM, minM, maxM, n: samples.length, windows: nWin, windowsValid: valid };
};

/** Copy of `data` whose heightMap is shifted by offsetM (datum minHeight unchanged). */
export const shiftHeightMap = (data, offsetM) => {
  const shifted = new Float32Array(data.heightMap.length);
  for (let i = 0; i < shifted.length; i++) shifted[i] = data.heightMap[i] + offsetM;
  return { ...data, heightMap: shifted };
};

/** Copy of `data` whose heightMap is shifted per pixel by offsetAt(sceneX, sceneZ). */
export const shiftHeightMapByField = (data, offsetAt) => {
  const { width: w, height: h } = data;
  const half = SCENE_SIZE / 2;
  const shifted = new Float32Array(data.heightMap.length);
  for (let row = 0; row < h; row++) {
    const z = (row / (h - 1)) * SCENE_SIZE - half;
    for (let col = 0; col < w; col++) {
      const x = (col / (w - 1)) * SCENE_SIZE - half;
      const i = row * w + col;
      shifted[i] = data.heightMap[i] + offsetAt(x, z);
    }
  }
  return { ...data, heightMap: shifted };
};
