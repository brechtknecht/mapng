import * as THREE from 'three';
import { TilesRenderer, GoogleCloudAuthPlugin, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { createMetricProjector } from './geoUtils.js';

// Mirror export3d.js — kept local to avoid a circular import.
const SCENE_SIZE = 100;

const sampleHeightAtScene = (data, x, z) => {
  const half = SCENE_SIZE / 2;
  const u = Math.max(0, Math.min(1, (x + half) / SCENE_SIZE));
  const v = Math.max(0, Math.min(1, (z + half) / SCENE_SIZE));
  const localX = u * (data.width - 1);
  const localZ = v * (data.height - 1);
  const x0 = Math.floor(localX);
  const x1 = Math.min(x0 + 1, data.width - 1);
  const y0 = Math.floor(localZ);
  const y1 = Math.min(y0 + 1, data.height - 1);
  const wx = localX - x0;
  const wy = localZ - y0;
  const hm = data.heightMap;
  const w = data.width;
  const minH = data.minHeight;
  const sample = (i) => (hm[i] < -10000 ? minH : hm[i]);
  const h00 = sample(y0 * w + x0);
  const h10 = sample(y0 * w + x1);
  const h01 = sample(y1 * w + x0);
  const h11 = sample(y1 * w + x1);
  return (
    h00 * (1 - wx) * (1 - wy) +
    h10 * wx * (1 - wy) +
    h01 * (1 - wx) * wy +
    h11 * wx * wy
  );
};

const computeUnitsPerMeter = (data) => {
  const latRad = (((data.bounds.north + data.bounds.south) / 2) * Math.PI) / 180;
  const metersPerDegree = 111320 * Math.cos(latRad);
  const realWidthMeters = (data.bounds.east - data.bounds.west) * metersPerDegree;
  return SCENE_SIZE / realWidthMeters;
};

/**
 * Fetch Google Photorealistic 3D Tiles covering the AOI in `data.bounds`, transform
 * into mapng's scene coordinate system, optionally strip ground tris, and return a
 * THREE.Group ready to add to the export scene.
 *
 * @param {object} data terrain data with .bounds, .width, .height, .heightMap, .minHeight
 * @param {object} options
 *   @param {string} options.apiKey Google Maps Platform API key with Map Tiles API enabled
 *   @param {number} [options.errorTarget=8] lower = higher detail, more requests, slower bake
 *   @param {boolean} [options.stripGround=true] drop near-horizontal tris (preserve mapng terrain)
 *   @param {number} [options.groundNormalThreshold=0.85] |normal.y| above this counts as ground
 *   @param {number} [options.maxWaitMs=180000] hard cap on bake time
 *   @param {number} [options.stabilityMs=2000] queue must stay quiet this long to consider done
 *   @param {(p: {visible:number, downloading:number, parsing:number, elapsed:number}) => void} [options.onProgress]
 */
export async function bakeGoogle3DTiles(data, options = {}) {
  const {
    apiKey,
    errorTarget = 8,
    stripGround = true,
    groundNormalThreshold = 0.85,
    maxWaitMs = 180000,
    stabilityMs = 2000,
    onProgress,
    // When set, output scene-Y is pre-divided by (worldSize / SCENE_SIZE) so that
    // the downstream BeamNG transform (which multiplies Y by that same factor)
    // produces world-Z in BeamNG terrain coordinates: 0 at the .ter file's
    // minHeight reference, climbing in real meters from there.
    worldSize = null,
  } = options;

  if (!apiKey) throw new Error('bakeGoogle3DTiles: missing apiKey');
  if (!data?.bounds || !data?.heightMap) throw new Error('bakeGoogle3DTiles: invalid terrain data');

  const centerLat = (data.bounds.north + data.bounds.south) / 2;
  const centerLng = (data.bounds.east + data.bounds.west) / 2;
  const latRad = (centerLat * Math.PI) / 180;
  const lonRad = (centerLng * Math.PI) / 180;

  // AOI extent (meters) — used to size the virtual camera so the LOD selector
  // picks tiles that cover the AOI from above.
  const metersPerDegree = 111320 * Math.cos(latRad);
  const widthM = (data.bounds.east - data.bounds.west) * metersPerDegree;
  const heightM = (data.bounds.north - data.bounds.south) * 111320;
  const extentM = Math.max(widthM, heightM);

  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey }));
  tiles.errorTarget = errorTarget;

  // Place an orbital camera looking straight down at the AOI center, in ECEF.
  const centerEcef = new THREE.Vector3();
  WGS84_ELLIPSOID.getCartographicToPosition(latRad, lonRad, 0, centerEcef);
  const upDir = centerEcef.clone().normalize();
  const cam = new THREE.PerspectiveCamera(60, 1, 1, 1e9);
  cam.position.copy(centerEcef).addScaledVector(upDir, extentM * 1.5 + 200);
  cam.up.copy(upDir);
  cam.lookAt(centerEcef);
  cam.updateMatrixWorld(true);

  // Offscreen WebGLRenderer is only needed for setResolutionFromRenderer's pixel
  // ratio + size info; nothing is ever drawn to it.
  const offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = 1024;
  offscreenCanvas.height = 1024;
  const offscreen = new THREE.WebGLRenderer({ canvas: offscreenCanvas, alpha: true });
  offscreen.setSize(1024, 1024, false);

  tiles.setCamera(cam);
  tiles.setResolutionFromRenderer(cam, offscreen);

  let updateError = null;
  const onUpdateError = (e) => { updateError = e; };
  tiles.addEventListener('load-error', onUpdateError);

  // Drive update loop until queue stays quiet for `stabilityMs` or we hit `maxWaitMs`.
  const startedAt = performance.now();
  await new Promise((resolve, reject) => {
    let lastChange = startedAt;
    let lastVisible = -1;

    const tick = () => {
      if (updateError) { reject(updateError); return; }
      try {
        tiles.update();
      } catch (e) { reject(e); return; }

      const now = performance.now();
      const downloading = tiles.stats?.downloading ?? 0;
      const parsing = tiles.stats?.parsing ?? 0;
      let visible = 0;
      tiles.group.traverse((o) => { if (o.isMesh) visible++; });

      if (visible !== lastVisible) {
        lastVisible = visible;
        lastChange = now;
      }

      onProgress?.({ visible, downloading, parsing, elapsed: now - startedAt });

      const quiet = downloading === 0 && parsing === 0 && (now - lastChange) > stabilityMs;
      if (quiet && visible > 0) { resolve(); return; }
      if (now - startedAt > maxWaitMs) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  tiles.removeEventListener('load-error', onUpdateError);

  // Sample Google's altitude near AOI center — we'll anchor Y so that Google's
  // ground at center == mapng's terrain at center. Picked from the lowest vertex
  // within a small radius around the center ECEF point.
  let googleGroundAlt = null;
  {
    const probeRadiusM = Math.max(50, extentM * 0.1);
    const probeRadiusSq = probeRadiusM * probeRadiusM;
    const tmp = new THREE.Vector3();
    const cart = {};
    tiles.group.updateMatrixWorld(true);
    tiles.group.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      const pos = node.geometry.attributes.position;
      if (!pos) return;
      const m = node.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
        if (tmp.distanceToSquared(centerEcef) > probeRadiusSq) continue;
        WGS84_ELLIPSOID.getPositionToCartographic(tmp, cart);
        if (googleGroundAlt === null || cart.height < googleGroundAlt) {
          googleGroundAlt = cart.height;
        }
      }
    });
  }
  if (googleGroundAlt === null) googleGroundAlt = 0;

  const projector = createMetricProjector(data.bounds, data.width, data.height);
  const unitsPerMeter = computeUnitsPerMeter(data);
  const mapngGroundY = sampleHeightAtScene(data, 0, 0);
  const halfScene = SCENE_SIZE / 2;

  // BeamNG terrain z = (heightmap_meters - minHeight), and the BeamNG export
  // applies `beamZ = sceneY * s` where s = worldSize / SCENE_SIZE.
  // To land buildings at terrain_z + relative_altitude_meters in BeamNG world,
  // emit sceneY = (terrain_z + relative_alt_meters) / s.
  const beamScale = worldSize ? worldSize / SCENE_SIZE : null;
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;

  const out = new THREE.Group();
  out.name = 'GoogleTiles3D';

  const tmpEcef = new THREE.Vector3();
  const cart = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

  tiles.group.updateMatrixWorld(true);

  let outputMeshIdx = 0;
  tiles.group.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const srcGeom = node.geometry;
    const srcPos = srcGeom.attributes.position;
    if (!srcPos) return;

    const vCount = srcPos.count;
    const worldMat = node.matrixWorld;

    const newPositions = new Float32Array(vCount * 3);
    const insideMask = new Uint8Array(vCount);

    for (let i = 0; i < vCount; i++) {
      tmpEcef.set(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i)).applyMatrix4(worldMat);
      WGS84_ELLIPSOID.getPositionToCartographic(tmpEcef, cart);
      const latDeg = (cart.lat * 180) / Math.PI;
      const lonDeg = (cart.lon * 180) / Math.PI;

      const p = projector(latDeg, lonDeg);
      const u = p.x / (data.width - 1);
      const v = p.y / (data.height - 1);
      const sceneX = u * SCENE_SIZE - halfScene;
      const sceneZ = v * SCENE_SIZE - halfScene;
      // In real meters: terrain top above the .ter datum + altitude above ground.
      const beamZMeters = (mapngGroundY - minH) + (cart.height - googleGroundAlt);
      const sceneY = beamScale
        ? beamZMeters / beamScale
        : mapngGroundY + (cart.height - googleGroundAlt) * unitsPerMeter;

      newPositions[i * 3]     = sceneX;
      newPositions[i * 3 + 1] = sceneY;
      newPositions[i * 3 + 2] = sceneZ;

      insideMask[i] = (Math.abs(sceneX) <= halfScene && Math.abs(sceneZ) <= halfScene) ? 1 : 0;
    }

    const srcIndex = srcGeom.index ? srcGeom.index.array : null;
    const triCount = srcIndex ? srcIndex.length / 3 : vCount / 3;
    const newIdx = [];

    for (let t = 0; t < triCount; t++) {
      const i0 = srcIndex ? srcIndex[t * 3]     : t * 3;
      const i1 = srcIndex ? srcIndex[t * 3 + 1] : t * 3 + 1;
      const i2 = srcIndex ? srcIndex[t * 3 + 2] : t * 3 + 2;

      if (!insideMask[i0] && !insideMask[i1] && !insideMask[i2]) continue;

      if (stripGround) {
        a.fromArray(newPositions, i0 * 3);
        b.fromArray(newPositions, i1 * 3);
        c.fromArray(newPositions, i2 * 3);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        normal.crossVectors(ab, ac).normalize();
        if (Math.abs(normal.y) > groundNormalThreshold) continue;
      }

      newIdx.push(i0, i1, i2);
    }

    if (newIdx.length === 0) return;

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
    if (srcGeom.attributes.uv) newGeom.setAttribute('uv', srcGeom.attributes.uv.clone());
    newGeom.setIndex(newIdx);
    newGeom.computeVertexNormals();

    // Each Google tile gets a unique material name so downstream Collada/material
    // pipelines can extract per-tile photogrammetry textures.
    //
    // Build a fresh MeshStandardMaterial regardless of the source type — Google's
    // photogrammetry tiles ship as MeshBasicMaterial (baked lighting), and the
    // ColladaExporter refuses to write texture refs for that type. The downstream
    // BeamNG materials.json defines an unlit-equivalent so visual result matches.
    const srcMat = Array.isArray(node.material) ? node.material[0] : node.material;
    const matName = `google_tile_${outputMeshIdx}`;
    const standard = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0,
    });
    // Explicit assignment — Material constructor param sometimes drops `name`
    // depending on Three.js version, and BeamNG resolves materials by the DAE's
    // <material name=""> attribute which ColladaExporter writes from `m.name`.
    standard.name = matName;
    // Snapshot the source texture to a standalone canvas. tiles.dispose() below
    // frees the b3dm/glb image data, which would leave the original Texture's
    // .image empty by the time ColladaExporter reads it for PNG extraction.
    if (srcMat?.map?.image) {
      const img = srcMat.map.image;
      const w = img.width || img.naturalWidth;
      const h = img.height || img.naturalHeight;
      if (w > 0 && h > 0) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const cx = c.getContext('2d');
        cx.drawImage(img, 0, 0);
        const snap = new THREE.CanvasTexture(c);
        snap.name = matName;
        snap.flipY = srcMat.map.flipY;
        snap.wrapS = srcMat.map.wrapS;
        snap.wrapT = srcMat.map.wrapT;
        snap.colorSpace = srcMat.map.colorSpace;
        standard.map = snap;
      }
    }
    const newMesh = new THREE.Mesh(newGeom, standard);
    newMesh.name = matName;
    newMesh.userData.isGoogleTile = true;
    out.add(newMesh);
    outputMeshIdx++;
  });

  try { tiles.dispose(); } catch (_) { /* noop */ }
  try { offscreen.dispose(); } catch (_) { /* noop */ }

  return out;
}
