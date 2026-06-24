// Headless DEM fetch for the test lab — the one piece the node bake doesn't do
// itself (the browser normally supplies terrain). Pulls Mapzen/Terrarium tiles
// (the app's default elevation source, services/terrain.js: zoom 15, AWS S3) and
// resamples them into the {heightMap,bounds,...} shape the bake + conform consume.
//
// Tile/decoding constants mirror services/terrain.js (TILE_API_URL, TERRAIN_ZOOM)
// and services/surroundingTiles.js (R*256+G+B/256-32768). Pixel→lat/lng matches
// createMetricProjector's row-0-is-north, col-0-is-west convention for small AOIs.

import { decode } from 'fast-png';

const TILE_API_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const ZOOM = 15;
const TILE = 256;

const lngToGlobalPx = (lng, n) => ((lng + 180) / 360) * n * TILE;
const latToGlobalPx = (lat, n) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * TILE;
};

const decodeElevation = (img, px, py) => {
  const { width, data, channels } = img;
  const i = (py * width + px) * channels;
  return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
};

/**
 * @param {object} o  { lat, lng, sizeM, n }
 * @returns {Promise<object>} terrain data {width,height,minHeight,maxHeight,heightMap,bounds}
 */
export const fetchTerrainHeadless = async ({ lat, lng, sizeM = 400, n = 256 }) => {
  // Square AOI around the centre (deg). cos(lat) corrects longitude span.
  const dLat = sizeM / 111320;
  const dLng = sizeM / (111320 * Math.cos((lat * Math.PI) / 180));
  const bounds = { north: lat + dLat / 2, south: lat - dLat / 2, east: lng + dLng / 2, west: lng - dLng / 2 };

  const nTiles = 2 ** ZOOM;
  // Tile span the AOI touches.
  const gx0 = lngToGlobalPx(bounds.west, nTiles), gx1 = lngToGlobalPx(bounds.east, nTiles);
  const gy0 = latToGlobalPx(bounds.north, nTiles), gy1 = latToGlobalPx(bounds.south, nTiles);
  const tx0 = Math.floor(gx0 / TILE), tx1 = Math.floor(gx1 / TILE);
  const ty0 = Math.floor(gy0 / TILE), ty1 = Math.floor(gy1 / TILE);

  // Fetch + decode every touched tile once.
  const tiles = new Map();
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push((async () => {
        const res = await fetch(`${TILE_API_URL}/${ZOOM}/${tx}/${ty}.png`);
        if (!res.ok) throw new Error(`terrarium ${ZOOM}/${tx}/${ty}: HTTP ${res.status}`);
        tiles.set(`${tx},${ty}`, decode(new Uint8Array(await res.arrayBuffer())));
      })());
    }
  }
  await Promise.all(jobs);

  const sampleGlobal = (gx, gy) => {
    const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
    const img = tiles.get(`${tx},${ty}`);
    if (!img) return NaN;
    const px = Math.min(TILE - 1, Math.max(0, Math.floor(gx - tx * TILE)));
    const py = Math.min(TILE - 1, Math.max(0, Math.floor(gy - ty * TILE)));
    return decodeElevation(img, px, py);
  };

  const heightMap = new Float32Array(n * n);
  let minHeight = Infinity, maxHeight = -Infinity;
  for (let row = 0; row < n; row++) {
    const latR = bounds.north - (row / (n - 1)) * (bounds.north - bounds.south); // row 0 = north
    const gy = latToGlobalPx(latR, nTiles);
    for (let col = 0; col < n; col++) {
      const lngC = bounds.west + (col / (n - 1)) * (bounds.east - bounds.west); // col 0 = west
      const h = sampleGlobal(lngToGlobalPx(lngC, nTiles), gy);
      heightMap[row * n + col] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  return { width: n, height: n, minHeight, maxHeight, heightMap, bounds, tilesFetched: tiles.size };
};
