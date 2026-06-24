/**
 * Web Worker for CPU-intensive terrain resampling operations.
 * Offloads the per-pixel projection + sampling loops from the main thread.
 *
 * Handles two message types:
 *   - resampleHeight: heightmap resampling (GeoTIFF tiles + Terrarium fallback)
 *   - resampleImage:  satellite image resampling
 *
 * All data is passed as transferable ArrayBuffers where possible.
 *
 * The pure projection/sampling and the finalize (inpaint/blur) pipeline now live
 * under resample/ (refactor doc 06 step 7); this file keeps only the worker
 * postMessage entry + the resample orchestration loops.
 */
import {
    createLocalToWGS84,
    getPixelLatLng,
    getOutputBounds,
    writeSampledImagePixel,
    buildPreparedTileGroups,
    sampleHeightAt,
} from './resample/heightSampling.js';
import { finalizeHeightMap } from './resample/heightFinalize.js';

const createProgressReporter = (id) => {
    const lastPercentByStage = new Map();
    return ({ stage, message, current = 0, total = 1, force = false }) => {
        const safeTotal = Math.max(1, total);
        const percent = Math.max(0, Math.min(100, (current / safeTotal) * 100));
        const rounded = Math.floor(percent);
        const previous = lastPercentByStage.get(stage) ?? -1;
        if (!force && rounded <= previous) return;
        lastPercentByStage.set(stage, rounded);
        self.postMessage({ id, type: 'progress', stage, message, current, total: safeTotal, percent });
    };
};

const resampleHeight = async ({ id, center, width, height, targetBounds = null, smooth, fillHoles = true, tiles, fallback, epsgDefs }) => {
    const heightMap = new Float32Array(width * height);
    const toWGS84 = createLocalToWGS84(center.lat, center.lng);

    const NO_DATA = -99999;
    const reportProgress = createProgressReporter(id);
    reportProgress({ stage: 'prepare', message: 'Preparing uploaded elevation tiles...', current: 0, total: 1, force: true });
    const preparedGroups = await buildPreparedTileGroups(tiles, epsgDefs, NO_DATA);
    reportProgress({ stage: 'prepare', message: 'Uploaded elevation tiles ready.', current: 1, total: 1, force: true });

    // Main resampling loop
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [lng, lat] = getPixelLatLng(x, y, width, height, toWGS84, targetBounds);

            let h = sampleHeightAt(lng, lat, preparedGroups, fallback, NO_DATA);

            if (!Number.isFinite(h) || h <= -200 || h === NO_DATA) h = NO_DATA;
            heightMap[y * width + x] = h;
        }
        if ((y & 31) === 31 || y === height - 1) {
            reportProgress({
                stage: 'sample-height',
                message: 'Mapping uploaded elevation to the output grid...',
                current: y + 1,
                total: height,
            });
        }
    }

    finalizeHeightMap(heightMap, width, height, NO_DATA, smooth, fillHoles, reportProgress);

    return {
        heightMap,
        bounds: getOutputBounds(toWGS84, width, height, targetBounds),
    };
};

const resampleHeightAndImage = async ({ id, center, width, height, targetBounds = null, smooth, fillHoles = true, tiles, fallback, epsgDefs, imageSource }) => {
    const heightMap = new Float32Array(width * height);
    const rgbaBuffer = new Uint8ClampedArray(width * height * 4);
    const toWGS84 = createLocalToWGS84(center.lat, center.lng);
    const NO_DATA = -99999;
    const reportProgress = createProgressReporter(id);
    reportProgress({ stage: 'prepare', message: 'Preparing uploaded elevation tiles...', current: 0, total: 1, force: true });
    const preparedGroups = await buildPreparedTileGroups(tiles, epsgDefs, NO_DATA);
    reportProgress({ stage: 'prepare', message: 'Uploaded elevation tiles ready.', current: 1, total: 1, force: true });

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        const rowPixelOffset = rowOffset * 4;
        for (let x = 0; x < width; x++) {
            const [lng, lat] = getPixelLatLng(x, y, width, height, toWGS84, targetBounds);

            let h = sampleHeightAt(lng, lat, preparedGroups, fallback, NO_DATA);
            if (!Number.isFinite(h) || h <= -200 || h === NO_DATA) h = NO_DATA;
            heightMap[rowOffset + x] = h;

            writeSampledImagePixel(
                rgbaBuffer,
                rowPixelOffset + x * 4,
                imageSource.pixels,
                imageSource.width,
                imageSource.height,
                imageSource.zoom,
                imageSource.minTileX,
                imageSource.minTileY,
                lat,
                lng,
            );
        }
        if ((y & 31) === 31 || y === height - 1) {
            reportProgress({
                stage: 'sample-height-image',
                message: 'Mapping uploaded elevation to the output grid...',
                current: y + 1,
                total: height,
            });
        }
    }

    finalizeHeightMap(heightMap, width, height, NO_DATA, smooth, fillHoles, reportProgress);

    return {
        heightMap,
        rgbaBuffer,
        bounds: getOutputBounds(toWGS84, width, height, targetBounds),
    };
};

// ─── Image Resampling ────────────────────────────────────────────────────────
const resampleImageData = ({ center, width, height, targetBounds = null, imageSource }) => {
    const rgbaBuffer = new Uint8ClampedArray(width * height * 4);
    const toWGS84 = createLocalToWGS84(center.lat, center.lng);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [lng, lat] = getPixelLatLng(x, y, width, height, toWGS84, targetBounds);
            const idx = (y * width + x) * 4;
            writeSampledImagePixel(
                rgbaBuffer,
                idx,
                imageSource.pixels,
                imageSource.width,
                imageSource.height,
                imageSource.zoom,
                imageSource.minTileX,
                imageSource.minTileY,
                lat,
                lng,
            );
        }
    }

    return rgbaBuffer;
};

// ─── Message Handler ─────────────────────────────────────────────────────────
self.onmessage = async (e) => {
    const { type, id, ...params } = e.data;

    try {
        if (type === 'resampleHeight') {
            const result = await resampleHeight({ id, ...params });
            self.postMessage(
                { id, type: 'result', heightMap: result.heightMap, bounds: result.bounds },
                [result.heightMap.buffer]
            );
        } else if (type === 'resampleHeightAndImage') {
            const result = await resampleHeightAndImage({ id, ...params });
            self.postMessage(
                {
                    id,
                    type: 'result',
                    heightMap: result.heightMap,
                    rgbaBuffer: result.rgbaBuffer,
                    bounds: result.bounds,
                },
                [result.heightMap.buffer, result.rgbaBuffer.buffer]
            );
        } else if (type === 'resampleImage') {
            const result = resampleImageData(params);
            self.postMessage(
                { id, type: 'result', rgbaBuffer: result },
                [result.buffer]
            );
        }
    } catch (err) {
        self.postMessage({ id, type: 'error', error: err.message });
    }
};
