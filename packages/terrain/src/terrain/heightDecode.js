/** @layer core */
// Elevation unit handling + GeoTIFF buffer re-parsing. Pure compute: turns raw
// elevation samples into metres and decodes cached GeoTIFF bytes back into the
// { image, raster, arrayBuffer } shape the live fetch paths produce.
import * as GeoTIFF from "geotiff";

export const FEET_TO_METERS = 0.3048;
export const US_SURVEY_FEET_TO_METERS = 1200 / 3937;

export const NO_DATA_VALUE = -99999;

/**
 * Determine the scale factor needed to convert raw elevation values to metres.
 * An explicit override (e.g. from the BYOD UI) takes precedence over any unit
 * detected in the file's metadata. Falls back to 1.0 (metres assumed) when
 * neither source yields a usable unit.
 *
 * @param {object} meta     - Parsed file metadata (tifLoader / lazLoader result)
 * @param {string} override - 'auto' | 'meters' | 'feet' | 'us_survey_feet'
 * @returns {{ scale: number, source: 'override'|'metadata'|'default' }}
 */
export const resolveElevationUnitScale = (meta, override = 'auto') => {
  const selected = (override || 'auto').toLowerCase();
  if (selected === 'meters') return { scale: 1, source: 'override' };
  if (selected === 'feet') return { scale: FEET_TO_METERS, source: 'override' };
  if (selected === 'us_survey_feet') return { scale: US_SURVEY_FEET_TO_METERS, source: 'override' };

  const detected = String(meta?.verticalUnitDetected || 'unknown').toLowerCase();
  if (detected === 'meters') return { scale: 1, source: 'metadata' };
  if (detected === 'feet') return { scale: FEET_TO_METERS, source: 'metadata' };
  if (detected === 'us_survey_feet') return { scale: US_SURVEY_FEET_TO_METERS, source: 'metadata' };
  return { scale: 1, source: 'default' };
};

/**
 * Scale every valid elevation sample in a Float32Array from its source unit to
 * metres. Modifies the array in-place. NO_DATA_VALUE (-99999) and non-finite
 * values are left untouched so they propagate correctly through hole-filling.
 *
 * @param {Float32Array} heightMap
 * @param {number} scale - multiply factor from resolveElevationUnitScale()
 */
export const convertHeightMapToMeters = (heightMap, scale) => {
  if (!heightMap || !Number.isFinite(scale) || Math.abs(scale - 1) < 1e-9) return;
  for (let i = 0; i < heightMap.length; i++) {
    const v = heightMap[i];
    if (Number.isFinite(v) && v !== NO_DATA_VALUE) {
      heightMap[i] = v * scale;
    }
  }
};

/**
 * Re-parse cached GeoTIFF ArrayBuffers back into the { image, raster, arrayBuffer }
 * shape the live GPXZ/USGS fetch paths produce — so a cache hit skips the network
 * entirely while downstream code stays identical to a fresh fetch.
 */
export const parseGeoTiffBuffers = async (buffers) => {
  const out = [];
  for (const arrayBuffer of buffers) {
    const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
    const image = await tiff.getImage();
    const rasters = await image.readRasters();
    const raster = rasters[0];
    await tiff.close();
    out.push({ image, raster, arrayBuffer });
  }
  return out;
};
