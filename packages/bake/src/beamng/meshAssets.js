/** @layer io */
// Collada (.dae) asset generation: OSM visual objects, building collision
// proxies, and the surrounding satellite-textured terrain backdrop. Uses THREE
// + ColladaExporter + scene3d mesh builders. Imports the scene3d *leaf* modules
// directly (NOT the export3d barrel) so this path never pulls a WebGLRenderer.
// Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ColladaExporter } from '../ColladaExporter.js';
import { createOSMGroup } from '../scene3d/osmMeshes.js';
import { createSurroundingMeshes } from '../scene3d/surroundingMeshes.js';
import { SCENE_SIZE } from '../scene3d/sceneProjection.js';
import { geoToWorldPoint } from './worldMath.js';

export async function generateOSMObjectsDAE(terrainData, worldSize, { hideBuildingVisuals = false } = {}) {
  if (!terrainData.osmFeatures?.length) return null;

  // Barriers are exported as native TSStatic objects in BeamNG scene JSON,
  // not baked into the generic OSM DAE mesh.
  const osmGroup = createOSMGroup(terrainData, {
    includeVegetation: false,
    includeBarriers: false,
    // Keep exact building footprints in exported levels.
    simplifyBuildingFootprints: false,
  });

  // Verify there is at least one mesh child — an empty group means no features
  // were of a type that produces geometry (e.g. only road centrelines).
  let hasMesh = false;
  osmGroup.traverse(c => { if (c.isMesh) hasMesh = true; });
  if (!hasMesh) return null;

  // Transform: scene-space (Y-up, normalised) → BeamNG world-space (Z-up, metres)
  const s = worldSize / SCENE_SIZE;
  const transformMatrix = new THREE.Matrix4().set(
    s,  0,  0,  0,   // beamX = sceneX * s
    0,  0, -s,  0,   // beamY = -sceneZ * s
    0,  s,  0,  0,   // beamZ = sceneY * s
    0,  0,  0,  1,
  );

  let buildingCollisionMesh = null;
  const hiddenVisuals = [];

  osmGroup.traverse(child => {
    if (!child.isMesh) return;

    // Bake the coordinate transform into each geometry's vertex data first.
    // applyMatrix4 handles positions and derives the correct normal matrix.
    child.geometry.applyMatrix4(transformMatrix);

    // Strip texture maps (3D-preview assets) and name materials for BeamNG.
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(m => {
      if (!m) return;
      m.map = null;
      m.normalMap = null;
      m.roughnessMap = null;
      m.metalnessMap = null;
      m.name = 'osm_object';
    });

    // Clone the already-transformed building geometry as the collision mesh.
    // Must be cloned AFTER applyMatrix4 so it is in BeamNG world coordinates.
    // BeamNG identifies collision geometry by the <geometry id> starting with "Col".
    const isBuildingMesh = String(child.name || '').toLowerCase() === 'buildings';
    if (isBuildingMesh && !buildingCollisionMesh) {
      const collisionGeom = child.geometry.clone();
      collisionGeom.name = 'Colmesh-1';
      buildingCollisionMesh = new THREE.Mesh(
        collisionGeom,
        new THREE.MeshBasicMaterial({ name: 'osm_object', color: 0xffffff }),
      );
      buildingCollisionMesh.name = 'Colmesh-1';
    }
    // Google photogrammetry replaces the extruded boxes VISUALLY, but the
    // boxes stay in Colmesh-1: simple, watertight collision is both cheaper
    // and more reliable than colliding against raw photogrammetry.
    if (isBuildingMesh && hideBuildingVisuals) {
      hiddenVisuals.push(child);
    }
  });

  if (hiddenVisuals.length > 0) {
    for (const mesh of hiddenVisuals) mesh.parent?.remove(mesh);
    console.info(
      `[BeamNG export] OSM building visuals hidden (${hiddenVisuals.length} mesh) — ` +
      'collision boxes kept in Colmesh-1, Google tiles provide the visuals',
    );
  }

  // Always wrap in the BeamNG scene hierarchy:
  // Working BeamNG structure (matches flag reference asset):
  //   base00 > start01 > [visual meshes] + Colmesh-1
  // base00 must be the TOP-LEVEL node directly inside <visual_scene>.
  // Passing a THREE.Scene to the exporter would wrap base00 in an extra
  // unnamed node, breaking BeamNG's strict node-depth requirements.
  const base00 = new THREE.Group();
  base00.name = 'base00';
  const start01 = new THREE.Group();
  start01.name = 'start01';
  start01.add(osmGroup);
  if (buildingCollisionMesh) start01.add(buildingCollisionMesh);
  base00.add(start01);

  // Compute world matrices with base00 as the root (not a Scene).
  base00.updateMatrixWorld(true);

  // Pass base00 directly so it becomes the top-level node in <visual_scene>,
  // matching the reference flag asset structure.
  const result = new ColladaExporter().parse(base00, undefined, { version: '1.4.1', upAxis: 'Z_UP' });
  if (!result?.data) return null;
  return result.data;
}

/**
 * Generate a collision-only Collada (.dae) for OSM buildings.
 *
 * BeamNG can be picky when visual + collision meshes are mixed in a single
 * object graph. This emits a dedicated Colmesh-only DAE and is referenced by a
 * hidden TSStatic collision object in the level scene.
 */
export async function generateOSMBuildingsCollisionDAE(terrainData, worldSize) {
  if (!terrainData?.osmFeatures?.length) return null;

  const buildings = terrainData.osmFeatures.filter((feature) => (
    feature?.type === 'building' && Array.isArray(feature.geometry) && feature.geometry.length >= 3
  ));
  if (buildings.length === 0) return null;

  const parseHeightMeters = (tags = {}) => {
    const parseNum = (value) => {
      if (value === undefined || value === null) return NaN;
      const raw = String(value).trim().toLowerCase();
      if (!raw) return NaN;
      if (raw.includes('ft')) {
        const ft = Number.parseFloat(raw.replace('ft', '').trim());
        return Number.isFinite(ft) && ft > 0 ? ft * 0.3048 : NaN;
      }
      const m = Number.parseFloat(raw.replace('m', '').trim());
      return Number.isFinite(m) && m > 0 ? m : NaN;
    };

    const explicitHeight = parseNum(tags.height);
    if (Number.isFinite(explicitHeight)) return Math.min(220, Math.max(2.5, explicitHeight));

    const levels = Number.parseFloat(tags['building:levels'] ?? tags.levels);
    if (Number.isFinite(levels) && levels > 0) {
      const roof = Number.parseFloat(tags['roof:levels'] ?? tags['building:roof:levels'] ?? 0);
      return Math.min(220, Math.max(2.5, (levels + Math.max(0, roof)) * 3.1));
    }

    const type = String(tags.building || '').toLowerCase();
    if (['industrial', 'warehouse', 'retail', 'commercial'].includes(type)) return 10;
    if (['garage', 'hut', 'shed'].includes(type)) return 4;
    return 7.5;
  };

  const proxyGeometries = [];
  const maxCollisionProxies = 12000;
  const squareSize = worldSize / terrainData.width;

  for (let i = 0; i < buildings.length && proxyGeometries.length < maxCollisionProxies; i++) {
    const feature = buildings[i];
    const geometry = Array.isArray(feature.geometry) ? feature.geometry : [];
    if (geometry.length < 3) continue;

    let ring = geometry;
    if (geometry.length > 3) {
      const first = geometry[0];
      const last = geometry[geometry.length - 1];
      if (first?.lat === last?.lat && first?.lng === last?.lng) {
        ring = geometry.slice(0, -1);
      }
    }
    if (ring.length < 3) continue;

    const worldPoints = ring.map((pt) => geoToWorldPoint(pt.lat, pt.lng, terrainData, squareSize, 0));

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minTerrainZ = Number.POSITIVE_INFINITY;

    for (let p = 0; p < worldPoints.length; p++) {
      const [x, y, z] = worldPoints[p];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      minTerrainZ = Math.min(minTerrainZ, z);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minTerrainZ)) continue;

    const spanX = Math.max(0.8, maxX - minX);
    const spanY = Math.max(0.8, maxY - minY);
    const heightZ = parseHeightMeters(feature.tags || {});
    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = minTerrainZ + (heightZ * 0.5);

    // BoxGeometry axes are X/Y/Z; we map directly to BeamNG world X/Y/Z.
    const box = new THREE.BoxGeometry(spanX, spanY, heightZ);
    box.translate(centerX, centerY, centerZ);
    proxyGeometries.push(box.index ? box.toNonIndexed() : box);
  }

  if (proxyGeometries.length === 0) return null;

  const mergedCollisionGeometry = mergeGeometries(proxyGeometries, false);
  proxyGeometries.forEach((g) => g.dispose());
  if (!mergedCollisionGeometry) return null;

  // Name the geometry so ColladaExporter generates id="Colmesh-1-mesh" —
  // BeamNG identifies collision geometry by the <geometry> element's id
  // starting with "Col" (matches the same convention as the node name).
  mergedCollisionGeometry.name = 'Colmesh-1';

  const collisionMesh = new THREE.Mesh(
    mergedCollisionGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  collisionMesh.name = 'Colmesh-1';
  collisionMesh.material.name = 'osm_object';

  const base00 = new THREE.Group();
  base00.name = 'base00';
  const collisionMarker = new THREE.Group();
  collisionMarker.name = 'collision-1';
  const start01 = new THREE.Group();
  start01.name = 'start01';
  start01.add(collisionMesh);
  base00.add(collisionMarker);
  base00.add(start01);

  const scene = new THREE.Scene();
  scene.add(base00);
  scene.updateMatrixWorld(true);

  const result = new ColladaExporter().parse(scene, undefined, { version: '1.4.1', upAxis: 'Z_UP' });
  if (!result?.data) return null;
  return result.data;
}

/**
 * Generate a Collada (.dae) Blob containing the 8 surrounding terrain tiles
 * (NW, N, NE, W, E, SW, S, SE) textured with satellite imagery at zoom 15.
 *
 * Fetches surrounding tile elevation + satellite data (zoom 15, max 1024px),
 * builds a Three.js mesh group with per-tile satellite textures, applies the
 * scene-space → BeamNG world-space coordinate transform, and exports as DAE.
 *
 * Each tile gets its own material named `backdrop_${pos}` (e.g. backdrop_NW).
 * The ColladaExporter packages the satellite images as `textures/backdrop_*.png`
 * and returns them in result.textures — these are saved alongside the DAE in
 * art/shapes/textures/ in the level zip.
 *
 * Returns { daeBlob, textureFiles, diagnostics } where textureFiles is the array from
 * ColladaExporter (each entry: { name, ext, data: Uint8Array, directory }).
 * Returns null if no surrounding data could be fetched.
 */
export async function generateTerrainBackdropDAE(terrainData, worldSize, options = {}) {
  // Zoom 15 gives ~4m/px satellite imagery; 1024px cap avoids canvas-size
  // failures at large resolutions while still giving usable texture quality.
  const surroundingGroup = await createSurroundingMeshes(terrainData, null, 128, {
    fetchResolutionCap: 1024,
    includeSatellite: true,
    satelliteZoom: 15,
    elevationSource: options.elevationSource || 'global30m',
    gpxzApiKey: options.gpxzApiKey || '',
  });
  if (!surroundingGroup) return null;

  let hasMesh = false;
  surroundingGroup.traverse(c => { if (c.isMesh) hasMesh = true; });
  if (!hasMesh) return null;

  // Place the group in a temporary scene so scene.updateMatrixWorld() propagates
  // the correct matrixWorld to every child (group at origin → mesh.matrixWorld
  // equals the mesh's own local matrix: rotation.x = -π/2 + position offset).
  const scene = new THREE.Scene();
  scene.add(surroundingGroup);
  scene.updateMatrixWorld(true);

  const s = worldSize / SCENE_SIZE;
  const transformMatrix = new THREE.Matrix4().set(
    s,  0,  0,  0,   // beamX = sceneX * s
    0,  0, -s,  0,   // beamY = -sceneZ * s
    0,  s,  0,  0,   // beamZ = sceneY * s
    0,  0,  0,  1,
  );

  surroundingGroup.traverse(child => {
    if (!child.isMesh) return;

    // Derive tile position name from mesh name (e.g. "terrain_NW" → "NW").
    const pos = child.name.replace('terrain_', '') || 'tile';
    const matName = `backdrop_${pos}`;

    // Name the material and its texture map for the ColladaExporter and for
    // BeamNG's material resolution via main.materials.json.
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    mats.forEach(m => {
      if (!m) return;
      m.name = matName;
      if (m.map) m.map.name = matName;
      // Strip non-diffuse maps — they don't belong in the level file.
      m.normalMap = null;
      m.roughnessMap = null;
      m.metalnessMap = null;
    });

    // Bake world transform (rotation + tile offset) into geometry vertex data,
    // then apply the BeamNG coordinate transform on top.
    child.geometry.applyMatrix4(child.matrixWorld);
    child.geometry.applyMatrix4(transformMatrix);

    // Reset node-level transform to identity — geometry now has everything baked.
    child.position.set(0, 0, 0);
    child.rotation.set(0, 0, 0);
    child.scale.set(1, 1, 1);
    child.updateMatrix();
    child.matrixWorld.identity();
  });

  const result = new ColladaExporter().parse(scene, undefined, {
    textureDirectory: 'textures',
    version: '1.4.1',
    upAxis: 'Z_UP',
  });
  if (!result?.data) return null;
  return {
    daeBlob: result.data,
    textureFiles: result.textures ?? [],
    diagnostics: surroundingGroup.userData?.surroundingDiagnostics ?? null,
  };
}
