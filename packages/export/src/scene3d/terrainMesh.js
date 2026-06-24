/** @layer io */
// Center-tile terrain mesh builder. Tessellates the heightmap into a textured
// THREE plane; loads the chosen texture via THREE.TextureLoader (network/blob),
// so this is an io module.
import * as THREE from "three";
import { SCENE_SIZE } from "./sceneProjection.js";

/**
 * Helper to generate the Three.js Mesh from TerrainData.
 * Shared by exporters to ensure identical output.
 */
export const resolveTerrainTextureUrl = (data, centerTextureType = 'osm') => {
  const textureByType = {
    satellite: data?.satelliteTextureUrl || null,
    osm: data?.osmTextureUrl || null,
    hybrid: data?.hybridTextureUrl || null,
    none: null,
  };

  const requested = textureByType[centerTextureType];
  if (requested || centerTextureType === 'none') return requested;

  return (
    textureByType.osm ||
    textureByType.hybrid ||
    textureByType.satellite ||
    null
  );
};

export const createTerrainMesh = async (data, maxMeshResolution = 1024, centerTextureType = 'osm') => {
  return new Promise((resolve, reject) => {
    try {
      // 1. Create Geometry
      const baseStride = Math.ceil(
        Math.max(data.width, data.height) / maxMeshResolution,
      );
      const stride = Math.max(baseStride, 1);

      const segmentsX = Math.floor((data.width - 1) / stride);
      const segmentsY = Math.floor((data.height - 1) / stride);

      const geometry = new THREE.PlaneGeometry(
        SCENE_SIZE,
        SCENE_SIZE,
        segmentsX,
        segmentsY,
      );
      const vertices = geometry.attributes.position.array;

      // Calculate scale factor (units per meter)
      const latRad =
        (((data.bounds.north + data.bounds.south) / 2) * Math.PI) / 180;
      const metersPerDegree = 111320 * Math.cos(latRad);
      const realWidthMeters =
        (data.bounds.east - data.bounds.west) * metersPerDegree;
      const unitsPerMeter = SCENE_SIZE / realWidthMeters;
      const EXAGGERATION = 1.0;

      // Apply heightmap data to vertices
      for (let i = 0; i < vertices.length / 3; i++) {
        const col = i % (segmentsX + 1);
        const row = Math.floor(i / (segmentsX + 1));

        // Use normalized mapping so outer vertices always land on the exact
        // source-grid boundary even when (size-1) is not divisible by stride.
        const mapCol = Math.min(
          data.width - 1,
          Math.round((col / Math.max(1, segmentsX)) * (data.width - 1)),
        );
        const mapRow = Math.min(
          data.height - 1,
          Math.round((row / Math.max(1, segmentsY)) * (data.height - 1)),
        );

        const dataIndex = mapRow * data.width + mapCol;

        const u = mapCol / (data.width - 1);
        const v = mapRow / (data.height - 1);

        // Manually position X and Y to ensure they exactly match the heightmap's bounds
        // and align perfectly with surrounding tiles at the extreme boundaries.
        vertices[i * 3]     = (u * SCENE_SIZE) - (SCENE_SIZE / 2);
        vertices[i * 3 + 1] = -((v * SCENE_SIZE) - (SCENE_SIZE / 2));

        // Apply height (Z becomes Y after rotation.x = -PI/2)
        // @ts-ignore
        vertices[i * 3 + 2] =
          (data.heightMap[dataIndex] - data.minHeight) *
          unitsPerMeter *
          EXAGGERATION;
      }

      geometry.computeVertexNormals();

      // 2. Create Material
      const material = new THREE.MeshStandardMaterial({
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
        color: 0xffffff,
      });

      // 3. Helper to finalize mesh with texture
      const finalize = (tex) => {
        if (tex) {
          material.map = tex;
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "center_terrain";
        // Rotate to make it lie flat (Y-up) in standard 3D viewers
        mesh.rotation.x = -Math.PI / 2;
        mesh.updateMatrixWorld();
        resolve(mesh);
      };

      // 4. Load Texture (Async)
      const textureUrl = resolveTerrainTextureUrl(data, centerTextureType);
      if (textureUrl) {
        const loader = new THREE.TextureLoader();
        loader.load(
          textureUrl,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.minFilter = THREE.LinearFilter;
            tex.magFilter = THREE.LinearFilter;
            finalize(tex);
          },
          undefined,
          (err) => {
            console.warn("Failed to load texture, exporting mesh only.", err);
            finalize();
          },
        );
      } else {
        finalize();
      }
    } catch (e) {
      reject(e);
    }
  });
};
