// Route-corridor stitch frame (Phase 3a).
//
// Each per-chunk GLB is exported in its OWN local scene frame:
//   - +X = east, +Z = south, -Z = north  (from latLngToScene)
//   - a UNIFORM scale of 1/unitsPerMeter converts the whole GLB to real metres
//     (Y was pre-multiplied by unitsPerMeter during export, so the uniform scale
//      is correct on every axis).
//
// To assemble the chunks into ONE continuous world we put them all in a shared
// metric frame anchored at the first chunk's centre:
//   world +X = east, +Z = south, +Y = up, metres.
// For chunk i:  scale its GLB by placement.scale, then translate by
//               placement.translationM.
//
// This keeps the chunks as separate pieces that tile together correctly — the
// scalable answer for long routes — and a later merge step (3b) can bake them
// into a single GLB for routes small enough to fit one file.

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

/**
 * @param {{center:{lat:number,lng:number}, unitsPerMeter:number, minHeight?:number}[]} chunkInfos
 * @param {number} chunkSizeM  AOI box edge length (for world bounds)
 * @returns {{
 *   anchor:{lat:number,lng:number,minHeight:number},
 *   convention:string,
 *   placements:{offsetEastM:number,offsetNorthM:number,scale:number,translationM:{x:number,y:number,z:number}}[],
 *   worldBoundsM:{minX:number,maxX:number,minZ:number,maxZ:number,widthM:number,depthM:number}
 * }}
 */
export function computeRouteFrame(chunkInfos, chunkSizeM) {
  if (!Array.isArray(chunkInfos) || chunkInfos.length === 0) {
    return { anchor: null, convention: CONVENTION, placements: [], worldBoundsM: null };
  }
  const anchorMinHeight = Number(chunkInfos[0].minHeight) || 0;
  const anchor = { lat: chunkInfos[0].center.lat, lng: chunkInfos[0].center.lng, minHeight: anchorMinHeight };
  const mPerDegLng = M_PER_DEG_LAT * Math.cos(anchor.lat * DEG) || M_PER_DEG_LAT;
  const half = (chunkSizeM || 0) / 2;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const nz = (n) => (n === 0 ? 0 : n); // normalise -0 → 0

  const placements = chunkInfos.map((c) => {
    const offsetEastM = (c.center.lng - anchor.lng) * mPerDegLng;
    const offsetNorthM = (c.center.lat - anchor.lat) * M_PER_DEG_LAT;
    // each chunk's terrain Y is relative to its own min-elevation datum;
    // lift it back to absolute elevation, anchored at the first chunk
    const offsetUpM = (Number(c.minHeight) || 0) - anchorMinHeight;
    // world +X = east, +Z = south → north maps to -Z
    const translationM = { x: nz(offsetEastM), y: nz(offsetUpM), z: nz(-offsetNorthM) };
    minX = Math.min(minX, translationM.x - half);
    maxX = Math.max(maxX, translationM.x + half);
    minZ = Math.min(minZ, translationM.z - half);
    maxZ = Math.max(maxZ, translationM.z + half);
    return {
      offsetEastM,
      offsetNorthM,
      scale: c.unitsPerMeter > 0 ? 1 / c.unitsPerMeter : 1,
      translationM,
    };
  });

  return {
    anchor,
    convention: CONVENTION,
    placements,
    worldBoundsM: { minX, maxX, minZ, maxZ, widthM: maxX - minX, depthM: maxZ - minZ },
  };
}

export const CONVENTION =
  'world +X=east, +Z=south, +Y=up (metres). Per chunk: scale GLB by placement.scale, then translate by placement.translationM.';
