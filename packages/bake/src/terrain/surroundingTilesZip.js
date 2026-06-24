/** @layer io */
// ZIP packaging + browser download for surrounding backdrop tiles (refactor doc
// 06 step 7). Moved verbatim from surroundingTiles.js — DOM (canvas/anchor) +
// fetch + zip, so it stays io.
import { encode } from 'fast-png';
import JSZip from 'jszip';
import { POSITION_LABELS } from './surroundingTileMath.js';

/**
 * Package surrounding tile results into a downloadable ZIP file.
 *
 * Each tile gets:
 *   - 16-bit PNG heightmap (normalized to its own min/max range)
 *   - Satellite texture (JPG)
 *   - Metadata JSON with bounds, height range, and scale info
 */
export const downloadSurroundingTilesZip = async (
  results,
  centerBounds,
  center,
  resolution,
  onProgress,
) => {
  const zip = new JSZip();
  const outputSize = resolution;
  const mpp = 1.0;
  const entries = Object.entries(results);

  for (let i = 0; i < entries.length; i++) {
    const [pos, data] = entries[i];
    onProgress?.(`Packaging tile ${pos} (${i + 1}/${entries.length})...`);

    // Encode heightmap as 16-bit PNG
    const range = data.maxHeight - data.minHeight;
    const hData = new Uint16Array(outputSize * outputSize);

    for (let j = 0; j < data.heightMap.length; j++) {
      let val = range > 0
        ? Math.floor(((data.heightMap[j] - data.minHeight) / range) * 65535)
        : 0;
      hData[j] = Math.max(0, Math.min(65535, val));
    }

    const pngBytes = encode({
      width: outputSize,
      height: outputSize,
      data: hData,
      depth: 16,
      channels: 1,
    });

    const label = POSITION_LABELS[pos] || pos;
    zip.file(`Tile${label}_${pos}_Heightmap_${outputSize}px.png`, new Uint8Array(pngBytes));

    // Satellite texture
    const satResp = await fetch(data.satelliteDataUrl);
    const satBlob = await satResp.blob();
    zip.file(`Tile${label}_${pos}_Satellite_${outputSize}px.jpg`, satBlob);

    // Per-tile metadata
    zip.file(`Tile${label}_${pos}_metadata.json`, JSON.stringify({
      position: pos,
      tileNumber: parseInt(label),
      bounds: data.bounds,
      outputPixels: outputSize,
      minHeight_m: Math.round(data.minHeight * 100) / 100,
      maxHeight_m: Math.round(data.maxHeight * 100) / 100,
      heightRange_m: Math.round(range * 100) / 100,
      metersPerPixel: mpp,
      areaSizeMeters: resolution,
    }, null, 2));
  }

  // Global info file
  zip.file('_tiles_info.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    centerCoordinates: center,
    centerBounds,
    centerResolution: resolution,
    tileOutputSize: resolution,
    tileAreaMeters: `${resolution}x${resolution}`,
    metersPerPixel: 1.0,
    tilesIncluded: entries.map(([pos]) => pos),
    tileLayout: [
      '1(NW)  2(N)   3(NE)',
      '4(W)   [CTR]  5(E)',
      '6(SW)  7(S)   8(SE)',
    ],
    note: 'Each heightmap is independently normalized to its own [minHeight, maxHeight] range. Use the per-tile metadata to reconstruct absolute elevation values if needed for seamless terrain stitching.',
  }, null, 2));

  onProgress?.('Compressing ZIP...');
  const blob = await zip.generateAsync({ type: 'blob' });

  const link = document.createElement('a');
  link.download = `MapNG_Surrounding_Tiles_${center.lat.toFixed(4)}_${center.lng.toFixed(4)}.zip`;
  link.href = URL.createObjectURL(blob);
  link.click();
  URL.revokeObjectURL(link.href);
};
