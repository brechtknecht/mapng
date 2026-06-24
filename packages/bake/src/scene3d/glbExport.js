/** @layer flow */
// GLB export orchestrator: assemble the scene (center terrain + OSM group +
// optional Google 3D tiles + surroundings), optionally corridor-mask the Google
// group, then encode with GLTFExporter and download/return the blob.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { getOrBakeGoogle3DTiles, computeUnitsPerMeter, getGoogleTilesZOffset } from "../google3dTiles.js";
import { createTerrainMesh } from "./terrainMesh.js";
import { createOSMGroup } from "./osmMeshes.js";
import { createSurroundingMeshes } from "./surroundingMeshes.js";
import { clipGroupToCorridorXZ } from "./corridorMask.js";
import { disposeScene } from "./sceneUtils.js";

export const exportToGLB = async (data, options = {}) => {
  const {
    includeSurroundings,
    includeCenterTile,
    tileSelection,
    centerTextureType = 'osm',
    onProgress,
    maxMeshResolution = 1024,
    returnBlob = false,
    useGoogle3DTiles = false,
    googleApiKey,
    google3DErrorTarget,
    stripGoogleGround,
    googleQuality, // optional: override bake quality tier ('high'|'roads'|'max'); omit to use the persisted preference
    corridorMask, // optional route mode: { segment: [{lat,lng}], halfWidthM } — clip Google tiles to the buffer
    googleZOffsetM, // optional override for the tiles' vertical offset (metres); omit → the global slider value
    googleGroundOffsetM, // route mode: one route-wide vertical anchor (metres) shared by every chunk so seams stay continuous
  } = options;
  const googleZOff = typeof googleZOffsetM === 'number' ? googleZOffsetM : getGoogleTilesZOffset();
  const resolvedIncludeCenterTile = typeof includeCenterTile === 'boolean'
    ? includeCenterTile
    : tileSelection !== 'surroundings-only';
  const resolvedIncludeSurroundings = typeof includeSurroundings === 'boolean'
    ? includeSurroundings
    : tileSelection === 'center-plus-surroundings' || tileSelection === 'surroundings-only';
  try {
    const scene = new THREE.Scene();

    if (resolvedIncludeCenterTile) {
      onProgress?.('Building terrain mesh...');
      const terrainMesh = await createTerrainMesh(data, maxMeshResolution, centerTextureType);
      const osmGroup = createOSMGroup(data, useGoogle3DTiles ? { includeBuildings: false } : {});
      scene.add(terrainMesh);
      scene.add(osmGroup);

      if (useGoogle3DTiles) {
        onProgress?.('Fetching Google Photorealistic 3D Tiles...');
        // stripGround only when explicitly chosen by the caller — otherwise
        // the persisted preference resolves centrally, keeping the cache key
        // identical to the preview's (a hardcoded value here silently
        // re-baked under a different key).
        const googleGroup = await getOrBakeGoogle3DTiles(data, {
          apiKey: googleApiKey,
          errorTarget: google3DErrorTarget,
          ...(googleQuality ? { quality: googleQuality } : {}),
          ...(typeof stripGoogleGround === 'boolean' ? { stripGround: stripGoogleGround } : {}),
          // Route mode: bake ONLY the corridor (stations follow the route),
          // not the whole box — the mask below then trims almost nothing.
          // memoryCache:false lets the route export bake several chunks at once
          // (the single-slot in-memory cache can't hold more than one).
          ...(corridorMask ? {
            corridorSegment: corridorMask.segment,
            corridorHalfWidthM: corridorMask.halfWidthM,
            memoryCache: false,
          } : {}),
          // Route mode: seat this chunk on the shared route-wide vertical anchor
          // so the preview matches the .dae and adjacent chunks don't float.
          ...(Number.isFinite(googleGroundOffsetM) ? { sharedGroundOffsetM: googleGroundOffsetM } : {}),
          onProgress: (p) => {
            onProgress?.(`Google tiles: ${p.visible} loaded, ${p.downloading + p.parsing} in flight`);
            // Structured sweep progress (station/stations, tile counts) for a
            // per-chunk fill on the route map — see routeBake/routeProgress.
            options.onBakeProgress?.(p);
          },
        });
        // Surface bake telemetry (station/tile counts, bake ms) for the route
        // manifest — undefined on an IndexedDB/in-memory cache hit.
        options.onBakeStats?.(googleGroup.userData?.bakeStats);
        // Surface the effective vertical anchor so a route can capture chunk 0's
        // and share it with every other chunk (continuous seams).
        options.onGroundOffset?.(googleGroup.userData?.groundOffsetM);
        // Clone the mesh nodes (geometry/material stay shared) — the cached
        // group is owned by the bake cache and may be parented into the 3D
        // preview scene right now; scene.add() on it directly would steal it.
        // Bake Y is metres above the .ter datum; scale by unitsPerMeter to
        // match the scene-unit terrain mesh. The preview's manual z-offset
        // (metres) ships with the export.
        const googleWrapper = new THREE.Group();
        googleWrapper.name = 'GoogleTiles3D';
        for (const child of googleGroup.children) googleWrapper.add(child.clone());
        if (corridorMask) {
          onProgress?.('Masking Google tiles to corridor...');
          const maskStats = clipGroupToCorridorXZ(googleWrapper, data, corridorMask.segment, corridorMask.halfWidthM, onProgress);
          options.onMaskStats?.(maskStats);
        }
        googleWrapper.scale.y = computeUnitsPerMeter(data);
        googleWrapper.position.y = googleZOff * computeUnitsPerMeter(data);
        scene.add(googleWrapper);
      }
    }

    if (resolvedIncludeSurroundings) {
      onProgress?.('Fetching surrounding tiles for GLB...');
      const surroundingGroup = await createSurroundingMeshes(data, onProgress, maxMeshResolution);
      if (surroundingGroup) scene.add(surroundingGroup);
    }

    onProgress?.('Encoding GLB...');
    return new Promise((resolve, reject) => {
      const exporter = new GLTFExporter();
      exporter.parse(
        scene,
        (gltf) => {
          const blob = new Blob([gltf], { type: "model/gltf-binary" });
          disposeScene(scene);

          if (returnBlob) {
            onProgress?.('Done!');
            resolve(blob);
            return;
          }

          const link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          const date = new Date().toISOString().slice(0, 10);
          const lat = ((data.bounds.north + data.bounds.south) / 2).toFixed(4);
          const lng = ((data.bounds.east + data.bounds.west) / 2).toFixed(4);
          link.download = `MapNG_Model_${date}_${lat}_${lng}.glb`;
          link.click();
          URL.revokeObjectURL(link.href);
          onProgress?.('Done!');
          resolve();
        },
        (err) => { disposeScene(scene); reject(err); },
        { binary: true },
      );
    });
  } catch (err) {
    console.error("Export failed:", err);
    if (returnBlob) throw err;
  }
};
