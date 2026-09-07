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
import { EXCLUDE_HIGHWAY, roadHalfWidthM } from './groundMask.js';
import { fitAsymmetricProfile } from './ground/asymmetricWhittaker.js';

const HALF = SCENE_SIZE / 2;

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// The minimal road subset a preview needs to build profiles later (geometry +
// tags only, no texture/area payloads) — small enough to pin per chunk.
// Road-class precedence for the junction solve: lower = more important. At a
// junction the more important road is the reference and the others meet its
// grade (see the consensus step in buildRoadProfiles).
const HIGHWAY_RANK = {
  motorway: 0, motorway_link: 1, trunk: 1, trunk_link: 2, primary: 2, primary_link: 3,
  secondary: 3, secondary_link: 4, tertiary: 4, tertiary_link: 5,
  unclassified: 6, residential: 6, living_street: 7, service: 8, track: 9,
};
export const highwayRank = (highway) => HIGHWAY_RANK[highway] ?? 7;

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
 * @param {number} [opts.vetoGradePct=35]  a resolved surface profile steeper than
 *   this anywhere is not a road (garage ramp, driveway under a building,
 *   untagged stacked geometry): it keeps its profile for display/stats but
 *   neither carves the .ter nor joins junction clusters (`carveVeto`).
 * @param {number} [opts.vetoTrustPct=25]  same veto for a `service` way whose
 *   trusted-sample share is below this (mostly interpolated guesswork).
 * @param {number} [opts.maxGradePct=25]  physical road-grade ceiling; a
 *   forward/backward slope limiter caps whatever junk survives smoothing
 * @param {number} [opts.junctionBlendM=25]  junction joint solve: arc length
 *   over which each road's profile is blended into the junction consensus
 *   height. Two roads meeting at a crossing sampled the ground independently
 *   (different cross-taps, different bridged spans), so their carve targets can
 *   disagree by metres AT THE SAME SPOT — the carve's weight blend ramps
 *   between the two surfaces but cannot remove the step. The solve clusters
 *   co-located samples of different roads, agrees one trust-weighted height
 *   per junction, and eases each profile into it. 0 disables (A/B).
 * @returns {null | {
 *   roads: Array<{
 *     highway: string, halfWidthM: number, throughStructure: boolean,
 *     resolved: boolean, lengthM: number, trustedPct: number, maxGradePct: number,
 *     pts: Array<{x:number, z:number, s:number, h:number, trusted:boolean}>,
 *   }>,
 *   stats: { roads:number, resolved:number, totalKm:number, trustedPct:number,
 *            maxUntrustedGapM:number, maxGradePct:number,
 *            maxGradeAt:null|{highway:string,x:number,z:number},
 *            worstTrust:null|{pct:number,highway:string,x:number,z:number},
 *            roughnessRmsM:number, worstBump:null|{m,highway,x,z},
 *            junctionClusters:number, junctionMaxAdjM:number,
 *            junctionPairs:number, junctionStepP95M:number,
 *            junctionStepMaxM:number, junctionStepMaxAt:null|{highway,x,z} },
 * }}
 */
export const buildRoadProfiles = (osmFeatures, data, ground, {
  stepM = 5, smoothM = 15, outlierM = 2.5, maxGradePct = 25, junctionBlendM = 25,
  vetoGradePct = 35, vetoTrustPct = 25,
  // Profile solver. 'whittaker' (default): asymmetric Whittaker baseline —
  // the road is the smooth curve UNDER the tile surface; observations above
  // it (cars, canopies, decks) weigh `aboveWeight`, observations below it are
  // Huber-bounded, and the curvature penalty is set by `cutoffM`, the shortest
  // real vertical road feature to keep. Untrusted samples carry no data; where
  // a road has no observation at all the curve relaxes toward the extracted
  // ground at `priorWeight` instead of holding the last value flat. Every
  // sample gets a height, so the carve can stamp the whole corridor
  // unconditionally (corridor authority — see carveRoadProfiles).
  // 'legacy': median3 + gaussian + grade limiter on gap-interpolated samples.
  // priorWeight sets the ease length of an unobserved road END into the
  // extracted ground: ≈ cutoffM / (2π) · priorWeight^(−¼) → 0.05 ≙ ~13 m.
  solver = 'whittaker', cutoffM = 40, coreM = 0.4, objectM = 1.0, aboveWeight = 0.02, priorWeight = 0.05,
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
  // Prior for unobserved spans (whittaker solver): the FILTERED extracted
  // ground — tile-derived where covered, DEM fallback elsewhere — i.e. what
  // the .ter would hold anyway if the road did not carve there.
  const priorFloor = { ...data, heightMap: ground.heightMap };
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
    const r = (roadHalfWidthM(t) + 2) * upm;
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
  let aggMaxGradeAt = null, worstTrust = null;
  let aggBumpSq = 0, aggBumpN = 0, worstBump = null;

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
    const halfWscene = roadHalfWidthM(t) * 0.4 * upm;
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

    // Solve the profile. Unresolved roads keep the raw (reference-only) heights.
    let smooth;
    if (!resolved) {
      smooth = filled;
    } else if (solver === 'whittaker') {
      // Asymmetric Whittaker baseline on the trusted cross-median readings;
      // untrusted samples are gaps, filled by the curvature prior and a weak
      // pull toward the extracted (filtered) ground, never a flat hold.
      const weight = Float64Array.from(trusted, (v) => (v ? 1 : 0));
      // Prior only on the UNBRACKETED spans: an interior gap (underpass, hole
      // under a deck) is bracketed by observations and the curvature prior
      // interpolates it — the filtered ground there is exactly the wrong
      // surface. Leading/trailing spans have observations on one side only,
      // so instead of extrapolating the trend for hundreds of metres they
      // ease into the extracted ground over ~(λ/w)^¼ samples.
      let firstT = -1, lastT = -1;
      for (let i = 0; i < pts.length; i++) if (trusted[i]) { if (firstT < 0) firstT = i; lastT = i; }
      const prior = new Float64Array(pts.length);
      const priorWeights = new Float64Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        prior[i] = sampleHeightAtScene(priorFloor, pts[i].x, pts[i].z);
        if (i < firstT || i > lastT) priorWeights[i] = priorWeight;
      }
      // The resampler may append the true endpoint a sub-step (even sub-mm)
      // after the last regular sample; the uniform-spacing solver must not
      // treat it as a full step. Solve without it, then extend the last
      // segment's slope over the true remaining arc length.
      const n = pts.length;
      const tailDs = pts[n - 1].s - pts[n - 2].s;
      const shortTail = n >= 3 && tailDs < 0.5 * stepM;
      const m = shortTail ? n - 1 : n;
      const fit = fitAsymmetricProfile(raw.subarray(0, m), weight.subarray(0, m), {
        stepM, cutoffM, coreM, objectM, aboveWeight, prior: prior.subarray(0, m), priorWeight: priorWeights.subarray(0, m),
      }).h;
      smooth = new Float64Array(n);
      smooth.set(fit);
      if (shortTail) {
        const slope = (fit[m - 1] - fit[m - 2]) / Math.max(1e-6, pts[m - 1].s - pts[m - 2].s);
        smooth[n - 1] = fit[m - 1] + slope * tailDs;
      }
    } else {
      const radius = Math.max(1, Math.round(smoothM / stepM));
      smooth = gauss1d(median3(Array.from(filled)), radius);
    }

    // Physical grade ceiling (legacy solver only) — whatever junk survives
    // median + gaussian cannot exceed what a road can actually do. Symmetric
    // forward/backward slope limiting (averaged, so neither direction biases
    // the result). The Whittaker solver gets its smoothness from the curvature
    // penalty; a hard clamp on top would reintroduce the flat-then-kink shape.
    if (resolved && solver !== 'whittaker' && pts.length >= 2) {
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

    // Grade stat uses the same 1cm spacing floor as the limiter above: the
    // resampler can append the final endpoint sub-mm from the previous sample,
    // and dividing a limiter-approved (~mm) step by that true ds reports an
    // absurd grade for what is physically a millimetre bump.
    let roadMaxGrade = 0, roadMaxGradeAt = -1;
    for (let i = 1; i < pts.length; i++) {
      const ds = pts[i].s - pts[i - 1].s;
      if (ds > 1e-6) {
        const g = Math.abs(smooth[i] - smooth[i - 1]) / Math.max(0.01, ds) * 100;
        if (g > roadMaxGrade) { roadMaxGrade = g; roadMaxGradeAt = i; }
      }
    }
    if (resolved && roadMaxGrade > aggMaxGradePct) {
      aggMaxGradePct = roadMaxGrade;
      aggMaxGradeAt = roadMaxGradeAt >= 0
        ? { highway: t.highway || 'unknown', x: pts[roadMaxGradeAt].x, z: pts[roadMaxGradeAt].z }
        : null;
    }
    if (resolved && !throughStructure) {
      const pct = Math.round((trustedCount / pts.length) * 100);
      if (!worstTrust || pct < worstTrust.pct) {
        const mid = pts[pts.length >> 1];
        worstTrust = { pct, highway: t.highway || 'unknown', x: mid.x, z: mid.z };
      }
    }

    // Longitudinal evenness: each interior sample's residual against the
    // straight line through its two neighbours — the bump amplitude a wheel
    // actually feels, in metres. Grade says STEEP; this says WAVY (the grade
    // limiter's flat-then-kink output scores here while passing the grade cap).
    let bumpSq = 0, bumpN = 0, roadBumpMax = 0, roadBumpMaxAt = -1;
    if (resolved) {
      for (let i = 1; i < pts.length - 1; i++) {
        const ds0 = pts[i].s - pts[i - 1].s, ds1 = pts[i + 1].s - pts[i].s;
        if (ds0 <= 1e-6 || ds1 <= 1e-6) continue;
        const tt = ds0 / (ds0 + ds1);
        const bump = Math.abs(smooth[i] - (smooth[i - 1] * (1 - tt) + smooth[i + 1] * tt));
        bumpSq += bump * bump; bumpN++;
        if (bump > roadBumpMax) { roadBumpMax = bump; roadBumpMaxAt = i; }
      }
      aggBumpSq += bumpSq; aggBumpN += bumpN;
      if (roadBumpMaxAt >= 0 && (!worstBump || roadBumpMax > worstBump.m)) {
        worstBump = {
          m: Math.round(roadBumpMax * 1000) / 1000,
          highway: t.highway || 'unknown',
          x: pts[roadBumpMaxAt].x, z: pts[roadBumpMaxAt].z,
        };
      }
    }

    for (let i = 0; i < pts.length; i++) {
      pts[i].h = smooth[i];
      pts[i].trusted = !!trusted[i];
    }

    totalSamples += pts.length;
    totalTrusted += trustedCount;
    // Carve veto — profile hygiene. A resolved surface profile whose solved
    // grade exceeds what any road can do is not a road profile: it is a garage
    // ramp, a driveway diving under a building, stacked geometry without layer
    // tags. Stamping it carves a gouge into the .ter and drags the junction
    // solve with it (measured live: service roads at 84–169 % grade, junction
    // steps of 2.8–3.6 m where they meet the route road). Low-trust SERVICE
    // ways (most of the profile interpolated) are vetoed too; arterial classes
    // keep carving on low trust because the route itself may be poorly
    // covered under trees. Vetoed roads stay in the result for the wireframe
    // and the stats, but neither carve nor join junction clusters.
    const trustedPctRoad = Math.round((trustedCount / pts.length) * 100);
    let carveVeto = null;
    if (resolved && !throughStructure) {
      if (roadMaxGrade > vetoGradePct) carveVeto = `grade ${roadMaxGrade.toFixed(0)}% > ${vetoGradePct}%`;
      else if (t.highway === 'service' && trustedPctRoad < vetoTrustPct) carveVeto = `service trust ${trustedPctRoad}% < ${vetoTrustPct}%`;
    }
    roads.push({
      highway: t.highway || 'unknown',
      halfWidthM: roadHalfWidthM(t),
      throughStructure,
      resolved,
      carveVeto,
      lengthM: Math.round(lengthM * 10) / 10,
      trustedPct: Math.round((trustedCount / pts.length) * 100),
      maxGradePct: Math.round(roadMaxGrade * 10) / 10,
      roughnessRmsM: bumpN ? Math.round(Math.sqrt(bumpSq / bumpN) * 1000) / 1000 : 0,
      pts,
    });
  }
  if (roads.length === 0) return null;

  // ── Junction joint solve ──────────────────────────────────────────────────
  // Each road profiled the ground on its own (own cross-taps, own outlier
  // rejection, own bridged spans), so where two roads pass through the same
  // spot their heights can disagree — and the carve's weighted blend then ramps
  // between two surfaces instead of meeting at one. Cluster co-located samples
  // of DIFFERENT surface roads (union-find over the same 6m gate the step
  // metric uses), agree a trust-weighted consensus height per cluster, and
  // ease every member road into it over junctionBlendM of arc. Runs BEFORE
  // deck stitching (abutments anchor onto agreed heights) and BEFORE the step
  // metric (which then reports the residual disagreement, not the solved one).
  // Bridges/tunnels never join a cluster: crossing at a different level is
  // their whole point.
  let junctionClusters = 0, junctionMaxAdjM = 0;
  if (junctionBlendM > 0 && roads.length > 1) {
    const gate = 6 * upm, cellS = 5 * upm;
    const samples = [];
    for (let ri = 0; ri < roads.length; ri++) {
      const r = roads[ri];
      if (!r.resolved || r.throughStructure || r.carveVeto) continue;
      let firstT = -1, lastT = -1;
      for (let i = 0; i < r.pts.length; i++) {
        if (r.pts[i].trusted) { if (firstT < 0) firstT = i; lastT = i; }
      }
      if (firstT < 0) continue;
      // Only the full-strength span joins: held ends never stamp the carve, so
      // they neither vote on a consensus nor get corrected toward one.
      for (let i = firstT; i <= lastT; i++) {
        const p = r.pts[i];
        samples.push({ ri, i, x: p.x, z: p.z, h: p.h, w: p.trusted ? 1 : 0.3, rank: highwayRank(r.highway) });
      }
    }
    if (samples.length > 1) {
      const parent = new Int32Array(samples.length);
      for (let k = 0; k < samples.length; k++) parent[k] = k;
      const find = (a) => {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      };
      const cells = new Map();
      for (let k = 0; k < samples.length; k++) {
        const s2 = samples[k];
        const key = Math.round(s2.x / cellS) * 100003 + Math.round(s2.z / cellS);
        let b = cells.get(key);
        if (!b) cells.set(key, b = []);
        b.push(k);
      }
      const link = (ka, kb) => {
        const a = samples[ka], b2 = samples[kb];
        if (a.ri === b2.ri) return;
        if (Math.hypot(a.x - b2.x, a.z - b2.z) > gate) return;
        const ra = find(ka), rb = find(kb);
        if (ra !== rb) parent[ra] = rb;
      };
      const NEIGH2 = [[1, 0], [0, 1], [1, 1], [1, -1]];
      for (const [key, b] of cells) {
        for (let i = 0; i < b.length; i++) {
          for (let j = i + 1; j < b.length; j++) link(b[i], b[j]);
        }
        for (const [dx, dz] of NEIGH2) {
          const nb = cells.get(key + dx * 100003 + dz);
          if (!nb) continue;
          for (const ka of b) for (const kb of nb) link(ka, kb);
        }
      }
      const clusters = new Map();
      for (let k = 0; k < samples.length; k++) {
        const root = find(k);
        let c = clusters.get(root);
        if (!c) clusters.set(root, c = []);
        c.push(k);
      }
      // Per-road constraint list: (sample index, delta toward the consensus).
      const constraints = new Map();
      for (const c of clusters.values()) {
        if (c.length < 2) continue;
        const riSet = new Set(c.map((k) => samples[k].ri));
        if (riSet.size < 2) continue; // one road folding back on itself is not a junction
        // Parallel-run guard: a genuine junction is POINT-like along every
        // member road. Two roads running side by side within the gate (dual
        // carriageway, slip lane, mapped service strip) chain into ONE cluster
        // through the union-find — and a single consensus height would flatten
        // both over their whole shared run, erasing real grade. If any road's
        // member samples span more than a junction plausibly can, skip: the
        // carve's weight blend keeps handling parallel corridors.
        const JUNCTION_SPAN_M = 15;
        let parallelRun = false;
        const spanByRoad = new Map();
        for (const k of c) {
          const s2 = samples[k];
          const sArc = roads[s2.ri].pts[s2.i].s;
          const sp = spanByRoad.get(s2.ri);
          if (!sp) spanByRoad.set(s2.ri, [sArc, sArc]);
          else {
            if (sArc < sp[0]) sp[0] = sArc;
            if (sArc > sp[1]) sp[1] = sArc;
          }
        }
        for (const [lo, hi] of spanByRoad.values()) {
          if (hi - lo > JUNCTION_SPAN_M) { parallelRun = true; break; }
        }
        if (parallelRun) continue;
        // Consensus = the HIGHEST-CLASS road present (trust-weighted mean over
        // its samples); lower classes ease into it. Roads are built that way —
        // a side street meets the main road's grade, never the reverse — and
        // the alternative (a trust-weighted mean over all members) let a
        // service way that read a raised crossing or parked cars lift the
        // driven road: measured as a 0.45 m hump over 40 m of a flat
        // residential road, exactly the 0.43 m junction adjustment logged.
        let topRank = Infinity;
        for (const k of c) if (samples[k].rank < topRank) topRank = samples[k].rank;
        let hw = 0, ww = 0;
        for (const k of c) { if (samples[k].rank !== topRank) continue; hw += samples[k].w * samples[k].h; ww += samples[k].w; }
        const H = hw / ww;
        // Physicality cap: easing a correction into a profile over
        // junctionBlendM at the maxGradePct ceiling can absorb at most
        // ~junctionBlendM×grade metres. A disagreement beyond that is not a
        // junction — it's stacked geometry without layer tags (parking decks,
        // mistagged ramps; seen live: 16m "consensus" adjustments) — and
        // forcing consensus would bend both roads at the grade ceiling. Skip;
        // the step metric still reports it for the log.
        const capM = junctionBlendM * (maxGradePct / 100);
        let maxDev = 0;
        for (const k of c) {
          const d = Math.abs(samples[k].h - H);
          if (d > maxDev) maxDev = d;
        }
        if (maxDev > capM) continue;
        junctionClusters++;
        for (const k of c) {
          const s2 = samples[k];
          let list = constraints.get(s2.ri);
          if (!list) constraints.set(s2.ri, list = []);
          list.push({ i: s2.i, delta: H - s2.h });
        }
      }
      // Ease each profile into its constraints: falloff-weighted average of the
      // deltas, normalised so overlapping junctions cannot overshoot, exact at
      // the junction sample itself. The falloff is smooth, so the correction
      // cannot introduce a kink the smoother just removed.
      for (const [ri, list] of constraints) {
        const pts = roads[ri].pts;
        const corr = new Float64Array(pts.length);
        const wsum = new Float64Array(pts.length);
        for (const { i: i0, delta } of list) {
          const s0 = pts[i0].s;
          for (let i = 0; i < pts.length; i++) {
            const dsAbs = Math.abs(pts[i].s - s0);
            if (dsAbs >= junctionBlendM) continue;
            const w = smoothstep(1 - dsAbs / junctionBlendM);
            corr[i] += w * delta;
            wsum[i] += w;
          }
        }
        for (let i = 0; i < pts.length; i++) {
          if (wsum[i] <= 0) continue;
          const adj = corr[i] / Math.max(1, wsum[i]);
          pts[i].h += adj;
          const a = Math.abs(adj);
          if (a > junctionMaxAdjM) junctionMaxAdjM = a;
        }
      }
    }
  }

  // Stitch structure profiles: a bridge way has no trusted samples of its own
  // (its raw min reads a mix of deck and the road below), but its ENDPOINTS
  // join resolved surface roads at the abutments. Anchor each end to the
  // nearest resolved sample within joinM and span linearly — decks are
  // straight. One anchored end → flat hold; none → stays unresolved.
  const joinScene = 15 * upm;
  const anchorAt = (x, z) => {
    let best = null, bestD = joinScene;
    for (const r of roads) {
      if (!r.resolved || r.throughStructure || r.carveVeto) continue;
      for (const p of r.pts) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bestD) { bestD = d; best = p.h; }
      }
    }
    return best;
  };
  for (const r of roads) {
    if (!r.throughStructure || r.resolved) continue;
    const first = r.pts[0], last = r.pts[r.pts.length - 1];
    const hA = anchorAt(first.x, first.z);
    const hB = anchorAt(last.x, last.z);
    if (hA == null && hB == null) continue;
    const a = hA ?? hB, b = hB ?? hA;
    const len = last.s || 1;
    for (const p of r.pts) p.h = a + (b - a) * (p.s / len);
    r.resolved = true;
    r.stitched = true;
  }

  // Junction evenness: wherever two carving roads pass through the same spot,
  // BOTH profiles stamp the cell — the carve blends their weights, but any
  // HEIGHT gap between the two targets survives as a step/ramp in the .ter
  // (weights taper smoothly; disagreeing heights don't). Spatial-hash the
  // full-strength samples and measure the worst cross-road disagreement. This
  // is the number the junction joint-solve has to drive to zero.
  const stepGate = 6 * upm;   // only compare samples this close (scene units)
  const cellJ = 5 * upm;      // hash cell ≈ one profile step
  const buckets = new Map();
  for (let ri = 0; ri < roads.length; ri++) {
    const r = roads[ri];
    if (!r.resolved || r.throughStructure || r.carveVeto) continue;
    let firstT = -1, lastT = -1;
    for (let i = 0; i < r.pts.length; i++) {
      if (r.pts[i].trusted) { if (firstT < 0) firstT = i; lastT = i; }
    }
    if (firstT < 0) { firstT = 0; lastT = r.pts.length - 1; }
    // Held end spans taper to zero carve weight — they never stamp, so they
    // don't belong in the junction audit. Interior bridged spans carve at full
    // strength and stay in.
    for (let i = firstT; i <= lastT; i++) {
      const p = r.pts[i];
      const kx = Math.round(p.x / cellJ), kz = Math.round(p.z / cellJ);
      const key = kx * 100003 + kz;
      let b = buckets.get(key);
      if (!b) buckets.set(key, b = []);
      b.push({ ri, h: p.h, x: p.x, z: p.z, hw: r.highway });
    }
  }
  const steps = [];
  let junctionMax = null;
  const compare = (a, b2) => {
    if (a.ri === b2.ri) return;
    const d = Math.hypot(a.x - b2.x, a.z - b2.z);
    if (d > stepGate) return;
    const step = Math.abs(a.h - b2.h);
    steps.push(step);
    if (!junctionMax || step > junctionMax.m) {
      junctionMax = {
        m: step, highways: `${a.hw}×${b2.hw}`,
        x: (a.x + b2.x) / 2, z: (a.z + b2.z) / 2,
      };
    }
  };
  // Half-neighbourhood sweep so every nearby pair is compared exactly once.
  const NEIGH = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [key, b] of buckets) {
    for (let i = 0; i < b.length; i++) {
      for (let j = i + 1; j < b.length; j++) compare(b[i], b[j]);
    }
    for (const [dx, dz] of NEIGH) {
      const nb = buckets.get(key + dx * 100003 + dz);
      if (!nb) continue;
      for (const a of b) for (const c of nb) compare(a, c);
    }
  }
  steps.sort((a, b2) => a - b2);
  const junctionStepP95M = steps.length
    ? Math.round(steps[Math.floor(0.95 * (steps.length - 1))] * 100) / 100 : 0;

  const resolvedCount = roads.filter((r) => r.resolved).length;
  return {
    roads,
    solver,
    stats: {
      roads: roads.length,
      resolved: resolvedCount,
      stitched: roads.filter((r) => r.stitched).length,
      // Profile hygiene: resolved surface roads that neither carve nor join
      // junctions (non-physical grade / low-trust service way), with where.
      vetoed: roads.filter((r) => r.carveVeto).length,
      vetoedRoads: roads.filter((r) => r.carveVeto).slice(0, 8).map((r) => {
        const mid = r.pts[r.pts.length >> 1];
        return { highway: r.highway, reason: r.carveVeto, x: Math.round(mid.x * 10) / 10, z: Math.round(mid.z * 10) / 10 };
      }),
      totalKm: Math.round(roads.reduce((acc, r) => acc + r.lengthM, 0) / 100) / 10,
      trustedPct: totalSamples ? Math.round((totalTrusted / totalSamples) * 100) : 0,
      maxUntrustedGapM: Math.round(maxUntrustedGapM),
      maxGradePct: Math.round(aggMaxGradePct * 10) / 10,
      // Diagnostics: where the worst numbers live (scene coords, matches the
      // profile-wireframe debug view) so a bad profile is pinnable from the log.
      maxGradeAt: aggMaxGradeAt,
      worstTrust,
      // Evenness telemetry (see task: road/.ter good→great). roughnessRmsM is
      // the aggregate bump amplitude of the SMOOTHED profiles; junction steps
      // measure cross-road target disagreement the carve blend can only ramp.
      roughnessRmsM: aggBumpN ? Math.round(Math.sqrt(aggBumpSq / aggBumpN) * 1000) / 1000 : 0,
      worstBump,
      junctionClusters,
      junctionMaxAdjM: Math.round(junctionMaxAdjM * 100) / 100,
      junctionPairs: steps.length,
      junctionStepP95M,
      junctionStepMaxM: junctionMax ? Math.round(junctionMax.m * 100) / 100 : 0,
      junctionStepMaxAt: junctionMax
        ? { highway: junctionMax.highways, x: junctionMax.x, z: junctionMax.z }
        : null,
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
 * @param {number} [opts.maxCarveM]  per-cell shift clamp. Default: 10 m for
 *   legacy profiles, NONE for whittaker profiles (corridor authority — a clamp
 *   leaves the extracted ground standing exactly where the profile disagrees
 *   with it most, which is the hole in the road). Shifts beyond 10 m are
 *   counted in `largeShiftCells` for diagnostics instead.
 * @param {number} [opts.endTaperM=10]  arc length over which a road's carve
 *   strength fades to zero across leading/trailing untrusted HELD spans (flat
 *   extrapolation, legacy solver only). Whittaker profiles have no held ends
 *   (unobserved spans relax to the extracted ground), so they stamp at full
 *   strength end to end. Interior bridged spans (underpasses) are never tapered.
 * @param {(r:object)=>boolean} [opts.roadFilter]  which roads stamp. Default:
 *   resolved non-structure roads (the .ter carve). The deck snap passes
 *   `r.throughStructure && r.resolved` to stamp stitched bridge profiles into
 *   a TRANSIENT deck floor instead.
 * @returns {{ carvedCells:number, maxShiftM:number, minH:number, maxH:number,
 *            profileResidualRmsM:number, profileResidualMaxM:number,
 *            residualSamples:number }}
 */
export const carveRoadProfiles = (profiles, data, ground, {
  featherM = 3, maxCarveM = null, endTaperM = 10, roadFilter = null,
} = {}) => {
  const empty = { carvedCells: 0, maxShiftM: 0, minH: Infinity, maxH: -Infinity, largeShiftCells: 0 };
  if (!profiles?.roads?.length || !ground?.heightMap) return empty;
  // Corridor authority: a whittaker profile has a height for every sample, so
  // the corridor is stamped unconditionally — no held-end taper, no clamp.
  const authority = profiles.solver === 'whittaker';
  const clampM = maxCarveM ?? (authority ? Infinity : 10);
  const LARGE_SHIFT_M = 10;
  const upm = computeUnitsPerMeter(data);
  const W = data.width, H = data.height;
  const hm = ground.heightMap, cm = ground.coveredMask ?? null;

  // Per-cell accumulation: weighted BLEND across claims instead of max-wins.
  // Within one road consecutive segments overlap and agree, so accumulating is
  // safe; ACROSS roads the targets can genuinely disagree at a junction (a
  // gap-bridged profile vs a trusted crossing road), and max-wins turned that
  // into stepped patchwork — whichever road claimed a cell hardest set it
  // alone. Blending ramps one profile into the other across the feather.
  const wSum = new Float32Array(W * H);
  const whSum = new Float32Array(W * H);
  const wMax = new Float32Array(W * H);
  // Peak weight from OBSERVED arc (between a road's first and last trusted
  // sample). Authority profiles also stamp their leading/trailing unobserved
  // spans (eased into the extracted ground), but those cells must not be
  // reported as tile-covered: at a chunk's corridor tail that span eases
  // toward the DEM, and a "covered" vote there would out-blend the neighbour
  // chunk's genuinely observed road in the route composite.
  const wObs = new Float32Array(W * H);
  const featherScene = featherM * upm;
  const toCol = (x) => ((x + HALF) / SCENE_SIZE) * (W - 1);
  const toRow = (z) => ((z + HALF) / SCENE_SIZE) * (H - 1);

  const keep = roadFilter ?? ((r) => r.resolved && !r.throughStructure && !r.carveVeto);
  const keptRoads = []; // for the post-carve fidelity resample below
  for (const r of profiles.roads) {
    if (!keep(r)) continue;
    const halfW = r.halfWidthM * upm;
    const reach = halfW + featherScene;
    const pts = r.pts;

    // Carve confidence along the arc: leading/trailing untrusted spans carry a
    // flat HOLD of the nearest trusted height (see buildRoadProfiles) — pure
    // extrapolation, wrong by metres where the road leaves coverage — so their
    // stamp weight tapers to zero over endTaperM. Interior bridged spans keep
    // full strength (underpasses depend on them), as do structure decks and
    // profiles without trust flags (deck snap, hand-built).
    let conf = null;
    let firstT = -1, lastT = -1;
    if (!r.throughStructure) {
      for (let i = 0; i < pts.length; i++) {
        if (pts[i].trusted) { if (firstT < 0) firstT = i; lastT = i; }
      }
    }
    // Observed arc-length window (Infinity-open for structure decks / profiles
    // without trust flags, which never carry unobserved ends).
    const obsS0 = firstT >= 0 ? pts[firstT].s : -Infinity;
    const obsS1 = lastT >= 0 ? pts[lastT].s : Infinity;
    if (!r.throughStructure && !authority) {
      if (firstT > 0 || (firstT >= 0 && lastT < pts.length - 1)) {
        conf = new Float64Array(pts.length).fill(1);
        for (let i = 0; i < firstT; i++) {
          conf[i] = Math.max(0, 1 - (pts[firstT].s - pts[i].s) / endTaperM);
        }
        for (let i = lastT + 1; i < pts.length; i++) {
          conf[i] = Math.max(0, 1 - (pts[i].s - pts[lastT].s) / endTaperM);
        }
      }
    }
    keptRoads.push({ pts, conf });

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
          let w = d <= halfW ? 1 : smoothstep((reach - d) / featherScene);
          if (conf) {
            w *= conf[i - 1] + (conf[i] - conf[i - 1]) * t;
            if (w <= 0) continue;
          }
          const idx = row * W + col;
          const h = a.h + (b.h - a.h) * t; // profile samples ~stepM apart
          wSum[idx] += w;
          whSum[idx] += w * h;
          if (w > wMax[idx]) wMax[idx] = w;
          const sArc = a.s + (b.s - a.s) * t;
          if (sArc >= obsS0 && sArc <= obsS1 && w > wObs[idx]) wObs[idx] = w;
        }
      }
    }
  }

  let carvedCells = 0, maxShiftM = 0, minH = Infinity, maxH = -Infinity, largeShiftCells = 0;
  for (let idx = 0; idx < wMax.length; idx++) {
    const w = wMax[idx];
    if (w <= 0) continue;
    let delta = (whSum[idx] / wSum[idx] - hm[idx]) * w;
    if (delta > clampM) delta = clampM;
    else if (delta < -clampM) delta = -clampM;
    if (delta !== 0) {
      hm[idx] += delta;
      const a = Math.abs(delta);
      if (a > maxShiftM) maxShiftM = a;
      if (a > LARGE_SHIFT_M) largeShiftCells++;
    }
    if (hm[idx] < minH) minH = hm[idx];
    if (hm[idx] > maxH) maxH = hm[idx];
    carvedCells++;
    // The profile IS the floor here — trusted, so the terSnap pass may pull the
    // road mesh onto it (underpass included). Legacy: carriageway core only;
    // authority: the feather too, so floor and mesh transition together at the
    // street edge instead of the mesh releasing where the floor still blends.
    // Only over the OBSERVED arc (wObs): unobserved eased ends stay uncovered.
    if (cm && (authority ? wObs[idx] > 0 : wObs[idx] >= 0.9)) cm[idx] = 1;
  }

  // Post-carve fidelity: resample the carved grid along every full-strength
  // profile span. The gap between what the 1D smoother promised and what the
  // grid actually holds is the resolution/blend cost — the .ter's own bumps
  // (grid aliasing, cross-road blend zones, maxCarveM clamps all land here).
  const carvedFloor = { ...data, heightMap: hm };
  let resSq = 0, resN = 0, resMax = 0, resMaxAt = null;
  for (const k of keptRoads) {
    for (let i = 0; i < k.pts.length; i++) {
      if (k.conf && k.conf[i] < 1) continue; // tapered ends never fully stamp
      const p = k.pts[i];
      const e = Math.abs(sampleHeightAtScene(carvedFloor, p.x, p.z) - p.h);
      resSq += e * e; resN++;
      if (e > resMax) { resMax = e; resMaxAt = { x: p.x, z: p.z }; }
    }
  }
  return {
    carvedCells, maxShiftM: +maxShiftM.toFixed(2), minH, maxH, largeShiftCells,
    profileResidualRmsM: resN ? Math.round(Math.sqrt(resSq / resN) * 1000) / 1000 : 0,
    profileResidualMaxM: Math.round(resMax * 100) / 100,
    profileResidualMaxAt: resMaxAt,
    residualSamples: resN,
  };
};
