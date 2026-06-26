// DEM-anchored residual ground filter.
//
// Intent: extract a smooth bare-earth DTM from a baked photogrammetry DSM
// (height raster that still contains buildings / trees / noise spikes).
// Instead of smoothing the spiky tile surface directly, we use the DEM as a
// physically-plausible smooth BASE and only add a heavily-smoothed, CLAMPED
// correction (residual) that nudges the DEM toward the observed tile lows.
//
// Why this CANNOT produce stalagmites:
//   result = demH + blend * blur(clamp(tileLow - demH))
//   - demH is already smooth (the DEM has no spikes).
//   - the residual is clamped to +/- clampM, so a 30 m roof becomes <= clampM.
//   - the residual is then blurred over a large radius, so any surviving local
//     bump is spread out and flattened.
// A bounded, low-pass-filtered correction added to a smooth base stays smooth.
//
// Units: ALL heights are SCENE UNITS. Metre thresholds -> scene units via
// (T * field.unitsPerMeter). Metre radii -> node counts via field.cellSizeM.

export const meta = {
  id: 'demAnchor',
  label: 'DEM-anchored residual',
  params: [
    { key: 'clampM', label: 'Clamp (m)', min: 0.5, max: 30, step: 0.5, default: 10 },
    { key: 'smoothRadiusM', label: 'Smooth radius (m)', min: 2, max: 80, step: 1, default: 25 },
    { key: 'blend', label: 'Blend', min: 0, max: 1, step: 0.05, default: 1 },
  ],
};

// Resolve a param against meta defaults, ignoring non-finite / missing values.
function param(params, key) {
  const v = params && params[key];
  if (Number.isFinite(v)) return v;
  const d = meta.params.find((p) => p.key === key);
  return d ? d.default : 0;
}

// Separable box blur of a scalar field, radius in nodes, with index clamping.
// O(n) per axis via a running sum, so O(n) total.
function boxBlur(src, nx, nz, radius) {
  const r = Math.max(0, radius | 0);
  if (r === 0) return src.slice();
  const win = 2 * r + 1;
  const tmp = new Float32Array(nx * nz);
  const out = new Float32Array(nx * nz);

  // Horizontal pass.
  for (let zi = 0; zi < nz; zi++) {
    const row = zi * nx;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clampIdx(k, nx)];
    for (let xi = 0; xi < nx; xi++) {
      tmp[row + xi] = sum / win;
      const add = src[row + clampIdx(xi + r + 1, nx)];
      const sub = src[row + clampIdx(xi - r, nx)];
      sum += add - sub;
    }
  }

  // Vertical pass.
  for (let xi = 0; xi < nx; xi++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clampIdx(k, nz) * nx + xi];
    for (let zi = 0; zi < nz; zi++) {
      out[zi * nx + xi] = sum / win;
      const add = tmp[clampIdx(zi + r + 1, nz) * nx + xi];
      const sub = tmp[clampIdx(zi - r, nz) * nx + xi];
      sum += add - sub;
    }
  }
  return out;
}

// Clamp an index into [0, n-1] (border replication).
function clampIdx(i, n) {
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

export function apply(field, params) {
  const { nx, nz, unitsPerMeter, cellSizeM, loH, demH, covered } = field;
  const n = nx * nz;

  const clampM = param(params, 'clampM');
  const smoothRadiusM = param(params, 'smoothRadiusM');
  const blend = param(params, 'blend');

  const clampU = clampM * unitsPerMeter; // correction limit, scene units
  const radius = Math.max(1, Math.round(smoothRadiusM / cellSizeM)); // nodes

  // 1+2. Clamped residual toward the tile lows; uncovered nodes stay on DEM (r=0).
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dem = demH[i];
    if (!covered[i]) { r[i] = 0; continue; } // uncovered -> pure DEM
    const lo = loH[i];
    if (!Number.isFinite(lo) || !Number.isFinite(dem)) { r[i] = 0; continue; }
    let d = lo - dem;
    if (d > clampU) d = clampU;
    else if (d < -clampU) d = -clampU;
    r[i] = d;
  }

  // 3. Heavily smooth the clamped residual (large radius => very smooth).
  const rSmooth = boxBlur(r, nx, nz, radius);

  // 4. Output = smooth DEM base + scaled smooth correction.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dem = demH[i];
    const base = Number.isFinite(dem) ? dem : 0;
    let v = base + blend * rSmooth[i];
    if (!Number.isFinite(v)) v = base; // guard
    out[i] = v;
  }
  return out;
}
