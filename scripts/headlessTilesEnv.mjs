// Shared headless-Node environment for Google 3D Tiles work (spike + bake
// worker). Importing this module:
//  1. polyfills the two browser globals the library's bake path touches,
//  2. registers the resolve hook that keeps the WebGL-at-module-scope
//     plugins index out of the graph (see headlessTilesHooks.mjs),
//  3. re-exports the library pieces via deep file imports — the package
//     indices ('3d-tiles-renderer', '3d-tiles-renderer/plugins') must never
//     be imported in Node, they evaluate that same plugins graph.
import { register } from 'node:module';

// TilesRendererBase.preprocessTileSet: new URL(base, window.location.href).
globalThis.window ??= { location: { href: 'https://tile.googleapis.com/' } };
// LRUCache.scheduleUnload + PriorityQueue's default scheduler use rAF.
globalThis.requestAnimationFrame ??= (fn) => setTimeout(fn, 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
// TilesRenderer.disposeTile does `texture.image instanceof ImageBitmap`.
globalThis.ImageBitmap ??= class ImageBitmap {};

register('./headlessTilesHooks.mjs', import.meta.url);

// Dynamic imports so they resolve AFTER the hook registration above.
export const { TilesRenderer } =
  await import('../node_modules/3d-tiles-renderer/src/three/TilesRenderer.js');
export const { GoogleCloudAuthPlugin } =
  await import('../node_modules/3d-tiles-renderer/src/plugins/three/GoogleCloudAuthPlugin.js');
export const { GLTFCesiumRTCExtension } =
  await import('../node_modules/3d-tiles-renderer/src/plugins/three/gltf/GLTFCesiumRTCExtension.js');
export const { WGS84_ELLIPSOID } =
  await import('../node_modules/3d-tiles-renderer/src/three/math/GeoConstants.js');

const THREE = await import('three');
const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

// --- texture capture ---------------------------------------------------------
// GLTFParser delegates texture loading to the first plugin implementing
// loadTexture(). We return a stub THREE.Texture carrying the UNDECODED image
// bytes — no Image/createImageBitmap/canvas anywhere, and ~10× less memory
// than decoded RGBA. The bytes ride on a NON-ENUMERABLE own property rather
// than userData: Texture.copy() round-trips userData through JSON, which
// would corrupt a Uint8Array if a glTF extension ever cloned the texture.

const WEBGL_WRAPPINGS = {
  33071: THREE.ClampToEdgeWrapping,
  33648: THREE.MirroredRepeatWrapping,
  10497: THREE.RepeatWrapping,
};

const CAPTURE_KEY = '__mapngCapturedImage';

/** The {bytes, mimeType} captured for a texture, or null. */
export const getCapturedImage = (texture) => texture?.[CAPTURE_KEY] ?? null;

class CaptureTexturesPlugin {
  constructor(parser) {
    this.parser = parser;
    this.name = 'MAPNG_capture_textures';
  }

  loadTexture(textureIndex) {
    const { parser } = this;
    const json = parser.json;
    const textureDef = json.textures[textureIndex];
    const imageDef = json.images?.[textureDef.source];
    if (!imageDef) return Promise.resolve(null);

    const texture = new THREE.Texture();
    texture.flipY = false; // glTF convention
    const sampler = json.samplers?.[textureDef.sampler] ?? {};
    texture.wrapS = WEBGL_WRAPPINGS[sampler.wrapS] ?? THREE.RepeatWrapping;
    texture.wrapT = WEBGL_WRAPPINGS[sampler.wrapT] ?? THREE.RepeatWrapping;
    const capture = (bytes, mimeType) => {
      Object.defineProperty(texture, CAPTURE_KEY, {
        value: { bytes, mimeType },
        enumerable: false,
      });
      return texture;
    };

    if (imageDef.bufferView !== undefined) {
      return parser.getDependency('bufferView', imageDef.bufferView)
        .then((bv) => capture(new Uint8Array(bv.slice(0)), imageDef.mimeType || 'image/jpeg'));
    }
    if (imageDef.uri?.startsWith('data:')) {
      const [head, body] = imageDef.uri.split(',');
      return Promise.resolve(capture(
        Uint8Array.from(Buffer.from(body, 'base64')),
        head.slice(5).split(';')[0] || 'image/jpeg',
      ));
    }
    // External uri — unexpected for Google GLBs; surface it loudly.
    console.warn(`[headlessTiles] texture ${textureIndex} has external uri ${imageDef.uri} — empty stub`);
    return Promise.resolve(texture);
  }
}

/**
 * Route every GLB/glTF tile through a capture loader: GLTFExtensionLoader
 * checks manager.getHandler before constructing its own (decoding) GLTFLoader.
 */
export const installCaptureLoader = (tiles) => {
  const loader = new GLTFLoader(tiles.manager);
  loader.register((parser) => new GLTFCesiumRTCExtension(parser));
  loader.register((parser) => new CaptureTexturesPlugin(parser));
  tiles.manager.addHandler(/\.(glb|gltf)$/i, loader);
};
