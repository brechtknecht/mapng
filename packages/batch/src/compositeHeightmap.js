/** @layer io */
/**
 * compositeHeightmap.js — Stitched grid heightmap: builds the composite
 * Uint16 buffer tile-by-tile and encodes/downloads it as a 16-bit PNG.
 */

import { encode } from 'fast-png';
import { triggerDownload } from './batchDownloads.js';

const COMPOSITE_MAX_PIXELS = 64 * 1024 * 1024;

export function createCompositeHeightmapContext(state) {
  if (!state?.exports?.heightmap) return null;

  const tileSize = Math.max(1, Number(state.resolution || 0));
  const fullWidth = tileSize * Math.max(1, Number(state.gridCols || 1));
  const fullHeight = tileSize * Math.max(1, Number(state.gridRows || 1));
  const totalPixels = fullWidth * fullHeight;
  const scale = totalPixels > COMPOSITE_MAX_PIXELS
    ? Math.sqrt(COMPOSITE_MAX_PIXELS / totalPixels)
    : 1;
  const outputTileSize = Math.max(1, Math.floor(tileSize * scale));

  return {
    tileInputSize: tileSize,
    tileOutputSize: outputTileSize,
    width: outputTileSize * Math.max(1, Number(state.gridCols || 1)),
    height: outputTileSize * Math.max(1, Number(state.gridRows || 1)),
    scale,
    data: null,
    writtenTiles: new Set(),
  };
}

export function writeTileToCompositeHeightmap(composite, state, tile, terrainData) {
  if (!composite || !terrainData?.heightMap) return;
  if (!composite.data) {
    composite.data = new Uint16Array(composite.width * composite.height);
  }

  const tileKey = `${tile.row}:${tile.col}`;
  if (composite.writtenTiles.has(tileKey)) return;

  const sharedMin = Number.isFinite(state?.elevationNormalization?.globalMinHeight)
    ? state.elevationNormalization.globalMinHeight
    : null;
  const sharedMax = Number.isFinite(state?.elevationNormalization?.globalMaxHeight)
    ? state.elevationNormalization.globalMaxHeight
    : null;

  const minHeight = Number.isFinite(sharedMin)
    ? sharedMin
    : terrainData.minHeight;
  const maxHeight = Number.isFinite(sharedMax)
    ? sharedMax
    : terrainData.maxHeight;
  const range = maxHeight - minHeight;

  const srcSize = composite.tileInputSize;
  const outSize = composite.tileOutputSize;
  const startX = tile.col * outSize;
  const startY = tile.row * outSize;
  const src = terrainData.heightMap;

  for (let y = 0; y < outSize; y++) {
    const srcY = Math.min(srcSize - 1, Math.floor((y / outSize) * srcSize));
    for (let x = 0; x < outSize; x++) {
      const srcX = Math.min(srcSize - 1, Math.floor((x / outSize) * srcSize));
      const srcIndex = srcY * srcSize + srcX;
      const h = src[srcIndex];
      let v = range > 0 ? Math.floor(((h - minHeight) / range) * 65535) : 0;
      v = Math.max(0, Math.min(65535, v));

      const dstIndex = (startY + y) * composite.width + (startX + x);
      composite.data[dstIndex] = v;
    }
  }

  composite.writtenTiles.add(tileKey);
}

export function downloadCompositeHeightmap(state, composite) {
  if (!composite?.data) return;

  const pngData = encode({
    width: composite.width,
    height: composite.height,
    data: composite.data,
    depth: 16,
    channels: 1,
  });
  const blob = new Blob([new Uint8Array(pngData)], { type: 'image/png' });

  const date = new Date().toISOString().slice(0, 10);
  const lat = Number(state.center?.lat || 0).toFixed(4);
  const lng = Number(state.center?.lng || 0).toFixed(4);
  const scaledLabel = composite.scale < 1 ? `_scaled_${composite.width}x${composite.height}` : '';
  triggerDownload(blob, `MapNG_Batch_Heightmap_Grid_${date}_${lat}_${lng}${scaledLabel}.png`);
}
