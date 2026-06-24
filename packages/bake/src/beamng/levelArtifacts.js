/** @layer flow */
// Compute phase of the BeamNG level export: crop/foundations → sizes/spawn →
// roads (architect/mesh/decal) + junctions → terrain materials, .ter, textures,
// heightmap, preview → OSM/Google DAEs → water → barriers → forest → backdrop →
// flag → the diagnostics report. Returns the explicit ctx the pure-core archive
// serializer (beamng/levelArchive.js) consumes. This is the io/renderer-bound
// half (THREE, canvas, fetch, the WebGLRenderer via google3dTiles) so it can't
// run headless — the orchestrator verifies the ctx field contract statically and
// a real in-app bake confirms it end-to-end. Extracted from exportBeamNGLevel.js
// (06 step 9c).
import { exportTer } from '../exportTer.js';
import { buildTerrainMaterials } from '../osmTerrainMaterials.js';
import { TILE_RENDER_BIAS_M } from '../google3dTiles.js';
import beamngGlbToDaeScript from '../../../../scripts/beamng_glb_to_dae.py?raw';
import { prepareCroppedTerrainData } from '../cropTerrain.js';
import { applyBuildingFoundations } from '../buildingFoundations.js';
import {
  buildJunctionPolygons,
  mergeJunctionClusters,
  validateJunctionPolygon,
} from '../junctionGeometry.js';
import { generateJunctionsDAE } from '../junctionMesh.js';
import { detectGapJunctions } from '../junctionRaster.js';
import {
  getBeamNGFlavorById,
  getGroundCoverProfile,
  getShapeMaterialDefsForFlavor,
} from '../beamngFlavorCatalog.js';
import {
  sanitizeLevelName,
  filterOSMFeaturesToBounds,
  computeSquareSize,
  findSpawnPosition,
  findHighestTerrainPoint,
} from './worldMath.js';
import { generateDecalRoads } from './decalRoads.js';
import { generateRoadArchitectSession } from './roadArchitectSession.js';
import { buildMeshRoadAnalysis, generateMeshRoads } from './meshRoads.js';
import {
  buildWaterBlockObjects,
  buildSeaLevelWaterPlane,
  buildRiverObjects,
} from './water.js';
import {
  buildNativeBarrierObjects,
  buildBarrierFolderItems,
} from './barriers.js';
import {
  buildForestPlacements,
  serializeForestFiles,
  buildGroundCoverObjects,
  cloneManagedItemData,
} from './forest.js';
import { getTerrainTextureBlob, resizePngBlob, generateHeightmapPng, generatePreviewBlob, generateRoadArchitectHeightmapPng, loadMapngFlagAsset } from './textures.js';
import { generateOSMObjectsDAE, generateTerrainBackdropDAE } from './meshAssets.js';
import { exportGoogleTilesForLevel } from './googleTilesAssets.js';
import { buildBeamNGExportReport } from './report.js';
import { buildRoadFolderGroups } from './levelZip.js';

const BEAMNG_EXPORT_SERVICE_LOG = '[BeamNG Export Service]';

/**
 * Compute every artifact for a BeamNG level export and return the ctx consumed
 * by writeLevelEntries (beamng/levelArchive.js). `progress` is the shared
 * tracker { report, beginStep, yield_, snapshot, exportStartedAt }.
 */
export async function buildLevelArtifacts(terrainData, center, options = {}, progress) {
  const { report, beginStep, yield_ } = progress;
  const {
    baseTexture = 'hybrid',
    includeBuildings = true,
    applyFoundations = true,
    includeBackdrop = false,
    includeWater = true,
    includeNativeBarriers = true,
    includeTrees = true,
    includeRocks = false,
    backdropElevationSource = 'global30m',
    backdropGpxzApiKey = '',
    roadType = 'architect',
    flavorId,
    levelName: requestedLevelName = '',
    useGoogle3DTiles = false,
    googleApiKey,
    google3DErrorTarget,
    // Route mode: instead of baking ONE AOI's Google tiles, the caller
    // (exportRouteAsBeamNGLevel) supplies N pre-assembled chunk tiles, each
    // already converted to a BeamNG shape with its own atlas + materials and a
    // world position. When present the internal single bake is skipped and the
    // level emits art/shapes/google_tiles_NN/ + one TSStatic per placement.
    // [{ name, daeBlob?|glbBlob, textureFiles:[{name,ext,data}], materialNames:[], position:[x,y,z] }]
    googleTilePlacements = null,
  } = options;
  const routeTilePieces = Array.isArray(googleTilePlacements) ? googleTilePlacements : null;
  // Backward compat: generatePbrMaterials (bool) → pbrSource (string)
  let pbrSource = options.pbrSource;
  if (pbrSource === undefined) {
    pbrSource = options.generatePbrMaterials === false ? 'none' : 'osm';
  }

  console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Start exportBeamNGLevel`);
  console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Input summary:`, {
    center,
    terrainWidth: terrainData?.width,
    terrainHeight: terrainData?.height,
    hasBounds: !!terrainData?.bounds,
    osmFeatureCount: Array.isArray(terrainData?.osmFeatures) ? terrainData.osmFeatures.length : null,
    options: {
      baseTexture,
      includeBuildings,
      applyFoundations,
      includeBackdrop,
      includeWater,
      includeNativeBarriers,
      includeTrees,
      includeRocks,
      backdropElevationSource,
      roadType,
      flavorId,
      levelName: requestedLevelName,
      pbrSource,
    },
  });

  // BeamNG TerrainBlock is square. If source data is rectangular, center-crop
  // everything (heightmap, bounds, textures) so terrain, texture, and OSM
  // objects share the same footprint.
  let td = terrainData;
  const didCropToSquare = td.width !== td.height;
  if (td.width !== td.height) {
    const cropSize = Math.min(td.width, td.height);
    td = await prepareCroppedTerrainData({ ...td, exportCropSize: cropSize });
  }

  const foundationInput = {
    ...td,
    osmFeatures: filterOSMFeaturesToBounds(td.osmFeatures, td.bounds),
  };

  let exportTerrainData = foundationInput;
  if (applyFoundations) {
    beginStep('Preparing building foundations…', 2);
    await yield_();
    exportTerrainData = await applyBuildingFoundations(
      foundationInput,
      {
        yieldFn: yield_,
        onProgress: ({ completed, total, applied, skipped }) => {
          if (!total) return;
          const pct = 2 + Math.round((completed / total) * 2);
          const counts = Number.isFinite(applied) && Number.isFinite(skipped)
            ? ` | Applied: ${applied}, Skipped: ${skipped}`
            : '';
          report(`Foundations ${completed}/${total}${counts}`, Math.min(4, pct));
        },
      }
    );
  } else {
    beginStep('Skipping building foundations (disabled)…', 4);
    await yield_();
  }

  const lat = center.lat.toFixed(4);
  const lng = center.lng.toFixed(4);
  const fallbackLevelName = `mapng_${lat}_${lng}`.replace(/-/g, '_').replace(/\./g, '_');
  const levelDisplayName = String(requestedLevelName || '').trim() || fallbackLevelName;
  const levelName = sanitizeLevelName(levelDisplayName) || sanitizeLevelName(fallbackLevelName) || 'mapng_level';
  const flavor = getBeamNGFlavorById(flavorId);
  if (!flavor) {
    console.error(`${BEAMNG_EXPORT_SERVICE_LOG} Invalid or missing flavorId.`, { flavorId });
    throw new Error(`Missing or invalid BeamNG flavor: ${flavorId || '(none)'}`);
  }

  const size = exportTerrainData.width;
  const osmFeatureCount = Array.isArray(exportTerrainData.osmFeatures) ? exportTerrainData.osmFeatures.length : 0;
  const squareSize = computeSquareSize(exportTerrainData);
  const halfExtent = (size / 2) * squareSize;
  const worldSize = size * squareSize;
  const terrainHeightRange = exportTerrainData.maxHeight - exportTerrainData.minHeight;
  // BeamNG TerrainBlock behaves poorly with maxHeight <= 0 (collision/road projection artifacts).
  const maxHeight = Math.max(1, Math.ceil(terrainHeightRange));

  const { position: spawnPosition, rotationMatrix: spawnRotationMatrix } =
    findSpawnPosition(exportTerrainData, center, squareSize);

  const roadArchitectSession = roadType === 'architect'
    ? generateRoadArchitectSession(exportTerrainData, squareSize, levelName)
    : null;
  const roadArchitectRoadCount = Array.isArray(roadArchitectSession?.data?.roads)
    ? roadArchitectSession.data.roads.length
    : 0;
  const roadArchitectJunctionCount = Array.isArray(roadArchitectSession?.data?.junctions)
    ? roadArchitectSession.data.junctions.length
    : 0;

  const meshRoadAnalysis = roadType === 'mesh'
    ? buildMeshRoadAnalysis(exportTerrainData, squareSize)
    : null;
  const { meshRoads, junctionEndpoints } = meshRoadAnalysis
    ? generateMeshRoads(exportTerrainData, squareSize, meshRoadAnalysis)
    : { meshRoads: [], junctionEndpoints: new Map() };
  const rawJunctions = buildJunctionPolygons(meshRoadAnalysis?.roadNetwork, junctionEndpoints);

  // Raster pass — diff a reference mask (OSM centerlines, round caps) against a
  // coverage mask (emitted MeshRoad polylines with BUTT caps + filled junction
  // polygons). Holes are real visible gaps; each hole becomes an extra junction
  // polygon directly (no shared-endpoint assumption, no pipeline re-run).
  const gapJunctions = meshRoadAnalysis
    ? detectGapJunctions(
        meshRoadAnalysis.segmentInfo,
        meshRoads,
        rawJunctions,
        { worldBounds: { minX: -halfExtent, minY: -halfExtent, maxX: halfExtent, maxY: halfExtent } },
      )
    : [];
  const mergedJunctions = mergeJunctionClusters([...rawJunctions, ...gapJunctions]);

  // Validation gate — drop any polygon that would produce a broken prism (and
  // therefore broken vehicle collision). Reason counts go to console so bad
  // polygons in real maps surface during export without blocking it.
  const rejectionCounts = Object.create(null);
  const meshRoadJunctions = [];
  for (const j of mergedJunctions) {
    const verdict = validateJunctionPolygon(j.polygon);
    if (verdict.ok) {
      meshRoadJunctions.push(j);
    } else {
      rejectionCounts[verdict.reason] = (rejectionCounts[verdict.reason] || 0) + 1;
    }
  }
  if (Object.keys(rejectionCounts).length > 0) {
    const breakdown = Object.entries(rejectionCounts).map(([r, c]) => `${r}=${c}`).join(' ');
    console.warn(`[junctions] dropped ${mergedJunctions.length - meshRoadJunctions.length} invalid polygons: ${breakdown}`);
  }

  const decalRoads = roadType === 'decal'
    ? generateDecalRoads(exportTerrainData, squareSize)
    : [];

  const roadArchitectHeightmapBlob = roadArchitectSession
    ? generateRoadArchitectHeightmapPng(exportTerrainData, maxHeight)
    : null;

  // ── Sequential pipeline — one heavy operation at a time ────────────────────
  // Running everything in parallel (Promise.all) keeps multiple large buffers
  // alive simultaneously. Sequencing lets each blob be GC-eligible before the
  // next one is allocated, which is critical for 4096+ terrain grids.

  await yield_();
  // BeamNG terrain material libraries must match the selected terrain resolution.
  // Source textures may be generated/cached at lower sizes (e.g. 8192), so we
  // always target the current export grid size here.
  const terrainBaseTexSize = size;

  // Legacy image-based inference is no longer generated and now falls back to OSM.
  const imageCanvas = null;
  const effectivePbrSource = (pbrSource === 'image' && !imageCanvas) ? 'osm' : pbrSource;

  beginStep(`Painting terrain materials (${effectivePbrSource.toUpperCase()})…`, 5);
  const pbrResult = effectivePbrSource !== 'none'
    ? await buildTerrainMaterials(exportTerrainData, worldSize, levelName, flavor, terrainBaseTexSize, {
        pbrSource: effectivePbrSource,
        imageCanvas,
      })
    : null;

  beginStep(`Exporting terrain binary (.ter, ${size}x${size})…`, 20);
  await yield_();
  const { blob: terBlob } = await exportTer(exportTerrainData, {
    layerMap: pbrResult?.layerMap ?? null,
    materialNames: pbrResult?.materialNames ?? null,
  });

  beginStep(`Generating base texture (${baseTexture}, ${terrainBaseTexSize}px)…`, 35);
  await yield_();
  let texBlob = await getTerrainTextureBlob(exportTerrainData, baseTexture);
  // terrain.png must be exactly baseTexSize pixels — TerrainBlock +
  // TerrainMaterialTextureSet expect a consistent base texture size.
  if (texBlob) {
    texBlob = await resizePngBlob(texBlob, terrainBaseTexSize);
  }

  beginStep(`Generating heightmap preview (${size}x${size})…`, 50);
  await yield_();
  const heightmapBlob = await generateHeightmapPng(exportTerrainData);

  beginStep('Generating level thumbnail image…', 58);
  await yield_();
  const previewBlob = await generatePreviewBlob(exportTerrainData);

  let osmDaeBlob = null;
  let googleTilesGlbBlob = null;
  let googleTilesDaeBlob = null;
  let googleTilesTextureFiles = [];
  let googleDebugCubeBlob = null;
  if (includeBuildings) {
    beginStep(`Building 3D OSM objects (${osmFeatureCount} features)…`, 65);
    await yield_();
    // With Google tiles active, the extruded OSM buildings stay in the DAE's
    // collision mesh but are dropped from the visuals — the photogrammetry
    // is the visible geometry, the boxes do the (cheap) colliding.
    osmDaeBlob = await generateOSMObjectsDAE(exportTerrainData, worldSize, {
      hideBuildingVisuals: !!(useGoogle3DTiles && googleApiKey),
    });

    if (useGoogle3DTiles && googleApiKey && !routeTilePieces) {
      // All Google-tiles export orchestration (sidecar / in-browser / Blender
      // bridge) lives in googleTilesAssets; a failed bake never aborts the level.
      const google = await exportGoogleTilesForLevel(
        exportTerrainData,
        worldSize,
        { googleApiKey, google3DErrorTarget },
        progress,
      );
      googleTilesGlbBlob = google.glbBlob;
      googleTilesDaeBlob = google.daeBlob;
      googleTilesTextureFiles = google.textureFiles;
      googleDebugCubeBlob = google.debugCubeBlob;
    }
  } else {
    beginStep('Skipping 3D OSM object export (disabled)…', 65);
    await yield_();
  }

  let junctionsDaeBlob = null;
  if (meshRoadJunctions.length > 0) {
    beginStep(`Building road junction prisms (${meshRoadJunctions.length})…`, 68);
    await yield_();
    junctionsDaeBlob = await generateJunctionsDAE(meshRoadJunctions);
  }

  beginStep(`Building water objects (sea level + inland ${includeWater ? 'enabled' : 'disabled'})…`, 71);
  await yield_();
  // Always emit a sea-level WaterPlane; includeWater toggles only inland OSM-derived water.
  const waterObjects = [
    buildSeaLevelWaterPlane(exportTerrainData, flavor),
    ...(includeWater
      ? [
          ...buildWaterBlockObjects(exportTerrainData, squareSize, flavor),
          ...buildRiverObjects(exportTerrainData, squareSize, flavor),
        ]
      : []),
  ];

  beginStep(`Building native barrier objects (${includeNativeBarriers ? 'enabled' : 'disabled'})…`, 74);
  await yield_();
  const barrierObjects = includeNativeBarriers
    ? buildNativeBarrierObjects(exportTerrainData, squareSize)
    : [];
  const barrierFolderItems = buildBarrierFolderItems(barrierObjects);
  const roadFolderGroups = buildRoadFolderGroups(roadArchitectSession);
  const usesEastCoastFenceMaterials = barrierFolderItems.some((obj) => (
    String(obj?.shapeName || '').toLowerCase().includes('eca_bld_wood_fence_a.dae')
  ));

  beginStep(`Building vegetation objects (trees: ${includeTrees ? 'on' : 'off'}, rocks: ${includeRocks ? 'on' : 'off'})…`, 77);
  await yield_();
  const forestPlacements = (includeTrees || includeRocks)
    ? buildForestPlacements(exportTerrainData, squareSize, { includeTrees, includeRocks }, flavor)
    : new Map();
  const forestFiles = serializeForestFiles(forestPlacements);
  const groundCoverObjects = buildGroundCoverObjects(exportTerrainData, squareSize, includeTrees, flavor);
  const managedForestItemData = cloneManagedItemData(Array.from(forestPlacements.keys()), flavor);
  const shapeMaterialDefsForFlavor = (forestFiles.length > 0 || includeRocks)
    ? await getShapeMaterialDefsForFlavor(flavor)
    : {};

  let backdropDaeBlob = null;
  let backdropTextureFiles = [];
  let backdropDiagnostics = null;
  if (includeBackdrop) {
    beginStep('Fetching terrain backdrop mesh…', 82);
    await yield_();
    const backdropResult = await generateTerrainBackdropDAE(exportTerrainData, worldSize, {
      elevationSource: backdropElevationSource,
      gpxzApiKey: backdropGpxzApiKey,
    });
    backdropDaeBlob = backdropResult?.daeBlob ?? null;
    backdropTextureFiles = backdropResult?.textureFiles ?? [];
    backdropDiagnostics = backdropResult?.diagnostics ?? null;
  }

  beginStep('Loading MapNG flag asset…', 85);
  await yield_();
  let mapngFlagFiles = [];
  try {
    mapngFlagFiles = await loadMapngFlagAsset();
  } catch (error) {
    console.warn('Failed to load MapNG flag asset, skipping:', error);
  }
  const mapngFlagPosition = findHighestTerrainPoint(exportTerrainData, squareSize);

  beginStep(`Assembling ZIP archive (${levelName})…`, 88);
  await yield_();

  // Diagnostics report — built while 'Assembling ZIP' is the current step so its
  // processing-timeline snapshot matches the pre-decomposition monolith.
  const reportGeneratedAt = new Date();
  const reportContents = buildBeamNGExportReport({
    terrainData: exportTerrainData,
    originalTerrainData: terrainData,
    center,
    options: {
      ...options,
      baseTexture,
      includeBuildings,
      applyFoundations,
      includeBackdrop,
      includeWater,
      includeNativeBarriers,
      includeTrees,
      includeRocks,
      requestedPbrSource: pbrSource,
      terrainMaterialNames: pbrResult?.materialNames ?? ['DefaultMaterial'],
    },
    levelName,
    levelDisplayName,
    flavor,
    squareSize,
    satelliteTexSize: terrainBaseTexSize,
    worldSize,
    exportStartedAt: progress.exportStartedAt,
    reportGeneratedAt,
    processingLog: progress.snapshot(),
    effectivePbrSource,
    waterObjects,
    barrierObjects,
    barrierMeshSplineGroups: barrierFolderItems.length > 0
      ? [{ groupName: 'barriers' }]
      : [],
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
  });

  // The explicit ctx the pure-core archive serializer consumes. Field set is
  // verified to match writeLevelEntries' reads exactly (06 step 9b/9c).
  return {
    levelName, levelDisplayName, lat, lng, size,
    spawnPosition, spawnRotationMatrix, halfExtent, squareSize, maxHeight,
    roadArchitectSession, roadArchitectHeightmapBlob,
    meshRoads, junctionsDaeBlob, decalRoads,
    pbrResult, terBlob, texBlob, heightmapBlob, previewBlob,
    osmDaeBlob, googleTilesGlbBlob, googleTilesDaeBlob, googleTilesTextureFiles, googleDebugCubeBlob,
    waterObjects, barrierFolderItems, roadFolderGroups, usesEastCoastFenceMaterials,
    forestFiles, groundCoverObjects, managedForestItemData, shapeMaterialDefsForFlavor,
    backdropDaeBlob, backdropTextureFiles,
    mapngFlagFiles, mapngFlagPosition, routeTilePieces,
    reportContents,
    groundCoverProfile: groundCoverObjects.length > 0 ? getGroundCoverProfile(flavor) : null,
    tileRenderBiasM: TILE_RENDER_BIAS_M,
    beamngGlbToDaeScript,
  };
}
