// Road-profile bench helpers — pure logic for the /road-profile-bench lab.
//
// Everything here works on REAL baked tiles: the dense per-cell MIN raster of
// the tile surface (heightField.js) and the production ground extraction.
// The bench draws a road where the user believes it is, reads the tile
// surface across that corridor, and fits elevation profiles two ways —
// the production chain (roadProfiles.buildRoadProfiles) and the asymmetric
// Whittaker baseline (ground/asymmetricWhittaker.js) — so both can be judged
// against the mesh itself, not against a synthetic model.
import { SCENE_SIZE, computeUnitsPerMeter } from '@mapng/bake/scene/sceneFrame';
import { sampleHeightAtScene } from '@mapng/bake/scene/sceneSample';
import { buildRoadProfiles } from '@mapng/bake/roadProfiles';
import { EXCLUDE_HIGHWAY, HALF_WIDTH_M } from '@mapng/bake/groundMask';
import { fitAsymmetricProfile } from '@mapng/bake/ground/asymmetricWhittaker';
import { createMetricProjector } from '@mapng/geo';

const HALF = SCENE_SIZE / 2;

/** Bilinear read of the per-cell MIN raster; NaN where any corner is uncovered. */
export function sampleFieldMin(field, x, z) {
  const { nx, nz, minH, covered } = field;
  const gx = ((x + HALF) / SCENE_SIZE) * (nx - 1);
  const gz = ((z + HALF) / SCENE_SIZE) * (nz - 1);
  if (gx < 0 || gz < 0 || gx > nx - 1 || gz > nz - 1) return NaN;
  const x0 = Math.floor(gx), z0 = Math.floor(gz);
  const x1 = Math.min(x0 + 1, nx - 1), z1 = Math.min(z0 + 1, nz - 1);
  const i00 = z0 * nx + x0, i10 = z0 * nx + x1, i01 = z1 * nx + x0, i11 = z1 * nx + x1;
  if (!covered[i00] || !covered[i10] || !covered[i01] || !covered[i11]) return NaN;
  const wx = gx - x0, wz = gz - z0;
  return minH[i00] * (1 - wx) * (1 - wz) + minH[i10] * wx * (1 - wz)
    + minH[i01] * (1 - wx) * wz + minH[i11] * wx * wz;
}

/** Resample a scene-space polyline at a fixed arc-length step (metres). */
export function resamplePolyline(points, stepM, upm) {
  if (!points || points.length < 2) return [];
  const step = stepM * upm;
  const out = [{ x: points[0].x, z: points[0].z, s: 0 }];
  let carry = 0, s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len === 0) continue;
    let d = step - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, s: (s + d) / upm });
      d += step;
    }
    carry = len - (d - step);
    s += len;
  }
  const last = points[points.length - 1];
  if (out[out.length - 1].s < s / upm - 1e-6) out.push({ x: last.x, z: last.z, s: s / upm });
  return out;
}

const medianOf = (arr) => {
  const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return NaN;
  return v.length % 2 ? v[v.length >> 1] : (v[(v.length >> 1) - 1] + v[v.length >> 1]) / 2;
};

/**
 * Read the tile surface across a drawn road corridor.
 * @param {object} field    HeightField (scene units)
 * @param {object} terrain  TerrainData (DEM, minHeight, bounds)
 * @param {Array<{x:number,z:number}>} line  scene-space centreline
 * @param {object} [opts]
 * @param {number} [opts.stepM=1]        arc-length sample spacing
 * @param {number} [opts.halfWidthM=4]   carriageway half width
 * @param {number} [opts.taps=5]         cross-section taps per sample
 * @param {number} [opts.tapSpan=0.8]    taps cover ±tapSpan·halfWidth
 * @returns {{ samples: Array<{x,z,s,taps:Float64Array,min,median,centre,dem}>, stepM, halfWidthM, upm }}
 */
export function sampleCorridor(field, terrain, line, { stepM = 1, halfWidthM = 4, taps = 5, tapSpan = 0.8 } = {}) {
  const upm = computeUnitsPerMeter(terrain) || 1;
  const minHeight = terrain.minHeight ?? 0;
  const pts = resamplePolyline(line, stepM, upm);
  const toM = (u) => u / upm + minHeight;
  const samples = pts.map((p, i) => {
    const q = pts[Math.min(i + 1, pts.length - 1)], o = pts[Math.max(i - 1, 0)];
    const dl = Math.hypot(q.x - o.x, q.z - o.z) || 1;
    const nx = -(q.z - o.z) / dl, nz = (q.x - o.x) / dl;
    const reach = halfWidthM * tapSpan * upm;
    const t = new Float64Array(taps);
    for (let k = 0; k < taps; k++) {
      const f = taps === 1 ? 0 : (k / (taps - 1)) * 2 - 1;
      const v = sampleFieldMin(field, p.x + nx * reach * f, p.z + nz * reach * f);
      t[k] = Number.isFinite(v) ? toM(v) : NaN;
    }
    let min = Infinity;
    for (const v of t) if (Number.isFinite(v) && v < min) min = v;
    const centre = t[taps >> 1];
    return {
      x: p.x, z: p.z, s: p.s, taps: t,
      min: Number.isFinite(min) ? min : NaN,
      median: medianOf(Array.from(t)),
      centre,
      dem: sampleHeightAtScene(terrain, p.x, p.z),
    };
  });
  return { samples, stepM, halfWidthM, upm };
}

/** Scene → WGS84 through the AOI bounds (linear; sub-pixel over one AOI). */
export function sceneToLatLng(terrain, x, z) {
  const b = terrain.bounds;
  const u = (x + HALF) / SCENE_SIZE, v = (z + HALF) / SCENE_SIZE;
  return { lat: b.north - v * (b.north - b.south), lng: b.west + u * (b.east - b.west) };
}

/** Build an OSM-shaped road feature from a drawn scene-space line. */
export function buildDrawnFeature(terrain, line, highway = 'residential') {
  return {
    type: 'road',
    id: 'drawn',
    geometry: line.map((p) => sceneToLatLng(terrain, p.x, p.z)),
    tags: { highway, name: 'drawn road' },
  };
}

/** Production chain: one road through buildRoadProfiles. */
export function runProductionProfile(feature, terrain, ground, opts = {}) {
  const prof = buildRoadProfiles([feature], terrain, ground, { junctionBlendM: 0, ...opts });
  return prof?.roads?.[0] ?? null;
}

/**
 * Candidate chain: asymmetric Whittaker on the chosen cross-section aggregate.
 * @returns {{ h: Float64Array, w: Float64Array, obs: Float64Array, above:number, below:number, core:number, lambda:number }}
 */
export function runCandidateProfile(corridor, {
  aggregate = 'median', cutoffM = 40, coreM = 0.4, objectM = 1.0, aboveWeight = 0.02, priorWeight = 0.05, iterations = 20,
} = {}) {
  const { samples, stepM } = corridor;
  const n = samples.length;
  const obs = new Float64Array(n), weight = new Float64Array(n), prior = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const v = aggregate === 'min' ? s.min : aggregate === 'centre' ? s.centre : s.median;
    obs[i] = v; weight[i] = Number.isFinite(v) ? 1 : 0; prior[i] = s.dem;
  }
  const fit = fitAsymmetricProfile(obs, weight, { stepM, cutoffM, coreM, objectM, aboveWeight, iterations, prior, priorWeight });
  return { ...fit, obs };
}

/** Resample a production profile (its own 5 m step) onto the corridor samples. */
export function resampleProductionOnto(road, corridor) {
  const n = corridor.samples.length;
  const out = new Float64Array(n).fill(NaN);
  if (!road?.pts?.length) return out;
  const pts = road.pts;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = corridor.samples[i].s;
    while (j < pts.length - 2 && pts[j + 1].s < s) j++;
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    const span = b.s - a.s;
    const t = span > 0 ? Math.max(0, Math.min(1, (s - a.s) / span)) : 0;
    out[i] = a.h + (b.h - a.h) * t;
  }
  return out;
}

/** Ride metrics of a profile at `stepM` spacing. */
export function profileMetrics(h, stepM) {
  let bumpSq = 0, bumpN = 0, maxGrade = 0, worstBump = 0;
  for (let i = 1; i < h.length; i++) {
    if (!Number.isFinite(h[i]) || !Number.isFinite(h[i - 1])) continue;
    maxGrade = Math.max(maxGrade, Math.abs(h[i] - h[i - 1]) / stepM);
    if (i < h.length - 1 && Number.isFinite(h[i + 1])) {
      const d2 = h[i - 1] - 2 * h[i] + h[i + 1];
      bumpSq += d2 * d2; bumpN++;
      worstBump = Math.max(worstBump, Math.abs(d2));
    }
  }
  return {
    roughnessRmsM: bumpN ? Math.sqrt(bumpSq / bumpN) : 0,
    worstBumpM: worstBump,
    maxGradePct: maxGrade * 100,
  };
}

/** Residual distribution of the observations against a profile. */
export function residualStats(h, obs, coreM = 0.4) {
  const r = [];
  let above = 0, below = 0;
  for (let i = 0; i < h.length; i++) {
    if (!Number.isFinite(obs[i]) || !Number.isFinite(h[i])) continue;
    const d = obs[i] - h[i];
    r.push(d);
    if (d > coreM) above++; else if (d < -coreM) below++;
  }
  r.sort((a, b) => a - b);
  const q = (p) => (r.length ? r[Math.min(r.length - 1, Math.floor(p * r.length))] : NaN);
  return { n: r.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), above, below };
}

export function compareProfiles(a, b) {
  let maxAbs = 0, sq = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const d = Math.abs(a[i] - b[i]);
    maxAbs = Math.max(maxAbs, d); sq += d * d; n++;
  }
  return { maxAbsM: maxAbs, rmsM: n ? Math.sqrt(sq / n) : 0 };
}

// ── OSM overlay helpers ──────────────────────────────────────────────────
export const drivableOsmRoads = (terrain) => (Array.isArray(terrain?.osmFeatures) ? terrain.osmFeatures : [])
  .filter((f) => f?.type === 'road' && Array.isArray(f.geometry) && f.geometry.length >= 2
    && f.tags?.highway && !EXCLUDE_HIGHWAY.has(f.tags.highway));

export function osmRoadToSceneLine(feature, terrain) {
  const project = createMetricProjector(terrain.bounds, terrain.width, terrain.height);
  return feature.geometry.map((g) => {
    const p = project(g.lat, g.lng);
    return { x: (p.x / (terrain.width - 1)) * SCENE_SIZE - HALF, z: (p.y / (terrain.height - 1)) * SCENE_SIZE - HALF };
  });
}

export function nearestOsmRoad(features, terrain, x, z) {
  let best = null, bestD = Infinity;
  for (const f of features) {
    const line = osmRoadToSceneLine(f, terrain);
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? ((x - a.x) * dx + (z - a.z) * dz) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
      if (d < bestD) { bestD = d; best = { feature: f, line }; }
    }
  }
  return best;
}

export const halfWidthForHighway = (highway) => HALF_WIDTH_M[highway] ?? HALF_WIDTH_M.default;
export const HIGHWAY_CLASSES = Object.keys(HALF_WIDTH_M).filter((k) => k !== 'default');
