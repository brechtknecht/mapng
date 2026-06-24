/** @layer flow */
// BeamNG level export orchestrator. The ~95 helpers that build each piece of a
// level (terrain math, decal/architect/mesh roads, water, barriers, forest,
// textures, DAE/GLB assets, the diagnostics report, zip serialization) were
// extracted verbatim into ./beamng/* during refactor 06 step 9; this file now
// wires them into the single exportBeamNGLevel() entry point and assembles +
// packages the level .zip. Re-exported unchanged via @mapng/bake/exportBeamNGLevel
// (consumers: components/panels/ExportPanel.vue, packages/route exportRouteLevel.js).
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
  generatePersistentId,
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
  EAST_COAST_FENCE_MATERIAL_DEFS,
} from './beamng/barriers.js';
import {
  buildForestPlacements,
  serializeForestFiles,
  buildGroundCoverObjects,
  cloneManagedItemData,
} from './beamng/forest.js';
import { buildBeamNGExportReport } from './beamng/report.js';
import { toNDJSON, writeSimGroupTree, buildRoadFolderGroups } from './beamng/levelZip.js';
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
  const base = `levels/${levelName}`;

  // Explicit directory entries so BeamNG's FS:directoryExists() works correctly
  zip.folder('levels');
  zip.folder(base);
  zip.folder(`${base}/art`);
  zip.folder(`${base}/bat`);
  zip.folder(`${base}/art/terrains`);
  zip.folder(`${base}/main`);
  zip.folder(`${base}/main/MissionGroup`);
  zip.folder(`${base}/main/MissionGroup/Level_objects`);
  zip.folder(`${base}/main/MissionGroup/Level_objects/Other`);
  zip.folder(`${base}/main/MissionGroup/PlayerDropPoints`);
  zip.folder(`${base}/main/MissionGroup/Water`);
  if (barrierFolderItems.length > 0) {
    zip.folder(`${base}/main/MissionGroup/barriers`);
  }
  if (roadFolderGroups.length > 0) {
    zip.folder(`${base}/main/MissionGroup/roads`);
  }
  if (meshRoads.length > 0) {
    zip.folder(`${base}/main/MissionGroup/Mesh_roads`);
  }
  if (forestFiles.length > 0 || groundCoverObjects.length > 0) {
    zip.folder(`${base}/main/MissionGroup/Level_objects/vegetation`);
    zip.folder(`${base}/art/forest`);
    zip.folder(`${base}/forest`);
  }

  // ── info.json ──────────────────────────────────────────────────────────────
  zip.file(`${base}/info.json`, JSON.stringify({
    authors: 'mapng',
    defaultSpawnPointName: 'spawn_default',
    description: `Generated by mapng at ${lat}, ${lng}`,
    previews: ['preview.png'],
    size: [size, size],
    spawnPoints: [{
      name: 'Default',
      objectname: 'spawn_default',
      preview: 'preview.png',
      translationId: 'Default Spawnpoint',
    }],
    title: levelDisplayName,
  }, null, 2));

  // ── mainLevel.lua ──────────────────────────────────────────────────────────
  // Lua initialization script executed on level load. Expected by BeamNG's
  // level subsystem and the World Editor.
  zip.file(`${base}/mainLevel.lua`, [
    '-- Auto-generated by mapng',
    'local M = {}',
    '',
    'local raAutoLoadPending = false',
    'local raAutoLoadDone = false',
    'local raAutoLoadWait = 0',
    'local raAutoLoadMaxWait = 15',
    '',
    'local function getRoadArchitectSessionPath()',
    '  if not core_levels or not getMissionFilename then return nil end',
    '  local levelName = core_levels.getLevelName(getMissionFilename())',
    '  if not levelName or levelName == "" then return nil end',
    '  return "/levels/" .. tostring(levelName) .. "/bat/roadatchitectsession.json"',
    'end',
    '',
    'local function moveRoadArchitectFolders(sessionData)',
    '  if not scenetree or not scenetree.MissionGroup then return end',
    '  local missionGroup = scenetree.MissionGroup',
    '  local roadsRoot = scenetree.findObject("roads")',
    '  if not roadsRoot then',
    '    roadsRoot = createObject("SimGroup")',
    '    roadsRoot:registerObject("roads")',
    '    missionGroup:addObject(roadsRoot)',
    '  end',
    '  local roads = (sessionData and sessionData.data and sessionData.data.roads) or {}',
    '  for i = 1, #roads do',
    '    local folder = scenetree.findObject("Road Architect - Road " .. tostring(i))',
    '    if folder then',
    '      roadsRoot:addObject(folder)',
    '    end',
    '  end',
    'end',
    '',
    'local function loadRoadArchitectSessionIfAvailable()',
    '  if raAutoLoadDone then return true end',
    '  local sessionPath = getRoadArchitectSessionPath()',
    '  if not sessionPath then return false end',
    '  if not FS or not FS.fileExists or not FS:fileExists(sessionPath) then',
    '    raAutoLoadDone = true',
    '    return true',
    '  end',
    '',
    '  local sessionData = jsonReadFile(sessionPath)',
    '  if not sessionData or not sessionData.data then',
    '    log("E", "mapng", "Road Architect session exists but could not be read: " .. tostring(sessionPath))',
    '    raAutoLoadDone = true',
    '    return true',
    '  end',
    '',
    '  if not extensions or not extensions.editor_roadArchitect or not extensions.editor_roadArchitect.onDeserialized then',
    '    return false',
    '  end',
    '',
    '  if FS and FS.directoryCreate then FS:directoryCreate("temp/") end',
    '  jsonWriteFile("temp/roadArchitect.json", sessionData, true)',
    '',
    '  local ok, err = pcall(extensions.editor_roadArchitect.onDeserialized)',
    '  if not ok then',
    '    log("E", "mapng", "Road Architect auto-load failed: " .. tostring(err))',
    '    return false',
    '  end',
    '',
    '  local okRoadMgr, roadMgr = pcall(require, "editor/tech/roadArchitect/roads")',
    '  if okRoadMgr and roadMgr and roadMgr.roads then',
    '    if scenetree and scenetree.findObject and scenetree.findObject("Road Architect - Road 1") then',
    '      raAutoLoadDone = true',
    '      return true',
    '    end',
    '    for i = 1, #roadMgr.roads do',
    '      local road = roadMgr.roads[i]',
    '      if road and road.isConformRoadToTerrain then',
    '        road.isConformRoadToTerrain[0] = true',
    '      end',
    '      if roadMgr.setDirty and road then',
    '        roadMgr.setDirty(road)',
    '      end',
    '    end',
    '    if roadMgr.computeAllRoadRenderData then',
    '      roadMgr.computeAllRoadRenderData()',
    '    end',
    '    if roadMgr.finalise and #roadMgr.roads > 0 then',
    '      pcall(roadMgr.finalise)',
    '      moveRoadArchitectFolders(sessionData)',
    '    end',
    '  end',
    '',
    '  raAutoLoadDone = true',
    '  return true',
    'end',
    '',
    'function M.onClientStartMission()',
    '  raAutoLoadPending = true',
    '  raAutoLoadWait = 0',
    '  loadRoadArchitectSessionIfAvailable()',
    'end',
    '',
    'function M.onUpdate(dtReal)',
    '  if not raAutoLoadPending or raAutoLoadDone then return end',
    '  raAutoLoadWait = raAutoLoadWait + (tonumber(dtReal) or 0)',
    '  if loadRoadArchitectSessionIfAvailable() then',
    '    raAutoLoadPending = false',
    '    return',
    '  end',
    '  if raAutoLoadWait >= raAutoLoadMaxWait then',
    '    raAutoLoadPending = false',
    '  end',
    'end',
    '',
    'function M.onSerialize()',
    '  return {}',
    'end',
    '',
    'function M.onDeserialized(data)',
    'end',
    '',
    'return M',
  ].join('\n') + '\n');

  // ── preview.png ────────────────────────────────────────────────────────────
  zip.file(`${base}/preview.png`, previewBlob);
  previewBlob = null;

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
  zip.file(`${base}/export_report.txt`, reportContents);

  if (roadArchitectSession) {
    zip.file(`${base}/bat/roadatchitectsession.json`, JSON.stringify(roadArchitectSession, null, 2));
    if (roadArchitectHeightmapBlob) {
      zip.file(`${base}/bat/roadatchitectsession.png`, roadArchitectHeightmapBlob);
    }
  }

  // ── theTerrain.ter ─────────────────────────────────────────────────────────
  zip.file(`${base}/theTerrain.ter`, terBlob);

  // ── theTerrain.terrainheightmap.png ────────────────────────────────────────
  // Grayscale heightmap preview used by BeamNG's terrain system and World Editor.
  // Capped at 2048px — the .ter binary holds the full-res data; this is display only.
  zip.file(`${base}/theTerrain.terrainheightmap.png`, heightmapBlob);
  heightmapBlob = null;

  // ── art/shapes/ (OSM 3D objects and/or terrain backdrop) ──────────────────
  // Only written when at least one DAE file is present.
  if (osmDaeBlob || junctionsDaeBlob || backdropDaeBlob || forestFiles.length > 0 || groundCoverObjects.length > 0 || mapngFlagFiles.length > 0) {
    zip.folder(`${base}/art/shapes`);
    if (mapngFlagFiles.length > 0) zip.folder(`${base}/art/shapes/mapng`);

    if (osmDaeBlob) zip.file(`${base}/art/shapes/osm_objects.dae`, osmDaeBlob);
    if (junctionsDaeBlob) zip.file(`${base}/art/shapes/road_junctions.dae`, junctionsDaeBlob);
    if (backdropDaeBlob) zip.file(`${base}/art/shapes/terrain_backdrop.dae`, backdropDaeBlob);

    // Google Photorealistic 3D Tiles live in their own folder (own
    // materials.json, own texture folder) — mirroring the working mapng_flag
    // asset layout. The geometry ships as google_tiles.glb plus a Blender
    // conversion script: BeamNG only loads .dae, and Blender's Collada
    // exporter is the BeamNG-proven serializer (see the README in the
    // folder). Run the script once, drop google_tiles.dae next to the glb.
    if (googleTilesGlbBlob) {
      zip.folder(`${base}/art/shapes/google_tiles`);
      if (googleTilesDaeBlob) {
        // The dev-server Blender bridge already produced the final shape —
        // the zip is ready to play, no GLB/conversion bundle needed.
        zip.file(`${base}/art/shapes/google_tiles/google_tiles.dae`, googleTilesDaeBlob);
      } else {
        zip.file(`${base}/art/shapes/google_tiles/google_tiles.glb`, googleTilesGlbBlob);
        zip.file(`${base}/art/shapes/google_tiles/beamng_glb_to_dae.py`, beamngGlbToDaeScript);
        zip.file(
        `${base}/art/shapes/google_tiles/README_CONVERT.txt`,
        [
          'Google 3D Tiles — one-time conversion to .dae',
          '=============================================',
          '',
          'BeamNG only loads COLLADA (.dae) shapes, and Blender\'s exporter is the',
          'reliable way to produce one.',
          '',
          '⚠ Blender 3.x or 4.x required (4.2 LTS recommended) — Collada export was',
          '  REMOVED in Blender 5.0+. A portable zip from',
          '  https://download.blender.org/release/Blender4.2/ works without installing.',
          '',
          '  1. Extract this zip (or open the folder if already extracted).',
          '  2. In this folder, run:',
          '',
          '     blender --background --factory-startup --python beamng_glb_to_dae.py -- google_tiles.glb google_tiles.dae',
          '',
          '     (On Windows, use the full path to blender.exe, e.g.',
          '      "...\\blender-4.2.9-windows-x64\\blender.exe")',
          '',
          '  3. Re-zip the level (or keep it as an unpacked folder in your BeamNG',
          '     mods directory). The level\'s items.level.json already references',
          '     google_tiles.dae — once the file exists, the photogrammetry appears.',
          '',
          'You can inspect google_tiles.glb in any glTF viewer (e.g. Blender itself,',
          'or https://gltf-viewer.donmccurdy.com) to verify the bake before converting.',
          '',
          'Textures are NOT read from the .dae — they resolve via main.materials.json',
          'in this folder (google_atlas_NN entries pointing at textures/*.png).',
        ].join('\n'),
        );
      }
      if (googleDebugCubeBlob) zip.file(`${base}/art/shapes/google_tiles/google_debug.dae`, googleDebugCubeBlob);
      // Collision mesh material (vertex-colour, no texture).
      const googleMaterials = {
        osm_object: {
          class: 'Material',
          name: 'osm_object',
          mapTo: 'osm_object',
          annotation: 'BUILDINGS',
          Stages: [{ diffuseColor: [1, 1, 1, 1], vertColor: true }],
          translucentBlendOp: 'None',
        },
      };
      // Per-tile photogrammetry textures + matching materials. Material shape
      // mirrors the working mapng_flag entry exactly (Material class uses
      // `colorMap`, not `diffuseMap`; needs 4 Stages even if 3 are empty).
      if (googleTilesTextureFiles.length > 0) {
        zip.folder(`${base}/art/shapes/google_tiles/textures`);
        for (const tex of googleTilesTextureFiles) {
          zip.file(`${base}/art/shapes/google_tiles/textures/${tex.name}.${tex.ext}`, tex.data);
          googleMaterials[tex.name] = {
            name: tex.name,
            mapTo: tex.name,
            class: 'Material',
            Stages: [
              { colorMap: `levels/${levelName}/art/shapes/google_tiles/textures/${tex.name}.${tex.ext}` },
              {},
              {},
              {},
            ],
            translucentBlendOp: 'None',
          };
        }
      }
      zip.file(`${base}/art/shapes/google_tiles/main.materials.json`, JSON.stringify(googleMaterials, null, 2));
    }
    for (const asset of mapngFlagFiles) {
      const relativePath = asset.path.startsWith('mapng/') ? asset.path.slice('mapng/'.length) : asset.path;
      if (relativePath === 'main.materials.json') {
        const materialDefs = JSON.parse(new TextDecoder().decode(asset.data));
        if (materialDefs.mapng_flag?.Stages?.[0]) {
          materialDefs.mapng_flag.class = 'Material';
          materialDefs.mapng_flag.Stages[0].colorMap = `levels/${levelName}/art/shapes/mapng/mapng_flag_d.png`;
        }
        zip.file(`${base}/art/shapes/mapng/main.materials.json`, JSON.stringify(materialDefs, null, 2));
      } else {
        zip.file(`${base}/art/shapes/mapng/${relativePath}`, asset.data);
      }
    }

    // Build a single materials JSON covering all DAEs in this directory.
    const shapeMaterials = {
      ...shapeMaterialDefsForFlavor,
      ...(usesEastCoastFenceMaterials ? EAST_COAST_FENCE_MATERIAL_DEFS : {}),
      ...(groundCoverObjects.length > 0 ? {
        [getGroundCoverProfile(flavor).materialName]: structuredClone(getGroundCoverProfile(flavor).materialDef),
      } : {}),
    };
    if (osmDaeBlob) {
      // Vertex-colour Material: BeamNG multiplies diffuseColor × vertex colour.
      // All OSM mesh materials are named "osm_object" to resolve to this entry.
      shapeMaterials.osm_object = {
        class: 'Material',
        name: 'osm_object',
        mapTo: 'osm_object',
        annotation: 'BUILDINGS',
        Stages: [{ diffuseColor: [1, 1, 1, 1], vertColor: true }],
        translucentBlendOp: 'None',
      };
    }
    if (backdropDaeBlob) {
      // Save per-tile satellite textures alongside the DAE.
      if (backdropTextureFiles.length > 0) {
        zip.folder(`${base}/art/shapes/textures`);
        for (const tex of backdropTextureFiles) {
          zip.file(`${base}/art/shapes/textures/${tex.name}.${tex.ext}`, tex.data);
          // One BeamNG Material entry per tile, referencing its satellite texture.
          shapeMaterials[tex.name] = {
            class: 'Material',
            name: tex.name,
            mapTo: tex.name,
            annotation: 'TERRAIN',
            Stages: [{
              diffuseMap: `levels/${levelName}/art/shapes/textures/${tex.name}.${tex.ext}`,
              diffuseColor: [1, 1, 1, 1],
            }],
            translucentBlendOp: 'None',
          };
        }
      } else {
        // No satellite textures available — use a flat earth-tone fallback.
        shapeMaterials.backdrop_terrain = {
          class: 'Material',
          name: 'backdrop_terrain',
          mapTo: 'backdrop_terrain',
          annotation: 'TERRAIN',
          Stages: [{ diffuseColor: [0.55, 0.5, 0.45, 1] }],
          translucentBlendOp: 'None',
        };
      }
    }
    zip.file(`${base}/art/shapes/main.materials.json`, JSON.stringify(shapeMaterials, null, 2));
  }

  // ── art/terrains/terrain.png ───────────────────────────────────────────────
  zip.file(`${base}/art/terrains/terrain.png`, texBlob);
  texBlob = null;

  // ── art/terrains/ PBR textures (when OSM material painting is enabled) ─────
  if (pbrResult?.textureFiles?.length) {
    for (const { path, blob } of pbrResult.textureFiles) {
      zip.file(`${base}/art/terrains/${path}`, blob);
    }
  }

  // ── art/terrains/main.materials.json ──────────────────────────────────────
  // When PBR materials are active, write all material definitions from the
  // OSM painter (DefaultMaterial satellite base + PBR overlays).
  // Otherwise, fall back to a single DefaultMaterial covering the whole terrain.
  const terrainMaterialDefs = pbrResult?.materialDefs ?? {
    DefaultMaterial: {
      class: 'TerrainMaterial',
      internalName: 'DefaultMaterial',
      diffuseMap: `levels/${levelName}/art/terrains/terrain.png`,
      diffuseSize: size,
      groundmodelName: 'GROUNDMODEL_ASPHALT1',
    },
  };
  zip.file(`${base}/art/terrains/main.materials.json`, JSON.stringify(terrainMaterialDefs, null, 2));

  // ── theTerrain.terrain.json — update materials list to match .ter contents ─
  const terrainMaterialNames = pbrResult?.materialNames ?? ['DefaultMaterial'];
  const heightMapSize = size * size;
  zip.file(`${base}/theTerrain.terrain.json`, JSON.stringify({
    binaryFormat: 'version(char), size(unsigned int), heightMap(heightMapSize * heightMapItemSize), layerMap(layerMapSize * layerMapItemSize), layerTextureMap(layerMapSize * layerMapItemSize), materialNames',
    datafile: `/levels/${levelName}/theTerrain.ter`,
    heightMapItemSize: 2,
    heightMapSize,
    heightmapImage: `/levels/${levelName}/theTerrain.terrainheightmap.png`,
    layerMapItemSize: 1,
    layerMapSize: heightMapSize,
    materials: terrainMaterialNames,
    size,
    version: 9,
  }, null, 2));

  // ── art/shapes/google_tiles_NN/ (route mode: one folder per chunk tile) ────
  // Route mode has no OSM, so the single-tile art/shapes block above is skipped;
  // write each chunk's pre-assembled tile shape + atlas + materials here. Layout
  // and material shape mirror the single google_tiles folder exactly.
  if (routeTilePieces?.length) {
    zip.folder(`${base}/art/shapes`);
    for (const piece of routeTilePieces) {
      const dir = `art/shapes/${piece.name}`;
      zip.folder(`${base}/${dir}`);
      if (piece.daeBlob) {
        zip.file(`${base}/${dir}/google_tiles.dae`, piece.daeBlob);
      } else if (piece.glbBlob) {
        // Blender bridge was unavailable — ship the GLB + the conversion script.
        zip.file(`${base}/${dir}/google_tiles.glb`, piece.glbBlob);
        zip.file(`${base}/${dir}/beamng_glb_to_dae.py`, beamngGlbToDaeScript);
      }
      const mats = {};
      if (piece.textureFiles?.length) {
        zip.folder(`${base}/${dir}/textures`);
        for (const tex of piece.textureFiles) {
          zip.file(`${base}/${dir}/textures/${tex.name}.${tex.ext}`, tex.data);
          mats[tex.name] = {
            name: tex.name,
            mapTo: tex.name,
            class: 'Material',
            Stages: [
              { colorMap: `levels/${levelName}/${dir}/textures/${tex.name}.${tex.ext}` },
              {}, {}, {},
            ],
            translucentBlendOp: 'None',
          };
        }
      }
      zip.file(`${base}/${dir}/main.materials.json`, JSON.stringify(mats, null, 2));
    }
  }

  // ── main/items.level.json ──────────────────────────────────────────────────
  zip.file(`${base}/main/items.level.json`,
    toNDJSON([{ class: 'SimGroup', name: 'MissionGroup', persistentId: generatePersistentId() }])
  );

  // ── main/MissionGroup/items.level.json ─────────────────────────────────────
  const missionGroupItems = [
    { __parent: 'MissionGroup', class: 'SimGroup', name: 'PlayerDropPoints', persistentId: generatePersistentId() },
    { __parent: 'MissionGroup', class: 'SimGroup', name: 'Level_objects', persistentId: generatePersistentId() },
    { __parent: 'MissionGroup', class: 'SimGroup', name: 'Water', persistentId: generatePersistentId() },
    ...(meshRoads.length > 0 ? [{
      __parent: 'MissionGroup',
      class: 'SimGroup',
      name: 'Mesh_roads',
      persistentId: generatePersistentId(),
    }] : []),
    ...(barrierFolderItems.length > 0 ? [{
      __parent: 'MissionGroup',
      class: 'SimGroup',
      name: 'barriers',
      persistentId: generatePersistentId(),
    }] : []),
    ...(roadFolderGroups.length > 0 ? [{
      __parent: 'MissionGroup',
      class: 'SimGroup',
      name: 'roads',
      persistentId: generatePersistentId(),
    }] : []),
    ...(decalRoads.length > 0 ? [{
      __parent: 'MissionGroup',
      class: 'SimGroup',
      name: 'Decal_Roads',
      persistentId: generatePersistentId(),
    }] : []),
  ];
  zip.file(`${base}/main/MissionGroup/items.level.json`, toNDJSON(missionGroupItems));

  // ── main/MissionGroup/Mesh_roads/items.level.json ─────────────────────────
  if (meshRoads.length > 0) {
    const meshRoadItems = [...meshRoads];
    if (junctionsDaeBlob) {
      meshRoadItems.push({
        __parent: 'Mesh_roads',
        class: 'TSStatic',
        name: 'road_junctions',
        persistentId: generatePersistentId(),
        position: [0, 0, 0],
        shapeName: `levels/${levelName}/art/shapes/road_junctions.dae`,
        collisionType: 'Collision Mesh',
        decalType: 'Collision Mesh',
        prebuildCollisionData: 0,
        useInstanceRenderData: true,
      });
    }
    zip.file(`${base}/main/MissionGroup/Mesh_roads/items.level.json`, toNDJSON(meshRoadItems));
  }

  // ── main/MissionGroup/barriers/items.level.json ─────────────────────────
  if (barrierFolderItems.length > 0) {
    zip.file(`${base}/main/MissionGroup/barriers/items.level.json`, toNDJSON(barrierFolderItems));
  }

  // ── main/MissionGroup/roads/items.level.json ──────────────────────────────
  if (roadFolderGroups.length > 0) {
    // Generate SimGroup objects for each Road Architect road group
    const roadGroups = roadFolderGroups.map(g => ({
      __parent: 'roads',
      class: 'SimGroup',
      name: g.groupName,
      persistentId: generatePersistentId(),
    }));

    zip.file(`${base}/main/MissionGroup/roads/items.level.json`, toNDJSON(roadGroups));

    // BeamNG requires sub-folders and an empty items.level.json for each nested SimGroup
    for (const g of roadGroups) {
      zip.folder(`${base}/main/MissionGroup/roads/${g.name}`);
      // An empty string or empty items list will parse without crashing.
      zip.file(`${base}/main/MissionGroup/roads/${g.name}/items.level.json`, '');
    }
  }

  // ── main/MissionGroup/Decal_Roads/items.level.json ────────────────────────
  if (decalRoads.length > 0) {
    writeSimGroupTree(zip, `${base}/main/MissionGroup/Decal_Roads`, decalRoads);
  }

  // ── main/MissionGroup/Level_objects/items.level.json ──────────────────────
  // LevelInfo, TimeOfDay, ScatterSky, and the Other group (which holds terrain)
  // are all defined here, matching the Cliff level's structure.
  zip.file(`${base}/main/MissionGroup/Level_objects/items.level.json`,
    toNDJSON([
      {
        __parent: 'Level_objects',
        class: 'LevelInfo',
        name: 'theLevelInfo',
        persistentId: generatePersistentId(),
        canvasClearColor: [0, 0, 0, 1],
        fogAtmosphereHeight: 1000,
        fogDensity: 0.0001,
        fogDensityOffset: 0,
        globalEnviromentMap: 'BNG_Sky_02_cubemap',
        gravity: -9.81,
        nearClip: 0.1,
        visibleDistance: 4000,
      },
      {
        __parent: 'Level_objects',
        class: 'TimeOfDay',
        name: 'tod',
        persistentId: generatePersistentId(),
        startTime: 0.15,
      },
      {
        __parent: 'Level_objects',
        class: 'ScatterSky',
        name: 'sunsky',
        persistentId: generatePersistentId(),
        ambientScaleGradientFile: 'art/sky_gradients/default/gradient_ambient.png',
        colorizeGradientFile: 'art/sky_gradients/default/gradient_colorize.png',
        enableFogFallBack: false,
        fogScaleGradientFile: 'art/sky_gradients/default/gradient_fog.png',
        shadowDistance: 1500,
        skyBrightness: 40,
        sunScaleGradientFile: 'art/sky_gradients/default/gradient_sunscale.png',
        texSize: 2048,
      },
      {
        __parent: 'Level_objects',
        class: 'SimGroup',
        name: 'Other',
        persistentId: generatePersistentId(),
      },
      ...((forestFiles.length > 0 || groundCoverObjects.length > 0) ? [{
        __parent: 'Level_objects',
        class: 'SimGroup',
        name: 'vegetation',
        persistentId: generatePersistentId(),
      }] : []),
    ])
  );

  // ── main/MissionGroup/Level_objects/Other/items.level.json ────────────────
  // TerrainBlock referencing the .ter file and the PBR material texture set.
  // - squareSize:        real-world meters per terrain grid square
  // - maxHeight:         elevation range in meters (maps ter 0→65535 to 0→maxHeight)
  // - baseTexSize:       resolution of the base color texture (matches satellite pixel size)
  // - terrainFile:       leading-slash path (BeamNG vanilla convention)
  // - materialTextureSet: links to the TerrainMaterialTextureSet for PBR atlas sizing
  // - minimapImage:      left empty; filled in by the World Editor when a minimap is baked
  //
  // TSStatic (optional): OSM 3D objects DAE, placed at world origin.
  // The DAE geometry is already in BeamNG world-space — no rotation or scale
  // needed on the TSStatic. Collada up_axis is declared Z_UP in the file.
  const otherItems = [{
    __parent: 'Other',
    class: 'TerrainBlock',
    name: 'theTerrain',
    persistentId: generatePersistentId(),
    position: [-halfExtent, -halfExtent, 0],
    squareSize,
    maxHeight,
    baseTexSize: size,
    terrainFile: `/levels/${levelName}/theTerrain.ter`,
    materialTextureSet: pbrResult?.textureSetName ?? '',
    minimapImage: '',
  }];

  if (osmDaeBlob) {
    otherItems.push({
      __parent: 'Other',
      class: 'TSStatic',
      name: 'osm_objects',
      persistentId: generatePersistentId(),
      position: [0, 0, 0],
      shapeName: `levels/${levelName}/art/shapes/osm_objects.dae`,
      collisionType: 'Collision Mesh',
      decalType: 'Collision Mesh',
      prebuildCollisionData: 0,
      useInstanceRenderData: true,
    });
  }

  if (googleTilesGlbBlob) {
    otherItems.push({
      __parent: 'Other',
      class: 'TSStatic',
      name: 'google_tiles',
      persistentId: generatePersistentId(),
      // Z = render-bias epsilon: lift the visual tiles a hair off the coplanar
      // .ter surface they were conformed onto so they don't z-fight (see
      // TILE_RENDER_BIAS_M). Drive surface (terrain) unchanged.
      position: [0, 0, TILE_RENDER_BIAS_M],
      // The .dae does not exist in the fresh zip — it's produced by the
      // one-time Blender conversion (see README_CONVERT.txt in the google_tiles
      // folder). Until then BeamNG logs a missing shape and renders nothing.
      shapeName: `levels/${levelName}/art/shapes/google_tiles/google_tiles.dae`,
      // Visual-only: the DAE ships no Colmesh and collision is explicitly off —
      // the hidden OSM building boxes in osm_objects.dae do the colliding.
      collisionType: 'None',
      decalType: 'None',
      prebuildCollisionData: 0,
      useInstanceRenderData: true,
    });
  }

  // Route mode: one TSStatic per chunk tile, placed at its world offset (from
  // computeRouteFrame, mapped to BeamNG [east, north, up]). Visual-only like the
  // single-tile google_tiles object — the terrain is the drive surface.
  if (routeTilePieces?.length) {
    for (const piece of routeTilePieces) {
      otherItems.push({
        __parent: 'Other',
        class: 'TSStatic',
        name: piece.name,
        persistentId: generatePersistentId(),
        position: Array.isArray(piece.position) ? piece.position : [0, 0, 0],
        shapeName: `levels/${levelName}/art/shapes/${piece.name}/google_tiles.dae`,
        collisionType: 'None',
        decalType: 'None',
        prebuildCollisionData: 0,
        useInstanceRenderData: true,
      });
    }
  }

  // Diagnostic probe: 4-meter cube floating 5 m above the spawn point using the
  // first Google tile material. If this cube renders textured but the big
  // google_tiles mesh stays invisible, the issue is in the photogrammetry
  // geometry (UVs / scale / normals), not the material/texture pipeline.
  if (googleDebugCubeBlob && Array.isArray(spawnPosition)) {
    otherItems.push({
      __parent: 'Other',
      class: 'TSStatic',
      name: 'google_debug_cube',
      persistentId: generatePersistentId(),
      position: [spawnPosition[0], spawnPosition[1], spawnPosition[2] + 5],
      shapeName: `levels/${levelName}/art/shapes/google_tiles/google_debug.dae`,
      useInstanceRenderData: true,
    });
  }



  if (backdropDaeBlob) {
    otherItems.push({
      __parent: 'Other',
      class: 'TSStatic',
      name: 'terrain_backdrop',
      persistentId: generatePersistentId(),
      position: [0, 0, 0],
      shapeName: `levels/${levelName}/art/shapes/terrain_backdrop.dae`,
      useInstanceRenderData: true,
    });
  }

  if (mapngFlagFiles.length > 0) {
    otherItems.push({
      __parent: 'Other',
      class: 'TSStatic',
      name: 'mapng_flag_marker',
      persistentId: generatePersistentId(),
      position: mapngFlagPosition,
      shapeName: `levels/${levelName}/art/shapes/mapng/flagng.dae`,
      useInstanceRenderData: true,
    });
  }

  zip.file(`${base}/main/MissionGroup/Level_objects/Other/items.level.json`,
    toNDJSON(otherItems)
  );

  zip.file(`${base}/main/MissionGroup/Water/items.level.json`,
    toNDJSON(waterObjects)
  );

  if (forestFiles.length > 0 || groundCoverObjects.length > 0) {
    zip.file(`${base}/main/MissionGroup/Level_objects/vegetation/items.level.json`,
      toNDJSON([
        ...(forestFiles.length > 0 ? [{
          __parent: 'vegetation',
          class: 'Forest',
          name: 'theForest',
          persistentId: generatePersistentId(),
          lodReflectScalar: 0,
        }] : []),
        ...groundCoverObjects,
      ])
    );
    if (forestFiles.length > 0) {
      zip.file(`${base}/art/forest/managedItemData.json`, JSON.stringify(managedForestItemData, null, 2));
      for (const forestFile of forestFiles) {
        zip.file(`${base}/${forestFile.path}`, forestFile.contents);
      }
    }
  }

  // ── main/MissionGroup/PlayerDropPoints/items.level.json ───────────────────
  // Spawn position: midpoint of nearest road to terrain center (or center
  // fallback), 3 m above the terrain surface at that point.
  // rotationMatrix: 9-element flat row-major matrix aligning the vehicle with
  // the road tangent direction at the spawn point.
  zip.file(`${base}/main/MissionGroup/PlayerDropPoints/items.level.json`,
    toNDJSON([{
      __parent: 'PlayerDropPoints',
      class: 'SpawnSphere',
      dataBlock: 'SpawnSphereMarker',
      name: 'spawn_default',
      persistentId: generatePersistentId(),
      position: spawnPosition,
      rotationMatrix: spawnRotationMatrix,
      radius: 5,
    }])
  );

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
