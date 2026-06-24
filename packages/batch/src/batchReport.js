/** @layer core */
/**
 * batchReport.js — Pure text/metadata builders for batch jobs: the elevation
 * report text and per-tile trace metadata. No DOM, no network — headless-testable.
 */

import { getTileLabel, getDefaultTileLabel } from './grid.js';
import { TILE_STATES } from './batchRuntime.js';
import { buildCommonTraceMetadata, getBuildTrace } from './traceability.js';

const formatReportNumber = (value, digits = 3) => {
  if (!Number.isFinite(value)) return 'n/a';
  return Number(value).toFixed(digits);
};

const formatReportCoordinate = (value) => formatReportNumber(value, 6);

export function buildBatchElevationReportText(state) {
  const tiles = Array.isArray(state?.tiles) ? state.tiles : [];
  const completedTiles = tiles.filter((tile) => tile.status === TILE_STATES.DONE);
  const tilesWithStats = completedTiles.filter((tile) => tile.elevationStats);
  const failedTiles = tiles.filter((tile) => tile.status === TILE_STATES.FAILED);

  const sharedMin = Number.isFinite(state?.elevationNormalization?.globalMinHeight)
    ? state.elevationNormalization.globalMinHeight
    : null;
  const sharedMax = Number.isFinite(state?.elevationNormalization?.globalMaxHeight)
    ? state.elevationNormalization.globalMaxHeight
    : null;
  const sharedRange = Number.isFinite(sharedMin) && Number.isFinite(sharedMax)
    ? sharedMax - sharedMin
    : null;

  const aggregate = tilesWithStats.reduce((acc, tile) => {
    const stats = tile.elevationStats;
    if (!stats) return acc;

    if (!acc.lowestLocalMin || stats.localMinHeight < acc.lowestLocalMin.value) {
      acc.lowestLocalMin = { value: stats.localMinHeight, tile };
    }
    if (!acc.highestLocalMax || stats.localMaxHeight > acc.highestLocalMax.value) {
      acc.highestLocalMax = { value: stats.localMaxHeight, tile };
    }
    if (!acc.narrowestRange || stats.localRange < acc.narrowestRange.value) {
      acc.narrowestRange = { value: stats.localRange, tile };
    }
    if (!acc.widestRange || stats.localRange > acc.widestRange.value) {
      acc.widestRange = { value: stats.localRange, tile };
    }
    return acc;
  }, {
    lowestLocalMin: null,
    highestLocalMax: null,
    narrowestRange: null,
    widestRange: null,
  });

  const lines = [
    'MapNG Batch Elevation Report',
    '===========================',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Job ID: ${state?.id || 'n/a'}`,
    `Status: ${state?.status || 'n/a'}`,
    `Elevation source: ${state?.elevationSource || 'n/a'}`,
    `Grid: ${Number(state?.gridCols || 0)} cols x ${Number(state?.gridRows || 0)} rows`,
    `Total tiles: ${tiles.length}`,
    `Completed tiles: ${completedTiles.length}`,
    `Failed tiles: ${failedTiles.length}`,
    `Resolution per tile: ${Number(state?.resolution || 0)} px`,
    `Job center: lat ${formatReportCoordinate(state?.center?.lat)}, lng ${formatReportCoordinate(state?.center?.lng)}`,
    `Shared elevation baseline: ${state?.elevationNormalization?.enabled ? 'enabled' : 'disabled'}`,
    `Shared baseline min height: ${formatReportNumber(sharedMin)}`,
    `Shared baseline max height: ${formatReportNumber(sharedMax)}`,
    `Shared baseline height difference: ${formatReportNumber(sharedRange)}`,
    '',
    'Aggregate Local Tile Stats',
    '--------------------------',
    `Tiles with captured stats: ${tilesWithStats.length}/${tiles.length}`,
    `Lowest local min: ${aggregate.lowestLocalMin ? `${formatReportNumber(aggregate.lowestLocalMin.value)} (${getTileLabel(aggregate.lowestLocalMin.tile, state.gridCols)})` : 'n/a'}`,
    `Highest local max: ${aggregate.highestLocalMax ? `${formatReportNumber(aggregate.highestLocalMax.value)} (${getTileLabel(aggregate.highestLocalMax.tile, state.gridCols)})` : 'n/a'}`,
    `Narrowest local height difference: ${aggregate.narrowestRange ? `${formatReportNumber(aggregate.narrowestRange.value)} (${getTileLabel(aggregate.narrowestRange.tile, state.gridCols)})` : 'n/a'}`,
    `Widest local height difference: ${aggregate.widestRange ? `${formatReportNumber(aggregate.widestRange.value)} (${getTileLabel(aggregate.widestRange.tile, state.gridCols)})` : 'n/a'}`,
    '',
    'Per-Tile Calculations',
    '---------------------',
  ];

  if (!tilesWithStats.length) {
    lines.push('No completed tile elevation stats were captured.');
  } else {
    for (const tile of tilesWithStats) {
      const stats = tile.elevationStats;
      const label = getTileLabel(tile, state.gridCols);
      lines.push(
        `${label} | center=(${formatReportCoordinate(tile.center?.lat)}, ${formatReportCoordinate(tile.center?.lng)}) | offset_m=(${formatReportNumber(tile.offsetX || 0)}, ${formatReportNumber(tile.offsetY || 0)})`,
      );
      lines.push(
        `  local_min=${formatReportNumber(stats.localMinHeight)} | local_max=${formatReportNumber(stats.localMaxHeight)} | local_height_difference=${formatReportNumber(stats.localRange)}`,
      );
      lines.push(
        `  encoded_min=${formatReportNumber(stats.encodedMinHeight)} | encoded_max=${formatReportNumber(stats.encodedMaxHeight)} | encoded_height_difference=${formatReportNumber(stats.encodedRange)}`,
      );
      lines.push(
        `  min_delta_vs_encoded=${formatReportNumber(stats.deltaMinToEncoded)} | max_delta_vs_encoded=${formatReportNumber(stats.deltaMaxToEncoded)} | extra_encoded_range=${formatReportNumber(stats.extraEncodedRange)}`,
      );
      lines.push('');
    }
  }

  if (failedTiles.length) {
    lines.push('Failed Tiles');
    lines.push('------------');
    for (const tile of failedTiles) {
      const label = getTileLabel(tile, state.gridCols);
      lines.push(`${label} | ${tile.lastError?.message || 'Unknown error'}`);
    }
    lines.push('');
  }

  lines.push('Definitions');
  lines.push('-----------');
  lines.push('Tile label = custom name when provided, otherwise the default row/column ID (R#C#).');
  lines.push('center = center coordinates of the current tile in latitude and longitude.');
  lines.push('offset_m = how far the tile was moved from its default grid position, in meters. X is east/west and Y is north/south. This is mostly diagnostic metadata.');
  lines.push('local_min = lowest elevation found inside this tile, in meters above sea level.');
  lines.push('local_max = highest elevation found inside this tile, in meters above sea level.');
  lines.push('local_height_difference = the tile\'s actual local elevation range. Formula: local_max - local_min.');
  lines.push('encoded_min = minimum elevation value used when encoding this tile\'s heightmap. With shared baseline enabled, this is the batch-wide minimum.');
  lines.push('encoded_max = maximum elevation value used when encoding this tile\'s heightmap. With shared baseline enabled, this is the batch-wide maximum.');
  lines.push('encoded_height_difference = total elevation range used for encoding. Formula: encoded_max - encoded_min.');
  lines.push('min_delta_vs_encoded = how much higher the tile\'s real minimum is than the encoded minimum. Formula: local_min - encoded_min.');
  lines.push('max_delta_vs_encoded = how much lower the tile\'s real maximum is than the encoded maximum. Formula: encoded_max - local_max.');
  lines.push('extra_encoded_range = how much larger the encoded range is than the tile\'s actual local range. Formula: encoded_height_difference - local_height_difference.');
  lines.push('');

  return `${lines.join('\n').trimEnd()}\n`;
}

export function buildTileMetadata(state, tile, terrainData) {
  const runConfig = {
    schemaVersion: 1,
    mode: 'batch',
    center: { ...state.center },
    resolution: state.resolution,
    gridCols: state.gridCols,
    gridRows: state.gridRows,
    includeOSM: state.includeOSM,
    elevationSource: state.elevationSource,
    gpxzApiKey: state.gpxzApiKey || '',
    gpxzStatus: state.gpxzStatus || null,
    glbMeshResolution: state.glbMeshResolution,
    performanceProfile: state.performanceProfile || 'balanced',
    tileOffsets: Array.isArray(state.tileOffsets) ? state.tileOffsets.map((entry) => ({ ...entry })) : [],
    elevationNormalization: state.elevationNormalization ? {
      enabled: !!state.elevationNormalization.enabled,
      scope: state.elevationNormalization.scope || 'global_batch',
      globalMinHeight: state.elevationNormalization.globalMinHeight,
      globalMaxHeight: state.elevationNormalization.globalMaxHeight,
    } : { enabled: false, scope: 'global_batch' },
    exports: { ...state.exports },
    scheduler: { ...(state.scheduler || {}) },
  };

  return buildCommonTraceMetadata({
    mode: 'batch',
    center: tile.center,
    zoom: null,
    resolution: state.resolution,
    terrainData,
    textureModes: {
      satellite: !!terrainData.satelliteTextureUrl,
      osm: !!terrainData.osmTextureUrl,
      hybrid: !!terrainData.hybridTextureUrl,
      roadMask: !!terrainData.osmFeatures?.length,
    },
    osmQuery: terrainData.osmRequestInfo || null,
    gpxz: state.gpxzStatus || null,
    extra: {
      batchId: state.id,
      tile: {
        id: tile.id,
        row: tile.row,
        col: tile.col,
        label: getTileLabel(tile, state.gridCols),
        defaultLabel: getDefaultTileLabel(tile, state.gridCols),
        customName: tile.customName || '',
        center: tile.center,
      },
      build: getBuildTrace(),
      runConfiguration: runConfig,
      stageTimings: tile.stageTimings,
      scheduler: { ...(state.scheduler || {}) },
      terrain: {
        bounds: terrainData.bounds,
        minHeight: terrainData.minHeight,
        maxHeight: terrainData.maxHeight,
        width: terrainData.width,
        height: terrainData.height,
      },
    },
  });
}
