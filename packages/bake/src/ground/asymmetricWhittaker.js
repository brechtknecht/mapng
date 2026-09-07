/** @layer core */
// Asymmetric Whittaker smoothing for 1D road elevation profiles.
//
// The road is the BASELINE under the photogrammetry: everything that sits on
// a road (cars, tree canopies, bridge decks, signs) is ABOVE it, so an
// observation above the fitted curve is nearly free, while an observation
// below it (a sink, a facade skirt, a seam) is penalised with bounded
// influence. Smoothness comes from a second-difference (curvature) penalty —
// the physical prior that a vertical road alignment is tangents joined by
// long vertical curves — parameterised by a cutoff WAVELENGTH in metres
// rather than a bare λ so the tuning knob has a physical meaning.
//
//   minimise  Σ_i w_i (y_i − h_i)²  +  λ Σ_i (h_{i−1} − 2 h_i + h_{i+1})²
//
//   w_i = base_i · ρ(y_i − h_i),   ρ(r) = 1            |r| ≤ core          (noise)
//                                        = core / |r|   core < |r|, r ≤ object  (robust noise, both sides)
//                                        = p            r  >  object  (object standing on the road)
//
// Iteratively reweighted least squares (Eilers & Boelens 2005, asymmetric
// least squares). The band up to `objectM` is treated SYMMETRICALLY (Huber)
// because the per-cell tile minimum errs both ways — seam skirts and facade
// bottoms below the road, curb blobs and noise above it — and a one-sided
// loss there would sink the road to the lower envelope of its own noise. Only
// clearly above the road does the asymmetry kick in: a car, a canopy, a deck.
// Each iteration solves one pentadiagonal system in O(n). Pure, DOM-free,
// uniform sample spacing.

/**
 * Cutoff wavelength (metres) → λ for a second-difference penalty at `stepM`
 * spacing. The smoother's frequency response is 1 / (1 + λ (2 − 2 cos ω)²)
 * ≈ 1 / (1 + λ ω⁴); half power at ω = λ^(−1/4), i.e. wavelength
 * 2π λ^(1/4) samples.
 */
export const lambdaForCutoff = (cutoffM, stepM) => ((cutoffM / (2 * Math.PI * stepM)) ** 4);

/**
 * Solve (diag(w) + λ DᵀD) h = w ∘ y where D is the (n−2)×n second-difference
 * operator. Banded LU with bandwidth 2; n ≥ 3.
 * @param {ArrayLike<number>} y
 * @param {ArrayLike<number>} w  per-sample data weights ≥ 0
 * @param {number} lambda
 * @returns {Float64Array}
 */
export function solveWhittaker(y, w, lambda) {
  const n = y.length;
  if (n === 0) return new Float64Array(0);
  if (n < 3) {
    // Too short for a curvature term — weighted mean, or the data itself.
    const out = new Float64Array(n);
    let ws = 0, s = 0;
    for (let i = 0; i < n; i++) { ws += w[i]; s += w[i] * y[i]; }
    const m = ws > 0 ? s / ws : 0;
    for (let i = 0; i < n; i++) out[i] = w[i] > 0 ? y[i] : m;
    return out;
  }
  // Band storage: row i holds columns i−2 … i+2 at offsets 0 … 4.
  const band = new Float64Array(n * 5);
  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) { band[i * 5 + 2] = w[i]; rhs[i] = w[i] * y[i]; }
  for (let i = 0; i < n - 2; i++) {
    // D row i touches h_i (+1), h_{i+1} (−2), h_{i+2} (+1).
    band[i * 5 + 2] += lambda;            band[(i + 1) * 5 + 2] += 4 * lambda; band[(i + 2) * 5 + 2] += lambda;
    band[i * 5 + 3] += -2 * lambda;       band[(i + 1) * 5 + 1] += -2 * lambda; // (i, i+1) and (i+1, i)
    band[(i + 1) * 5 + 3] += -2 * lambda; band[(i + 2) * 5 + 1] += -2 * lambda; // (i+1, i+2) and (i+2, i+1)
    band[i * 5 + 4] += lambda;            band[(i + 2) * 5 + 0] += lambda;       // (i, i+2) and (i+2, i)
  }
  // Forward elimination (the matrix is symmetric positive definite whenever
  // any weight is positive, so no pivoting is needed).
  for (let i = 0; i < n; i++) {
    const piv = band[i * 5 + 2];
    for (let off = 1; off <= 2; off++) {
      const r = i + off;
      if (r >= n) break;
      const f = band[r * 5 + (2 - off)] / piv;
      if (f === 0) continue;
      for (let c = i; c <= Math.min(n - 1, i + 2); c++) {
        band[r * 5 + (2 - (r - c))] -= f * band[i * 5 + (2 + (c - i))];
      }
      rhs[r] -= f * rhs[i];
    }
  }
  const h = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = rhs[i];
    for (let c = i + 1; c <= Math.min(n - 1, i + 2); c++) s -= band[i * 5 + (2 + (c - i))] * h[c];
    h[i] = s / band[i * 5 + 2];
  }
  return h;
}

/**
 * Fit the road baseline through uniformly spaced observations.
 *
 * @param {ArrayLike<number>} y        observed heights (metres), one per arc sample
 * @param {ArrayLike<number>} weight   base weight per sample in [0,1]: 1 = a
 *   trusted tile observation, 0 = no observation (gap, bridge deck footprint,
 *   uncovered cell). Semantic knowledge goes in here, nothing else.
 * @param {object} [opts]
 * @param {number} [opts.stepM=1]        sample spacing (metres)
 * @param {number} [opts.cutoffM=40]     half-power wavelength of the curvature
 *   penalty — the shortest real vertical road feature to keep. Anything
 *   shorter (cars, bumps, seam skirts) is treated as noise.
 * @param {number} [opts.coreM=0.4]      symmetric noise core (metres): residuals
 *   inside ±coreM are plain least squares; beyond it (both sides, up to
 *   objectM above) the influence is Huber-bounded.
 * @param {number} [opts.objectM=1.0]    height above the curve beyond which an
 *   observation is an OBJECT on the road (car, canopy, deck), not noise.
 * @param {number} [opts.aboveWeight=0.02]  weight of such an object sample.
 * @param {number} [opts.iterations=20]
 * @param {ArrayLike<number>|null} [opts.prior=null]  fallback heights (DEM)
 *   used where weight is 0, at `priorWeight` — long gaps relax toward the
 *   prior instead of extrapolating the curvature freely.
 * @param {number|ArrayLike<number>} [opts.priorWeight=0]  scalar, or one
 *   weight per sample (e.g. only the unbracketed leading/trailing spans of a
 *   road relax to the prior while interior gaps are interpolated).
 * @returns {{ h: Float64Array, w: Float64Array, lambda: number,
 *             above: number, below: number, core: number }}
 *   h = fitted heights; w = final per-sample weights; above/below/core =
 *   observation counts by residual class after the last iteration.
 */
export function fitAsymmetricProfile(y, weight, {
  stepM = 1, cutoffM = 40, coreM = 0.4, objectM = 1.0, aboveWeight = 0.02, iterations = 20,
  prior = null, priorWeight = 0,
} = {}) {
  const n = y.length;
  const lambda = lambdaForCutoff(cutoffM, stepM);
  const yy = new Float64Array(n);
  const base = new Float64Array(n);
  const priorW = (i) => (typeof priorWeight === 'number' ? priorWeight : (priorWeight?.[i] ?? 0));
  for (let i = 0; i < n; i++) {
    const bw = weight ? Math.max(0, Math.min(1, weight[i] || 0)) : 1;
    const pw = priorW(i);
    if (bw > 0 && Number.isFinite(y[i])) { yy[i] = y[i]; base[i] = bw; }
    else if (prior && pw > 0 && Number.isFinite(prior[i])) { yy[i] = prior[i]; base[i] = -pw; } // negative = prior marker
  }
  let w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.abs(base[i]);
  let h = solveWhittaker(yy, w, lambda);
  let above = 0, below = 0, core = 0;
  for (let it = 0; it < iterations; it++) {
    above = 0; below = 0; core = 0;
    const w2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (base[i] <= 0) { w2[i] = -base[i]; continue; } // prior samples keep their weight
      const r = yy[i] - h[i];
      let rho;
      if (r > Math.max(objectM, coreM)) { rho = aboveWeight; above++; }
      else if (r > coreM) { rho = coreM / r; core++; }
      else if (r < -coreM) { rho = coreM / -r; below++; }
      else { rho = 1; core++; }
      w2[i] = base[i] * rho;
    }
    w = w2;
    h = solveWhittaker(yy, w, lambda);
  }
  return { h, w, lambda, above, below, core };
}
