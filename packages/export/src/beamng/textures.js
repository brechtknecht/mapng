/** @layer io */
// Canvas/blob/PNG texture IO: satellite/heightmap re-encoding, preview + minimap
// + Road Architect 16-bit heightmap generation, and the bundled flag-asset
// loader. Browser-only (DOM canvas, fetch). Extracted verbatim from
// exportBeamNGLevel.js (06 step 9).
import { encode } from 'fast-png';
import JSZip from 'jszip';

/**
 * Load a URL into a canvas and re-encode as a PNG Blob.
 * Required because BeamNG's GBitmap::readPNG rejects non-PNG streams
 * (satellite tiles are JPEG).
 */
export async function urlToPngBlob(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

/**
 * Resize a PNG blob to an exact square pixel size.
 * Required so terrain.png always matches baseTexSize in the TerrainMaterialTextureSet.
 */
export async function resizePngBlob(blob, targetSize) {
  if (!blob) return blob;
  const bmp = await createImageBitmap(blob);
  if (bmp.width === targetSize && bmp.height === targetSize) {
    bmp.close();
    return blob;
  }
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;
  canvas.getContext('2d').drawImage(bmp, 0, 0, targetSize, targetSize);
  bmp.close();
  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

/**
 * Return the terrain texture as a PNG Blob for the given textureType.
 *
 * textureType options:
 *   'none'            — flat neutral color
 *   'hybrid'          — satellite + road overlay (default)
 *   'satellite'       — plain satellite imagery
 *   'osm'             — procedural OSM texture
 *
 * Falls back to the grey 64×64 placeholder if the requested texture is
 * unavailable. Always re-encodes as PNG.
 */
export async function getTerrainTextureBlob(terrainData, textureType = 'hybrid') {
  try {
    if (textureType === 'none') {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return new Promise(r => canvas.toBlob(r, 'image/png'));
    }
    if (textureType === 'hybrid') {
      // Priority: raw canvas (lossless, direct) → pre-encoded blob → blob URL fallback.
      // The canvas may be null after the 3D preview frees it from terrainData, but the
      // blob is always kept alive since it's a compressed PNG (much smaller than the canvas).
      if (terrainData.hybridTextureCanvas) {
        return new Promise(r => terrainData.hybridTextureCanvas.toBlob(r, 'image/png'));
      }
      if (terrainData.hybridTextureBlob) return terrainData.hybridTextureBlob;
      if (terrainData.hybridTextureUrl) return await urlToPngBlob(terrainData.hybridTextureUrl);
    } else if (textureType === 'satellite') {
      if (terrainData.satelliteTextureUrl) return await urlToPngBlob(terrainData.satelliteTextureUrl);
    } else if (textureType === 'osm') {
      if (terrainData.osmTextureCanvas) return new Promise(r => terrainData.osmTextureCanvas.toBlob(r, 'image/png'));
      if (terrainData.osmTextureBlob) return terrainData.osmTextureBlob;
      if (terrainData.osmTextureUrl) return await urlToPngBlob(terrainData.osmTextureUrl);
    }
  } catch (_) {}

  // Fallback: try plain satellite, then grey placeholder
  if (terrainData.satelliteTextureUrl) {
    try { return await urlToPngBlob(terrainData.satelliteTextureUrl); } catch (_) {}
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  canvas.getContext('2d').fillStyle = '#888';
  canvas.getContext('2d').fillRect(0, 0, 64, 64);
  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

/**
 * Generate a 512×512 preview PNG (satellite or heightmap fallback).
 * Required: freeroamConfigurator.validateFiles() checks that the file listed
 * in info.json["previews"] physically exists — without it the level falls back
 * to the default level (West Coast USA).
 */
export async function generatePreviewBlob(terrainData) {
  const SIZE = 512;
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');

  if (terrainData.satelliteTextureUrl) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = terrainData.satelliteTextureUrl;
    });
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
  } else {
    const { width, height, heightMap, minHeight, maxHeight } = terrainData;
    const imgData = ctx.createImageData(SIZE, SIZE);
    const range = maxHeight - minHeight;
    const stepX = width / SIZE;
    const stepY = height / SIZE;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const srcX = Math.min(Math.floor(x * stepX), width - 1);
        const srcY = Math.min(Math.floor(y * stepY), height - 1);
        const h = heightMap[srcY * width + srcX];
        const v = range > 0 ? Math.floor(((h - minHeight) / range) * 255) : 128;
        const idx = (y * SIZE + x) * 4;
        imgData.data[idx] = v;
        imgData.data[idx + 1] = v;
        imgData.data[idx + 2] = v;
        imgData.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

/**
 * Generate a grayscale heightmap PNG at the terrain's native resolution.
 * Written as {terrainName}.terrainheightmap.png alongside the .ter file.
 * Referenced by terrain.terrain.json as "heightmapImage" — used by BeamNG's
 * terrain system internally (minimap display, editor visualization).
 */
export async function generateHeightmapPng(terrainData, maxSize = 2048) {
  const { width, height, heightMap, minHeight, maxHeight } = terrainData;
  // Cap output to maxSize — this is a visual reference only (World Editor minimap).
  // Full-resolution for large terrains would waste hundreds of MB of canvas RAM.
  const outW = Math.min(width,  maxSize);
  const outH = Math.min(height, maxSize);
  const scaleX = width  / outW;
  const scaleY = height / outH;
  const range  = maxHeight - minHeight;

  const canvas = document.createElement('canvas');
  canvas.width  = outW;
  canvas.height = outH;
  const ctx     = canvas.getContext('2d');
  const imgData = ctx.createImageData(outW, outH);
  const d       = imgData.data;

  for (let y = 0; y < outH; y++) {
    const srcY = Math.min(height - 1, Math.round(y * scaleY));
    for (let x = 0; x < outW; x++) {
      const srcX = Math.min(width - 1, Math.round(x * scaleX));
      const h    = heightMap[srcY * width + srcX];
      const v    = range > 0 ? Math.floor(((h - minHeight) / range) * 255) : 128;
      const idx  = (y * outW + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = v;
      d[idx + 3] = 255;
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return new Promise(r => canvas.toBlob(r, 'image/png'));
}

/**
 * Generate Road Architect-compatible terrain bitmap (16-bit grayscale PNG).
 *
 * Road Architect writes this as GFXFormatR16 and later reads it with
 * bmp:getTexel(x, y), then maps texel values back to terrain heights with:
 *   height = texel * ((zMax - zMin) / 65535) + zMin
 *
 * For generated levels, TerrainBlock zMin is 0 and zMax is maxHeight.
 */
export function generateRoadArchitectHeightmapPng(terrainData, terrainBlockMaxHeight) {
  const { width, height, heightMap, minHeight } = terrainData;
  const zMin = 0;
  const zMax = Math.max(1, Number(terrainBlockMaxHeight) || 1);
  const scale = 65535 / Math.max(1e-9, (zMax - zMin));

  const data = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    // Terrain data uses north-origin rows; TerrainBlock grid is south-origin.
    const srcY = height - 1 - y;
    const srcRow = srcY * width;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      const worldRelativeH = Math.max(0, (heightMap[srcRow + x] - minHeight));
      const texel = Math.max(0, Math.min(65535, Math.round(worldRelativeH * scale)));
      data[dstRow + x] = texel;
    }
  }

  const pngData = encode({ width, height, data, depth: 16, channels: 1 });
  return new Blob([new Uint8Array(pngData)], { type: 'image/png' });
}

/**
 * Load bundled MapNG flag assets from the static zip served at runtime.
 *
 * Returns an array of { path, data } entries ready to write into JSZip.
 */
export async function loadMapngFlagAsset() {
  const response = await fetch('/mapng_flag_static.zip');
  if (!response.ok) throw new Error(`Failed to load mapng flag asset: ${response.status}`);
  const archive = await JSZip.loadAsync(await response.arrayBuffer());
  const files = [];
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    files.push({
      path: entry.name,
      data: await entry.async('uint8array'),
    });
  }
  return files;
}
