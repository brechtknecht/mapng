import proj4 from 'proj4';
import * as GeoTIFF from 'geotiff';
import { createLocalToWGS84, bilinear } from '@mapng/geo';
// Pure hole-filling kernels extracted to resample/resampleKernels.js
// (docs/refactor/06 step 7).
import { pushPullInpaint, expandFill, relaxFilled } from './resample/resampleKernels.js';

const normalizeLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

const getPixelLatLng = (x, y, width, height, toWGS84, targetBounds) => {
    if (targetBounds && Number.isFinite(targetBounds.north) && Number.isFinite(targetBounds.south)
        && Number.isFinite(targetBounds.east) && Number.isFinite(targetBounds.west)) {
        const u = width > 1 ? x / (width - 1) : 0.5;
        const v = height > 1 ? y / (height - 1) : 0.5;
        const lat = targetBounds.north - v * (targetBounds.north - targetBounds.south);

        let lngSpan = targetBounds.east - targetBounds.west;
        if (lngSpan > 180) lngSpan -= 360;
        if (lngSpan < -180) lngSpan += 360;
        const lng = normalizeLng(targetBounds.west + u * lngSpan);
        return [lng, lat];
    }

    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const localX = x - halfWidth;
    const localY = halfHeight - y;
    return toWGS84.forward([localX, localY]);
};

export const getOutputBounds = (toWGS84, width, height, targetBounds) => {
    if (targetBounds && Number.isFinite(targetBounds.north) && Number.isFinite(targetBounds.south)
        && Number.isFinite(targetBounds.east) && Number.isFinite(targetBounds.west)) {
        return {
            north: targetBounds.north,
            south: targetBounds.south,
            east: normalizeLng(targetBounds.east),
            west: normalizeLng(targetBounds.west),
        };
    }

    const halfWidth = width / 2;
    const halfHeight = height / 2;
    const nw = toWGS84.forward([-halfWidth, halfHeight]);
    const se = toWGS84.forward([halfWidth, -halfHeight]);
    return {
        north: nw[1],
        west: nw[0],
        south: se[1],
        east: se[0],
    };
};

/**
 * Resamples a source raster (GeoTIFF or generic sampler) to a 1 meter/pixel grid
 * centered at the given location.
 */
export const resampleToMeterGrid = async (
    source,
    center,
    width,
    height,
    _interpolation = 'bilinear',
    smooth = false,
    fillHoles = true,
    targetBounds = null
) => {

    const heightMap = new Float32Array(width * height);

    // Use shared local Transverse Mercator projection
    const toWGS84 = createLocalToWGS84(center.lat, center.lng);

    const tiles = [];

    if ((source.type === 'geotiff' || source.type === 'grid') && source.data) {
        if (source.type === 'grid') {
            for (const item of source.data.tiles || []) {
                let converter = null;
                if (item.epsgCode) {
                    const epsg = `EPSG:${item.epsgCode}`;
                    try {
                        if (!proj4.defs(epsg)) {
                            const response = await fetch(`https://epsg.io/${item.epsgCode}.proj4`);
                            if (response.ok) {
                                const def = await response.text();
                                proj4.defs(epsg, def);
                            }
                        }
                        converter = proj4('EPSG:4326', epsg);
                    } catch (e) {
                        if (item.epsgCode === 4326) {
                            converter = { forward: (p) => p };
                        }
                    }
                } else {
                    converter = { forward: (p) => p };
                }

                if (converter) {
                    tiles.push({
                        raster: item.raster,
                        width: item.width,
                        height: item.height,
                        originX: item.originX,
                        originY: item.originY,
                        resX: item.resX,
                        resY: item.resY,
                        noData: Number.isFinite(item.noData) ? item.noData : -99999,
                        converter,
                    });
                }
            }
        } else {
        for (const item of source.data) {
            const image = item.image;
            const raster = item.raster;
            const width = image.getWidth();
            const height = image.getHeight();
            const [originX, originY] = image.getOrigin();
            const [resX, resY] = image.getResolution();
            const noData = Number.isFinite(image.getGDALNoData()) ? image.getGDALNoData() : -99999;

            const geoKeys = image.getGeoKeys();
            const epsgCode = geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey;

            let converter = null;

            if (epsgCode) {
                const epsg = `EPSG:${epsgCode}`;

                // Check if definition exists, if not fetch it
                try {
                    if (!proj4.defs(epsg)) {
                        console.log(`[Resampler] Fetching Proj4 definition for ${epsg}...`);
                        const response = await fetch(`https://epsg.io/${epsgCode}.proj4`);
                        if (response.ok) {
                            const def = await response.text();
                            proj4.defs(epsg, def);
                            console.log(`[Resampler] Loaded definition for ${epsg}`);
                        } else {
                            console.warn(`[Resampler] Failed to fetch definition for ${epsg}`);
                        }
                    }

                    converter = proj4('EPSG:4326', epsg);
                } catch (e) {
                    console.warn(`Proj4 definition for ${epsg} missing or invalid, assuming WGS84 if 4326`, e);
                    if (epsgCode === 4326) {
                        converter = { forward: (p) => p };
                    }
                }
            } else {
                // Fallback for missing EPSG code (common in some web-served GeoTIFFs like GPXZ)
                console.warn("[Resampler] No EPSG code found in GeoTIFF keys. Assuming EPSG:4326 (Lat/Lon).");
                converter = { forward: (p) => p };
            }

            if (converter) {
                tiles.push({
                    raster,
                    width,
                    height,
                    originX,
                    originY,
                    resX,
                    resY,
                    noData,
                    converter
                });
            }
        }
        }
    }

    // Bilinear interpolation now lives in @mapng/geo (verbatim).

    // Iterate over the target grid (1m per pixel)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [lng, lat] = getPixelLatLng(x, y, width, height, toWGS84, targetBounds);

            let h = -99999; // Match terrain.ts NO_DATA_VALUE

            if ((source.type === 'geotiff' || source.type === 'grid') && tiles.length > 0) {
                // Try to find a tile that covers this point
                for (const tile of tiles) {
                    // Convert Lat/Lon to TIFF CRS
                    const [tx, ty] = tile.converter.forward([lng, lat]);

                    // Map to TIFF pixel space
                    const px = (tx - tile.originX) / tile.resX;
                    const py = (ty - tile.originY) / tile.resY;

                    if (px >= 0 && px < tile.width - 1 && py >= 0 && py < tile.height - 1) {
                        const val = bilinear(tile.raster, tile.width, px, py, tile.noData);
                        if (val !== tile.noData) {
                            h = val;
                            break; // Found valid data, stop searching
                        }
                    }
                }
            }

            // Fallback to sampler if GeoTIFF failed or returned NoData
            if (h === -99999 && source.sampler) {
                h = source.sampler(lat, lng);
            }

            if (!Number.isFinite(h) || h <= -200 || h === -99999) h = -99999;
            heightMap[y * width + x] = h;
        }
    }

    // Fill holes introduced by missing Terrarium tiles or GeoTIFF nodata (skip when disabled)
    if (fillHoles) {
        console.debug('[Resampler] Hole filling enabled: starting push/pull seed');
        const seededMask = pushPullInpaint(heightMap, width, height, -99999);
        console.debug('[Resampler] Push/pull seed complete');
        const expandedMask = expandFill(heightMap, width, height, -99999, 64, 3, seededMask);
        console.debug('[Resampler] Expand fill complete');
        relaxFilled(heightMap, width, height, -99999, expandedMask || seededMask, 200);
        console.debug('[Resampler] Relaxation complete');
    }

    // Apply smoothing if requested
    if (smooth) {
        console.log("[Resampler] Applying smoothing pass (Dual Separable Box Blur)...");

        // O(1) per-pixel box blur using running sum (sliding window).
        // ~17x faster than naive O(radius) approach for radius=8.
        const radius = 8;
        const tempMap = new Float32Array(heightMap.length);
        const NO_DATA = -99999;

        const blurH = (src, dst) => {
            for (let y = 0; y < height; y++) {
                const rowOff = y * width;
                let sum = 0, count = 0;
                // Initialize window for x=0
                for (let k = 0; k <= radius && k < width; k++) {
                    const val = src[rowOff + k];
                    if (val !== NO_DATA) { sum += val; count++; }
                }
                for (let x = 0; x < width; x++) {
                    // Add right edge entering the window
                    const addX = x + radius;
                    if (addX < width && addX > radius) { // only if not already counted in init
                        const val = src[rowOff + addX];
                        if (val !== NO_DATA) { sum += val; count++; }
                    }
                    // Remove left edge leaving the window
                    const remX = x - radius - 1;
                    if (remX >= 0) {
                        const val = src[rowOff + remX];
                        if (val !== NO_DATA) { sum -= val; count--; }
                    }
                    dst[rowOff + x] = count > 0 ? sum / count : NO_DATA;
                }
            }
        };

        const blurV = (src, dst) => {
            for (let x = 0; x < width; x++) {
                let sum = 0, count = 0;
                // Initialize window for y=0
                for (let k = 0; k <= radius && k < height; k++) {
                    const val = src[k * width + x];
                    if (val !== NO_DATA) { sum += val; count++; }
                }
                for (let y = 0; y < height; y++) {
                    const addY = y + radius;
                    if (addY < height && addY > radius) {
                        const val = src[addY * width + x];
                        if (val !== NO_DATA) { sum += val; count++; }
                    }
                    const remY = y - radius - 1;
                    if (remY >= 0) {
                        const val = src[remY * width + x];
                        if (val !== NO_DATA) { sum -= val; count--; }
                    }
                    dst[y * width + x] = count > 0 ? sum / count : NO_DATA;
                }
            }
        };

        // Pass 1
        blurH(heightMap, tempMap);
        blurV(tempMap, heightMap);

        // Pass 2
        blurH(heightMap, tempMap);
        blurV(tempMap, heightMap);
    }

    return {
        heightMap,
        bounds: getOutputBounds(toWGS84, width, height, targetBounds),
    };
};

/**
 * Resamples an image source (Canvas/Image) to a 1 meter/pixel grid
 * centered at the given location.
 */
export const resampleImageToMeterGrid = async (
    source,
    center,
    width,
    height,
    targetBounds = null
) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not create canvas context");

    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    // Use shared local Transverse Mercator projection
    const toWGS84 = createLocalToWGS84(center.lat, center.lng);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const [lng, lat] = getPixelLatLng(x, y, width, height, toWGS84, targetBounds);

            const color = source.sampler(lat, lng);

            const idx = (y * width + x) * 4;
            data[idx] = color.r;
            data[idx + 1] = color.g;
            data[idx + 2] = color.b;
            data[idx + 3] = color.a;
        }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
};
