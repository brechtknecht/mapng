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

// Manual chunk-size presets (metres). chunkSizeM doubles as the per-box terrain
// heightmap resolution (1 px = 1 m), so these are also 512²…4096² px terrains.
export const CHUNK_SIZE_PRESETS = [512, 1024, 2048, 4096];

/**
 * Resolve the effective AOI box size for a route bake. `override` decouples the
 * box size from the quality tier (null/0/invalid → the tier's default). The box
 * must be able to CONTAIN the corridor, so it is floored at twice the tier's
 * half-width (a 512 m box can't hold a ±500 m ultra corridor).
 *
 * @param {string} tierId
 * @param {number|null|undefined} override metres
 * @returns {number} effective chunkSizeM
 */
export function resolveChunkSizeM(tierId, override) {
  const tier = getCorridorTier(tierId);
  if (!Number.isFinite(override) || override <= 0) return tier.chunkSizeM;
  const min = Math.max(256, tier.halfWidthM * 2);
  return Math.max(min, Math.round(override));
}

// Metric overlap band (metres) shared by neighbouring AOI boxes so their Google
// bakes have common ground geometry to weld/stitch later (Phase 1b/3). A FIXED
// distance, NOT a fraction of the box: the weld needs the same physical band
// regardless of chunk size, whereas a percentage made big boxes re-bake a
// needless ~300 m strip (2048 m → 307 m) and stacked many heavy overlaps on
// small boxes. ~64 m gives plenty of shared tiles for a weld while keeping the
// doubled-geometry seam thin.
export const CHUNK_OVERLAP_M = 64;

/**
 * Overlap band a box keeps to its neighbour, in metres. Coverage-aware: at
 * least the fixed weld floor, but ≥ ~the corridor half-width so the corridor
 * stays covered where the route nears a box edge. Capped at half the box so a
 * box still advances along the route.
 */
export const routeOverlapM = (chunkSizeM, halfWidthM = 0) =>
  Math.min(chunkSizeM * 0.5, Math.max(CHUNK_OVERLAP_M, halfWidthM * 1.2));

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

// Chebyshev (max-axis) distance in metres between two {lat,lng}. This is the
// box's OWN metric — a point is inside an axis-aligned box of side S centred at
// c iff chebMeters(p, c) ≤ S/2 — so it's what placement must reason in, not
// great-circle arc length.
const chebMeters = (p, q) => {
  const dN = Math.abs(p.lat - q.lat) * M_PER_DEG_LAT;
  const dE = Math.abs(p.lng - q.lng) * M_PER_DEG_LAT * Math.cos(((p.lat + q.lat) / 2) * DEG);
  return Math.max(dN, dE);
};

/**
 * Decompose a route polyline into a chain of overlapping axis-aligned AOI boxes
 * that follow the road. Boxes are placed by 2D COVERAGE, not arc length: walk
 * the route and drop a new box only when the road is about to leave the current
 * box. Compared with fixed arc-length stepping this removes the redundant
 * pile-up of near-coincident boxes through curves/switchbacks, and on diagonal
 * runs it spaces boxes by their real 2D extent instead of their (shorter)
 * along-axis projection — far fewer overlaps. Each box still shares a
 * coverage-aware overlap band (routeOverlapM) with its neighbour to weld later.
 *
 * NOTE: the boxes stay axis-aligned, so a road at ~45° still overlaps somewhat
 * in the perpendicular axis — eliminating that entirely needs ROTATED AOIs.
 *
 * @param {{lat:number,lng:number}[]} polyline decoded route centerline
 * @param {string} tierId corridor tier id
 * @param {number|null} [chunkSizeOverrideM] manual box size, decoupled from the
 *   tier (null → the tier's default; see resolveChunkSizeM)
 * @returns {{id:string,index:number,center:{lat,lng},bounds:object,segment:{lat,lng}[],distanceFromStartM:number}[]}
 */
export function chunkRoute(polyline, tierId, chunkSizeOverrideM = null) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const chunkSizeM = resolveChunkSizeM(tierId, chunkSizeOverrideM);

  // total route length
  let total = 0;
  for (let i = 1; i < polyline.length; i++) total += haversineMeters(polyline[i - 1], polyline[i]);

  // Resample the polyline at a fine, uniform step so coverage can be tested
  // incrementally (and so a box lands close to the point that triggered it).
  const ds = Math.max(8, chunkSizeM / 32);
  const samples = [{ lat: polyline[0].lat, lng: polyline[0].lng, arc: 0 }];
  let arc = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1], b = polyline[i];
    const segM = haversineMeters(a, b);
    const sub = Math.max(1, Math.ceil(segM / ds));
    for (let k = 1; k <= sub; k++) {
      const f = k / sub;
      arc += segM / sub;
      samples.push({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f, arc });
    }
  }
  const N = samples.length;

  const reach = chunkSizeM / 2; // a box covers chebMeters ≤ reach around its centre
  const overlapM = routeOverlapM(chunkSizeM, getCorridorTier(tierId).halfWidthM);
  const lead = Math.max(1, reach - overlapM); // place a centre this far ahead of the first uncovered sample

  // Centre arc positions (the box centres along the route).
  const centerArcs = [];
  if (total <= chunkSizeM) {
    centerArcs.push(total / 2); // whole route fits one box — centre it
  } else {
    let u = 0; // index of the first not-yet-covered sample
    while (u < N) {
      // Push the centre `lead` ahead of the uncovered frontier so the box's
      // forward half does the covering (its trailing half overlaps the previous
      // box by ~overlapM). Clamp to the route end.
      let c = u;
      while (c + 1 < N && chebMeters(samples[c], samples[u]) < lead) c++;
      centerArcs.push(samples[c].arc);
      // Covered = the CONTIGUOUS run from u that stays inside this box. Stopping
      // at the first sample outside guarantees no centerline gap.
      let j = u;
      while (j < N && chebMeters(samples[j], samples[c]) <= reach) j++;
      u = j > u ? j : u + 1; // always make progress
    }
  }

  // Map arc → cumulative-vertex lookup for the segment filter.
  const cumM = [0];
  for (let i = 1; i < polyline.length; i++) cumM[i] = cumM[i - 1] + haversineMeters(polyline[i - 1], polyline[i]);

  return centerArcs.map((s, index) => {
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
