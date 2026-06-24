/** @layer core */
/**
 * grid.js — Pure grid/label math for batch jobs.
 *
 * Tile layout, offset normalization, grid bounds, and tile-label derivation.
 * No DOM, no network — fully headless-testable.
 */

// ─── Grid Computation ────────────────────────────────────────────────

export function computeGridTiles(center, resolution, gridCols, gridRows) {
  const tiles = [];
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(center.lat * Math.PI / 180);

  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      const offsetX = (col - (gridCols - 1) / 2) * resolution;
      const offsetY = ((gridRows - 1) / 2 - row) * resolution;

      const tileLat = center.lat + offsetY / metersPerDegLat;
      const tileLng = center.lng + offsetX / metersPerDegLng;

      const halfLatSpan = resolution / 2 / metersPerDegLat;
      const halfLngSpan = resolution / 2 / metersPerDegLng;

      tiles.push({
        row,
        col,
        index: row * gridCols + col,
        center: { lat: tileLat, lng: tileLng },
        bounds: {
          north: tileLat + halfLatSpan,
          south: tileLat - halfLatSpan,
          east: tileLng + halfLngSpan,
          west: tileLng - halfLngSpan,
        },
      });
    }
  }
  return tiles;
}

export function normalizeTileOffsets(rawOffsets = [], maxTiles = Infinity) {
  if (!Array.isArray(rawOffsets)) return [];
  return rawOffsets
    .map((entry) => ({
      index: Number(entry?.index),
      offsetX: Number(entry?.offsetX || 0),
      offsetY: Number(entry?.offsetY || 0),
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index < maxTiles)
    .map((entry) => ({
      index: entry.index,
      offsetX: Number.isFinite(entry.offsetX) ? entry.offsetX : 0,
      offsetY: Number.isFinite(entry.offsetY) ? entry.offsetY : 0,
    }))
    .sort((a, b) => a.index - b.index);
}

export function computeGridTilesWithOffsets(center, resolution, gridCols, gridRows, tileOffsets = []) {
  const baseTiles = computeGridTiles(center, resolution, gridCols, gridRows);
  if (!tileOffsets?.length) return baseTiles;

  const offsets = normalizeTileOffsets(tileOffsets, baseTiles.length);
  const byIndex = new Map(offsets.map((entry) => [entry.index, entry]));

  return baseTiles.map((tile) => {
    const offset = byIndex.get(tile.index);
    if (!offset) return tile;

    const metersPerDegLat = 111320;
    const metersPerDegLng = 111320 * Math.cos(tile.center.lat * Math.PI / 180);
    const latDelta = offset.offsetY / metersPerDegLat;
    const lngDelta = offset.offsetX / metersPerDegLng;

    const centerShifted = {
      lat: tile.center.lat + latDelta,
      lng: tile.center.lng + lngDelta,
    };

    const halfLatSpan = resolution / 2 / metersPerDegLat;
    const halfLngSpan = resolution / 2 / metersPerDegLng;

    return {
      ...tile,
      center: centerShifted,
      offsetX: offset.offsetX,
      offsetY: offset.offsetY,
      bounds: {
        north: centerShifted.lat + halfLatSpan,
        south: centerShifted.lat - halfLatSpan,
        east: centerShifted.lng + halfLngSpan,
        west: centerShifted.lng - halfLngSpan,
      },
    };
  });
}

export function computeGridBounds(center, resolution, gridCols, gridRows) {
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(center.lat * Math.PI / 180);

  const totalWidth = gridCols * resolution;
  const totalHeight = gridRows * resolution;

  return {
    north: center.lat + totalHeight / 2 / metersPerDegLat,
    south: center.lat - totalHeight / 2 / metersPerDegLat,
    east: center.lng + totalWidth / 2 / metersPerDegLng,
    west: center.lng - totalWidth / 2 / metersPerDegLng,
  };
}

export function getDefaultTileLabel(tileOrIndex, gridCols = 1) {
  if (typeof tileOrIndex === 'number') {
    const safeCols = Math.max(1, Number(gridCols || 1));
    return `R${Math.floor(tileOrIndex / safeCols) + 1}C${(tileOrIndex % safeCols) + 1}`;
  }
  const row = Number(tileOrIndex?.row || 0);
  const col = Number(tileOrIndex?.col || 0);
  return `R${row + 1}C${col + 1}`;
}

export function normalizeTileNames(rawNames = [], maxTiles = Infinity, gridCols = 1) {
  if (!Array.isArray(rawNames)) return [];
  return rawNames
    .map((entry) => ({
      index: Number(entry?.index),
      name: String(entry?.name || '').trim(),
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index < maxTiles && entry.name)
    .filter((entry) => entry.name !== getDefaultTileLabel(entry.index, gridCols))
    .sort((a, b) => a.index - b.index);
}

export function getTileLabel(tile, gridCols = 1) {
  return String(tile?.label || tile?.name || tile?.customName || '').trim() || getDefaultTileLabel(tile, gridCols);
}

export function sanitizeFilenamePart(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tile';
}
