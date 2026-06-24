/** @layer core */
// Vertical-anchor probe + finest-covering tile selection for the Google 3D
// Tiles bake. Pure / DOM-free (THREE used for vector math; meshes/ellipsoid are
// injected). Extracted from googleBakeCore.js (docs/refactor/06 step 2);
// googleBakeCore re-exports both.

import * as THREE from 'three';

/**
 * Ellipsoidal ground altitude near the AOI centre: a low percentile of vertex
 * heights within `max(50m, 10% of extent)` of the centre.
 *
 * The probe must be HORIZONTAL (lat/lon distance). An earlier version
 * measured 3D ECEF distance from a point at ellipsoid height 0 — but real
 * ground sits tens of metres above the ellipsoid (geoid offset + terrain
 * elevation, ~75 m in Berlin), so few or no vertices fell inside the
 * sphere and the anchor collapsed to 0, floating the whole city by that
 * altitude. Use a low percentile rather than the minimum so below-ground
 * junk geometry (canals, basements) can't sink the anchor either.
 *
 * @param {(cb: (node) => void) => void} forEachMesh iterate candidate meshes (matrixWorld must be current)
 * @returns {number|null} ellipsoidal height, or null when no vertices hit
 */
export const probeGroundAltitude = (forEachMesh, frame, ellipsoid, { stride = 1, percentile = 0.05 } = {}) => {
  const probeRadiusM = Math.max(50, frame.extentM * 0.1);
  const probeRadiusSq = probeRadiusM * probeRadiusM;
  const cosLat = Math.cos(frame.latRad);
  const tmp = new THREE.Vector3();
  const cart = {};
  const heights = [];
  forEachMesh((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos = node.geometry.attributes.position;
    const m = node.matrixWorld;
    for (let i = 0; i < pos.count; i += stride) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
      ellipsoid.getPositionToCartographic(tmp, cart);
      const dNorth = (cart.lat - frame.latRad) * 6371000;
      const dEast = (cart.lon - frame.lonRad) * 6371000 * cosLat;
      if (dNorth * dNorth + dEast * dEast > probeRadiusSq) continue;
      heights.push(cart.height);
    }
  });
  if (heights.length === 0) return null;
  heights.sort((x, y) => x - y);
  return heights[Math.floor(heights.length * percentile)];
};

/**
 * Different stations select the same region at different depths (e.g. the
 * far side of the AOI is coarser from an oblique view). Keep the finest:
 * drop any selected tile whose area is fully covered by selected
 * descendants. Tiles partially covered by finer selections are kept —
 * a small overlap beats a hole.
 */
export const selectFinestCovering = (selectedTiles) => {
  const coverMemo = new Map();
  const coveredBySelection = (tile) => {
    if (selectedTiles.has(tile)) return true;
    if (coverMemo.has(tile)) return coverMemo.get(tile);
    const kids = tile.children || [];
    const covered = kids.length > 0 && kids.every(coveredBySelection);
    coverMemo.set(tile, covered);
    return covered;
  };
  return [...selectedTiles].filter((tile) => {
    const kids = tile.children || [];
    return !(kids.length > 0 && kids.every(coveredBySelection));
  });
};
