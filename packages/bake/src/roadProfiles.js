// Per-road 1D elevation profiles — the road-centric successor to per-cell
// snapping (see docs/route-generation-plan.md and the terSnap pass).
//
// The extracted tile ground is a 2.5D heightfield: locally right on open road,
// but fallback (DEM) under bridges, in deep cuttings, and wherever coverage has
// holes — which is exactly where per-cell snapping went wrong. Roads, however,
// are smooth ALONG their length by physical necessity, so this module resamples
// each OSM road centreline, reads the extracted ground along it, and turns the
// noisy per-cell heights into a clean 1D profile:
//
//   1. resample the centreline at a fixed arc-length step,
//   2. read the extracted ground + its coveredMask at every sample,
//   3. bridge untrusted spans (tunnels, under-bridge holes, band-gated
//      underpass cells) by interpolating ALONG the road between trusted ends,
//   4. despike + smooth along the arc length — aggressive smoothing is CORRECT
//      here in a way 2D smoothing never is.
//
// Output heights are ABSOLUTE metres on the same datum as the input ground
// (terrain.minHeight), sample positions are scene X/Z — ready to serve as the
// snap/.ter target in a later phase. Pure / canvas-free, mirrors groundMask.js
// so it runs identically in the browser bake, unit tests, and the sidecar
// worker.

import { SCENE_SIZE, computeUnitsPerMeter } from './googleBakeCore.js';
import { sampleHeightAtScene } from './scene/sceneSample.js';
import { createMetricProjector } from '@mapng/geo';
import { EXCLUDE_HIGHWAY, HALF_WIDTH_M } from './groundMask.js';

const HALF = SCENE_SIZE / 2;

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// The minimal road subset a preview needs to build profiles later (geometry +
// tags only, no texture/area payloads) — small enough to pin per chunk.
export const pickProfileRoads = (features) => (Array.isArray(features) ? features : [])
  .filter((f) => f?.type === 'road' && Array.isArray(f.geometry) && f.geometry.length >= 2)
  .map((f) => ({ type: 'road', geometry: f.geometry, tags: f.tags }));

// 1D median (radius 1) — kills single-sample needles without touching grades.
const median3 = (h) => {
  if (h.length < 3) return h.slice();
  const out = h.slice();
  for (let i = 1; i < h.length - 1; i++) {
    const a = h[i - 1], b = h[i], c = h[i + 1];
    out[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  }
  return out;
};

// 1D gaussian along the sample axis, edge-clamped.
const gauss1d = (h, radius) => {
  if (radius <= 0 || h.length < 2) return h.slice();
  const sigma = Math.max(radius / 2, 0.5);
  const k = new Float64Array(radius * 2 + 1);
  let ksum = 0;
  for (let r = -radius; r <= radius; r++) {
    const w = Math.exp(-(r * r) / (2 * sigma * sigma));
    k[r + radius] = w; ksum += w;
  }
  const out = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    let acc = 0;
    for (let r = -radius; r <= radius; r++) {
      const j = Math.min(h.length - 1, Math.max(0, i + r));
      acc += k[r + radius] * h[j];
    }
    out[i] = acc / ksum;
  }
  return out;
};

/**
 * Build 1D elevation profiles along OSM road centrelines from the extracted
 * tile ground.
 *
 * @param {Array} osmFeatures  same features the ground mask consumes
 * @param {object} data        chunk TerrainData (bounds, width, height, minHeight)
 * @param {object} ground      extracted ground { heightMap (abs m, data grid),
 *                             coveredMask (Uint8Array, data grid) }
 * @param {object} [opts]
 * @param {number} [opts.stepM=5]       arc-length sample spacing (metres)
 * @param {number} [opts.smoothM=15]    gaussian window along the road (metres)
 * @param {number} [opts.outlierM=2.5]  a sample deviating more than this from
 *   its sliding-median neighbourhood is junk (wall bottoms, skirts) — it turns
 *   untrusted and is interpolated along the road like any other gap
 * @param {number} [opts.maxGradePct=25]  physical road-grade ceiling; a
 *   forward/backward slope limiter caps whatever junk survives smoothing
 * @returns {null | {
 *   roads: Array<{
 *     highway: string, halfWidthM: number, throughStructure: boolean,
 *     resolved: boolean, lengthM: number, trustedPct: number, maxGradePct: number,
 *     pts: Array<{x:number, z:number, s:number, h:number, trusted:boolean}>,
 *   }>,
 *   stats: { roads:number, resolved:number, totalKm:number, trustedPct:number,
 *            maxUntrustedGapM:number, maxGradePct:number },
 * }}
 */
export const buildRoadProfiles = (osmFeatures, data, ground, {
  stepM = 5, smoothM = 15, outlierM = 2.5, maxGradePct = 25,
} = {}) => {
  if (!Array.isArray(osmFeatures) || osmFeatures.length === 0) return null;
  if (!data?.bounds || !data.width || !data.height) return null;
  if (!ground?.heightMap) return null;

  const upm = computeUnitsPerMeter(data);
  const project = createMetricProjector(data.bounds, data.width, data.height);
  const toScene = (lat, lng) => {
    const p = project(lat, lng);
    return {
      x: (p.x / (data.width - 1)) * SCENE_SIZE - HALF,
      z: (p.y / (data.height - 1)) * SCENE_SIZE - HALF,
    };
  };

  // Height source: prefer the RAW per-cell min over the filtered ground. The
  // bare-earth filters fill narrow dips by design (pit-lift cannot tell a real
  // underpass from junk) while the cells stay covered — sampling the filtered
  // ground there would faithfully reproduce the wrong surface. The raw min
  // still descends into the underpass; its noise is tamed by the 1D smoothing
  // along the road below (which is exactly what per-cell filters can't do).
  const floor = { ...data, heightMap: ground.rawMinHeightMap ?? ground.heightMap };
  const cm = ground.coveredMask ?? null;
  const trustedAt = (x, z) => {
    // Outside the AOI footprint the sampler edge-clamps — never trust that.
    if (x < -HALF || x > HALF || z < -HALF || z > HALF) return false;
    if (!cm) return true;
    // All four bilinear neighbours covered (same rule as the conform's
    // floorTrusted, so profile trust and snap trust can't disagree).
    const u = Math.max(0, Math.min(1, (x + HALF) / SCENE_SIZE));
    const v = Math.max(0, Math.min(1, (z + HALF) / SCENE_SIZE));
    const lx = u * (data.width - 1);
    const lz = v * (data.height - 1);
    const x0 = Math.floor(lx), x1 = Math.min(x0 + 1, data.width - 1);
    const z0 = Math.floor(lz), z1 = Math.min(z0 + 1, data.height - 1);
    const w = data.width;
    return !!(cm[z0 * w + x0] && cm[z0 * w + x1] && cm[z1 * w + x0] && cm[z1 * w + x1]);
  };

  // Pass 0: ELEVATED-structure footprints (bridge / layer>0 ways). Under a deck
  // the true underpass road is band-gated out of the raw min, and the DECK
  // (horizontal, in band) becomes the per-cell minimum — so a road sampled
  // inside a bridge footprint is reading the deck, not itself. Demote those
  // samples to untrusted; the gap-bridging then interpolates the underpass
  // bottom between the trusted ramp ends. (Tunnels stay out: they lie BELOW
  // and never pollute the min of the surface road above.)
  const segDist2 = (px, pz, ax, az, bx, bz) => {
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let tt = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
    tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
    return Math.hypot(px - (ax + tt * dx), pz - (az + tt * dz));
  };
  const structSegs = [];
  for (const f of osmFeatures) {
    if (!f || f.type !== 'road' || !Array.isArray(f.geometry) || f.geometry.length < 2) continue;
    const t = f.tags || {};
    const elevated = (t.bridge && t.bridge !== 'no') || (t.layer != null && Number(t.layer) > 0);
    if (!elevated) continue;
    // Deck footprint: class half-width + 2m margin (deck edges overhang a bit).
    const r = ((HALF_WIDTH_M[t.highway] ?? HALF_WIDTH_M.default) + 2) * upm;
    let prev = toScene(f.geometry[0].lat, f.geometry[0].lng);
    for (let i = 1; i < f.geometry.length; i++) {
      const cur = toScene(f.geometry[i].lat, f.geometry[i].lng);
      structSegs.push({ ax: prev.x, az: prev.z, bx: cur.x, bz: cur.z, r });
      prev = cur;
    }
  }
  const underStructure = (x, z) => {
    for (const s of structSegs) if (segDist2(x, z, s.ax, s.az, s.bx, s.bz) <= s.r) return true;
    return false;
  };

  const stepScene = stepM * upm;
  const roads = [];
  let totalSamples = 0, totalTrusted = 0, maxUntrustedGapM = 0, aggMaxGradePct = 0;

  for (const f of osmFeatures) {
    if (!f || f.type !== 'road' || !Array.isArray(f.geometry) || f.geometry.length < 2) continue;
    const t = f.tags || {};
    if (t.highway && EXCLUDE_HIGHWAY.has(t.highway)) continue;
    // area:highway rings etc. are the mask's polygon business, not a centreline.
    if (t.area === 'yes') continue;

    // Bridges/tunnels/stacked layers stay IN as profiles — their height must be
    // carried by the road (interpolated along it), never read from the 2.5D
    // ground. Every sample on them is untrusted by construction.
    const throughStructure = Boolean(
      (t.bridge && t.bridge !== 'no') || (t.tunnel && t.tunnel !== 'no') ||
      (t.layer != null && Number(t.layer) !== 0),
    );

    // Uniform arc-length resample of the centreline (scene units).
    const verts = f.geometry.map((p) => toScene(p.lat, p.lng));
    const pts = [];
    let s = 0; // metres along the road
    let carry = 0; // scene distance until the next sample
    for (let i = 1; i < verts.length; i++) {
      const a = verts[i - 1], b = verts[i];
      const segLen = Math.hypot(b.x - a.x, b.z - a.z);
      if (segLen <= 1e-9) continue;
      let d = carry;
      if (pts.length === 0) { pts.push({ x: a.x, z: a.z, s: 0 }); }
      while (d <= segLen) {
        const tt = d / segLen;
        const x = a.x + (b.x - a.x) * tt;
        const z = a.z + (b.z - a.z) * tt;
        const sM = s + d / upm;
        if (d > 0 || i > 1) pts.push({ x, z, s: sM });
        d += stepScene;
      }
      carry = d - segLen;
      s += segLen / upm;
    }
    const last = verts[verts.length - 1];
    if (pts.length === 0 || pts[pts.length - 1].s < s - 1e-6) pts.push({ x: last.x, z: last.z, s });
    if (pts.length < 2) continue;

    // Read the extracted ground + trust along the line. CROSS-ROAD MEDIAN of 3
    // taps (centreline ± 40% of the half-width): a single centreline tap on the
    // raw min is fragile — one junk cell (wall bottom, skirt) poisons it.
    const halfWscene = (HALF_WIDTH_M[t.highway] ?? HALF_WIDTH_M.default) * 0.4 * upm;
    const raw = new Float64Array(pts.length);
    const trusted = new Uint8Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
      const dl = Math.hypot(q.x - o.x, q.z - o.z) || 1;
      const nx_ = -(q.z - o.z) / dl, nz_ = (q.x - o.x) / dl; // unit perpendicular
      const a = sampleHeightAtScene(floor, p.x, p.z);
      const b = sampleHeightAtScene(floor, p.x + nx_ * halfWscene, p.z + nz_ * halfWscene);
      const c = sampleHeightAtScene(floor, p.x - nx_ * halfWscene, p.z - nz_ * halfWscene);
      raw[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); // median3
      trusted[i] = (!throughStructure && !underStructure(p.x, p.z) && trustedAt(p.x, p.z)) ? 1 : 0;
    }

    // Outlier rejection: junk that survives the cross-median (abutment walls,
    // multi-cell skirts) still jumps against the road's local trend. Compare
    // each trusted sample to the median of its ±windowR neighbourhood; a
    // deviation beyond outlierM demotes it to untrusted → interpolated along
    // the road like any other gap.
    if (pts.length >= 5) {
      const windowR = 4; // ±4 samples ≈ ±20m at the default step
      const win = [];
      for (let i = 0; i < pts.length; i++) {
        if (!trusted[i]) continue;
        win.length = 0;
        for (let j = Math.max(0, i - windowR); j <= Math.min(pts.length - 1, i + windowR); j++) {
          if (trusted[j]) win.push(raw[j]);
        }
        if (win.length < 3) continue;
        win.sort((x, y) => x - y);
        if (Math.abs(raw[i] - win[win.length >> 1]) > outlierM) trusted[i] = 0;
      }
    }

    const trustedCount = trusted.reduce((acc, v) => acc + v, 0);
    const lengthM = pts[pts.length - 1].s;
    const resolved = trustedCount > 0;

    // Bridge untrusted spans by interpolating ALONG the road between trusted
    // anchors; hold the nearest trusted value at untrusted ends.
    const filled = Float64Array.from(raw);
    if (resolved && trustedCount < pts.length) {
      let prev = -1; // index of last trusted sample
      for (let i = 0; i < pts.length; i++) {
        if (!trusted[i]) continue;
        if (prev === -1) {
          for (let j = 0; j < i; j++) filled[j] = raw[i]; // leading hold
        } else if (i - prev > 1) {
          const gapM = pts[i].s - pts[prev].s;
          if (gapM > maxUntrustedGapM) maxUntrustedGapM = gapM;
          for (let j = prev + 1; j < i; j++) {
            const tt = (pts[j].s - pts[prev].s) / (pts[i].s - pts[prev].s);
            filled[j] = raw[prev] * (1 - tt) + raw[i] * tt;
          }
        }
        prev = i;
      }
      for (let j = prev + 1; j < pts.length; j++) filled[j] = raw[prev]; // trailing hold
    }

    // Despike + smooth along the arc length. Only meaningful when we have some
    // trust; unresolved roads keep the raw (reference-only) heights.
    const radius = Math.max(1, Math.round(smoothM / stepM));
    const smooth = resolved ? gauss1d(median3(Array.from(filled)), radius) : filled;

    // Physical grade ceiling — whatever junk survives median + gaussian cannot
    // exceed what a road can actually do. Symmetric forward/backward slope
    // limiting (averaged, so neither direction biases the result).
    if (resolved && pts.length >= 2) {
      const maxG = maxGradePct / 100;
      const fwd = Float64Array.from(smooth), bwd = Float64Array.from(smooth);
      for (let i = 1; i < pts.length; i++) {
        const lim = maxG * Math.max(0.01, pts[i].s - pts[i - 1].s);
        if (fwd[i] > fwd[i - 1] + lim) fwd[i] = fwd[i - 1] + lim;
        else if (fwd[i] < fwd[i - 1] - lim) fwd[i] = fwd[i - 1] - lim;
      }
      for (let i = pts.length - 2; i >= 0; i--) {
        const lim = maxG * Math.max(0.01, pts[i + 1].s - pts[i].s);
        if (bwd[i] > bwd[i + 1] + lim) bwd[i] = bwd[i + 1] + lim;
        else if (bwd[i] < bwd[i + 1] - lim) bwd[i] = bwd[i + 1] - lim;
      }
      for (let i = 0; i < pts.length; i++) smooth[i] = (fwd[i] + bwd[i]) / 2;
    }

    let roadMaxGrade = 0;
    for (let i = 1; i < pts.length; i++) {
      const ds = pts[i].s - pts[i - 1].s;
      if (ds > 1e-6) {
        const g = Math.abs(smooth[i] - smooth[i - 1]) / ds * 100;
        if (g > roadMaxGrade) roadMaxGrade = g;
      }
    }
    if (resolved && roadMaxGrade > aggMaxGradePct) aggMaxGradePct = roadMaxGrade;

    for (let i = 0; i < pts.length; i++) {
      pts[i].h = smooth[i];
      pts[i].trusted = !!trusted[i];
    }

    totalSamples += pts.length;
    totalTrusted += trustedCount;
    roads.push({
      highway: t.highway || 'unknown',
      halfWidthM: HALF_WIDTH_M[t.highway] ?? HALF_WIDTH_M.default,
      throughStructure,
      resolved,
      lengthM: Math.round(lengthM * 10) / 10,
      trustedPct: Math.round((trustedCount / pts.length) * 100),
      maxGradePct: Math.round(roadMaxGrade * 10) / 10,
      pts,
    });
  }
  if (roads.length === 0) return null;

  const resolvedCount = roads.filter((r) => r.resolved).length;
  return {
    roads,
    stats: {
      roads: roads.length,
      resolved: resolvedCount,
      totalKm: Math.round(roads.reduce((acc, r) => acc + r.lengthM, 0) / 100) / 10,
      trustedPct: totalSamples ? Math.round((totalTrusted / totalSamples) * 100) : 0,
      maxUntrustedGapM: Math.round(maxUntrustedGapM),
      maxGradePct: Math.round(aggMaxGradePct * 10) / 10,
    },
  };
};

/**
 * Carve the road profiles into the extracted ground (Phase 2). Per-cell logic
 * cannot distinguish a real underpass from sub-street junk — the pit-lift
 * defense fills both — but the PROFILE knows the road descends there. Every
 * resolved, non-structure road stamps its corridor (halfWidthM + feather) onto
 * the ground grid, blending the cell toward the profile height; the .ter then
 * follows the road down into underpasses (and up onto embankments) while the
 * pit defenses keep working off-road. throughStructure roads (bridges/tunnels)
 * never carve, so at a crossing the LOWER road always wins the .ter — the deck
 * above stays visual (collision meshes for decks are a separate feature).
 *
 * Mutates ground.heightMap in place and marks fully-carved cells covered, so
 * the terSnap pass trusts the carved floor and pulls the underpass road mesh
 * onto it (closing the visual gap too).
 *
 * @param {ReturnType<typeof buildRoadProfiles>} profiles
 * @param {object} data    chunk TerrainData (grid frame)
 * @param {object} ground  { heightMap (abs m), coveredMask } — data grid, mutated
 * @param {object} [opts]
 * @param {number} [opts.featherM=3]    blend band beyond the carriageway (m).
 *   MUST match groundMask's featherM: the terSnap releases the tile mesh over
 *   the mask feather, so if the floor keeps transitioning further out, the two
 *   disagree in the overhang band and the street edges read as bent lips.
 * @param {number} [opts.maxCarveM=10]  per-cell shift clamp (safety)
 * @returns {{ carvedCells:number, maxShiftM:number, minH:number, maxH:number }}
 */
export const carveRoadProfiles = (profiles, data, ground, { featherM = 3, maxCarveM = 10 } = {}) => {
  const empty = { carvedCells: 0, maxShiftM: 0, minH: Infinity, maxH: -Infinity };
  if (!profiles?.roads?.length || !ground?.heightMap) return empty;
  const upm = computeUnitsPerMeter(data);
  const W = data.width, H = data.height;
  const hm = ground.heightMap, cm = ground.coveredMask ?? null;

  // Per-cell best (weight, target height) across all roads — max weight wins, so
  // junction cells take whichever road claims them hardest (heights agree there).
  const wBest = new Float32Array(W * H);
  const hBest = new Float32Array(W * H);
  const featherScene = featherM * upm;
  const toCol = (x) => ((x + HALF) / SCENE_SIZE) * (W - 1);
  const toRow = (z) => ((z + HALF) / SCENE_SIZE) * (H - 1);

  for (const r of profiles.roads) {
    if (!r.resolved || r.throughStructure) continue;
    const halfW = r.halfWidthM * upm;
    const reach = halfW + featherScene;
    const pts = r.pts;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const c0 = Math.max(0, Math.floor(toCol(Math.min(a.x, b.x) - reach)));
      const c1 = Math.min(W - 1, Math.ceil(toCol(Math.max(a.x, b.x) + reach)));
      const r0 = Math.max(0, Math.floor(toRow(Math.min(a.z, b.z) - reach)));
      const r1 = Math.min(H - 1, Math.ceil(toRow(Math.max(a.z, b.z) + reach)));
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      for (let row = r0; row <= r1; row++) {
        const pz = (row / (H - 1)) * SCENE_SIZE - HALF;
        for (let col = c0; col <= c1; col++) {
          const px = (col / (W - 1)) * SCENE_SIZE - HALF;
          let t = len2 > 0 ? ((px - a.x) * dx + (pz - a.z) * dz) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const d = Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
          if (d >= reach) continue;
          const w = d <= halfW ? 1 : smoothstep((reach - d) / featherScene);
          const idx = row * W + col;
          if (w > wBest[idx]) {
            wBest[idx] = w;
            hBest[idx] = a.h + (b.h - a.h) * t; // profile samples ~stepM apart
          }
        }
      }
    }
  }

  let carvedCells = 0, maxShiftM = 0, minH = Infinity, maxH = -Infinity;
  for (let idx = 0; idx < wBest.length; idx++) {
    const w = wBest[idx];
    if (w <= 0) continue;
    let delta = (hBest[idx] - hm[idx]) * w;
    if (delta > maxCarveM) delta = maxCarveM;
    else if (delta < -maxCarveM) delta = -maxCarveM;
    if (delta !== 0) {
      hm[idx] += delta;
      const a = Math.abs(delta);
      if (a > maxShiftM) maxShiftM = a;
    }
    if (hm[idx] < minH) minH = hm[idx];
    if (hm[idx] > maxH) maxH = hm[idx];
    carvedCells++;
    // Fully inside the carriageway ⇒ the profile IS the floor here — trusted,
    // so the terSnap pass may pull the road mesh onto it (underpass included).
    if (cm && w >= 0.9) cm[idx] = 1;
  }
  return { carvedCells, maxShiftM: +maxShiftM.toFixed(2), minH, maxH };
};
