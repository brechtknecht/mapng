// Pure terrain compositing for the route → BeamNG level export. No DOM/WebGL
// deps, so it's unit-testable in Node (services/exportRouteLevel.js, which pulls
// in the full bake/level pipeline, is not).

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;
const mPerDegLng = (lat) => M_PER_DEG_LAT * Math.cos(lat * DEG) || M_PER_DEG_LAT;
const nextPow2 = (n) => 2 ** Math.round(Math.log2(Math.max(1, n)));

/** Bilinearly sample a chunk terrain's absolute elevation at a lat/lng. */
export function sampleHeightAt(terrain, lat, lng) {
  const b = terrain.bounds;
  const u = (lng - b.west) / (b.east - b.west);
  const v = (b.north - lat) / (b.north - b.south); // heightMap rows are north-origin
  const w = terrain.width, h = terrain.height, hm = terrain.heightMap;
  const fx = Math.max(0, Math.min(w - 1, u * (w - 1)));
  const fy = Math.max(0, Math.min(h - 1, v * (h - 1)));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0, ty = fy - y0;
  const minH = terrain.minHeight ?? 0;
  const s = (i) => (hm[i] < -10000 ? minH : hm[i]);
  const h00 = s(y0 * w + x0), h10 = s(y0 * w + x1);
  const h01 = s(y1 * w + x0), h11 = s(y1 * w + x1);
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

/**
 * Composite the per-chunk heightmaps into ONE square terrainData spanning the
 * route bbox. Off-corridor pixels (the bulk of a diagonal route's square box)
 * stay at a flat filler floor — they're hidden, the player stays on the road.
 *
 * @param {object[]} terrains  per-chunk TerrainData (with heightMap + bounds)
 * @returns {object} terrainData-shaped { bounds, width, height, heightMap, minHeight, maxHeight, metersPerPixel, osmFeatures }
 */
export function buildCombinedRouteTerrain(terrains, { targetMetersPerPixel = 2, maxSize = 4096 } = {}) {
  let north = -Infinity, south = Infinity, east = -Infinity, west = Infinity;
  for (const t of terrains) {
    north = Math.max(north, t.bounds.north); south = Math.min(south, t.bounds.south);
    east = Math.max(east, t.bounds.east); west = Math.min(west, t.bounds.west);
  }
  const centerLat = (north + south) / 2;
  const centerLng = (east + west) / 2;
  const mLng = mPerDegLng(centerLat);
  const widthM = (east - west) * mLng;
  const heightM = (north - south) * M_PER_DEG_LAT;
  const sideM = Math.max(widthM, heightM, 1);

  // Square the bounds around the centre (BeamNG TerrainBlock is square).
  const halfLat = (sideM / 2) / M_PER_DEG_LAT;
  const halfLng = (sideM / 2) / mLng;
  const bounds = {
    north: centerLat + halfLat, south: centerLat - halfLat,
    east: centerLng + halfLng, west: centerLng - halfLng,
  };

  const N = nextPow2(Math.min(maxSize, Math.max(256, Math.round(sideM / targetMetersPerPixel))));
  const squareSize = sideM / N;

  // Filler floor = lowest chunk datum, so off-corridor terrain sits below the
  // road rather than poking through it.
  const fillFloor = terrains.reduce((m, t) => Math.min(m, t.minHeight ?? 0), Infinity);
  const heightMap = new Float32Array(N * N).fill(fillFloor);
  let minHeight = fillFloor, maxHeight = fillFloor;

  // Blit each chunk over its pixel rect only (O(covered px), not O(N²·chunks)).
  for (const t of terrains) {
    const cb = t.bounds;
    const gx0 = Math.max(0, Math.floor((cb.west - bounds.west) / (bounds.east - bounds.west) * (N - 1)));
    const gx1 = Math.min(N - 1, Math.ceil((cb.east - bounds.west) / (bounds.east - bounds.west) * (N - 1)));
    const gy0 = Math.max(0, Math.floor((bounds.north - cb.north) / (bounds.north - bounds.south) * (N - 1)));
    const gy1 = Math.min(N - 1, Math.ceil((bounds.north - cb.south) / (bounds.north - bounds.south) * (N - 1)));
    for (let gy = gy0; gy <= gy1; gy++) {
      const lat = bounds.north - (gy / (N - 1)) * (bounds.north - bounds.south);
      for (let gx = gx0; gx <= gx1; gx++) {
        const lng = bounds.west + (gx / (N - 1)) * (bounds.east - bounds.west);
        if (lng < cb.west || lng > cb.east || lat < cb.south || lat > cb.north) continue;
        const hgt = sampleHeightAt(t, lat, lng);
        heightMap[gy * N + gx] = hgt;
        if (hgt < minHeight) minHeight = hgt;
        if (hgt > maxHeight) maxHeight = hgt;
      }
    }
  }

  return {
    bounds, width: N, height: N, heightMap,
    minHeight, maxHeight,
    metersPerPixel: squareSize,
    osmFeatures: [],
  };
}
