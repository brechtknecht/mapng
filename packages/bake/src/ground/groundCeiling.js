/** @layer core */
// Ground ceiling: the .ter must never sit ABOVE the visible tile surface where
// a tile surface exists. Off the carriageway the bare-earth filters and the
// corridor feather over-estimate the ground (blurred residuals, pavements,
// yards): measured on a real route, 10–36 % of the covered cells 6–60 m from the
// route line had the .ter above the tile surface even with the 0.15 m render
// bias — the terrain pokes through the tiles ("z-fighting am Boden"). On the
// carriageway the road profile is the authority and the terSnap seats the
// visible road onto it, so the ceiling does not touch masked cells.
//
// Rule per covered cell outside the carriageway mask: if the ground exceeds
// the per-cell tile-surface minimum by more than `epsilonM` and at most
// `maxExcessM`, lower it to (minimum − epsilonM). Larger excesses are left
// alone: a surface metres under the ground is sub-surface junk or a sunken
// yard the pit defences handle, not a poke-through. Pure / DOM-free.

/**
 * @param {{heightMap:Float32Array, rawMinHeightMap?:Float32Array, coveredMask?:Uint8Array, width:number, height:number}} ground
 *   extractTileGround result (rawMinHeightMap = gated per-cell tile min, abs m)
 * @param {{sample:(x:number,z:number)=>number}|null} roadMask  groundMask.buildGroundMask
 * @param {object} [opts]
 * @param {number} [opts.epsilonM=0.05]    clearance kept below the tile surface
 * @param {number} [opts.maxExcessM=1.5]   ignore cells whose ground is further above the min (junk / pits)
 * @param {number} [opts.maskMax=0.5]      cells with road-mask weight ≥ this are the carriageway: untouched
 * @param {number} [opts.sceneSize=100]
 * @returns {{ lowered:number, candidates:number, maxLoweredM:number, meanLoweredM:number }}
 */
export const applyGroundCeiling = (ground, roadMask, {
  epsilonM = 0.05,
  maxExcessM = 1.5,
  maskMax = 0.5,
  sceneSize = 100,
} = {}) => {
  const out = { lowered: 0, candidates: 0, maxLoweredM: 0, meanLoweredM: 0 };
  const hm = ground?.heightMap, raw = ground?.rawMinHeightMap, cov = ground?.coveredMask;
  if (!hm || !raw || !cov) return out;
  const W = ground.width, H = ground.height, half = sceneSize / 2;
  let sum = 0;
  for (let row = 0; row < H; row++) {
    const z = (row / (H - 1)) * sceneSize - half;
    for (let col = 0; col < W; col++) {
      const i = row * W + col;
      if (!cov[i]) continue;
      const excess = hm[i] - raw[i];
      if (!(excess > epsilonM) || excess > maxExcessM) continue;
      out.candidates++;
      if (roadMask) {
        const x = (col / (W - 1)) * sceneSize - half;
        if (roadMask.sample(x, z) >= maskMax) continue;
      }
      const d = excess - epsilonM;
      hm[i] = raw[i] - epsilonM;
      out.lowered++;
      sum += d;
      if (d > out.maxLoweredM) out.maxLoweredM = d;
    }
  }
  out.meanLoweredM = out.lowered ? sum / out.lowered : 0;
  return out;
};
