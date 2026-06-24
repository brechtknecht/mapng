/** @layer flow */
// BeamNG level export orchestrator. The piece-builders live in ./beamng/*
// (compute: terrain math, roads, water, barriers, forest; io: textures, DAE/GLB
// assets) and the level archive is serialized by the pure-core writers in
// ./beamng/levelArchive.js (writeLevelEntries → writeLevelFiles + writeMissionGroup).
// This file computes every artifact, packs them into one ctx, hands it to the
// serializer, and compresses the .zip. Re-exported unchanged via
// @mapng/bake/exportBeamNGLevel (consumers: components/panels/ExportPanel.vue,
// packages/route exportRouteLevel.js).
import JSZip from 'jszip';
import { exportTer } from './exportTer.js';
import { buildTerrainMaterials } from './osmTerrainMaterials.js';
import {
  getGoogleTilesZOffset,
  exportGoogleTilesViaSidecar,
  googleBakeSidecarAvailable,
  TILE_RENDER_BIAS_M,
} from './google3dTiles.js';
import beamngGlbToDaeScript from '../../../scripts/beamng_glb_to_dae.py?raw';
import { prepareCroppedTerrainData } from './cropTerrain.js';
import { applyBuildingFoundations } from './buildingFoundations.js';
import {
  buildJunctionPolygons,
  mergeJunctionClusters,
  validateJunctionPolygon,
} from './junctionGeometry.js';
import { generateJunctionsDAE } from './junctionMesh.js';
import { detectGapJunctions } from './junctionRaster.js';
import { zipSidecarAvailable, compressZipViaSidecar, isServerPathEntry } from './zipExportSidecar.js';
import {
  getBeamNGFlavorById,
  getGroundCoverProfile,
  getShapeMaterialDefsForFlavor,
} from './beamngFlavorCatalog.js';
import {
  sanitizeLevelName,
  filterOSMFeaturesToBounds,
  computeSquareSize,
  findSpawnPosition,
  findHighestTerrainPoint,
} from './beamng/worldMath.js';
import { generateDecalRoads } from './beamng/decalRoads.js';
import { generateRoadArchitectSession } from './beamng/roadArchitectSession.js';
import { buildMeshRoadAnalysis, generateMeshRoads } from './beamng/meshRoads.js';
import {
  buildWaterBlockObjects,
  buildSeaLevelWaterPlane,
  buildRiverObjects,
} from './beamng/water.js';
import {
  buildNativeBarrierObjects,
  buildBarrierFolderItems,
} from './beamng/barriers.js';
import {
  buildForestPlacements,
  serializeForestFiles,
  buildGroundCoverObjects,
  cloneManagedItemData,
} from './beamng/forest.js';
import { buildBeamNGExportReport } from './beamng/report.js';
import { buildRoadFolderGroups } from './beamng/levelZip.js';
import {
  getTerrainTextureBlob,
  resizePngBlob,
  generateHeightmapPng,
  generatePreviewBlob,
  generateRoadArchitectHeightmapPng,
  loadMapngFlagAsset,
} from './beamng/textures.js';
import { generateOSMObjectsDAE, generateTerrainBackdropDAE } from './beamng/meshAssets.js';
import { generateGoogleTilesGLB, generateGoogleDebugCubeDAE } from './beamng/googleTilesAssets.js';
import { writeLevelEntries } from './beamng/levelArchive.js';

const BEAMNG_EXPORT_SERVICE_LOG = '[BeamNG Export Service]';

/**
 * Generate a complete BeamNG level .zip from terrainData and center coordinates.
 *
 * ZIP structure:
 *   {levelName}.zip/
 *   └── levels/{levelName}/
 *       ├── info.json
 *       ├── mainLevel.lua
 *       ├── preview.png
 *       ├── theTerrain.ter
 *       ├── theTerrain.terrain.json
 *       ├── theTerrain.terrainheightmap.png
 *       ├── art/terrains/
 *       │   ├── terrain.png
 *       │   └── main.materials.json        (TerrainMaterial + TerrainMaterialTextureSet)
 *       ├── art/shapes/                    (present when OSM features or backdrop exist)
 *       │   ├── osm_objects.dae            (buildings, street furniture — optional)
 *       │   ├── terrain_backdrop.dae       (surrounding terrain mesh — optional)
 *       │   └── main.materials.json        (Materials for all DAEs in this folder)
 *       └── main/
 *           └── MissionGroup/
 *               ├── items.level.json
 *               ├── PlayerDropPoints/
 *               │   └── items.level.json
 *               ├── Level_objects/
 *               │   ├── items.level.json   (LevelInfo, TimeOfDay, ScatterSky, Other group)
 *               │   └── Other/
 *               │       └── items.level.json  (TerrainBlock + optional TSStatics)
 *
 * @param {object} terrainData
 * @param {object} center        — { lat, lng }
 * @param {object} [options]
 * @param {string}  [options.baseTexture='hybrid']         — 'none' | 'hybrid' | 'satellite' | 'osm'
 * @param {boolean} [options.includeBuildings=true]         — include generated OSM 3D objects (.dae)
 * @param {boolean} [options.applyFoundations=true]         — apply terrain foundation pass under buildings
 * @param {boolean} [options.includeBackdrop=false]         — fetch and include surrounding terrain backdrop DAE
 * @param {boolean} [options.includeWater=true]             — emit native BeamNG inland water objects
 * @param {boolean} [options.includeNativeBarriers=true]    — emit native BeamNG TSStatic barrier objects from OSM barriers into MissionGroup/barriers
 * @param {boolean} [options.includeTrees=true]             — emit native BeamNG tree and bush forest instances
 * @param {boolean} [options.includeRocks=false]            — emit native BeamNG rock forest instances
 * @param {string}  [options.flavorId]                      — BeamNG official level flavor id
 * @param {string}  [options.levelName]                     — custom user-facing/generated level name
 * @param {'osm'|'image'|'none'} [options.pbrSource='osm'] — layer map source: 'osm' uses OSM polygon data,
 *   'image' is accepted for backward compatibility and falls back to OSM inference, 'none' disables PBR materials.
 *   Legacy boolean option `generatePbrMaterials` is still accepted for backward compatibility.
 * @param {boolean} [options.useMeshRoads=false]            — export roads as 3D MeshRoad geometry instead of flat DecalRoad decals
 */
export async function exportBeamNGLevel(terrainData, center, options = {}) {
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
    onProgress,
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
  // Report progress and yield to the browser so UI updates and GC can run.
  /**
   * Emit progress callbacks consumed by the export UI.
   */
  const report = (step, pct) => {
    console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Step`, { step, pct });
    onProgress?.({ step, pct });
  };
  /**
   * Yield one event-loop tick so UI paint and GC can run during long exports.
   */
  const yield_ = () => new Promise(r => setTimeout(r, 0));
  const exportStartedAt = new Date();
  const processingLog = [];
  let currentStep = null;
  let currentStepStartedAt = performance.now();
  /**
   * Start a timed processing step and close the previous one in the log.
   */
  const beginStep = (step, pct) => {
    const now = performance.now();
    if (currentStep !== null) {
      processingLog.push({
        step: currentStep.step,
        pct: currentStep.pct,
        durationMs: now - currentStepStartedAt,
      });
    }
    currentStep = { step, pct };
    currentStepStartedAt = now;
    report(step, pct);
  };
  /**
   * Finalize and flush the active timed step into the processing log.
   */
  const finishProcessingLog = () => {
    if (currentStep !== null) {
      processingLog.push({
        step: currentStep.step,
        pct: currentStep.pct,
        durationMs: performance.now() - currentStepStartedAt,
      });
      currentStep = null;
    }
  };

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
  let heightmapBlob = await generateHeightmapPng(exportTerrainData);

  beginStep('Generating level thumbnail image…', 58);
  await yield_();
  let previewBlob = await generatePreviewBlob(exportTerrainData);

  let osmDaeBlob = null;
  let googleTilesGlbBlob = null;
  let googleTilesDaeBlob = null;
  let googleTilesTextureFiles = [];
  let googleTilesMaterialNames = [];
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
      // A failed Google bake must never take down the whole level export —
      // catch, log loudly, and continue with the OSM-only level.
      //
      // SIDEcar path first: the bake worker assembles atlases + GLB on the
      // server (it holds every tile record) and hands back FILE PATHS — the
      // ultra-scale exports that crashed the tab (39 atlas canvases + a
      // 1.5 GB GLB in the renderer) never enter the browser at all.
      const googleProgress = (p) => report(
        `Google tiles pass ${p.station ?? 1}/${p.stations ?? 1}: ${p.visible} loaded, ${p.downloading + p.parsing} in flight`,
        65,
      );
      if (await googleBakeSidecarAvailable()) {
        try {
          beginStep('Assembling Google tiles on the bake sidecar…', 65);
          await yield_();
          const exported = await exportGoogleTilesViaSidecar(exportTerrainData, {
            apiKey: googleApiKey,
            errorTarget: google3DErrorTarget,
            onProgress: googleProgress,
          }, {
            worldSize,
            zOffsetM: getGoogleTilesZOffset(),
          });
          // Server-side artifacts ride through the existing zip variables as
          // {fromPath} markers — the zip sidecar ingests them from disk.
          googleTilesGlbBlob = { fromPath: exported.glbPath, size: exported.glbBytes ?? 0 };
          googleTilesTextureFiles = (exported.textures ?? []).map((t) => ({
            name: t.name,
            ext: 'png',
            data: { fromPath: t.path, size: t.bytes ?? 0 },
          }));
          googleTilesMaterialNames = exported.materialNames ?? [];
          console.info(
            `[BeamNG export] sidecar assembled google_tiles.glb: ${exported.meshes} meshes, ` +
            `${googleTilesMaterialNames.length} atlases, ${((exported.glbBytes ?? 0) / 1024 ** 2).toFixed(0)} MB — zero renderer memory`,
          );
        } catch (err) {
          console.warn('[BeamNG export] sidecar export failed — falling back to in-browser assembly:', err);
          report(`Sidecar export failed (${err?.message ?? err}) — assembling in the browser`, 65);
        }
      }

      if (!googleTilesGlbBlob) {
        try {
          const googleResult = await generateGoogleTilesGLB(exportTerrainData, worldSize, {
            apiKey: googleApiKey,
            errorTarget: google3DErrorTarget,
            onProgress: googleProgress,
          });
          googleTilesGlbBlob = googleResult?.glbBlob ?? null;
          googleTilesTextureFiles = googleResult?.textureFiles ?? [];
          googleTilesMaterialNames = googleResult?.materialNames ?? [];
          if (!googleResult) {
            console.warn('[BeamNG export] Google 3D Tiles produced no geometry — exporting without them');
            report('Google tiles: no geometry produced — exporting without them', 65);
          } else {
            console.info(
              `[BeamNG export] Google tiles GLB built: ${googleTilesMaterialNames.length} atlas materials, ` +
              `${googleTilesTextureFiles.length} textures — convert with scripts/beamng_glb_to_dae.py`,
            );
          }
        } catch (err) {
          console.error('[BeamNG export] Google 3D Tiles bake failed — exporting without them:', err);
          report(`Google tiles failed (${err?.message ?? err}) — exporting without them`, 65);
        }
      }
      if (googleTilesMaterialNames.length > 0) {
        googleDebugCubeBlob = generateGoogleDebugCubeDAE(googleTilesMaterialNames[0]);
      }

      // Auto-convert GLB → .dae through the dev-server Blender bridge
      // (vite middleware → headless Blender ≤4.2). Sidecar-assembled GLBs
      // convert IN PLACE on the server (?file= mode) — no multi-GB blobs in
      // the tab. When the bridge is unavailable (no Blender, prod build),
      // the zip ships the GLB plus the conversion script for the documented
      // manual one-liner.
      if (googleTilesGlbBlob) {
        try {
          beginStep('Converting Google tiles to DAE (Blender)…', 66);
          await yield_();
          const serverPath = googleTilesGlbBlob.fromPath;
          const resp = serverPath
            ? await fetch(`/api/convert-dae?file=${encodeURIComponent(serverPath)}`, { method: 'POST' })
            : await fetch('/api/convert-dae', {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: googleTilesGlbBlob,
            });
          if (resp.ok && serverPath) {
            const { daePath, bytes } = await resp.json();
            googleTilesDaeBlob = { fromPath: daePath, size: bytes ?? 0 };
            console.info(
              `[BeamNG export] Blender bridge converted google_tiles.dae in place ` +
              `(${((bytes ?? 0) / 1024 ** 2).toFixed(1)} MB) — zip is ready to play`,
            );
          } else if (resp.ok) {
            googleTilesDaeBlob = await resp.blob();
            console.info(
              `[BeamNG export] Blender bridge converted google_tiles.dae ` +
              `(${(googleTilesDaeBlob.size / 1024 ** 2).toFixed(1)} MB) — zip is ready to play`,
            );
          } else {
            const msg = await resp.text();
            console.warn(
              `[BeamNG export] Blender bridge unavailable (HTTP ${resp.status}): ${msg} — ` +
              'shipping GLB + conversion script instead',
            );
            report('Blender bridge unavailable — zip needs the manual conversion step', 66);
          }
        } catch (err) {
          console.warn(
            '[BeamNG export] Blender bridge unreachable — shipping GLB + conversion script instead:',
            err,
          );
          report('Blender bridge unreachable — zip needs the manual conversion step', 66);
        }
      }
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

  // Diagnostics report — computed here (while 'Assembling ZIP' is the current
  // step) so its processing-timeline snapshot matches the pre-decomposition
  // monolith; passed to the serializer via ctx.reportContents.
  const reportGeneratedAt = new Date();
  const processingLogSnapshot = currentStep !== null
    ? [
        ...processingLog,
        {
          step: currentStep.step,
          pct: currentStep.pct,
          durationMs: performance.now() - currentStepStartedAt,
        },
      ]
    : processingLog.slice();
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
    exportStartedAt,
    reportGeneratedAt,
    processingLog: processingLogSnapshot,
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

  // Assemble the archive as a plain path → content recorder, NOT a JSZip:
  // JSZip eagerly reads every Blob into a JS-heap Uint8Array at file() time
  // (FileReader in prepareContent), so a large level — e.g. a 1+ GB Google
  // tiles DAE — blew the renderer heap during assembly, before compression
  // even started. Here contents keep their original form (Blobs stay
  // browser-managed/disk-backed); the sidecar uploads them as-is, and only
  // the prod fallback materialises a real JSZip at the very end.
  const zipDirs = [];
  const zipEntries = new Map(); // path → string | Blob | TypedArray
  const zip = {
    folder: (p) => { zipDirs.push(p); },
    file: (p, content) => { zipEntries.set(p, content); },
  };

  // The full level directory tree is serialized by the pure-core writers in
  // beamng/levelArchive.js. Everything they need is threaded explicitly through
  // ctx (no closure scope) — including the three values they must NOT import to
  // stay renderer/?raw-free: the groundcover profile, the Google z-fight render
  // bias, and the GLB→DAE python script string.
  writeLevelEntries(zip, {
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
  });

  beginStep('Compressing ZIP archive (DEFLATE)…', 94);
  await yield_();

  // Offload compression to the Node sidecar when the dev server provides it:
  // the in-browser path materialises the whole archive in the renderer heap
  // (JSZip assembly + pako DEFLATE) and hangs large maps. The sidecar receives
  // each entry as-is (Blobs stream from browser storage, no JS-heap copy),
  // DEFLATEs natively to a temp file, and hands back a GET URL the UI streams
  // straight to disk. The in-browser path below stays as the prod fallback.
  const filename = `${levelName}.zip`;
  if (await zipSidecarAvailable()) {
    const { url, jobId } = await compressZipViaSidecar({ dirs: zipDirs, entries: zipEntries }, {
      filename,
      // Map the upload progress onto the 94→99% window; the step text carries
      // the live file/byte counters so the UI visibly ticks.
      onProgress: ({ step, pct }) => report(step, 94 + Math.round((pct / 100) * 5)),
    });
    beginStep('Done', 100);
    finishProcessingLog();
    console.log(`${BEAMNG_EXPORT_SERVICE_LOG} ZIP compressed via sidecar:`, { filename, jobId, url });
    console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Completed exportBeamNGLevel`);
    return { download: { url, jobId }, filename };
  }

  // Prod fallback: materialise a real JSZip from the recorder and compress
  // in-browser. This is where the old memory ceiling still applies.
  // Server-path markers can't exist here in practice (they're only created
  // when the bake sidecar ran, which implies a dev server with the zip
  // sidecar too) — but if the zip sidecar vanished mid-export, skip them
  // loudly rather than writing "[object Object]" into the archive.
  const realZip = new JSZip();
  for (const dir of zipDirs) realZip.folder(dir);
  for (const [p, content] of zipEntries) {
    if (isServerPathEntry(content)) {
      console.error(`[BeamNG export] cannot embed server-side entry "${p}" without the zip sidecar — skipped`);
      continue;
    }
    realZip.file(p, content);
  }
  const zipBlob = await realZip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  console.log(`${BEAMNG_EXPORT_SERVICE_LOG} ZIP generated:`, {
    filename,
    blobType: zipBlob?.type,
    blobSize: zipBlob?.size,
    levelName,
  });
  beginStep('Done', 100);
  finishProcessingLog();
  console.log(`${BEAMNG_EXPORT_SERVICE_LOG} Completed exportBeamNGLevel`);
  return { blob: zipBlob, filename };
}
