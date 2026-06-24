/** @layer io */
/**
 * tileSnapshot.js — Canvas-based tile snapshot generation and terrain-resource
 * release (canvas teardown + object-URL revocation). Browser-only (canvas/Image/URL).
 */

function getSnapshotSize(state) {
  const maxGridPx = 400;
  const cols = Math.max(1, Number(state.gridCols || 1));
  const rows = Math.max(1, Number(state.gridRows || 1));
  const cellPx = maxGridPx / Math.max(cols, rows);
  const ideal = Math.round(cellPx * 2);
  return Math.max(96, Math.min(512, ideal));
}

async function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

export async function generateTileSnapshot(terrainData, state) {
  const size = getSnapshotSize(state);
  const jpegQuality = size >= 320 ? 0.85 : 0.75;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  try {
    if (terrainData.satelliteTextureUrl) {
      const img = await loadImage(terrainData.satelliteTextureUrl);
      ctx.drawImage(img, 0, 0, size, size);
      return canvas.toDataURL('image/jpeg', jpegQuality);
    }

    if (terrainData.heightMap) {
      const imgData = ctx.createImageData(size, size);
      const range = terrainData.maxHeight - terrainData.minHeight;
      const stepX = terrainData.width / size;
      const stepY = terrainData.height / size;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const srcX = Math.min(Math.floor(x * stepX), terrainData.width - 1);
          const srcY = Math.min(Math.floor(y * stepY), terrainData.height - 1);
          const h = terrainData.heightMap[srcY * terrainData.width + srcX];
          const v = range > 0 ? Math.floor(((h - terrainData.minHeight) / range) * 255) : 0;
          const idx = (y * size + x) * 4;
          imgData.data[idx] = v;
          imgData.data[idx + 1] = v;
          imgData.data[idx + 2] = v;
          imgData.data[idx + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL('image/jpeg', jpegQuality);
    }
  } catch {
  }

  return null;
}

export function releaseTerrainResources(terrainData) {
  if (!terrainData || typeof terrainData !== 'object') return;

  if (terrainData.heightMap) terrainData.heightMap = null;

  if (terrainData.osmTextureCanvas) {
    terrainData.osmTextureCanvas.width = 1;
    terrainData.osmTextureCanvas.height = 1;
    terrainData.osmTextureCanvas = null;
  }
  if (terrainData.hybridTextureCanvas) {
    terrainData.hybridTextureCanvas.width = 1;
    terrainData.hybridTextureCanvas.height = 1;
    terrainData.hybridTextureCanvas = null;
  }
  if (terrainData.segmentedTextureCanvas) {
    terrainData.segmentedTextureCanvas.width = 1;
    terrainData.segmentedTextureCanvas.height = 1;
    terrainData.segmentedTextureCanvas = null;
  }
  if (terrainData.segmentedHybridTextureCanvas) {
    terrainData.segmentedHybridTextureCanvas.width = 1;
    terrainData.segmentedHybridTextureCanvas.height = 1;
    terrainData.segmentedHybridTextureCanvas = null;
  }

  if (terrainData.osmTextureUrl) URL.revokeObjectURL(terrainData.osmTextureUrl);
  if (terrainData.hybridTextureUrl) URL.revokeObjectURL(terrainData.hybridTextureUrl);
  if (terrainData.segmentedTextureUrl) URL.revokeObjectURL(terrainData.segmentedTextureUrl);
  if (terrainData.segmentedHybridTextureUrl) URL.revokeObjectURL(terrainData.segmentedHybridTextureUrl);
  if (terrainData.satelliteTextureUrl) URL.revokeObjectURL(terrainData.satelliteTextureUrl);

  terrainData.osmTextureUrl = null;
  terrainData.hybridTextureUrl = null;
  terrainData.segmentedTextureUrl = null;
  terrainData.segmentedHybridTextureUrl = null;
  terrainData.satelliteTextureUrl = null;

  terrainData.osmTextureBlob = null;
  terrainData.hybridTextureBlob = null;
  terrainData.segmentedTextureBlob = null;
  terrainData.segmentedHybridTextureBlob = null;

  terrainData.osmFeatures = null;
  terrainData.sourceGeoTiffs = null;
}
