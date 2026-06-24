/** @layer io */
// Projection + per-point elevation/image sampling for the terrain resampler
// worker (refactor doc 06 step 7). Moved VERBATIM from resamplerWorker.js.
// buildPreparedTileGroups may fetch an epsg.io proj4 definition (→ io); the rest
// is pure transforms over typed arrays.
import proj4 from 'proj4';
import { bilinear } from '@mapng/geo';
import { getBuiltInProj4 } from '@mapng/geo';

// ─── Web Mercator Projection (mirrors terrain.js) ───────────────────────────
const TILE_SIZE = 256;
const MAX_LATITUDE = 85.05112878;

const project = (lat, lng, zoom) => {
    const d = Math.PI / 180;
    const max = MAX_LATITUDE;
    const latClamped = Math.max(Math.min(max, lat), -max);
    const sin = Math.sin(latClamped * d);
    const z = TILE_SIZE * Math.pow(2, zoom);
    const x = (z * (lng + 180)) / 360;
    const y = z * (0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI);
    return { x, y };
};

// ─── Local Transverse Mercator (mirrors geoUtils.js) ─────────────────────────
export const createLocalToWGS84 = (centerLat, centerLng) => {
    const def = `+proj=tmerc +lat_0=${centerLat} +lon_0=${centerLng} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
    return proj4(def, 'EPSG:4326');
};

const normalizeLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

export const getPixelLatLng = (x, y, width, height, toWGS84, targetBounds) => {
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
    return { north: nw[1], west: nw[0], south: se[1], east: se[0] };
};

// ─── Bilinear Interpolation ──────────────────────────────────────────────────
// Now sourced verbatim from @mapng/geo.

// ─── Terrarium Sampler ───────────────────────────────────────────────────────
const sampleTerrarium = (pixels, imgW, imgH, zoom, minTileX, minTileY, lat, lng, noDataVal) => {
    const p = project(lat, lng, zoom);
    const localX = p.x - minTileX * TILE_SIZE;
    const localY = p.y - minTileY * TILE_SIZE;

    const x0 = Math.floor(localX);
    const y0 = Math.floor(localY);
    const dx = localX - x0;
    const dy = localY - y0;

    const getH = (x, y) => {
        const cx = Math.max(0, Math.min(imgW - 1, x));
        const cy = Math.max(0, Math.min(imgH - 1, y));
        const i = (cy * imgW + cx) * 4;
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const h = r * 256 + g + b / 256 - 32768;
        return h <= -32760 ? noDataVal : h;
    };

    const h00 = getH(x0, y0);
    const h10 = getH(x0 + 1, y0);
    const h01 = getH(x0, y0 + 1);
    const h11 = getH(x0 + 1, y0 + 1);

    if (h00 === noDataVal || h10 === noDataVal || h01 === noDataVal || h11 === noDataVal) return noDataVal;

    const top = (1 - dx) * h00 + dx * h10;
    const bottom = (1 - dx) * h01 + dx * h11;
    return (1 - dy) * top + dy * bottom;
};

// ─── Satellite Pixel Sampler ─────────────────────────────────────────────────
export const writeSampledImagePixel = (out, outIndex, pixels, imgW, imgH, zoom, minTileX, minTileY, lat, lng) => {
    const p = project(lat, lng, zoom);
    const localX = p.x - minTileX * TILE_SIZE;
    const localY = p.y - minTileY * TILE_SIZE;

    const x = Math.floor(localX);
    const y = Math.floor(localY);

    if (x < 0 || x >= imgW || y < 0 || y >= imgH) {
        out[outIndex] = 0;
        out[outIndex + 1] = 0;
        out[outIndex + 2] = 0;
        out[outIndex + 3] = 255;
        return;
    }

    const i = (y * imgW + x) * 4;
    out[outIndex] = pixels[i];
    out[outIndex + 1] = pixels[i + 1];
    out[outIndex + 2] = pixels[i + 2];
    out[outIndex + 3] = pixels[i + 3];
};

/**
 * Group GeoTIFF tiles by CRS, look up (or fetch) proj4 definitions for each
 * group, and build a converter from WGS84 lon/lat to the tile's projected
 * coordinate space. Returns an array of group objects ready for sampleHeightAt().
 *
 * Tiles that share a CRS are batched together so the expensive proj4 conversion
 * is only performed once per output pixel regardless of how many source tiles
 * cover that area.
 */
export const buildPreparedTileGroups = async (tiles, epsgDefs, noDataValue) => {
    if (epsgDefs) {
        for (const [code, def] of Object.entries(epsgDefs)) {
            if (def && !proj4.defs(code)) proj4.defs(code, def);
        }
    }

    const groups = new Map();

    if (!tiles || tiles.length === 0) return [];

    for (const tile of tiles) {
        const epsgKey = tile.epsgCode ? `EPSG:${tile.epsgCode}` : 'EPSG:4326';
        let group = groups.get(epsgKey);

        if (!group) {
            let converter = null;
            const identity = !tile.epsgCode || tile.epsgCode === 4326;
            if (!identity) {
                try {
                    if (!proj4.defs(epsgKey)) {
                        const builtIn = getBuiltInProj4(tile.epsgCode);
                        if (builtIn) {
                            proj4.defs(epsgKey, builtIn);
                        } else {
                            const response = await fetch(`https://epsg.io/${tile.epsgCode}.proj4`);
                            if (response.ok) {
                                const def = await response.text();
                                proj4.defs(epsgKey, def);
                            }
                        }
                    }
                    converter = proj4('EPSG:4326', epsgKey);
                } catch (e) {
                    if (tile.epsgCode === 4326) {
                        converter = { forward: (p) => p };
                    } else {
                        continue;
                    }
                }
            }

            group = {
                identity,
                converter,
                tiles: [],
                lastTile: null,
            };
            groups.set(epsgKey, group);
        }

        group.tiles.push({
            raster: tile.raster,
            width: tile.width,
            height: tile.height,
            originX: tile.originX,
            originY: tile.originY,
            resX: tile.resX,
            resY: tile.resY,
            noData: Number.isFinite(tile.noData) ? tile.noData : noDataValue,
        });
    }

    return [...groups.values()];
};

const samplePreparedTile = (tile, projectedX, projectedY) => {
    const px = (projectedX - tile.originX) / tile.resX;
    const py = (projectedY - tile.originY) / tile.resY;
    if (px < 0 || px >= tile.width - 1 || py < 0 || py >= tile.height - 1) {
        return tile.noData;
    }
    return bilinear(tile.raster, tile.width, px, py, tile.noData);
};

/**
 * Sample elevation at a single WGS84 point from the prepared tile groups, with
 * Terrarium fallback for positions not covered by any high-res tile.
 *
 * Implements a simple "last-tile cache": after a successful lookup, the winning
 * tile is stored on its group so the next nearby pixel skips the linear scan.
 * This gives a large speedup on spatially coherent access patterns (raster scan).
 */
export const sampleHeightAt = (lng, lat, preparedGroups, fallback, noData) => {
    for (const group of preparedGroups) {
        let projectedX;
        let projectedY;
        if (group.identity) {
            projectedX = lng;
            projectedY = lat;
        } else {
            const projected = group.converter.forward([lng, lat]);
            projectedX = projected[0];
            projectedY = projected[1];
        }

        if (group.lastTile) {
            const cachedVal = samplePreparedTile(group.lastTile, projectedX, projectedY);
            if (cachedVal !== group.lastTile.noData) return cachedVal;
        }

        for (const tile of group.tiles) {
            if (tile === group.lastTile) continue;
            const value = samplePreparedTile(tile, projectedX, projectedY);
            if (value !== tile.noData) {
                group.lastTile = tile;
                return value;
            }
        }
    }

    if (fallback) {
        return sampleTerrarium(
            fallback.pixels,
            fallback.width,
            fallback.height,
            fallback.zoom,
            fallback.minTileX,
            fallback.minTileY,
            lat,
            lng,
            noData,
        );
    }

    return noData;
};
