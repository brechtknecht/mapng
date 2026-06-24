/** @layer core */
// Writes the main/MissionGroup/* scene-object tree (the items.level.json NDJSON
// graph): SimGroups, Mesh_roads, barriers, roads, Decal_Roads, Level_objects
// (LevelInfo/TimeOfDay/ScatterSky), the Other group (TerrainBlock + OSM/Google/
// backdrop/flag TSStatics), Water, vegetation (Forest + groundcover), and the
// player spawn. Every generatePersistentId() call in the archive lives here, so
// writeLevelEntries runs the files writer first then this one to preserve the
// PRNG order. Pure: all artifacts arrive via `ctx`. Extracted verbatim from
// exportBeamNGLevel.js (06 step 9b).
import { toNDJSON, writeSimGroupTree } from './levelZip.js';
import { generatePersistentId } from './worldMath.js';

/**
 * Write the main/MissionGroup/* scene tree into the `zip` recorder.
 */
export function writeMissionGroup(zip, ctx) {
  const {
    levelName, size, squareSize, halfExtent, maxHeight,
    spawnPosition, spawnRotationMatrix,
    meshRoads, decalRoads, junctionsDaeBlob,
    barrierFolderItems, roadFolderGroups,
    osmDaeBlob, googleTilesGlbBlob, googleDebugCubeBlob, backdropDaeBlob,
    routeTilePieces, pbrResult, waterObjects,
    forestFiles, groundCoverObjects, managedForestItemData,
    mapngFlagFiles, mapngFlagPosition, tileRenderBiasM,
  } = ctx;
  const base = `levels/${levelName}`;

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
      position: [0, 0, tileRenderBiasM],
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
}
