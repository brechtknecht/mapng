// Synthetic MULTI-CHUNK route model for the lab — reproduces the vertical
// pipeline services/exportRouteLevel.js runs, which the single-chunk lab never
// modelled: a route-wide shared anchor (chunk 0), the conform applied PER CHUNK
// against that chunk's own terrain, the combined terrain the level actually
// drives on (buildCombinedRouteTerrain), and baseUp placement against
// combined.minHeight. Residual is measured against the COMBINED terrain — the
// surface under the wheels — not the per-chunk terrain the conform targeted.
//
// Pure/DOM-free so it runs in node tests. Uses the REAL conform + the REAL
// route compositor; only the terrain + tile geometry are synthesised so the
// failure modes (geoid drift, per-chunk DEM disagreement at seams) are
// controllable.

import { conformTilesToFloor } from '@mapng/bake/tileGroundConform';
import { buildCombinedRouteTerrain, sampleHeightAt, sampleCombinedHeightMap } from '@mapng/route/routeTerrainComposite';
import { SCENE_SIZE } from '@mapng/bake/googleBakeCore';

const HALF = SCENE_SIZE / 2;
const M_PER_DEG_LAT = 111320;

// Scene XZ → lat/lng within a chunk's bounds (matches sampleHeightAtScene's
// u=(x+50)/100 west→east, v=(z+50)/100 north→south convention).
const sceneToLatLng = (b, x, z) => ({
  lng: b.west + ((x + HALF) / SCENE_SIZE) * (b.east - b.west),
  lat: b.north - ((z + HALF) / SCENE_SIZE) * (b.north - b.south),
});

// "True" orthometric ground as a function of metres east of the route start —
// a gentle slope + a long wave, shared by every chunk's DEM and the tiles.
const truthGround = (wEast) => 120 + 0.012 * wEast + 6 * Math.sin(wEast / 180);

const makeTerrain = (bounds, n, wEastOf, biasM) => {
  const heightMap = new Float32Array(n * n);
  let minHeight = Infinity, maxHeight = -Infinity;
  for (let row = 0; row < n; row++) {
    const lat = bounds.north - (row / (n - 1)) * (bounds.north - bounds.south);
    for (let col = 0; col < n; col++) {
      const lng = bounds.west + (col / (n - 1)) * (bounds.east - bounds.west);
      const h = truthGround(wEastOf(lat, lng)) + biasM; // per-chunk DEM bias
      heightMap[row * n + col] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }
  return { width: n, height: n, minHeight, maxHeight, heightMap, bounds };
};

// A ground carpet whose Y reproduces the worker's transform for this chunk:
//   Y = (groundOffset − chunkMinHeight) + cart.height
// with cart.height = ellipsoidal ground = truth + geoidN(chunk). groundOffset is
// the route-wide shared anchor.
const makeGroundSoup = (terrain, wEastOf, geoidN, sharedAnchor, gridN) => {
  const b = terrain.bounds;
  const verts = [];
  for (let r = 0; r <= gridN; r++) {
    for (let c = 0; c <= gridN; c++) {
      const x = -HALF + (c / gridN) * SCENE_SIZE;
      const z = -HALF + (r / gridN) * SCENE_SIZE;
      const { lat, lng } = sceneToLatLng(b, x, z);
      const cartHeight = truthGround(wEastOf(lat, lng)) + geoidN;
      const y = (sharedAnchor - terrain.minHeight) + cartHeight;
      verts.push(x, y, z);
    }
  }
  const index = [];
  const idx = (r, c) => r * (gridN + 1) + c;
  for (let r = 0; r < gridN; r++) for (let c = 0; c < gridN; c++) {
    index.push(idx(r, c), idx(r, c + 1), idx(r + 1, c), idx(r, c + 1), idx(r + 1, c + 1), idx(r + 1, c));
  }
  return [{ positions: new Float32Array(verts), index: new Uint32Array(index), kind: 'ground' }];
};

/**
 * Build a synthetic route.
 * @param {object} o
 * @param {number} [o.nChunks=3]
 * @param {number} [o.sizeM=300]       chunk square size
 * @param {number} [o.overlapFrac=0.15] adjacent-chunk overlap (real chunks overlap)
 * @param {number} [o.lat0=34.0]
 * @param {number[]} [o.biasPerChunk]  per-chunk DEM offset (m) — models elevation
 *   tiles disagreeing between chunks. Default all 0.
 * @param {number[]} [o.geoidPerChunk] per-chunk geoid undulation (m) — models the
 *   ellipsoid↔orthometric term drifting along the route. Default all -32.
 * @returns {{ chunks: Array<{terrain, soup, bounds}>, sharedAnchor:number }}
 */
export const buildSyntheticRoute = ({
  nChunks = 3, sizeM = 300, n = 64, gridN = 40, overlapFrac = 0.15,
  lat0 = 34.0, biasPerChunk = null, geoidPerChunk = null,
} = {}) => {
  const dLat = sizeM / M_PER_DEG_LAT;
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const dLng = sizeM / mPerDegLng;
  const stepM = sizeM * (1 - overlapFrac);
  const stepLng = stepM / mPerDegLng;
  const lng0 = -117.7;
  // metres east of route start, from lng
  const wEastOf = (_lat, lng) => (lng - lng0) * mPerDegLng;

  const bias = biasPerChunk ?? new Array(nChunks).fill(0);
  const geoid = geoidPerChunk ?? new Array(nChunks).fill(-32);

  // chunk 0's natural anchor = chunkDEM_0(centre) − cart.height_0(centre)
  //                          = (truth+bias0) − (truth+geoid0) = bias0 − geoid0
  const sharedAnchor = bias[0] - geoid[0];

  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    const centerLng = lng0 + i * stepLng + dLng / 2;
    const bounds = {
      north: lat0 + dLat / 2, south: lat0 - dLat / 2,
      east: centerLng + dLng / 2, west: centerLng - dLng / 2,
    };
    const terrain = makeTerrain(bounds, n, wEastOf, bias[i]);
    const soup = makeGroundSoup(terrain, wEastOf, geoid[i], sharedAnchor, gridN);
    chunks.push({ terrain, soup, bounds });
  }
  return { chunks, sharedAnchor, wEastOf };
};

// Resample the combined terrain onto a chunk's bounds/grid, so the conform can
// optionally target the combined surface (the proposed fix) instead of the
// per-chunk terrain.
// The exact terrain exportRouteLevel now bakes each chunk against: the combined
// heights on the chunk's grid, keeping the chunk's bounds + minHeight (datum) so
// baseUp placement is unchanged. Uses the SAME service helper as the app.
const combinedAsChunk = (combined, chunkTerrain) => ({
  ...chunkTerrain,
  heightMap: sampleCombinedHeightMap(combined, chunkTerrain),
});

/**
 * Run the route vertical pipeline and measure per-chunk residual vs the COMBINED
 * terrain (the drivable surface).
 * @param {object} route  buildSyntheticRoute() result
 * @param {object} [opts] { conformMode: 'perChunk' | 'combined' | 'off' }
 * @returns {{ combined, perChunk: Array<{meanAbsResidualM:number, maxAbsResidualM:number}> }}
 */
export const analyzeRoute = (route, { conformMode = 'perChunk' } = {}) => {
  const { chunks } = route;
  const combined = buildCombinedRouteTerrain(chunks.map((c) => c.terrain));

  const perChunk = chunks.map((c) => {
    const target = conformMode === 'combined' ? combinedAsChunk(combined, c.terrain) : c.terrain;
    const conformed = conformMode === 'off'
      ? { positions: [null] }
      : conformTilesToFloor(c.soup, target);
    const baseUp = c.terrain.minHeight - combined.minHeight;

    let sum = 0, max = 0, cnt = 0;
    const out = conformed.positions[0] || c.soup[0].positions;
    const p = c.soup[0].positions;
    for (let i = 0; i < p.length; i += 3) {
      const yConf = (conformMode === 'off' ? p[i + 1] : out[i + 1]);
      const { lat, lng } = sceneToLatLng(c.bounds, p[i], p[i + 2]);
      const worldZ = baseUp + yConf;
      const combinedAbove = sampleHeightAt(combined, lat, lng) - combined.minHeight;
      const res = Math.abs(worldZ - combinedAbove);
      sum += res; if (res > max) max = res; cnt++;
    }
    return { meanAbsResidualM: sum / cnt, maxAbsResidualM: max };
  });

  return { combined, perChunk };
};
