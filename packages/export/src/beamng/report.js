/** @layer core */
// Export diagnostics: OSM/terrain-sample summaries, elevation-source labelling,
// and the plaintext report bundled into the level zip. Extracted verbatim from
// exportBeamNGLevel.js (06 step 9).
import { isClosedRing } from './worldMath.js';
import {
  formatIsoTimestamp,
  formatDurationMs,
  formatNumber,
  metersToKm2,
  formatBool,
} from './format.js';

/**
 * Summarize OSM feature counts by feature type and basic geometry shape.
 */
export function summarizeOsmFeatures(features = []) {
  const summary = {
    total: 0,
    roads: 0,
    buildings: 0,
    water: 0,
    vegetation: 0,
    landuse: 0,
    points: 0,
    lines: 0,
    polygons: 0,
  };

  for (const feature of features) {
    summary.total += 1;
    if (feature?.type === 'road') summary.roads += 1;
    if (feature?.type === 'building') summary.buildings += 1;
    if (feature?.type === 'water') summary.water += 1;
    if (feature?.type === 'vegetation') summary.vegetation += 1;
    if (feature?.type === 'landuse') summary.landuse += 1;

    const pointCount = Array.isArray(feature?.geometry) ? feature.geometry.length : 0;
    if (pointCount <= 1) summary.points += 1;
    else if (isClosedRing(feature.geometry)) summary.polygons += 1;
    else summary.lines += 1;
  }

  return summary;
}

/**
 * Build a human-readable elevation source label for export reports.
 */
export function resolveElevationSourceLabel(terrainData, selectedElevationSource) {
  const explicit = typeof selectedElevationSource === 'string' ? selectedElevationSource.trim() : '';
  const normalized = explicit.toLowerCase();
  const sourceGeoTiffsSource = terrainData?.sourceGeoTiffs?.source;

  if (normalized === 'usgs') {
    return terrainData?.usgsFallback ? 'USGS requested, fell back to default/WGS84 source' : 'USGS';
  }
  if (normalized === 'gpxz') return 'GPXZ';
  if (normalized === 'kron86') {
    return terrainData?.kron86Fallback ? 'NMT EVRF2007 requested, fell back to default/WGS84 source' : 'NMT EVRF2007 (Poland)';
  }
  if (normalized === 'default') {
    return sourceGeoTiffsSource ? `Default (${String(sourceGeoTiffsSource).toUpperCase()})` : 'Default/WGS84';
  }
  if (explicit) return explicit;
  if (sourceGeoTiffsSource) return String(sourceGeoTiffsSource).toUpperCase();
  return 'Default/WGS84';
}

/**
 * Count valid vs no-data elevation samples from terrainData.heightMap.
 */
export function summarizeTerrainSamples(terrainData) {
  const heightMap = terrainData?.heightMap;
  if (!heightMap || typeof heightMap.length !== 'number') {
    return {
      total: 0,
      valid: 0,
      noData: 0,
      noDataRatio: NaN,
      allInvalid: false,
    };
  }

  let valid = 0;
  let noData = 0;
  for (let i = 0; i < heightMap.length; i++) {
    const h = heightMap[i];
    if (Number.isFinite(h) && h > -10000) valid += 1;
    else noData += 1;
  }

  const total = valid + noData;
  const noDataRatio = total > 0 ? noData / total : NaN;
  return {
    total,
    valid,
    noData,
    noDataRatio,
    allInvalid: total > 0 && valid === 0,
  };
}

/**
 * Build the plaintext export diagnostics report bundled in the level zip.
 */
export function buildBeamNGExportReport({
  terrainData,
  originalTerrainData,
  center,
  options,
  levelName,
  levelDisplayName,
  flavor,
  squareSize,
  satelliteTexSize,
  worldSize,
  exportStartedAt,
  reportGeneratedAt,
  processingLog,
  effectivePbrSource,
  waterObjects,
  barrierObjects,
  barrierMeshSplineGroups,
  roadArchitectRoadCount,
  roadArchitectJunctionCount,
  forestPlacements,
  forestFiles,
  groundCoverObjects,
  osmDaeBlob,
  backdropDaeBlob,
  backdropTextureFiles,
  backdropDiagnostics,
  mapngFlagFiles,
  didCropToSquare,
}) {
  const minHeight = Number(terrainData?.minHeight);
  const maxHeight = Number(terrainData?.maxHeight);
  const heightDiff = maxHeight - minHeight;
  const totalAreaM2 = worldSize * worldSize;
  const bounds = terrainData?.bounds ?? {};
  const selectedResolution = Number(options?.requestedResolution);
  const terrainSampleSummary = summarizeTerrainSamples(terrainData);
  const osmSummary = summarizeOsmFeatures(terrainData?.osmFeatures);
  const originalOsmSummary = summarizeOsmFeatures(originalTerrainData?.osmFeatures);
  const forestPlacementCount = Array.from(forestPlacements.values()).reduce((sum, placements) => sum + placements.length, 0);
  const terrainMaterialCount = Array.isArray(options?.terrainMaterialNames) ? options.terrainMaterialNames.length : 0;
  const startedMs = exportStartedAt instanceof Date ? exportStartedAt.getTime() : NaN;
  const reportGeneratedMs = reportGeneratedAt instanceof Date ? reportGeneratedAt.getTime() : NaN;
  const totalDurationMs = reportGeneratedMs - startedMs;
  const reportLines = [
    'MapNG BeamNG Level Export Report',
    '================================',
    '',
    'Summary',
    `- Level display name: ${levelDisplayName}`,
    `- Level folder name: ${levelName}`,
    `- Flavor: ${flavor?.label || flavor?.name || flavor?.id || 'n/a'}`,
    `- Export started (UTC): ${formatIsoTimestamp(exportStartedAt)}`,
    `- Report generated (UTC): ${formatIsoTimestamp(reportGeneratedAt)}`,
    `- Processing time before ZIP compression: ${formatDurationMs(totalDurationMs)}`,
    '',
    'Terrain',
    `- Requested resolution: ${Number.isFinite(selectedResolution) ? `${selectedResolution} px` : 'n/a'}`,
    `- Exported terrain size: ${terrainData?.width ?? 'n/a'} x ${terrainData?.height ?? 'n/a'} px`,
    `- Terrain texture size: ${satelliteTexSize} x ${satelliteTexSize} px`,
    `- Height range min/max: ${formatNumber(minHeight, 2)} m / ${formatNumber(maxHeight, 2)} m`,
    `- Height difference: ${formatNumber(heightDiff, 2)} m`,
    `- Scale: ${formatNumber(squareSize, 3)} m/px`,
    `- World size: ${formatNumber(worldSize, 2)} m x ${formatNumber(worldSize, 2)} m`,
    `- Total area: ${formatNumber(totalAreaM2, 2)} m^2 (${metersToKm2(totalAreaM2)} km^2)`,
    `- Center coordinates: ${formatNumber(center?.lat, 6)}, ${formatNumber(center?.lng, 6)}`,
    `- Bounds north/south/east/west: ${formatNumber(bounds.north, 6)}, ${formatNumber(bounds.south, 6)}, ${formatNumber(bounds.east, 6)}, ${formatNumber(bounds.west, 6)}`,
    `- Elevation source used: ${resolveElevationSourceLabel(originalTerrainData, options?.elevationSource)}`,
    `- Source GeoTIFF source: ${originalTerrainData?.sourceGeoTiffs?.source ? String(originalTerrainData.sourceGeoTiffs.source).toUpperCase() : 'n/a'}`,
    `- Cropped to square for BeamNG: ${formatBool(didCropToSquare)}`,
    `- Terrain samples (valid/no-data/total): ${terrainSampleSummary.valid}/${terrainSampleSummary.noData}/${terrainSampleSummary.total}`,
    `- Terrain no-data ratio: ${Number.isFinite(terrainSampleSummary.noDataRatio) ? `${formatNumber(terrainSampleSummary.noDataRatio * 100, 2)}%` : 'n/a'}`,
    `- Terrain sample warning: ${terrainSampleSummary.allInvalid ? 'ALL_ELEVATION_SAMPLES_INVALID (export likely unreliable)' : 'none'}`,
    '',
    'Selected Export Options',
    `- Base texture: ${options?.baseTexture ?? 'n/a'}`,
    `- Include buildings: ${formatBool(options?.includeBuildings)}`,
    `- Apply foundations: ${formatBool(options?.applyFoundations)}`,
    `- Include backdrop: ${formatBool(options?.includeBackdrop)}`,
    `- PBR materials: ${effectivePbrSource === 'none' ? 'No' : 'Yes'}`,
    `- PBR source requested: ${options?.requestedPbrSource ?? 'n/a'}`,
    `- PBR source used: ${effectivePbrSource}`,
    `- Include water: ${formatBool(options?.includeWater)}`,
    `- Include native barriers: ${formatBool(options?.includeNativeBarriers)}`,
    `- Include trees/bushes: ${formatBool(options?.includeTrees)}`,
    `- Include rocks: ${formatBool(options?.includeRocks)}`,
    '',
    'Generated Content',
    `- Terrain materials written: ${terrainMaterialCount}`,
    `- Road Architect roads generated: ${roadArchitectRoadCount}`,
    `- Road Architect junctions generated: ${roadArchitectJunctionCount}`,
    `- Barrier folders: ${barrierMeshSplineGroups.length}`,
    `- Barrier TSStatic objects: ${barrierObjects.length}`,
    `- Water objects generated: ${waterObjects.length}`,
    `- Forest placement groups: ${forestPlacements.size}`,
    `- Forest placement files: ${forestFiles.length}`,
    `- Forest placements total: ${forestPlacementCount}`,
    `- Ground cover objects: ${groundCoverObjects.length}`,
    `- OSM DAE written: ${formatBool(!!osmDaeBlob)}`,
    `- Backdrop DAE written: ${formatBool(!!backdropDaeBlob)}`,
    `- Backdrop textures written: ${backdropTextureFiles.length}`,
    `- MapNG flag asset written: ${formatBool(mapngFlagFiles.length > 0)}`,
  ];

  if (backdropDiagnostics) {
    reportLines.push('');
    reportLines.push('Surrounding Backdrop Diagnostics');
    reportLines.push(`- Requested surrounding tiles: ${backdropDiagnostics.requestedTiles ?? 'n/a'}`);
    reportLines.push(`- Built surrounding tiles: ${backdropDiagnostics.builtTiles ?? 'n/a'}`);
    reportLines.push(`- Direct elevation tiles: ${backdropDiagnostics.directTiles ?? 'n/a'}`);
    reportLines.push(`- Flat-fallback tiles: ${backdropDiagnostics.flatFallbackTiles ?? 'n/a'}`);
    reportLines.push(`- Skipped tiles: ${backdropDiagnostics.skippedTiles ?? 'n/a'}`);
    reportLines.push(`- Flat-fallback threshold (no-data ratio): ${Number.isFinite(backdropDiagnostics.maxNoDataRatio) ? `${formatNumber(backdropDiagnostics.maxNoDataRatio * 100, 2)}%` : 'n/a'}`);

    const perTile = backdropDiagnostics.tiles && typeof backdropDiagnostics.tiles === 'object'
      ? Object.entries(backdropDiagnostics.tiles)
      : [];
    for (const [tileKey, tileDiag] of perTile) {
      const ratioPct = Number.isFinite(tileDiag?.noDataRatio)
        ? `${formatNumber(tileDiag.noDataRatio * 100, 2)}%`
        : 'n/a';
      reportLines.push(
        `- Tile ${tileKey}: mode=${tileDiag?.mode ?? 'unknown'}, valid=${tileDiag?.validSamples ?? 'n/a'}, no-data=${tileDiag?.noDataSamples ?? 'n/a'}, total=${tileDiag?.totalSamples ?? 'n/a'}, no-data ratio=${ratioPct}`
      );
    }
  }

  reportLines.push('');
  reportLines.push('OSM Analysis');
  reportLines.push(`- Source OSM features before bounds filter: ${originalOsmSummary.total}`);
  reportLines.push(`- OSM features after export filter: ${osmSummary.total}`);
  reportLines.push(`- Roads: ${osmSummary.roads}`);
  reportLines.push(`- Buildings: ${osmSummary.buildings}`);
  reportLines.push(`- Water features: ${osmSummary.water}`);
  reportLines.push(`- Vegetation points/features: ${osmSummary.vegetation}`);
  reportLines.push(`- Landuse features: ${osmSummary.landuse}`);
  reportLines.push(`- Point/line/polygon split: ${osmSummary.points}/${osmSummary.lines}/${osmSummary.polygons}`);
  reportLines.push('');
  reportLines.push('Processing Timeline');

  for (const entry of processingLog) {
    reportLines.push(`- ${entry.step}: ${formatDurationMs(entry.durationMs)} (${entry.pct}%)`);
  }

  if (originalTerrainData?.osmRequestInfo) {
    reportLines.push('');
    reportLines.push('OSM Request Metadata');
    for (const [key, value] of Object.entries(originalTerrainData.osmRequestInfo)) {
      reportLines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
    }
  }

  return reportLines.join('\n') + '\n';
}
