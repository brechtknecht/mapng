// Headless DOM-canvas shim for Node, backing the @mapng/bake texture/export
// pipeline with @napi-rs/canvas (refactor doc 06 — programmatic export oracle).
//
// The browser-only bits of the bake (osmTexture's generateOSMTexture/
// generateHybridTexture, osmTerrainMaterials' neutral-texture gen, the
// exportBeamNGLevel ZIP path) call `document.createElement('canvas')`,
// `canvas.toBlob`, `new Image()` and `URL.createObjectURL`. Registering this
// shim BEFORE importing those modules lets them run in `node --test` with no
// browser, so their output can be hashed as a regression oracle.
//
// Usage:
//   import { installCanvasShim } from '../tools/testlab/canvasShim.mjs';
//   installCanvasShim();
//   const { generateOSMTexture } = await import('@mapng/bake/osmTexture');
import { createCanvas, Image, loadImage } from '@napi-rs/canvas';

let installed = false;

// Add a WHATWG-ish toBlob() to an @napi-rs Canvas instance (it ships toBuffer).
const addToBlob = (canvas) => {
  if (typeof canvas.toBlob === 'function') return canvas;
  canvas.toBlob = (cb, mime = 'image/png', quality) => {
    let buf;
    try {
      const type = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      buf = canvas.toBuffer(type, quality);
    } catch (err) {
      cb(null);
      return;
    }
    // A Blob backed by the encoded bytes; .arrayBuffer()/.size match the browser.
    cb(new Blob([buf], { type: mime }));
  };
  // toDataURL is already provided by @napi-rs/canvas.
  return canvas;
};

export function installCanvasShim() {
  if (installed) return globalThis;
  installed = true;

  const makeCanvas = (w = 300, h = 150) => addToBlob(createCanvas(w, h));

  if (typeof globalThis.document === 'undefined') globalThis.document = {};
  const prevCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    if (String(tag).toLowerCase() === 'canvas') return makeCanvas();
    if (typeof prevCreate === 'function') return prevCreate.call(globalThis.document, tag);
    // Minimal stand-ins for the few non-canvas elements the export touches
    // (e.g. an <a download> link); enough that calling them is a no-op.
    return { style: {}, setAttribute() {}, click() {}, remove() {} };
  };

  if (typeof globalThis.Image === 'undefined') globalThis.Image = Image;

  // The texture code snapshots blobs to object URLs purely as opaque handles —
  // a stable fake string is all that's needed headlessly.
  if (typeof globalThis.URL === 'undefined') globalThis.URL = {};
  let urlSeq = 0;
  if (typeof globalThis.URL.createObjectURL !== 'function') {
    globalThis.URL.createObjectURL = () => `blob:mapng-headless/${urlSeq++}`;
  }
  if (typeof globalThis.URL.revokeObjectURL !== 'function') {
    globalThis.URL.revokeObjectURL = () => {};
  }

  return globalThis;
}

export { createCanvas, Image, loadImage, addToBlob };
