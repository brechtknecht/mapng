/** @layer core */
// Pure heightmap finalize pipeline for the terrain resampler worker (refactor
// doc 06 step 7): push/pull pyramid inpaint → expand fill → bi-Laplacian relax,
// plus a separable box blur. Operate in place on Float32 height maps; no IO/DOM.
// Moved VERBATIM from resamplerWorker.js — these are intentionally tuned
// differently from resample/resampleKernels.js (the terrainResampler copy), so
// they are kept as a separate module rather than merged.

const DEBUG_RESAMPLER = false;
const debugLog = (...args) => {
    if (DEBUG_RESAMPLER) console.debug(...args);
};

const LARGE_HOLE_SKIP_RATIO = 0.35;

/**
 * Pyramid-based push/pull inpainting for NO_DATA holes.
 *
 * Builds a mipmap pyramid by averaging valid (non-NO_DATA) neighbours at each
 * level. The coarsest level is seeded with the global mean. Then the pyramid is
 * pulled back up: each hole at a finer level is bilinearly interpolated from the
 * coarser level above it. A final 1-pixel box blur smooths seams around filled
 * areas.
 *
 * Returns the filled-pixel mask (1 where a hole was patched) so that subsequent
 * relaxation passes can target only those pixels.
 */
const pushPullInpaint = (map, width, height, noData) => {
    let hasHole = false;
    let sumValid = 0;
    let countValid = 0;
    for (let i = 0; i < map.length; i++) {
        const v = map[i];
        if (v === noData || !Number.isFinite(v)) hasHole = true;
        else { sumValid += v; countValid++; }
    }
    if (!hasHole) {
        debugLog('[ResamplerWorker] No holes detected, skipping inpaint');
        return null;
    }
    const fallback = countValid > 0 ? sumValid / countValid : 0;

    const levels = [];
    levels.push({ data: new Float32Array(map), w: width, h: height });

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
        const mask = new Uint8Array(fine.data.length);

        for (let y = 0; y < fine.h; y++) {
            const cy = y * 0.5;
            const y0 = Math.floor(cy);
            const fy = cy - y0;
            const y1 = Math.min(coarse.h - 1, y0 + 1);
            for (let x = 0; x < fine.w; x++) {
                const idx = y * fine.w + x;
                if (fine.data[idx] !== noData) continue;
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
                mask[idx] = 1;
            }
        }

        levels[li].mask = mask;
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

/**
 * Neighbour-average fill for holes that pushPullInpaint couldn't reach.
 * Iterates up to maxPasses times; each pass replaces every remaining NO_DATA
 * pixel with the average of its valid neighbours within `radius` pixels.
 * Stops early when no new pixels are filled.
 *
 * Returns a mask of all pixels that were touched (combining the seed mask from
 * pushPull with newly filled pixels) so the relaxation step knows which
 * values were synthesised vs. sampled directly from source data.
 */
const expandFill = (map, width, height, noData, maxPasses = 64, radius = 3, baseMask = null) => {
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

/**
 * Smooth synthesised (hole-filled) pixels by iterating a blended bi-harmonic /
 * Laplacian operator only on pixels marked in filledMask.
 *
 * The update rule mixes:
 *   - Bi-harmonic (weighted 1−tension): promotes smooth curvature, suppresses
 *     sharp kinks at the boundary between real data and filled values.
 *   - Laplacian (weighted tension=0.5): acts as a tension/spring term that
 *     anchors the surface closer to its neighbours, preventing Gibbs-phenomenon
 *     overshoots in filled pits or sharp ridges.
 *
 * Only filled pixels are mutated; real-data pixels act as fixed boundary
 * conditions that constrain the solution.
 */
const relaxFilled = (map, width, height, noData, filledMask, iterations = 200) => {
    if (!filledMask) return;
    const filledIndices = [];
    for (let i = 0; i < filledMask.length; i++) {
        if (filledMask[i]) filledIndices.push(i);
    }
    if (filledIndices.length === 0) return;

    for (let iter = 0; iter < iterations; iter++) {
        let updated = false;
        for (let i = 0; i < filledIndices.length; i++) {
            const idx = filledIndices[i];
            const y = (idx / width) | 0;
            const x = idx - y * width;
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
        if (!updated) break;
    }
};

const measureNoDataCoverage = (map, noData) => {
    let missing = 0;
    for (let index = 0; index < map.length; index++) {
        const value = map[index];
        if (value === noData || !Number.isFinite(value)) missing++;
    }
    return {
        missing,
        total: map.length,
        ratio: map.length > 0 ? missing / map.length : 0,
    };
};

const boxBlurHorizontal = (src, dst, width, height, radius, noData) => {
    for (let y = 0; y < height; y++) {
        const rowOff = y * width;
        let sum = 0;
        let count = 0;

        for (let k = 0; k <= Math.min(width - 1, radius); k++) {
            const val = src[rowOff + k];
            if (val !== noData) {
                sum += val;
                count++;
            }
        }

        for (let x = 0; x < width; x++) {
            dst[rowOff + x] = count > 0 ? sum / count : noData;

            const removeX = x - radius;
            if (removeX >= 0) {
                const removeVal = src[rowOff + removeX];
                if (removeVal !== noData) {
                    sum -= removeVal;
                    count--;
                }
            }

            const addX = x + radius + 1;
            if (addX < width) {
                const addVal = src[rowOff + addX];
                if (addVal !== noData) {
                    sum += addVal;
                    count++;
                }
            }
        }
    }
};

const boxBlurVertical = (src, dst, width, height, radius, noData) => {
    for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;

        for (let k = 0; k <= Math.min(height - 1, radius); k++) {
            const val = src[k * width + x];
            if (val !== noData) {
                sum += val;
                count++;
            }
        }

        for (let y = 0; y < height; y++) {
            dst[y * width + x] = count > 0 ? sum / count : noData;

            const removeY = y - radius;
            if (removeY >= 0) {
                const removeVal = src[removeY * width + x];
                if (removeVal !== noData) {
                    sum -= removeVal;
                    count--;
                }
            }

            const addY = y + radius + 1;
            if (addY < height) {
                const addVal = src[addY * width + x];
                if (addVal !== noData) {
                    sum += addVal;
                    count++;
                }
            }
        }
    }
};

const smoothHeightMap = (heightMap, width, height, noData) => {
    const radius = 8;
    const tempMap = new Float32Array(heightMap.length);
    boxBlurHorizontal(heightMap, tempMap, width, height, radius, noData);
    boxBlurVertical(tempMap, heightMap, width, height, radius, noData);
    boxBlurHorizontal(heightMap, tempMap, width, height, radius, noData);
    boxBlurVertical(tempMap, heightMap, width, height, radius, noData);
};

/**
 * Post-processing pipeline applied to a freshly resampled heightmap:
 *  1. Hole filling  — pushPull seed → expandFill propagation → Laplacian relax
 *  2. Smoothing     — separable box blur (GPXZ coarse-data mode only)
 */
export const finalizeHeightMap = (heightMap, width, height, noData, smooth, fillHoles, reportProgress = null) => {
    if (fillHoles) {
        const noDataCoverage = measureNoDataCoverage(heightMap, noData);
        if (noDataCoverage.ratio >= LARGE_HOLE_SKIP_RATIO) {
            reportProgress?.({
                stage: 'finalize',
                message: 'Large unmapped regions detected; preserving gaps instead of synthesizing terrain.',
                current: 3,
                total: 3,
                force: true,
            });
            console.warn(
                `[ResamplerWorker] Skipping hole filling for sparse output (${(noDataCoverage.ratio * 100).toFixed(1)}% no-data).`,
            );
            return;
        }

        reportProgress?.({ stage: 'finalize', message: 'Filling gaps in uploaded elevation...', current: 1, total: 3, force: true });
        debugLog('[ResamplerWorker] Hole filling enabled: starting push/pull seed');
        const seededMask = pushPullInpaint(heightMap, width, height, noData);
        if (!seededMask) {
            reportProgress?.({
                stage: 'finalize',
                message: 'No gaps detected in uploaded elevation.',
                current: 3,
                total: 3,
                force: true,
            });
            return;
        }
        reportProgress?.({ stage: 'finalize', message: 'Expanding filled gaps...', current: 2, total: 3, force: true });
        const expandedMask = expandFill(heightMap, width, height, noData, 64, 3, seededMask);
        relaxFilled(heightMap, width, height, noData, expandedMask || seededMask, 200);
    }

    if (smooth) {
        reportProgress?.({ stage: 'finalize', message: 'Smoothing uploaded elevation...', current: 3, total: 3, force: true });
        smoothHeightMap(heightMap, width, height, noData);
    } else if (fillHoles) {
        reportProgress?.({ stage: 'finalize', message: 'Uploaded elevation cleanup complete.', current: 3, total: 3, force: true });
    }
};
