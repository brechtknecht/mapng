/** @layer io */
// Surrounding-tile terrain meshes for GLB/DAE export. Fetches the 8 neighbour
// tiles (network), builds seam-blended terrain planes that lock to the centre
// tile's edge, and textures them with satellite imagery.
import * as THREE from "three";
import { clamp } from '@mapng/geo';
import { fetchSurroundingTiles, POSITIONS } from "@mapng/terrain/surroundingTiles";
import { SCENE_SIZE, getHeightAtScenePos } from "./sceneProjection.js";

const SURROUND_OFFSETS = {
  NW: { x: -1, z: -1 },
  N:  { x:  0, z: -1 },
  NE: { x:  1, z: -1 },
  W:  { x: -1, z:  0 },
  E:  { x:  1, z:  0 },
  SW: { x: -1, z:  1 },
  S:  { x:  0, z:  1 },
  SE: { x:  1, z:  1 },
};

const GLB_SURROUND_SAT_ZOOM = 17;
const SEAM_BLEND_WIDTH_UNITS = SCENE_SIZE * 0.42;
const EXPORT_SURROUND_PROFILE = {
  fetchResolutionCap: 4096,
  seamEdgeResolution: 768,
  depthResolution: 128,
  cornerResolution: 256,
  anisotropy: 16,
};
const SURROUND_TILE_MAX_NODATA_RATIO = 0.25;


const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};

const getSeamContext = (data, globalX, globalZ) => {
  const half = SCENE_SIZE / 2;

  // Point on center tile boundary nearest to current vertex.
  const seamX = clamp(globalX, -half, half);
  const seamZ = clamp(globalZ, -half, half);

  // Euclidean distance from current point to center-tile seam.
  const dx = globalX - seamX;
  const dz = globalZ - seamZ;
  const distanceToSeam = Math.sqrt(dx * dx + dz * dz);

  // 11-tap filter along dominant seam tangent to stabilize seam elevation.
  const isHorizontalSeam = Math.abs(dz) > Math.abs(dx);
  const meshStep = SCENE_SIZE / EXPORT_SURROUND_PROFILE.seamEdgeResolution;
  const samples = 11;
  let totalH = 0;
  for (let s = 0; s < samples; s++) {
    const t = (s / (samples - 1)) - 0.5;
    const offX = isHorizontalSeam ? (t * meshStep * 2.0) : 0;
    const offZ = !isHorizontalSeam ? (t * meshStep * 2.0) : 0;
    totalH += getHeightAtScenePos(data, seamX + offX, seamZ + offZ);
  }

  return {
    seamX,
    seamZ,
    distanceToSeam,
    centerEdgeH: totalH / samples,
  };
};

const blendToCenterSeamHeight = (data, tileData, offset, globalX, globalZ, surroundingHeight, unitsPerMeter, exaggeration) => {
  const half = SCENE_SIZE / 2;
  const seam = getSeamContext(data, globalX, globalZ);

  if (seam.distanceToSeam > SEAM_BLEND_WIDTH_UNITS) return surroundingHeight;

  // Surround height at the corresponding boundary point in surrounding tile UV.
  const localX = seam.seamX - offset.x * SCENE_SIZE;
  const localZ = seam.seamZ - offset.z * SCENE_SIZE;
  const uEdge = (localX + half) / SCENE_SIZE;
  const vEdge = (localZ + half) / SCENE_SIZE;
  const surroundingRawH = sampleSurroundingHeight(tileData, uEdge, vEdge);
  const surroundingEdgeH = (surroundingRawH - data.minHeight) * unitsPerMeter * exaggeration;

  // Compute vertical correction at seam.
  const errorAtSeam = seam.centerEdgeH - surroundingEdgeH;

  // Taper correction to zero away from seam.
  const plateau = 0.5;
  const blend = smoothstep(plateau, SEAM_BLEND_WIDTH_UNITS, seam.distanceToSeam);

  return surroundingHeight + errorAtSeam * (1 - blend);
};

const buildFlatSeamedFallbackHeight = (data, globalX, globalZ, flatHeight = 0) => {
  const seam = getSeamContext(data, globalX, globalZ);
  // Keep the seam locked to center terrain and fade to flat across one tile depth.
  const fade = smoothstep(0, SCENE_SIZE, seam.distanceToSeam);
  return seam.centerEdgeH * (1 - fade) + flatHeight * fade;
};

const sampleSurroundingHeightRaw = (tileData, u, v) => {
  const w = tileData.width;
  const h = tileData.height;
  const x = clamp(u * (w - 1), 0, Math.max(0, w - 1));
  const y = clamp(v * (h - 1), 0, Math.max(0, h - 1));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const dx = x - x0;
  const dy = y - y0;

  const index = (ix, iy) => iy * w + ix;
  const h00Raw = tileData.heightMap[index(x0, y0)];
  const h10Raw = tileData.heightMap[index(x1, y0)];
  const h01Raw = tileData.heightMap[index(x0, y1)];
  const h11Raw = tileData.heightMap[index(x1, y1)];

  const h00 = h00Raw < -10000 ? tileData.minHeight : h00Raw;
  const h10 = h10Raw < -10000 ? tileData.minHeight : h10Raw;
  const h01 = h01Raw < -10000 ? tileData.minHeight : h01Raw;
  const h11 = h11Raw < -10000 ? tileData.minHeight : h11Raw;

  const top = (1 - dx) * h00 + dx * h10;
  const bottom = (1 - dx) * h01 + dx * h11;
  return (1 - dy) * top + dy * bottom;
};

const sampleSurroundingHeight = (tileData, u, v) => {
  const center = sampleSurroundingHeightRaw(tileData, u, v);
  if (!Number.isFinite(center)) return tileData.minHeight;

  // Second-stage outlier suppression at mesh-sample time.
  // This catches isolated Terrarium spikes that can slip through tile decoding.
  const du = 1 / Math.max(8, tileData.width - 1);
  const dv = 1 / Math.max(8, tileData.height - 1);
  const neighbors = [];

  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      if (ox === 0 && oy === 0) continue;
      const nu = clamp(u + ox * du, 0, 1);
      const nv = clamp(v + oy * dv, 0, 1);
      const n = sampleSurroundingHeightRaw(tileData, nu, nv);
      if (Number.isFinite(n)) neighbors.push(n);
    }
  }

  if (neighbors.length < 5) return center;
  neighbors.sort((a, b) => a - b);
  const median = neighbors[Math.floor(neighbors.length / 2)];

  // Robust local spread estimate (median absolute deviation) so a single
  // extreme sample cannot relax the threshold for the whole tile.
  const deviations = neighbors.map((n) => Math.abs(n - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] || 0;
  const spikeDelta = Math.max(8, mad * 6);
  const isAbsurd = center > 12000 || center < -12000;
  if (isAbsurd || Math.abs(center - median) > spikeDelta) {
    tileData._meshSpikeSuppressions = (tileData._meshSpikeSuppressions || 0) + 1;
    return median;
  }
  return center;
};

export const createSurroundingMeshes = async (data, onProgress, maxMeshResolution = 128, fetchOptions = {}) => {
  try {
    const allPositions = POSITIONS.map(p => p.key);
    const resolutionCap = fetchOptions.fetchResolutionCap ?? EXPORT_SURROUND_PROFILE.fetchResolutionCap;
    const surroundResolution = Math.min(
      Math.max(256, data.width || 1024),
      resolutionCap,
    );
    const tileOptions = { useNativeTerrainGrid: true };
    if (fetchOptions.includeSatellite !== undefined) tileOptions.includeSatellite = fetchOptions.includeSatellite;
    if (fetchOptions.elevationSource) tileOptions.elevationSource = fetchOptions.elevationSource;
    if (fetchOptions.gpxzApiKey) tileOptions.gpxzApiKey = fetchOptions.gpxzApiKey;
    const satZoom = fetchOptions.satelliteZoom !== undefined ? fetchOptions.satelliteZoom : GLB_SURROUND_SAT_ZOOM;
    const results = await fetchSurroundingTiles(
      data.bounds,
      allPositions,
      surroundResolution,
      satZoom,
      onProgress,
      undefined,
      tileOptions,
    );

    const latRad = ((data.bounds.north + data.bounds.south) / 2 * Math.PI) / 180;
    const metersPerDegree = 111320 * Math.cos(latRad);
    const realWidthMeters = (data.bounds.east - data.bounds.west) * metersPerDegree;
    const unitsPerMeter = SCENE_SIZE / realWidthMeters;
    const EXAGGERATION = 1.0;

    // Match center-tile edge tessellation to avoid T-junction cracks along seams.
    const centerStride = Math.max(1, Math.ceil(Math.max(data.width, data.height) / Math.max(1, maxMeshResolution)));
    const centerSegsX = Math.max(4, Math.floor((data.width - 1) / centerStride));
    const centerSegsY = Math.max(4, Math.floor((data.height - 1) / centerStride));

    const group = new THREE.Group();
    group.name = 'surrounding_terrain';

    const diagnosticsSummary = {
      requestedTiles: Object.keys(results || {}).length,
      builtTiles: 0,
      directTiles: 0,
      flatFallbackTiles: 0,
      skippedTiles: 0,
      maxNoDataRatio: SURROUND_TILE_MAX_NODATA_RATIO,
      tiles: {},
    };
    group.userData.surroundingDiagnostics = diagnosticsSummary;

    if (!results || Object.keys(results).length === 0) {
      console.warn('[DAE/GLB Surroundings] No results returned from fetch');
      return group;
    }

    for (const [pos, tileData] of Object.entries(results)) {
      const offset = SURROUND_OFFSETS[pos];
      if (!offset || !tileData) continue;

      const diagnostics = tileData.diagnostics || null;
      const noDataRatio = Number.isFinite(diagnostics?.noDataRatio) ? diagnostics.noDataRatio : 0;
      const useFlatFallback = diagnostics?.allInvalid || noDataRatio > SURROUND_TILE_MAX_NODATA_RATIO;
      diagnosticsSummary.tiles[pos] = {
        mode: useFlatFallback ? 'flat-fallback' : 'direct',
        validSamples: diagnostics?.validSamples ?? null,
        noDataSamples: diagnostics?.noDataSamples ?? null,
        totalSamples: diagnostics?.totalSamples ?? null,
        noDataRatio: Number.isFinite(noDataRatio) ? noDataRatio : null,
        spikeReplacements: Number.isFinite(diagnostics?.spikeReplacements) ? diagnostics.spikeReplacements : 0,
        meshSpikeSuppressions: 0,
      };

      if (useFlatFallback) {
        diagnosticsSummary.flatFallbackTiles++;
        console.warn(
          `[GLB Surroundings] Tile ${pos}: using flat fallback (valid=${diagnostics?.validSamples ?? 'n/a'}, noData=${diagnostics?.noDataSamples ?? 'n/a'}, ratio=${diagnostics?.noDataRatio ?? 'n/a'})`
        );
      } else {
        diagnosticsSummary.directTiles++;
      }

      onProgress?.(`Building mesh for tile ${pos}...`);

      const w = tileData.width;
      const h = tileData.height;
      const maxSegX = Math.max(4, w - 1);
      const maxSegY = Math.max(4, h - 1);
      const isCornerTile = offset.x !== 0 && offset.z !== 0;
      const seamRunsAlongX = offset.x === 0 && offset.z !== 0;
      const seamRunsAlongY = offset.z === 0 && offset.x !== 0;

      let segsX;
      let segsY;

      if (isCornerTile) {
        // Corner edges must match adjacent side tiles on both axes.
        segsX = Math.min(maxSegX, EXPORT_SURROUND_PROFILE.depthResolution);
        segsY = Math.min(maxSegY, EXPORT_SURROUND_PROFILE.depthResolution);
      } else if (seamRunsAlongX) {
        // N/S tiles share X-edge with center; match center X segmentation.
        segsX = Math.min(maxSegX, centerSegsX);
        segsY = Math.min(maxSegY, EXPORT_SURROUND_PROFILE.depthResolution);
      } else if (seamRunsAlongY) {
        segsX = Math.min(maxSegX, EXPORT_SURROUND_PROFILE.depthResolution);
        // E/W tiles share Y-edge with center; match center Y segmentation.
        segsY = Math.min(maxSegY, centerSegsY);
      } else {
        segsX = Math.min(maxSegX, EXPORT_SURROUND_PROFILE.depthResolution);
        segsY = Math.min(maxSegY, EXPORT_SURROUND_PROFILE.depthResolution);
      }

      segsX = Math.max(4, Math.floor(segsX));
      segsY = Math.max(4, Math.floor(segsY));

      const geo = new THREE.PlaneGeometry(SCENE_SIZE, SCENE_SIZE, segsX, segsY);
      const verts = geo.attributes.position.array;

      for (let i = 0; i < verts.length / 3; i++) {
        const col = i % (segsX + 1);
        const row = Math.floor(i / (segsX + 1));

        const u = col / segsX;
        const v = row / segsY;

        const elev = sampleSurroundingHeight(tileData, u, v);

        const localX = u * SCENE_SIZE - SCENE_SIZE / 2;
        const localZ = v * SCENE_SIZE - SCENE_SIZE / 2;
        const globalX = localX + offset.x * SCENE_SIZE;
        const globalZ = localZ + offset.z * SCENE_SIZE;
        let blendedHeight;
        if (useFlatFallback) {
          blendedHeight = buildFlatSeamedFallbackHeight(data, globalX, globalZ, 0);
        } else {
          const surroundingHeight = (elev - data.minHeight) * unitsPerMeter * EXAGGERATION;
          blendedHeight = blendToCenterSeamHeight(
            data,
            tileData,
            offset,
            globalX,
            globalZ,
            surroundingHeight,
            unitsPerMeter,
            EXAGGERATION,
          );
        }

        verts[i * 3]     = localX;
        verts[i * 3 + 1] = -localZ;
        verts[i * 3 + 2] = blendedHeight;
      }

      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
        color: 0xffffff,
      });

      // Load satellite texture
      if (tileData.satelliteDataUrl) {
        try {
          const tex = await new Promise((resolve, reject) => {
            new THREE.TextureLoader().load(
              tileData.satelliteDataUrl,
              (t) => {
                t.colorSpace = THREE.SRGBColorSpace;
                t.generateMipmaps = false;
                t.minFilter = THREE.LinearFilter;
                t.magFilter = THREE.LinearFilter;
                t.anisotropy = EXPORT_SURROUND_PROFILE.anisotropy;
                resolve(t);
              },
              undefined,
              reject,
            );
          });
          mat.map = tex;
        } catch {
          // texture load failed, use solid color
        }
      }

      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(offset.x * SCENE_SIZE, 0, offset.z * SCENE_SIZE);
      mesh.updateMatrixWorld();
      mesh.name = `terrain_${pos}`;
      mesh.receiveShadow = true;
      group.add(mesh);

      diagnosticsSummary.tiles[pos].meshSpikeSuppressions = Number(tileData._meshSpikeSuppressions || 0);
      diagnosticsSummary.builtTiles++;
    }

    return group;
  } catch (e) {
    console.error('[GLB Surroundings] Failed:', e);
    return null;
  }
};
