/** @layer core */
// Per-mesh ECEF → mapng scene transform + AOI clip + ground strip for Google 3D
// Tiles. Pure / DOM-free. Extracted from googleBakeCore.js (docs/refactor/06
// step 2); googleBakeCore re-exports it.

import * as THREE from 'three';
import { createMetricProjector } from '@mapng/geo';
import { SCENE_SIZE, computeUnitsPerMeter } from '../scene/sceneFrame.js';
import { sampleHeightAtScene } from '../scene/sceneSample.js';

/**
 * Per-mesh ECEF → mapng transform + AOI clip + ground strip.
 *
 * Returns a function (node) => THREE.BufferGeometry|null. Output coordinates
 * are mode-neutral: X/Z in scene units ([-50, 50]), Y in REAL METERS above
 * the .ter datum. Consumers convert — the 3D preview scales Y by
 * computeUnitsPerMeter(data), the BeamNG export maps Y → world-Z with
 * factor 1 (BeamNG world-Z is meters above the .ter reference).
 *
 * Every output geometry carries the identical attribute set
 * (position+uv+normal): mergeGeometries() in the BeamNG export returns
 * null on any mismatch, which silently kills the entire Google output
 * (no DAE, no debug cube, no error). Zero-fill uv for the rare
 * untextured tile rather than dropping it or poisoning the merge.
 */
export const createTileMeshTransformer = (data, frame, ellipsoid, googleGroundAlt, {
  stripGround = true,
  groundNormalThreshold = 0.85,
  groundDistanceM = 2.5,
  // The Node worker skips this — its consumer (deserializeGroup) recomputes
  // normals on restore anyway, so shipping them would be pure waste.
  computeNormals = true,
  // Route mode: a single, route-wide vertical anchor (metres) shared by every
  // chunk. Each chunk would otherwise re-seat Google's ground onto the local
  // DEM at its OWN centre, so adjacent chunks disagree at the shared seam and
  // the next one floats. Passing one constant here keeps the Google tiles the
  // single continuous mesh they already are — see exportRouteLevel.
  groundOffsetM = null,
} = {}) => {
  const projector = createMetricProjector(data.bounds, data.width, data.height);
  const mapngGroundY = sampleHeightAtScene(data, 0, 0);
  const halfScene = SCENE_SIZE / 2;
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  // The per-chunk anchor: lift Google's ground (ellipsoidal) to sit on the
  // mapng terrain at THIS chunk's centre. Route mode overrides it with one
  // route-wide value so chunks stay co-continuous.
  const localGroundOffset = mapngGroundY - googleGroundAlt;
  const groundOffset = Number.isFinite(groundOffsetM) ? groundOffsetM : localGroundOffset;
  // Output Y is meters while X/Z are scene units — anisotropic. The ground-
  // normal test below must run in a metrically uniform space or sloped
  // hillsides stop counting as ground; scale Y by this when building tris.
  const unitsPerMeter = computeUnitsPerMeter(data);

  const tmpEcef = new THREE.Vector3();
  const cart = {};
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();

  const transform = (node) => {
    const srcGeom = node.geometry;
    const srcPos = srcGeom.attributes.position;
    if (!srcPos) return null;

    const vCount = srcPos.count;
    const worldMat = node.matrixWorld;

    const newPositions = new Float32Array(vCount * 3);
    const insideMask = new Uint8Array(vCount);
    // Metres above the local mapng terrain — lets the ground strip below
    // distinguish streets (≈0 m) from flat roofs (10–30 m).
    const aboveTerrain = new Float32Array(vCount);

    for (let i = 0; i < vCount; i++) {
      tmpEcef.set(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i)).applyMatrix4(worldMat);
      ellipsoid.getPositionToCartographic(tmpEcef, cart);
      const latDeg = (cart.lat * 180) / Math.PI;
      const lonDeg = (cart.lon * 180) / Math.PI;

      const p = projector(latDeg, lonDeg);
      const u = p.x / (data.width - 1);
      const v = p.y / (data.height - 1);
      const sceneX = u * SCENE_SIZE - halfScene;
      const sceneZ = v * SCENE_SIZE - halfScene;
      // Terrain top above minHeight + altitude above the anchor's ground.
      // groundOffset is per-chunk by default, or one route-wide constant so
      // adjacent chunks share a vertical datum and seams stay continuous.
      const beamZMeters = (groundOffset - minH) + cart.height;

      newPositions[i * 3]     = sceneX;
      newPositions[i * 3 + 1] = beamZMeters;
      newPositions[i * 3 + 2] = sceneZ;
      aboveTerrain[i] = beamZMeters - (sampleHeightAtScene(data, sceneX, sceneZ) - minH);

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
        // Orientation alone can't tell a street from a flat roof — both are
        // near-horizontal. Only strip tris that are ALSO near the mapng
        // terrain height, so streets vanish and roofs survive.
        const elevAvg = (aboveTerrain[i0] + aboveTerrain[i1] + aboveTerrain[i2]) / 3;
        if (elevAvg < groundDistanceM) {
          a.fromArray(newPositions, i0 * 3);
          b.fromArray(newPositions, i1 * 3);
          c.fromArray(newPositions, i2 * 3);
          a.y *= unitsPerMeter;
          b.y *= unitsPerMeter;
          c.y *= unitsPerMeter;
          ab.subVectors(b, a);
          ac.subVectors(c, a);
          normal.crossVectors(ab, ac).normalize();
          if (Math.abs(normal.y) > groundNormalThreshold) continue;
        }
      }

      newIdx.push(i0, i1, i2);
    }

    if (newIdx.length === 0) return null;

    const newGeom = new THREE.BufferGeometry();
    newGeom.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
    if (srcGeom.attributes.uv) {
      newGeom.setAttribute('uv', srcGeom.attributes.uv.clone());
    } else {
      newGeom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vCount * 2), 2));
    }
    newGeom.setIndex(newIdx);
    if (computeNormals) newGeom.computeVertexNormals();
    return newGeom;
  };

  // Expose anchor info for the orchestrators' log lines.
  transform.mapngGroundY = mapngGroundY;
  transform.minH = minH;
  // The effective vertical anchor used (route-wide override when given, else the
  // local per-chunk value). The route reads chunk 0's to share it downstream.
  transform.groundOffsetM = groundOffset;
  return transform;
};
