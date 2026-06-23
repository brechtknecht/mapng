/** @layer core */
// Foundational scene-space constants + the AOI reference frame shared by every
// bake step. Pure / DOM-free (THREE is used only for vector math), so the
// headless Node worker imports this without a renderer. Extracted from
// googleBakeCore.js (docs/refactor/06 step 1); googleBakeCore re-exports these.

import * as THREE from 'three';

// Bake scene plane: X/Z span [-SCENE_SIZE/2, +SCENE_SIZE/2]; Y is real metres.
export const SCENE_SIZE = 100;

export const computeUnitsPerMeter = (data) => {
  const latRad = (((data.bounds.north + data.bounds.south) / 2) * Math.PI) / 180;
  const metersPerDegree = 111320 * Math.cos(latRad);
  const realWidthMeters = (data.bounds.east - data.bounds.west) * metersPerDegree;
  return SCENE_SIZE / realWidthMeters;
};

/**
 * AOI-centred reference frame shared by every bake step: geographic centre,
 * metric extent, the ECEF centre point and a local ENU basis around it.
 */
export const computeAoiFrame = (data, ellipsoid) => {
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

  const centerEcef = new THREE.Vector3();
  ellipsoid.getCartographicToPosition(latRad, lonRad, 0, centerEcef);
  const upDir = centerEcef.clone().normalize();
  // Local ENU basis at the AOI centre (ECEF +Z points at the north pole).
  const eastDir = new THREE.Vector3(0, 0, 1).cross(upDir).normalize();
  const northDir = upDir.clone().cross(eastDir).normalize();
  const horiz = (e, n) =>
    new THREE.Vector3().addScaledVector(eastDir, e).addScaledVector(northDir, n);

  return {
    centerLat, centerLng, latRad, lonRad,
    metersPerDegree, widthM, heightM, extentM,
    centerEcef, upDir, eastDir, northDir, horiz,
  };
};
