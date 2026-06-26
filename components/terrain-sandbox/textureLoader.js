// Tiny async texture loader for the terrain sandbox ground meshes.
import * as THREE from 'three';

/** Load an image URL into a THREE texture (sRGB). Resolves null on failure/empty. */
export function loadSatelliteTexture(url) {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (tex) => { tex.colorSpace = THREE.SRGBColorSpace; resolve(tex); },
      undefined,
      () => resolve(null),
    );
  });
}
