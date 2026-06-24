/** @layer core */
/**
 * schedulerConfig.js — Pure export-flag normalization, legacy status mapping,
 * and scheduler-config derivation for batch jobs. No DOM, no network.
 */

import { JOB_STATES, TILE_STATES } from './batchRuntime.js';

export const toStrictBool = (value) => value === true;

const flattenNestedExportFlags = (raw, keys) => {
  const flattened = {};
  let current = raw;
  let depth = 0;
  while (current && typeof current === 'object' && depth < 20) {
    for (const key of keys) {
      if (flattened[key] === undefined && (current[key] === true || current[key] === false)) {
        flattened[key] = current[key];
      }
    }
    if (!current.value || typeof current.value !== 'object') break;
    current = current.value;
    depth += 1;
  }
  return flattened;
};

export const normalizeExportFlags = (raw = {}) => {
  const defaults = {
    heightmap: false,
    satellite: false,
    osmTexture: false,
    hybridTexture: false,
    roadMask: false,
    glb: false,
    dae: false,
    ter: false,
    geotiff: false,
    geojson: false,
  };

  const flattened = flattenNestedExportFlags(raw || {}, Object.keys(defaults));
  const merged = { ...defaults, ...flattened };
  const normalized = {};
  for (const key of Object.keys(defaults)) {
    normalized[key] = toStrictBool(merged[key]);
  }
  return normalized;
};

export const mapLegacyJobStatus = (status) => {
  if (status === 'idle') return JOB_STATES.PENDING;
  if (status === 'running') return JOB_STATES.RUNNING;
  if (status === 'paused') return JOB_STATES.PAUSED;
  if (status === 'completed' || status === 'completed_with_errors') return JOB_STATES.COMPLETED;
  return status;
};

export const mapLegacyTileStatus = (status) => {
  if (status === 'pending') return TILE_STATES.QUEUED;
  if (status === 'processing') return TILE_STATES.PROCESSING;
  if (status === 'completed') return TILE_STATES.DONE;
  return status;
};

export function deriveSchedulerConfig(input) {
  const resolution = Number(input?.resolution || 1024);
  const exports = normalizeExportFlags(input?.exports || {});
  const includeOSM = toStrictBool(input?.includeOSM);
  const requestedProfile = String(input?.performanceProfile || '').trim();

  const heavy3D = !!(exports.glb || exports.dae);
  const heavyVectorTextures = includeOSM && !!(exports.osmTexture || exports.hybridTexture);
  const heavySegmentation = false;
  const highRes = resolution >= 8192;
  const veryHighRes = resolution >= 4096;

  let profile = 'balanced';
  let globalTileConcurrency = 20;
  let fetchConcurrency = 4;
  let computeConcurrency = 1;
  let encodeConcurrency = 1;
  let overpassMinIntervalMs = 600;

  if (requestedProfile === 'throughput') {
    profile = 'throughput';
    globalTileConcurrency = resolution >= 8192 ? 12 : 20;
    fetchConcurrency = resolution >= 8192 ? 3 : 4;
    computeConcurrency = 1;
    encodeConcurrency = 1;
    overpassMinIntervalMs = 550;
    return {
      profile,
      fetchConcurrency,
      computeConcurrency,
      encodeConcurrency,
      globalTileConcurrency,
      overpassMinIntervalMs,
    };
  }

  if (requestedProfile === 'low_memory') {
    profile = 'low_memory';
    globalTileConcurrency = resolution >= 8192 ? 6 : 8;
    fetchConcurrency = resolution >= 4096 ? 1 : 2;
    computeConcurrency = 1;
    encodeConcurrency = 1;
    overpassMinIntervalMs = 900;
    return {
      profile,
      fetchConcurrency,
      computeConcurrency,
      encodeConcurrency,
      globalTileConcurrency,
      overpassMinIntervalMs,
    };
  }

  if (highRes) {
    profile = 'highres_8192';
    globalTileConcurrency = (heavy3D || heavySegmentation || heavyVectorTextures) ? 8 : 10;
    fetchConcurrency = 2;
    computeConcurrency = 1;
    encodeConcurrency = 1;
    overpassMinIntervalMs = 750;
  } else if (veryHighRes) {
    profile = 'highres_4096';
    globalTileConcurrency = 12;
    fetchConcurrency = 3;
    computeConcurrency = 1;
    encodeConcurrency = 1;
    overpassMinIntervalMs = 650;
  }

  return {
    profile,
    fetchConcurrency,
    computeConcurrency,
    encodeConcurrency,
    globalTileConcurrency,
    overpassMinIntervalMs,
  };
}
