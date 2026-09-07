#!/usr/bin/env node
// Chunk frame invariant check for route bakes.
//
// Reads the REAL sidecar bake containers (job.json + out.bin, MBK1) of one
// route and places every chunk's tile mesh, extracted ground and DEM into ONE
// absolute frame:
//   east/north  = equirectangular metres about chunk 0's centre (the frame the
//                 route composite and both placements use),
//   height      = absolute metres (mesh: Y + chunk datum minHeight; ground and
//                 DEM: absolute already).
// Then it verifies the invariants the assembly relies on:
//   1. per chunk: anchor chain (natural vs shared offset, DEM re-seat), mesh /
//      ground / DEM height distributions, tile-vs-ground and tile-vs-DEM gaps
//      on the corridor,
//   2. per chunk pair (bounds overlap): ground A−B, DEM A−B, TILE A−B (where
//      both meshes exist), cross gaps (tile A − ground B, tile B − ground A),
//      horizontal best shift of the grounds, and TILE seam continuity across
//      the ownership (Voronoi) line — with and without the registration
//      offsets the assembly applies,
//   3. placement: preview translation.y vs export baseUp vs .ter datum, plus
//      what registerChunkGrounds would apply.
// Optionally writes top-down debug PNGs (heat maps + chunk boundaries).
//
// Usage:
//   node tools/chunk_frame_invariants.mjs                 # newest route set in $TMPDIR
//   node tools/chunk_frame_invariants.mjs --list          # list candidate sets
//   node tools/chunk_frame_invariants.mjs --set <index>   # pick a set from --list
//   node tools/chunk_frame_invariants.mjs <dir> <dir> ... # explicit containers
//   options: --png <outDir>  --cell <metres, default 2>  --json <file>

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import proj4 from 'proj4';
import { encode as encodePng } from 'fast-png';
import { registerChunkGrounds, sampleHeightAt } from '../packages/route/src/routeTerrainComposite.js';
import { computeRouteFrame } from '../packages/route/src/routeStitch.js';

const M_PER_DEG_LAT = 111320;
const SCENE_SIZE = 100;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = { png: null, cell: 2, json: null, list: false, set: null, dirs: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--png') opt.png = argv[++i];
  else if (a === '--cell') opt.cell = Number(argv[++i]);
  else if (a === '--json') opt.json = argv[++i];
  else if (a === '--list') opt.list = true;
  else if (a === '--set') opt.set = Number(argv[++i]);
  else opt.dirs.push(a);
}

// ─── Container discovery ─────────────────────────────────────────────────────
const readJobSummary = (dir) => {
  const jp = path.join(dir, 'job.json');
  const op = path.join(dir, 'out.bin');
  if (!existsSync(jp) || !existsSync(op)) return null;
  let job;
  try { job = JSON.parse(readFileSync(jp, 'utf8')); } catch { return null; }
  const o = job.options || {};
  if (o.prefetchOnly) return null;
  const own = o.corridorOwnership;
  const groupKey = own?.centers
    ? own.centers.map((c) => `${c.lat.toFixed(6)},${c.lng.toFixed(6)}`).join(';')
    : `single:${JSON.stringify(job.data.bounds)}`;
  return {
    dir,
    mtime: statSync(op).mtimeMs,
    self: own?.self ?? 0,
    groupKey,
    n: own?.centers?.length ?? 1,
    shared: o.sharedGroundOffsetM ?? null,
  };
};

const discoverSets = () => {
  const T = process.env.TMPDIR || os.tmpdir();
  const jobs = readdirSync(T)
    .filter((d) => d.startsWith('mapng-google-bake-'))
    .map((d) => readJobSummary(path.join(T, d)))
    .filter(Boolean);
  const groups = new Map();
  for (const j of jobs) {
    if (!groups.has(j.groupKey)) groups.set(j.groupKey, []);
    groups.get(j.groupKey).push(j);
  }
  const sets = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    // Generations: containers of the same chunk written at different times.
    // A "set" = for each self, one container; build one set per distinct
    // generation by clustering on write time (gap > 6 minutes = new generation).
    list.sort((a, b) => a.mtime - b.mtime);
    let gen = [];
    const flush = () => {
      if (!gen.length) return;
      const bySelf = new Map();
      for (const j of gen) bySelf.set(j.self, j); // newest wins within a generation
      sets.push({ key, n: gen[0].n, chunks: [...bySelf.values()].sort((a, b) => a.self - b.self), mtime: Math.max(...gen.map((j) => j.mtime)) });
      gen = [];
    };
    for (let i = 0; i < list.length; i++) {
      if (gen.length && list[i].mtime - gen[gen.length - 1].mtime > 6 * 60 * 1000) flush();
      gen.push(list[i]);
    }
    flush();
  }
  sets.sort((a, b) => a.mtime - b.mtime);
  return sets;
};

// ─── Container parsing ───────────────────────────────────────────────────────
const decodeF32 = (b64) => {
  const b = Buffer.from(b64, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

const readContainer = (dir) => {
  const job = JSON.parse(readFileSync(path.join(dir, 'job.json'), 'utf8'));
  job.data.heightMap = typeof job.data.heightMap === 'string' ? decodeF32(job.data.heightMap) : Float32Array.from(job.data.heightMap);
  const buf = readFileSync(path.join(dir, 'out.bin'));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(0, true) !== 0x4d424b31) throw new Error(`${dir}: not an MBK1 container`);
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8'));
  const payload = (8 + headerLen + 3) & ~3;
  const f32 = (ref) => new Float32Array(buf.buffer.slice(buf.byteOffset + payload + ref.offset, buf.byteOffset + payload + ref.offset + ref.byteLength));
  const u8 = (ref) => new Uint8Array(buf.buffer.slice(buf.byteOffset + payload + ref.offset, buf.byteOffset + payload + ref.offset + ref.byteLength));
  const ground = header.ground?.heightMap
    ? {
      heightMap: f32(header.ground.heightMap),
      coverage: header.ground.coverage ? u8(header.ground.coverage) : null,
      width: header.ground.width,
      height: header.ground.height,
      minHeight: header.ground.minHeight,
      bounds: job.data.bounds,
    }
    : null;
  // Only INDEXED vertices are rendered: the worker's strip / ownership-clip
  // passes rewrite the index and leave the dropped vertices in the position
  // buffer. Mark the referenced vertices so the rasterizer sees the visible mesh.
  const meshes = header.meshes.map((m) => {
    const positions = f32(m.positions);
    let used = null;
    if (m.index) {
      const Idx = m.index.kind === 'u32' ? Uint32Array : Uint16Array;
      const idx = new Idx(buf.buffer.slice(buf.byteOffset + payload + m.index.offset, buf.byteOffset + payload + m.index.offset + m.index.byteLength));
      used = new Uint8Array(positions.length / 3);
      for (let i = 0; i < idx.length; i++) used[idx[i]] = 1;
    }
    return { name: m.name, positions, used };
  });
  return { dir, job, header, ground, meshes };
};

// Inverse of createMetricProjector (packages/geo): scene X/Z → lat/lng.
const createSceneToLatLng = (data) => {
  const b = data.bounds;
  const centerLat = (b.north + b.south) / 2;
  const centerLng = (b.east + b.west) / 2;
  const tmerc = `+proj=tmerc +lat_0=${centerLat} +lon_0=${centerLng} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
  const conv = proj4('EPSG:4326', tmerc);
  const [minX, minY] = conv.forward([b.west, b.south]);
  const [maxX, maxY] = conv.forward([b.east, b.north]);
  const widthM = Math.abs(maxX - minX), heightM = Math.abs(maxY - minY);
  return (x, z) => {
    const u = (x + SCENE_SIZE / 2) / SCENE_SIZE;
    const v = (z + SCENE_SIZE / 2) / SCENE_SIZE; // v = pixel row fraction (north = 0)
    const localX = minX + u * widthM;
    const localY = minY + (1 - v) * heightM;
    const [lng, lat] = conv.inverse([localX, localY]);
    return { lat, lng };
  };
};

// ─── Statistics helpers ──────────────────────────────────────────────────────
const quant = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN);
const stats = (arr) => {
  const s = Float64Array.from(arr).sort();
  const n = s.length;
  if (!n) return { n: 0 };
  let sum = 0; for (let i = 0; i < n; i++) sum += s[i];
  return { n, min: s[0], p05: quant(s, 0.05), p25: quant(s, 0.25), p50: quant(s, 0.5), p75: quant(s, 0.75), p95: quant(s, 0.95), max: s[n - 1], mean: sum / n };
};
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '   —');
const fmt = (st) => (st.n ? `n=${String(st.n).padStart(6)}  p05 ${f2(st.p05).padStart(7)}  p50 ${f2(st.p50).padStart(7)}  p95 ${f2(st.p95).padStart(7)}  mean ${f2(st.mean).padStart(7)}  [${f2(st.min)}, ${f2(st.max)}]` : 'n=     0');

// ─── Global raster frame ─────────────────────────────────────────────────────
class Raster {
  constructor(frame, fill = NaN) {
    this.frame = frame;
    this.w = frame.cols; this.h = frame.rows;
    this.a = new Float32Array(this.w * this.h).fill(fill);
  }
  idx(col, row) { return row * this.w + col; }
  get(col, row) { return this.a[row * this.w + col]; }
  set(col, row, v) { this.a[row * this.w + col] = v; }
}

const buildFrame = (chunks, cellM) => {
  const c0 = chunks[0].center;
  const mLng = mPerDegLng(c0.lat);
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (const c of chunks) {
    const b = c.job.data.bounds;
    minE = Math.min(minE, (b.west - c0.lng) * mLng); maxE = Math.max(maxE, (b.east - c0.lng) * mLng);
    minN = Math.min(minN, (b.south - c0.lat) * M_PER_DEG_LAT); maxN = Math.max(maxN, (b.north - c0.lat) * M_PER_DEG_LAT);
  }
  const pad = 4 * cellM;
  minE -= pad; maxE += pad; minN -= pad; maxN += pad;
  const cols = Math.ceil((maxE - minE) / cellM), rows = Math.ceil((maxN - minN) / cellM);
  const frame = {
    origin: c0, mLng, cellM, minE, maxE, minN, maxN, cols, rows,
    toEN: (lat, lng) => ({ e: (lng - c0.lng) * mLng, n: (lat - c0.lat) * M_PER_DEG_LAT }),
    toCell: (e, n) => ({ col: Math.floor((e - minE) / cellM), row: Math.floor((maxN - n) / cellM) }), // row 0 = north
    cellCenterLatLng: (col, row) => {
      const e = minE + (col + 0.5) * cellM, n = maxN - (row + 0.5) * cellM;
      return { lat: c0.lat + n / M_PER_DEG_LAT, lng: c0.lng + e / mLng, e, n };
    },
  };
  return frame;
};

const inBounds = (b, lat, lng) => lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;

// Rasterize a chunk's mesh onto the global grid: per cell the MIN absolute
// height (the road surface where the road is the lowest thing), the vertex
// count, and — for a sub-surface junk check — the count of vertices more than
// 2 m below the cell minimum-of-the-upper-cluster (approximated by the p10 of a
// small per-cell reservoir).
const rasterizeMesh = (chunk, frame) => {
  const minR = new Raster(frame, Infinity);
  const cnt = new Uint32Array(frame.cols * frame.rows);
  const toLL = createSceneToLatLng(chunk.job.data);
  const datum = chunk.job.data.minHeight;
  let verts = 0, yMin = Infinity, yMax = -Infinity;
  const ySample = [];
  for (const m of chunk.meshes) {
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      if (m.used && !m.used[i / 3]) continue; // dropped by strip / ownership clip
      const x = p[i], y = p[i + 1] + datum, z = p[i + 2];
      verts++;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
      if ((verts % 97) === 0) ySample.push(y);
      const ll = toLL(x, z);
      const { e, n } = frame.toEN(ll.lat, ll.lng);
      const { col, row } = frame.toCell(e, n);
      if (col < 0 || col >= frame.cols || row < 0 || row >= frame.rows) continue;
      const k = minR.idx(col, row);
      if (y < minR.a[k]) minR.a[k] = y;
      cnt[k]++;
    }
  }
  for (let k = 0; k < minR.a.length; k++) if (minR.a[k] === Infinity) minR.a[k] = NaN;
  return { min: minR, cnt, verts, yMin, yMax, yAbs: stats(ySample) };
};

// Sample a chunk-grid field (bounds-linear, north-origin rows) onto the global grid.
const rasterizeField = (chunk, frame, field, w, h, { nearest = false } = {}) => {
  const r = new Raster(frame, NaN);
  const b = chunk.job.data.bounds;
  const terrain = { bounds: b, width: w, height: h, heightMap: field, minHeight: -1e9 };
  for (let row = 0; row < frame.rows; row++) {
    for (let col = 0; col < frame.cols; col++) {
      const { lat, lng } = frame.cellCenterLatLng(col, row);
      if (!inBounds(b, lat, lng)) continue;
      if (nearest) {
        const u = (lng - b.west) / (b.east - b.west), v = (b.north - lat) / (b.north - b.south);
        const x = Math.round(u * (w - 1)), y = Math.round(v * (h - 1));
        r.set(col, row, field[y * w + x]);
      } else {
        r.set(col, row, sampleHeightAt(terrain, lat, lng));
      }
    }
  }
  return r;
};

// Corridor distance raster: metres from the union of the chunks' corridor
// centrelines (job.options.corridorSegment).
const rasterizeCorridorDistance = (chunks, frame) => {
  const r = new Raster(frame, Infinity);
  const segs = [];
  for (const c of chunks) {
    const seg = c.job.options.corridorSegment;
    if (!Array.isArray(seg)) continue;
    const pts = seg.map((p) => frame.toEN(p.lat, p.lng));
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  }
  const distSeg = (e, n, [a, b]) => {
    const dx = b.e - a.e, dy = b.n - a.n;
    const L2 = dx * dx + dy * dy || 1e-9;
    let t = ((e - a.e) * dx + (n - a.n) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(e - (a.e + t * dx), n - (a.n + t * dy));
  };
  for (let row = 0; row < frame.rows; row++) {
    for (let col = 0; col < frame.cols; col++) {
      const { e, n } = frame.cellCenterLatLng(col, row);
      let d = Infinity;
      for (const s of segs) { const v = distSeg(e, n, s); if (v < d) d = v; }
      r.set(col, row, d);
    }
  }
  return r;
};

// Ownership raster: index of the nearest ROUTE chunk centre per cell (Voronoi).
// Uses the centre set the worker clipped against (job.options.corridorOwnership),
// so a partially loaded set still gets the true ownership lines.
const rasterizeOwnership = (chunks, frame) => {
  const routeCenters = chunks[0].job.options.corridorOwnership?.centers ?? chunks.map((c) => c.center);
  const centers = routeCenters.map((c) => frame.toEN(c.lat, c.lng));
  const own = new Int16Array(frame.cols * frame.rows).fill(-1);
  for (let row = 0; row < frame.rows; row++) {
    for (let col = 0; col < frame.cols; col++) {
      const { e, n } = frame.cellCenterLatLng(col, row);
      let best = -1, bd = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = Math.hypot(centers[i].e - e, centers[i].n - n);
        if (d < bd) { bd = d; best = i; }
      }
      own[row * frame.cols + col] = best;
    }
  }
  return own;
};

// Best horizontal shift (in cells) of raster B against raster A minimising the
// median |A − B| over cells where both are finite (and `mask` true).
const bestShift = (A, B, mask, maxCells) => {
  const { cols, rows } = A.frame;
  let best = null;
  for (let de = -maxCells; de <= maxCells; de++) {
    for (let dn = -maxCells; dn <= maxCells; dn++) {
      const ds = [];
      for (let row = 0; row < rows; row++) {
        const rb = row - dn; // shift B north by dn cells → sample B at row − dn
        if (rb < 0 || rb >= rows) continue;
        for (let col = 0; col < cols; col++) {
          const cb = col - de;
          if (cb < 0 || cb >= cols) continue;
          const k = row * cols + col;
          if (mask && !mask[k]) continue;
          const a = A.a[k], b = B.a[rb * cols + cb];
          if (Number.isNaN(a) || Number.isNaN(b)) continue;
          ds.push(Math.abs(a - b));
        }
      }
      if (ds.length < 30) continue;
      const s = Float64Array.from(ds).sort();
      const med = s[s.length >> 1];
      if (!best || med < best.med) best = { de, dn, med, n: ds.length };
    }
  }
  return best;
};

// ─── PNG output ──────────────────────────────────────────────────────────────
const CHUNK_COLORS = [[230, 80, 60], [60, 160, 230], [90, 200, 90], [240, 190, 40], [200, 90, 220], [60, 210, 200], [240, 130, 40], [150, 150, 150]];

const divergingColor = (v, range) => {
  // blue (below) → white (0) → red (above)
  const t = Math.max(-1, Math.min(1, v / range));
  if (t >= 0) return [255, Math.round(255 * (1 - t)), Math.round(255 * (1 - t))];
  return [Math.round(255 * (1 + t)), Math.round(255 * (1 + t)), 255];
};
const grayColor = (v, lo, hi) => { const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))); const g = Math.round(40 + 215 * t); return [g, g, g]; };

const drawOverlays = (img, frame, chunks, ownership, corridorDist) => {
  const { cols, rows } = frame;
  const put = (col, row, rgb, alpha = 1) => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return;
    const k = (row * cols + col) * 4;
    img[k] = Math.round(img[k] * (1 - alpha) + rgb[0] * alpha);
    img[k + 1] = Math.round(img[k + 1] * (1 - alpha) + rgb[1] * alpha);
    img[k + 2] = Math.round(img[k + 2] * (1 - alpha) + rgb[2] * alpha);
  };
  // Voronoi (ownership) lines: cells whose right/bottom neighbour has another owner.
  for (let row = 0; row < rows - 1; row++) for (let col = 0; col < cols - 1; col++) {
    const o = ownership[row * cols + col];
    if (o !== ownership[row * cols + col + 1] || o !== ownership[(row + 1) * cols + col]) put(col, row, [255, 255, 255]);
  }
  // Corridor centreline (black) — cells within half a cell of the line.
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    if (corridorDist.get(col, row) <= frame.cellM * 0.75) put(col, row, [0, 0, 0]);
  }
  // Chunk bounds rectangles in the chunk colour.
  chunks.forEach((c, i) => {
    const b = c.job.data.bounds;
    const sw = frame.toCell(frame.toEN(b.south, b.west).e, frame.toEN(b.south, b.west).n);
    const ne = frame.toCell(frame.toEN(b.north, b.east).e, frame.toEN(b.north, b.east).n);
    const col0 = Math.min(sw.col, ne.col), col1 = Math.max(sw.col, ne.col);
    const row0 = Math.min(sw.row, ne.row), row1 = Math.max(sw.row, ne.row);
    const rgb = CHUNK_COLORS[i % CHUNK_COLORS.length];
    for (let col = col0; col <= col1; col++) { put(col, row0, rgb); put(col, row1, rgb); put(col, row0 + 1, rgb, 0.6); put(col, row1 - 1, rgb, 0.6); }
    for (let row = row0; row <= row1; row++) { put(col0, row, rgb); put(col1, row, rgb); put(col0 + 1, row, rgb, 0.6); put(col1 - 1, row, rgb, 0.6); }
    // Chunk centre marker (5×5).
    const cc = frame.toCell(frame.toEN(c.center.lat, c.center.lng).e, frame.toEN(c.center.lat, c.center.lng).n);
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) put(cc.col + dc, cc.row + dr, rgb);
  });
};

const writeRasterPng = (file, frame, colorAt, chunks, ownership, corridorDist) => {
  const { cols, rows } = frame;
  const img = new Uint8Array(cols * rows * 4);
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const rgb = colorAt(col, row) || [20, 20, 24];
    const k = (row * cols + col) * 4;
    img[k] = rgb[0]; img[k + 1] = rgb[1]; img[k + 2] = rgb[2]; img[k + 3] = 255;
  }
  drawOverlays(img, frame, chunks, ownership, corridorDist);
  writeFileSync(file, encodePng({ width: cols, height: rows, data: img, channels: 4 }));
};

// ─── Main ────────────────────────────────────────────────────────────────────
const main = () => {
  let dirs = opt.dirs;
  if (!dirs.length) {
    const sets = discoverSets();
    if (opt.list || !sets.length) {
      if (!sets.length) { console.log('no route bake sets found in', process.env.TMPDIR || os.tmpdir()); return; }
      sets.forEach((s, i) => {
        console.log(`[${i}] ${new Date(s.mtime).toISOString().slice(0, 19)}  ${s.chunks.length}/${s.n} chunks  shared=${s.chunks.map((c) => (c.shared == null ? 'nat' : c.shared.toFixed(2))).join('/')}  ${s.chunks.map((c) => path.basename(c.dir).replace('mapng-google-bake-', '')).join(' ')}`);
      });
      if (opt.list) return;
    }
    const pick = opt.set ?? sets.length - 1;
    const s = sets[pick];
    console.log(`set [${pick}] ${new Date(s.mtime).toISOString().slice(0, 19)} — ${s.chunks.length} chunks`);
    dirs = s.chunks.map((c) => c.dir);
  }

  const chunks = dirs.map((d) => {
    const c = readContainer(d);
    const b = c.job.data.bounds;
    c.center = c.job.options.corridorOwnership?.centers?.[c.job.options.corridorOwnership.self]
      ?? { lat: (b.north + b.south) / 2, lng: (b.east + b.west) / 2 };
    c.self = c.job.options.corridorOwnership?.self ?? chunks?.length ?? 0;
    return c;
  });
  chunks.sort((a, b) => a.self - b.self);

  const frame = buildFrame(chunks, opt.cell);
  console.log(`\nglobal frame: origin chunk 0 centre ${frame.origin.lat.toFixed(6)},${frame.origin.lng.toFixed(6)}; grid ${frame.cols}×${frame.rows} @ ${frame.cellM} m`);

  const corridorDist = rasterizeCorridorDistance(chunks, frame);
  const ownership = rasterizeOwnership(chunks, frame);
  const halfWidth = chunks[0].job.options.corridorHalfWidthM || 50;
  const roadCore = new Uint8Array(frame.cols * frame.rows);
  const corridor = new Uint8Array(frame.cols * frame.rows);
  for (let k = 0; k < roadCore.length; k++) { roadCore[k] = corridorDist.a[k] <= 6 ? 1 : 0; corridor[k] = corridorDist.a[k] <= halfWidth ? 1 : 0; }

  // ── 1. per chunk ──────────────────────────────────────────────────────────
  console.log('\n══ 1. per-chunk anchor chain and absolute heights ══');
  const per = [];
  for (const c of chunks) {
    const d = c.job.data, o = c.job.options, a = c.header.anchor;
    const centerIdx = Math.floor(d.height / 2) * d.width + Math.floor(d.width / 2);
    // sampleHeightAtScene(data,0,0) = bilinear at pixel ((w−1)/2,(h−1)/2)
    const jobDemCenter = sampleHeightAt(d, (d.bounds.north + d.bounds.south) / 2, (d.bounds.east + d.bounds.west) / 2);
    const naturalJob = jobDemCenter - a.googleGroundAlt;
    const naturalHdr = a.mapngGroundY - a.googleGroundAlt;
    const shared = o.sharedGroundOffsetM ?? null;
    const used = shared ?? naturalJob;
    const demReseat = shared != null ? shared - naturalJob : 0;
    const demReseatApplied = shared != null && Math.abs(naturalHdr - shared) < 1e-3 && Math.abs(demReseat) > 1e-3;
    let demMin = Infinity, demMax = -Infinity;
    for (const v of d.heightMap) { if (v < demMin) demMin = v; if (v > demMax) demMax = v; }

    const mesh = rasterizeMesh(c, frame);
    const groundR = c.ground ? rasterizeField(c, frame, c.ground.heightMap, c.ground.width, c.ground.height) : null;
    const covR = c.ground?.coverage ? rasterizeField(c, frame, Float32Array.from(c.ground.coverage), c.ground.width, c.ground.height, { nearest: true }) : null;
    const demR = rasterizeField(c, frame, d.heightMap, d.width, d.height);

    // Ownership check: fraction of tile cells outside this chunk's Voronoi cell.
    let tileCells = 0, foreign = 0;
    const gapCov = [], gapRoad = [], tileDemRoad = [], groundDemRoad = [], groundCov = [];
    for (let k = 0; k < mesh.min.a.length; k++) {
      const t = mesh.min.a[k];
      if (!Number.isNaN(t)) { tileCells++; if (ownership[k] !== c.self) foreign++; }
      const g = groundR ? groundR.a[k] : NaN;
      const cov = covR ? covR.a[k] >= 1 : true;
      if (!Number.isNaN(g) && cov) groundCov.push(g);
      if (!Number.isNaN(t) && !Number.isNaN(g) && cov) { gapCov.push(t - g); if (roadCore[k]) gapRoad.push(t - g); }
      if (!Number.isNaN(t) && roadCore[k] && !Number.isNaN(demR.a[k])) tileDemRoad.push(t - demR.a[k]);
      if (!Number.isNaN(g) && roadCore[k] && !Number.isNaN(demR.a[k])) groundDemRoad.push(g - demR.a[k]);
    }
    const rec = {
      self: c.self, dir: path.basename(c.dir), datum: d.minHeight, demMin, demMax, jobDemCenter,
      googleGroundAlt: a.googleGroundAlt, mapngGroundYHdr: a.mapngGroundY, naturalJob, naturalHdr, shared, used, demReseat, demReseatApplied,
      meshVerts: mesh.verts, meshAbs: mesh.yAbs, meshMinAbs: mesh.yMin, meshMaxAbs: mesh.yMax,
      tileCells, foreignFrac: tileCells ? foreign / tileCells : 0,
      groundAbs: stats(groundCov), groundMinHdr: c.ground?.minHeight,
      tileMinusGroundCovered: stats(gapCov), tileMinusGroundRoad: stats(gapRoad),
      tileMinusDemRoad: stats(tileDemRoad), groundMinusDemRoad: stats(groundDemRoad),
      _mesh: mesh, _ground: groundR, _cov: covR, _dem: demR,
    };
    per.push(rec);
    console.log(`\n── chunk ${c.self}  (${rec.dir})`);
    console.log(`   datum minHeight ${f2(d.minHeight)}   DEM(job) [${f2(demMin)}, ${f2(demMax)}]  centre ${f2(jobDemCenter)}   ground.minHeight(header) ${f2(c.ground?.minHeight)}`);
    console.log(`   probe googleGroundAlt ${f2(a.googleGroundAlt)} (ellipsoidal)   natural offset (job DEM) ${f2(naturalJob)}   header mapngGroundY ${f2(a.mapngGroundY)} → header natural ${f2(naturalHdr)}`);
    console.log(`   shared ${shared == null ? 'none (natural anchor)' : f2(shared)}   USED ${f2(used)}   shared − natural = ${f2(demReseat)}   DEM re-seated in worker: ${
      Number.isFinite(a.demShiftM)
        ? `${f2(a.demShiftM)} m${Array.isArray(a.demShiftRangeM) ? ` along route ${f2(a.demShiftRangeM[0])} … ${f2(a.demShiftRangeM[1])} m` : ''} (corridor estimate, header)`
        : demReseatApplied ? 'YES (single-point probe delta, tsnap13)' : 'no'}`);
    console.log(`   mesh: ${mesh.verts} verts, abs Y [${f2(mesh.yMin)}, ${f2(mesh.yMax)}], sample ${fmt(mesh.yAbs)}`);
    console.log(`   mesh cells ${tileCells}, outside own Voronoi cell ${(rec.foreignFrac * 100).toFixed(1)}%`);
    console.log(`   ground abs (covered):      ${fmt(rec.groundAbs)}`);
    console.log(`   tile MIN − ground (covered): ${fmt(rec.tileMinusGroundCovered)}`);
    console.log(`   tile MIN − ground (road ≤6m):${fmt(rec.tileMinusGroundRoad)}`);
    console.log(`   tile MIN − DEM(job) (road):  ${fmt(rec.tileMinusDemRoad)}`);
    console.log(`   ground − DEM(job) (road):    ${fmt(rec.groundMinusDemRoad)}`);
  }

  // ── 2. per pair ───────────────────────────────────────────────────────────
  console.log('\n══ 2. chunk pairs (bounds overlap) ══');
  const pairs = [];
  const maxShiftCells = Math.max(1, Math.round(8 / frame.cellM));
  for (let i = 0; i < per.length; i++) for (let j = i + 1; j < per.length; j++) {
    const A = per[i], B = per[j];
    const bA = chunks[i].job.data.bounds, bB = chunks[j].job.data.bounds;
    const west = Math.max(bA.west, bB.west), east = Math.min(bA.east, bB.east), south = Math.max(bA.south, bB.south), north = Math.min(bA.north, bB.north);
    if (east <= west || north <= south) continue;
    const band = new Uint8Array(frame.cols * frame.rows);
    for (let row = 0; row < frame.rows; row++) for (let col = 0; col < frame.cols; col++) {
      const { lat, lng } = frame.cellCenterLatLng(col, row);
      if (lat >= south && lat <= north && lng >= west && lng <= east) band[row * frame.cols + col] = 1;
    }
    const gAB = [], gABroad = [], dAB = [], tAB = [], tAgB = [], tBgA = [], tAgBroad = [], tBgAroad = [];
    for (let k = 0; k < band.length; k++) {
      if (!band[k]) continue;
      const ga = A._ground?.a[k] ?? NaN, gb = B._ground?.a[k] ?? NaN;
      const ca = A._cov ? A._cov.a[k] >= 1 : true, cb = B._cov ? B._cov.a[k] >= 1 : true;
      const ta = A._mesh.min.a[k], tb = B._mesh.min.a[k];
      const da = A._dem.a[k], db = B._dem.a[k];
      if (!Number.isNaN(ga) && !Number.isNaN(gb) && ca && cb) { gAB.push(ga - gb); if (roadCore[k]) gABroad.push(ga - gb); }
      if (!Number.isNaN(da) && !Number.isNaN(db)) dAB.push(da - db);
      if (!Number.isNaN(ta) && !Number.isNaN(tb)) tAB.push(ta - tb);
      if (!Number.isNaN(ta) && !Number.isNaN(gb) && cb) { tAgB.push(ta - gb); if (roadCore[k]) tAgBroad.push(ta - gb); }
      if (!Number.isNaN(tb) && !Number.isNaN(ga) && ca) { tBgA.push(tb - ga); if (roadCore[k]) tBgAroad.push(tb - ga); }
    }
    const shiftG = A._ground && B._ground ? bestShift(A._ground, B._ground, band, maxShiftCells) : null;
    // Seam continuity of the TILES across the ownership line: for road-core
    // cells owned by A within 6 m of a B-owned cell, compare A's tile min with
    // the nearest B tile min across the line (≤ 3 cells away).
    const seam = (offA = 0, offB = 0) => {
      const ds = [];
      const R = Math.max(1, Math.round(6 / frame.cellM));
      for (let row = R; row < frame.rows - R; row++) for (let col = R; col < frame.cols - R; col++) {
        const k = row * frame.cols + col;
        if (ownership[k] !== A.self || !roadCore[k]) continue;
        const ta = A._mesh.min.a[k];
        if (Number.isNaN(ta)) continue;
        let bestD = Infinity, tb = NaN;
        for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
          const kk = (row + dr) * frame.cols + col + dc;
          if (ownership[kk] !== B.self) continue;
          const v = B._mesh.min.a[kk];
          if (Number.isNaN(v)) continue;
          const dd = dr * dr + dc * dc;
          if (dd < bestD) { bestD = dd; tb = v; }
        }
        if (!Number.isNaN(tb)) ds.push((ta + offA) - (tb + offB));
      }
      return stats(ds);
    };
    const rec = { a: A.self, b: B.self, bandM: [(east - west) * frame.mLng, (north - south) * M_PER_DEG_LAT],
      groundAB: stats(gAB), groundABroad: stats(gABroad), demAB: stats(dAB), tileAB: stats(tAB),
      tileAgroundB: stats(tAgB), tileBgroundA: stats(tBgA), tileAgroundBroad: stats(tAgBroad), tileBgroundAroad: stats(tBgAroad),
      groundBestShift: shiftG, seamRaw: seam() };
    pairs.push(rec);
    console.log(`\n── chunks ${A.self} ↔ ${B.self}: overlap band ${rec.bandM[0].toFixed(0)} × ${rec.bandM[1].toFixed(0)} m`);
    console.log(`   DEM A − DEM B:                 ${fmt(rec.demAB)}`);
    console.log(`   ground A − ground B (covered): ${fmt(rec.groundAB)}`);
    console.log(`   ground A − ground B (road):    ${fmt(rec.groundABroad)}`);
    console.log(`   tile A − tile B (both meshes): ${fmt(rec.tileAB)}`);
    console.log(`   tile A − ground B (covered):   ${fmt(rec.tileAgroundB)}`);
    console.log(`   tile B − ground A (covered):   ${fmt(rec.tileBgroundA)}`);
    console.log(`   tile A − ground B (road):      ${fmt(rec.tileAgroundBroad)}`);
    console.log(`   tile B − ground A (road):      ${fmt(rec.tileBgroundAroad)}`);
    if (shiftG) console.log(`   ground best shift of B: east ${shiftG.de * frame.cellM} m, north ${shiftG.dn * frame.cellM} m → median |Δ| ${f2(shiftG.med)} (n=${shiftG.n})`);
    console.log(`   TILE seam continuity across ownership line (road, raw placement): ${fmt(rec.seamRaw)}`);
    rec._seam = seam;
  }

  // ── 3. placement ──────────────────────────────────────────────────────────
  console.log('\n══ 3. placement: preview (computeRouteFrame) vs export (baseUp) vs .ter datum ══');
  const frameInputs = chunks.map((c) => ({ center: c.center, unitsPerMeter: SCENE_SIZE / ((c.job.data.bounds.east - c.job.data.bounds.west) * mPerDegLng((c.job.data.bounds.north + c.job.data.bounds.south) / 2)), minHeight: c.job.data.minHeight }));
  const rf = computeRouteFrame(frameInputs, 512);
  const datums = chunks.map((c) => c.job.data.minHeight);
  const combinedMinHeight = Math.min(...datums); // buildCombinedRouteTerrain fill floor = lowest datum
  const reg = registerChunkGrounds(chunks.map((c) => (c.ground ? { ...c.ground, coverage: c.ground.coverage } : null)));
  console.log(`   .ter datum (combined.minHeight ≈ lowest chunk datum): ${f2(combinedMinHeight)}`);
  for (let i = 0; i < chunks.length; i++) {
    const prevY = rf.placements[i].translationM.y;
    const baseUp = datums[i] - combinedMinHeight;
    const regOff = reg.offsets[i] || 0;
    console.log(`   chunk ${i}: datum ${f2(datums[i])}  preview y ${f2(prevY)}  export baseUp ${f2(baseUp)}  (baseUp − y = ${f2(baseUp - prevY)}, must equal ${f2(datums[0] - combinedMinHeight)} for all)  registration offset ${f2(regOff)}${regOff ? '  ← applied to mesh AND ground' : ''}`);
  }
  for (const p of reg.pairs) console.log(`   registerChunkGrounds ${p.a}→${p.b}: median Δh ${f2(p.medianDhM)} over ${p.n} samples → offset ${f2(p.offsetM)}${p.applied ? '' : ' (inherited)'}`);
  // Effect of registration on the TILE seams.
  console.log('\n   TILE seam continuity WITH the registration offsets applied to the mesh placement:');
  for (const pr of pairs) {
    const st = pr._seam(reg.offsets[pr.a] || 0, reg.offsets[pr.b] || 0);
    pr.seamRegistered = st;
    console.log(`   chunks ${pr.a} ↔ ${pr.b}: raw p50 ${f2(pr.seamRaw.p50)} → registered p50 ${f2(st.p50)}   (p05 ${f2(st.p05)}, p95 ${f2(st.p95)}, n=${st.n})`);
  }

  // ── 4. verdicts ───────────────────────────────────────────────────────────
  console.log('\n══ 4. invariant verdicts ══');
  const flag = (ok, msg) => console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${msg}`);
  const sharedVals = per.map((p) => p.shared).filter((v) => v != null);
  flag(sharedVals.every((v) => Math.abs(v - sharedVals[0]) < 1e-6), `one shared anchor for all chunks (${sharedVals.map(f2).join(', ')}; chunk 0 natural ${f2(per[0].naturalJob)})`);
  for (const pr of pairs) {
    flag(Math.abs(pr.demAB.p50 ?? 0) < 0.05, `DEM continuity ${pr.a}↔${pr.b}: median ${f2(pr.demAB.p50)} m`);
    flag(pr.tileAB.n === 0 || Math.abs(pr.tileAB.p50) < 0.3, `tile continuity ${pr.a}↔${pr.b} where both meshes exist: median ${f2(pr.tileAB.p50)} m (n=${pr.tileAB.n})`);
    flag(Math.abs(pr.seamRaw.p50 ?? 0) < 0.3, `tile seam continuity ${pr.a}↔${pr.b} (raw placement): median ${f2(pr.seamRaw.p50)} m`);
    flag(Math.abs(pr.seamRegistered?.p50 ?? 0) < 0.3, `tile seam continuity ${pr.a}↔${pr.b} (registered placement): median ${f2(pr.seamRegistered?.p50)} m`);
    // The drive surface is what matters: judge on the corridor road cells; the
    // all-covered figure includes off-corridor DEM-fallback cells whose per-chunk
    // re-seat legitimately differs (the .ter takes the owner there, feathered).
    const gRoad = pr.groundABroad.n >= 20 ? pr.groundABroad : pr.groundAB;
    flag(Math.abs(gRoad.p50 ?? 0) < 0.3, `ground continuity ${pr.a}↔${pr.b} (road): median ${f2(gRoad.p50)} m  (all covered cells: ${f2(pr.groundAB.p50)} m)`);
  }
  for (const p of per) {
    flag(Math.abs(p.tileMinusGroundRoad.p50 ?? 0) < 0.3, `chunk ${p.self} ground sits on the tile road: tile MIN − ground (road) median ${f2(p.tileMinusGroundRoad.p50)} m`);
  }

  // ── PNGs ──────────────────────────────────────────────────────────────────
  if (opt.png) {
    mkdirSync(opt.png, { recursive: true });
    const { cols, rows } = frame;
    // Owner-composited tile min and ground for the whole route.
    const tileAll = new Float32Array(cols * rows).fill(NaN), groundAll = new Float32Array(cols * rows).fill(NaN), demAll = new Float32Array(cols * rows).fill(NaN);
    for (let k = 0; k < cols * rows; k++) {
      const o = ownership[k];
      for (const p of per) {
        if (!Number.isNaN(p._mesh.min.a[k]) && (Number.isNaN(tileAll[k]) || p.self === o)) tileAll[k] = p._mesh.min.a[k];
        if (p._ground && !Number.isNaN(p._ground.a[k]) && (Number.isNaN(groundAll[k]) || p.self === o)) groundAll[k] = p._ground.a[k];
        if (!Number.isNaN(p._dem.a[k]) && (Number.isNaN(demAll[k]) || p.self === o)) demAll[k] = p._dem.a[k];
      }
    }
    const finite = (arr) => Float64Array.from(arr.filter((v) => !Number.isNaN(v))).sort();
    const tf = finite(Array.from(groundAll));
    const lo = quant(tf, 0.02), hi = quant(tf, 0.98);
    const out = (name, colorAt) => { const f = path.join(opt.png, name); writeRasterPng(f, frame, colorAt, chunks, ownership, corridorDist); console.log(`   wrote ${f}`); };
    console.log(`\n══ PNGs (top-down, north up, ${frame.cellM} m/px; white = ownership line, black = corridor centreline, coloured boxes = chunk bounds) ══`);
    out('01_tile_min_abs.png', (c, r) => { const v = tileAll[r * cols + c]; return Number.isNaN(v) ? null : grayColor(v, lo, hi); });
    out('02_ground_abs.png', (c, r) => { const v = groundAll[r * cols + c]; return Number.isNaN(v) ? null : grayColor(v, lo, hi); });
    out('03_gap_tile_minus_ground_owner_pm3m.png', (c, r) => { const k = r * cols + c; const t = tileAll[k], g = groundAll[k]; return Number.isNaN(t) || Number.isNaN(g) ? null : divergingColor(t - g, 3); });
    out('04_tile_minus_dem_pm8m.png', (c, r) => { const k = r * cols + c; const t = tileAll[k], d = demAll[k]; return Number.isNaN(t) || Number.isNaN(d) ? null : divergingColor(t - d, 8); });
    out('05_ground_minus_dem_pm8m.png', (c, r) => { const k = r * cols + c; const g = groundAll[k], d = demAll[k]; return Number.isNaN(g) || Number.isNaN(d) ? null : divergingColor(g - d, 8); });
    // Ground disagreement between overlapping chunks (any pair): max |Δ|.
    out('06_ground_overlap_disagreement_pm3m.png', (c, r) => {
      const k = r * cols + c; let best = NaN;
      for (let i = 0; i < per.length; i++) for (let j = i + 1; j < per.length; j++) {
        const a = per[i]._ground?.a[k], b = per[j]._ground?.a[k];
        if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) continue;
        if (Number.isNaN(best) || Math.abs(a - b) > Math.abs(best)) best = a - b;
      }
      return Number.isNaN(best) ? null : divergingColor(best, 3);
    });
    out('07_tile_coverage_by_chunk.png', (c, r) => {
      const k = r * cols + c; let rgb = null, count = 0;
      for (const p of per) if (!Number.isNaN(p._mesh.min.a[k])) { count++; rgb = CHUNK_COLORS[p.self % CHUNK_COLORS.length]; }
      return count === 0 ? null : count > 1 ? [255, 255, 0] : rgb;
    });
  }

  if (opt.json) {
    const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v)));
    writeFileSync(opt.json, JSON.stringify({ frame: { origin: frame.origin, cellM: frame.cellM }, chunks: strip(per), pairs: strip(pairs), registration: reg, placements: rf.placements }, null, 2));
    console.log(`\nwrote ${opt.json}`);
  }
};

main();
