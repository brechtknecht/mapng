/** @layer flow */
// Collada (.dae) export orchestrator: assemble the scene (center terrain + OSM
// group + optional Google 3D tiles + surroundings), encode with ColladaExporter,
// then package the .dae + textures into a .zip and download/return the blob.
import * as THREE from "three";
import JSZip from "jszip";
import { ColladaExporter } from "../ColladaExporter.js";
import { getOrBakeGoogle3DTiles, computeUnitsPerMeter, getGoogleTilesZOffset } from "../google3dTiles.js";
import { createTerrainMesh } from "./terrainMesh.js";
import { createOSMGroup } from "./osmMeshes.js";
import { createSurroundingMeshes } from "./surroundingMeshes.js";
import { disposeScene } from "./sceneUtils.js";

export const exportToDAE = async (data, options = {}) => {
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
        const googleGroup = await getOrBakeGoogle3DTiles(data, {
          apiKey: googleApiKey,
          errorTarget: google3DErrorTarget,
          ...(googleQuality ? { quality: googleQuality } : {}),
          ...(typeof stripGoogleGround === 'boolean' ? { stripGround: stripGoogleGround } : {}),
          onProgress: (p) => onProgress?.(`Google tiles: ${p.visible} loaded, ${p.downloading + p.parsing} in flight`),
        });
        // Same shared-cache handling as the GLB path above: clone the mesh
        // nodes and scale metres-Y into scene units (+ the preview z-offset).
        const googleWrapper = new THREE.Group();
        googleWrapper.name = 'GoogleTiles3D';
        for (const child of googleGroup.children) googleWrapper.add(child.clone());
        googleWrapper.scale.y = computeUnitsPerMeter(data);
        googleWrapper.position.y = googleZOff * computeUnitsPerMeter(data);
        scene.add(googleWrapper);
      }
    }

    if (resolvedIncludeSurroundings) {
      onProgress?.('Fetching surrounding tiles for DAE...');
      const surroundingGroup = await createSurroundingMeshes(data, onProgress, maxMeshResolution);
      if (surroundingGroup) {
        surroundingGroup.name = "surroundings";
        scene.add(surroundingGroup);
      }
    }

    let meshCount = 0;
    scene.traverse((node) => {
      if (node?.isMesh) meshCount += 1;
    });
    if (meshCount === 0) {
      throw new Error('No mesh data available for DAE export.');
    }

    // Ensure all matrix values are up to date throughout hierarchy
    scene.updateMatrixWorld(true);

    onProgress?.('Encoding Collada...');
    const exporter = new ColladaExporter();
    const result = exporter.parse(scene, undefined, {
      textureDirectory: 'textures',
      version: '1.4.1',
    });

    // We MUST process the result BEFORE disposing the scene,
    // just in case any textures need to be re-read (though parse is usually sync).
    const daeBlob = result?.data;
    if (!daeBlob) {
      throw new Error('Collada exporter returned no model data.');
    }

    onProgress?.('Packaging DAE archive...');
    const zip = new JSZip();
    zip.file('model.dae', daeBlob);

    if (result.textures && result.textures.length > 0) {
      for (const tex of result.textures) {
        // Ensure path alignment
        const relDir = tex.directory ? (tex.directory.endsWith('/') ? tex.directory : tex.directory + '/') : '';
        zip.file(`${relDir}${tex.name}.${tex.ext}`, tex.data);
      }
    }
    const finalBlob = await zip.generateAsync({ type: 'blob' });

    disposeScene(scene);

    if (returnBlob) {
      onProgress?.('Done!');
      return finalBlob;
    }

    const link = document.createElement('a');
    link.href = URL.createObjectURL(finalBlob);
    const date = new Date().toISOString().slice(0, 10);
    const lat = ((data.bounds.north + data.bounds.south) / 2).toFixed(4);
    const lng = ((data.bounds.east + data.bounds.west) / 2).toFixed(4);
    const ext = '.dae.zip';
    link.download = `MapNG_Model_${date}_${lat}_${lng}${ext}`;
    link.click();
    URL.revokeObjectURL(link.href);

    onProgress?.('Done!');
  } catch (err) {
    console.error("DAE Export failed:", err);
    throw err;
  }
};
