/** @layer core */
// Chunk ownership (route mode): every point of the route belongs to exactly
// ONE chunk — the one whose centre is nearest (Voronoi by chunk centre). Where
// neighbouring AOI boxes overlap, both chunks baked the same ground
// independently and disagree by up to metres; blending two solutions there
// puts the drive surface between them while the visible mesh is one of them.
// Ownership makes mesh and floor switch chunk at the SAME line: the mesh is
// hard-clipped to its owner region, the .ter takes the owner's floor (with a
// short feather, see routeTerrainComposite). Pure, DOM-free.
import { SCENE_SIZE } from '../scene/sceneFrame.js';
import { createMetricProjector } from '@mapng/geo';

/**
 * Chunk centres (lat/lng) → this chunk's scene XZ frame.
 * @param {Array<{lat:number,lng:number}>} centers
 * @param {object} data  chunk TerrainData (bounds, width, height)
 * @returns {Array<{x:number,z:number}>}
 */
export const chunkCentersToScene = (centers, data) => {
  const project = createMetricProjector(data.bounds, data.width, data.height);
  const half = SCENE_SIZE / 2;
  return centers.map((c) => {
    const p = project(c.lat, c.lng);
    return {
      x: (p.x / (data.width - 1)) * SCENE_SIZE - half,
      z: (p.y / (data.height - 1)) * SCENE_SIZE - half,
    };
  });
};

/** Index of the nearest centre to (x, z); ties resolve to the lower index. */
export const nearestCenterIndex = (centers, x, z) => {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const dx = centers[i].x - x, dz = centers[i].z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
};

/**
 * Ownership weight of chunk `self` at (x, z): 1 deep inside its Voronoi cell,
 * 0.5 on the bisector to the nearest other centre, 0 a feather beyond it.
 * Distances and `feather` in the same units as the centres.
 */
export const ownershipWeight = (centers, self, x, z, feather) => {
  const c = centers[self];
  const dSelf = Math.hypot(c.x - x, c.z - z);
  let dOther = Infinity;
  for (let i = 0; i < centers.length; i++) {
    if (i === self) continue;
    const d = Math.hypot(centers[i].x - x, centers[i].z - z);
    if (d < dOther) dOther = d;
  }
  if (dOther === Infinity) return 1;
  if (!(feather > 0)) return dSelf < dOther || (dSelf === dOther && isLowestTie(centers, self, x, z)) ? 1 : 0;
  const t = (dOther - dSelf) / (2 * feather) + 0.5;
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
};

const isLowestTie = (centers, self, x, z) => nearestCenterIndex(centers, x, z) === self;

/**
 * Clip a tile soup to the region owned by chunk `self`: keep a triangle only
 * when its XZ centroid's nearest centre is `self`. Returns per-record index
 * arrays (same contract as stripGroundTris) plus counts.
 *
 * @param {Array<{positions:Float32Array,index:ArrayLike<number>|null}>} soup
 * @param {object} data                       chunk TerrainData
 * @param {{centers:Array<{lat,lng}>, self:number}} ownership
 */
export const clipSoupToOwnership = (soup, data, ownership) => {
  const centers = chunkCentersToScene(ownership.centers, data);
  const self = ownership.self;
  let removed = 0, total = 0;
  const indices = soup.map((m) => {
    const p = m.positions, idx = m.index;
    if (!idx || !p) return m.index;
    const out = [];
    let changed = false;
    for (let t = 0; t < idx.length; t += 3) {
      total++;
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const cx = (p[a * 3] + p[b * 3] + p[c * 3]) / 3;
      const cz = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3;
      if (nearestCenterIndex(centers, cx, cz) === self) out.push(a, b, c);
      else { removed++; changed = true; }
    }
    if (!changed) return idx;
    return idx instanceof Uint32Array || idx instanceof Uint16Array ? new idx.constructor(out) : out;
  });
  return { indices, removed, total };
};
