// Route-corridor shared config.
//
// The single "corridor quality" dial couples how WIDE a band we pull around the
// route with how DETAILED it is (LOD). Each tier maps to:
//   - halfWidthM:   corridor half-width in metres (surroundings each side of road)
//   - googleQuality: baseline Google 3D Tiles bake quality tier (see googleBakeCore)
//   - chunkSizeM:   AOI box size used when chunking a long route (Phase 1)
//
// Phase 0 only consumes halfWidthM + labels for the UI. chunking/baking land later.

export const CORRIDOR_TIERS = [
  { id: 'draft', halfWidthM: 50, googleQuality: 'high', chunkSizeM: 1024 },
  { id: 'standard', halfWidthM: 150, googleQuality: 'roads', chunkSizeM: 1024 },
  { id: 'fine', halfWidthM: 300, googleQuality: 'roads', chunkSizeM: 2048 },
  { id: 'ultra', halfWidthM: 500, googleQuality: 'max', chunkSizeM: 2048 },
];

export const DEFAULT_CORRIDOR_TIER = 'standard';

export function getCorridorTier(id) {
  return CORRIDOR_TIERS.find((t) => t.id === id) || CORRIDOR_TIERS.find((t) => t.id === DEFAULT_CORRIDOR_TIER);
}

// Fraction adjacent AOI boxes overlap along the route, so neighbouring Google
// bakes share an edge to weld later (Phase 1b/3).
export const CHUNK_OVERLAP = 0.15;

const DEG = Math.PI / 180;
const M_PER_DEG_LAT = 111320;

/** Great-circle distance in metres between two {lat,lng}. */
export function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const la1 = a.lat * DEG;
  const la2 = b.lat * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Total polyline length in metres. */
export function polylineLengthMeters(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineMeters(points[i - 1], points[i]);
  return total;
}

const lerpPoint = (a, b, f) => ({
  lat: a.lat + (b.lat - a.lat) * f,
  lng: a.lng + (b.lng - a.lng) * f,
});

/**
 * Point on the polyline at arc-length `targetM` from the start.
 * @param {{lat,lng}[]} points
 * @param {number[]} cumM  cumulative distance at each vertex (cumM[0] === 0)
 * @param {number} targetM
 */
function pointAtArcLength(points, cumM, targetM) {
  if (targetM <= 0) return points[0];
  const last = cumM[cumM.length - 1];
  if (targetM >= last) return points[points.length - 1];
  // find segment containing targetM
  let i = 1;
  while (i < cumM.length && cumM[i] < targetM) i++;
  const segLen = cumM[i] - cumM[i - 1] || 1;
  const f = (targetM - cumM[i - 1]) / segLen;
  return lerpPoint(points[i - 1], points[i], f);
}

/** Axis-aligned square bounds of side `sizeM` centred on `center`. */
export function squareBounds(center, sizeM) {
  const halfLat = sizeM / 2 / M_PER_DEG_LAT;
  const halfLng = sizeM / 2 / (M_PER_DEG_LAT * Math.cos(center.lat * DEG) || M_PER_DEG_LAT);
  return {
    north: center.lat + halfLat,
    south: center.lat - halfLat,
    east: center.lng + halfLng,
    west: center.lng - halfLng,
  };
}

const inBounds = (p, b) => p.lat >= b.south && p.lat <= b.north && p.lng >= b.west && p.lng <= b.east;

/**
 * Decompose a route polyline into a chain of overlapping axis-aligned AOI boxes
 * that follow the road. Each box is centred on the route and sized by the tier's
 * chunkSizeM; consecutive boxes step along the route by chunkSizeM*(1-overlap)
 * so their union covers the whole route with a shared overlap to weld later.
 *
 * @param {{lat:number,lng:number}[]} polyline decoded route centerline
 * @param {string} tierId corridor tier id
 * @returns {{id:string,index:number,center:{lat,lng},bounds:object,segment:{lat,lng}[],distanceFromStartM:number}[]}
 */
export function chunkRoute(polyline, tierId) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const tier = getCorridorTier(tierId);
  const chunkSizeM = tier.chunkSizeM;
  const step = Math.max(1, chunkSizeM * (1 - CHUNK_OVERLAP));

  // cumulative arc length
  const cumM = [0];
  for (let i = 1; i < polyline.length; i++) {
    cumM[i] = cumM[i - 1] + haversineMeters(polyline[i - 1], polyline[i]);
  }
  const total = cumM[cumM.length - 1];

  // chunk-center arc positions
  const positions = [];
  if (total <= chunkSizeM) {
    positions.push(total / 2); // whole route fits one box
  } else {
    for (let s = 0; s < total; s += step) positions.push(s);
    if (positions[positions.length - 1] < total - 1) positions.push(total);
  }

  return positions.map((s, index) => {
    const center = pointAtArcLength(polyline, cumM, s);
    const bounds = squareBounds(center, chunkSizeM);
    const segment = polyline.filter((p) => inBounds(p, bounds));
    return {
      id: `chunk-${index}`,
      index,
      center: { lat: center.lat, lng: center.lng },
      bounds,
      segment,
      distanceFromStartM: s,
    };
  });
}
