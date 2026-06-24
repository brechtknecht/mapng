/** @layer core */
// Pure hole-filling kernels for DEM resampling: push-pull pyramid inpaint,
// iterative expand fill, and a bi-Laplacian relax over filled cells. Operate in
// place on Float32 height maps; no IO/DOM. Extracted from terrainResampler.js
// (docs/refactor/06 step 7); terrainResampler imports them.

export const pushPullInpaint = (map, width, height, noData) => {
  let hasHole = false;
  let sumValid = 0;
  let countValid = 0;
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    if (v === noData || !Number.isFinite(v)) { hasHole = true; }
    else { sumValid += v; countValid++; }
  }
  if (!hasHole) {
    console.debug('[Resampler] No holes detected, skipping inpaint');
    return null;
  }

  const fallback = countValid > 0 ? sumValid / countValid : 0;
  const levels = [{ data: new Float32Array(map), w: width, h: height }];

  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const prev = levels[levels.length - 1];
    const nw = Math.max(1, Math.floor((prev.w + 1) / 2));
    const nh = Math.max(1, Math.floor((prev.h + 1) / 2));
    const next = new Float32Array(nw * nh);
    next.fill(noData);

    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let sum = 0;
        let cnt = 0;
        for (let dy = 0; dy < 2; dy++) {
          const py = y * 2 + dy;
          if (py >= prev.h) continue;
          for (let dx = 0; dx < 2; dx++) {
            const px = x * 2 + dx;
            if (px >= prev.w) continue;
            const v = prev.data[py * prev.w + px];
            if (v !== noData && Number.isFinite(v)) { sum += v; cnt++; }
          }
        }
        if (cnt > 0) next[y * nw + x] = sum / cnt;
      }
    }

    levels.push({ data: next, w: nw, h: nh });
  }

  const top = levels[levels.length - 1];
  for (let i = 0; i < top.data.length; i++) {
    if (top.data[i] === noData) top.data[i] = fallback;
  }

  for (let li = levels.length - 2; li >= 0; li--) {
    const coarse = levels[li + 1];
    const fine = levels[li];
    const filledMask = new Uint8Array(fine.data.length);

    for (let y = 0; y < fine.h; y++) {
      const cy = y * 0.5;
      const y0 = Math.floor(cy);
      const fy = cy - y0;
      const y1 = Math.min(coarse.h - 1, y0 + 1);
      for (let x = 0; x < fine.w; x++) {
        const idx = y * fine.w + x;
        if (fine.data[idx] !== noData && Number.isFinite(fine.data[idx])) continue;
        const cx = x * 0.5;
        const x0 = Math.floor(cx);
        const fx = cx - x0;
        const x1 = Math.min(coarse.w - 1, x0 + 1);

        const c00 = coarse.data[y0 * coarse.w + x0];
        const c10 = coarse.data[y0 * coarse.w + x1];
        const c01 = coarse.data[y1 * coarse.w + x0];
        const c11 = coarse.data[y1 * coarse.w + x1];

        const topVal = c00 * (1 - fx) + c10 * fx;
        const botVal = c01 * (1 - fx) + c11 * fx;
        const interp = topVal * (1 - fy) + botVal * fy;

        fine.data[idx] = interp;
        filledMask[idx] = 1;
      }
    }

    levels[li].mask = filledMask;
  }

  const base = levels[0];
  const mask = base.mask;
  if (mask) {
    const out = new Float32Array(base.data);
    const rad = 1;
    for (let y = 0; y < base.h; y++) {
      for (let x = 0; x < base.w; x++) {
        const idx = y * base.w + x;
        if (!mask[idx]) continue;
        let sum = 0;
        let cnt = 0;
        for (let dy = -rad; dy <= rad; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= base.h) continue;
          const rowOff = ny * base.w;
          for (let dx = -rad; dx <= rad; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= base.w) continue;
            sum += base.data[rowOff + nx];
            cnt++;
          }
        }
        if (cnt > 0) out[idx] = sum / cnt;
      }
    }
    base.data.set(out);
  }

  map.set(levels[0].data);
  return mask || null;
};

export const expandFill = (map, width, height, noData, maxPasses = 64, radius = 3, baseMask = null) => {
  const filledMask = baseMask ? new Uint8Array(baseMask) : new Uint8Array(map.length);
  for (let pass = 0; pass < maxPasses; pass++) {
    let any = false;
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        const idx = rowOff + x;
        if (map[idx] !== noData) continue;
        let sum = 0;
        let cnt = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          const base = ny * width;
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const v = map[base + nx];
            if (v !== noData && Number.isFinite(v)) { sum += v; cnt++; }
          }
        }
        if (cnt > 0) {
          map[idx] = sum / cnt;
          filledMask[idx] = 1;
          any = true;
        }
      }
    }
    if (!any) break;
  }
  return filledMask;
};

export const relaxFilled = (map, width, height, noData, filledMask, iterations = 120) => {
  if (!filledMask) return;
  for (let iter = 0; iter < iterations; iter++) {
    let updated = false;
    for (let y = 0; y < height; y++) {
      const rowOff = y * width;
      for (let x = 0; x < width; x++) {
        const idx = rowOff + x;
        if (!filledMask[idx]) continue;

        const curVal = map[idx];
        const getV = (dx, dy) => {
          const nx = Math.max(0, Math.min(width - 1, x + dx));
          const ny = Math.max(0, Math.min(height - 1, y + dy));
          const val = map[ny * width + nx];
          if (val === noData || !Number.isFinite(val)) return curVal;
          return val;
        };

        let sumBi = 0;
        // distance 1: weight 8
        sumBi += 8 * (getV(-1, 0) + getV(1, 0) + getV(0, -1) + getV(0, 1));
        // distance sqrt(2): weight -2
        sumBi -= 2 * (getV(-1, -1) + getV(1, -1) + getV(-1, 1) + getV(1, 1));
        // distance 2: weight -1
        sumBi -= 1 * (getV(-2, 0) + getV(2, 0) + getV(0, -2) + getV(0, 2));
        const biVal = sumBi / 20;

        let sumLap = getV(-1, 0) + getV(1, 0) + getV(0, -1) + getV(0, 1);
        const lapVal = sumLap / 4;

        // 50% tension to prevent deep pits/overshoots (Gibbs phenomenon) while preserving smooth curvature
        const tension = 0.5;
        const newVal = biVal * (1 - tension) + lapVal * tension;

        if (Math.abs(newVal - curVal) > 0.0001) {
          map[idx] = newVal;
          updated = true;
        }
      }
    }
    if (!updated) break;
  }
};
