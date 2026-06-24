// Node module-resolution hook that makes 3d-tiles-renderer importable headless.
//
// `src/three/loaders/GLTFExtensionLoader.js` (pulled in by TilesRenderer)
// statically imports the deprecation shim
// `src/three/loaders/gltf/GLTFCesiumRTCExtension.js`, which re-exports through
// `src/plugins/index.js` — and THAT module graph instantiates a WebGLRenderer
// at module scope (gltf metadata TextureReadUtility), crashing Node with
// "document is not defined". The real GLTFCesiumRTCExtension implementation is
// DOM-free; redirect the shim straight to it so the plugins index is never
// evaluated.
//
// Register before importing the library (see headlessTilesEnv.mjs):
//   import { register } from 'node:module';
//   register('./headlessTilesHooks.mjs', import.meta.url);

const SHIM = '/3d-tiles-renderer/src/three/loaders/gltf/GLTFCesiumRTCExtension.js';
const IMPL = '/3d-tiles-renderer/src/plugins/three/gltf/GLTFCesiumRTCExtension.js';

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url?.endsWith(SHIM)) {
    return { url: resolved.url.replace(SHIM, IMPL), shortCircuit: true };
  }
  return resolved;
}
