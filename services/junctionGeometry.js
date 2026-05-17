// Pure geometry for OSM-road intersection prisms and MeshRoad polyline cleanup.
// No THREE.js dependency — every function operates on plain numeric arrays in
// BeamNG world space (X east, Y north, Z up; metres).

export const MESH_ROAD_SURFACE_LIFT = 0.5;
export const MESH_ROAD_DEPTH = 0.5;
export const JUNCTION_COLLISION_OVERLAP = 0.05;
export const MIN_MESH_ROAD_LENGTH = 3.0;
export const MESH_ROAD_RESAMPLE_SPACING_M = 4.0;
export const MITER_LIMIT_FACTOR = 4.0;
export const MIN_TANGENT_DISTANCE = 3.0;
export const MIN_JUNCTION_SEGMENTS = 3;
export const MAX_CLIPBACK_RATIO = 0.4;
export const JUNCTION_MERGE_RADIUS_M = 15.0;
export const JUNCTION_MERGE_MAX_Z_RANGE_M = 1.5;
export const JUNCTION_MERGE_BBOX_SLOP_M = 0.5;
export const JUNCTION_POLYGON_Z_CLAMP_RANGE_M = 1.0;
export const JUNCTION_VALIDATE_MIN_AREA_M2 = 0.5;
export const JUNCTION_VALIDATE_MIN_EDGE_M = 0.05;
export const JUNCTION_VALIDATE_MAX_BBOX_DIAG_M = 200.0;
export const KINK_SMOOTH_THRESHOLD_DEG = 75;
export const KINK_SMOOTH_THRESHOLD_TIGHT_DEG = 30;
export const KINK_SHORT_EDGE_M = 4.0;
export const KINK_SMOOTH_OFFSET_M = 2.0;
export const KINK_OFFSET_MAX_RATIO = 0.4;
export const END_EDGE_RATIO_THRESHOLD = 0.4;
export const END_EDGE_KINK_DEG = 15;
export const END_EDGE_PRUNE_MIN_M = 2.0;

const EPS = 1e-9;

function dist2D(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLength2D(nodes) {
  let total = 0;
  for (let i = 1; i < nodes.length; i++) total += dist2D(nodes[i - 1], nodes[i]);
  return total;
}

function unit2D(dx, dy) {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < EPS) return [0, 0];
  return [dx / len, dy / len];
}

function angleChangeDeg(a, b, c) {
  const v1 = unit2D(b[0] - a[0], b[1] - a[1]);
  const v2 = unit2D(c[0] - b[0], c[1] - b[1]);
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1]));
  return (Math.acos(dot) * 180) / Math.PI;
}

/**
 * Walk along a segment's worldGeometry from the indicated end, accumulating 2D
 * distance, and return a unit outbound vector (away from junction) from the
 * first sample at least MIN_TANGENT_DISTANCE away.
 */
function inboundTangent(worldGeometry, end) {
  if (!Array.isArray(worldGeometry) || worldGeometry.length < 2) return [0, 0];
  const seq = end === 'start' ? worldGeometry : [...worldGeometry].reverse();
  const node = seq[0];
  let acc = 0;
  let from = seq[seq.length - 1];
  for (let i = 1; i < seq.length; i++) {
    acc += dist2D(seq[i - 1], seq[i]);
    if (acc >= MIN_TANGENT_DISTANCE) { from = seq[i]; break; }
  }
  return unit2D(node[0] - from[0], node[1] - from[1]);
}

function solveWedge(nodeXY, outA, halfWidthA, outB, halfWidthB) {
  const leftA  = [-outA[1],  outA[0]];
  const rightB = [ outB[1], -outB[0]];
  const Px = nodeXY[0] + leftA[0]  * halfWidthA;
  const Py = nodeXY[1] + leftA[1]  * halfWidthA;
  const Qx = nodeXY[0] + rightB[0] * halfWidthB;
  const Qy = nodeXY[1] + rightB[1] * halfWidthB;

  const det = outB[0] * outA[1] - outA[0] * outB[1];
  if (Math.abs(det) < 1e-6) return { distA: 0, distB: 0 };

  const dx = Qx - Px;
  const dy = Qy - Py;
  let s = (-dx * outB[1] + outB[0] * dy) / det;
  let t = ( outA[0] * dy  - dx * outA[1]) / det;

  const limit = Math.max(halfWidthA, halfWidthB) * MITER_LIMIT_FACTOR;
  if (s < 0) s = 0;
  if (t < 0) t = 0;
  if (s > limit) s = limit;
  if (t > limit) t = limit;
  return { distA: s, distB: t };
}

// ─── Pass 1 — clip computation ────────────────────────────────────────────

/**
 * For each junction node (≥ MIN_JUNCTION_SEGMENTS approaches) compute how far
 * back along each segment the MeshRoad should be trimmed so adjacent slabs
 * don't visually overlap. Uses angle-bisector (miter) geometry on the raw
 * worldGeometry tangents — intentionally approximate; the polygon is built in
 * Pass 2 from actual MeshRoad endpoints, not from these positions.
 *
 * Returns Map<segmentId, { start: number, end: number }> — metres to trim from
 * each end. Segments not in the map are not at any junction.
 *
 * segmentInfo: Map<segmentId, { worldGeometry: [[x,y,z],…], halfWidth: number }>
 * worldGeometry must already include MESH_ROAD_SURFACE_LIFT.
 */
export function analyzeJunctions(roadNetwork, segmentInfo) {
  const segmentClips = new Map();
  if (!roadNetwork?.intersections) return segmentClips;

  const recordClip = (segId, end, dist) => {
    const cur = segmentClips.get(segId) || { start: 0, end: 0 };
    if (dist > cur[end]) cur[end] = dist;
    segmentClips.set(segId, cur);
  };

  for (const [, entries] of roadNetwork.intersections) {
    if (!Array.isArray(entries) || entries.length < MIN_JUNCTION_SEGMENTS) continue;

    // Derive junction XY from any segment's touching endpoint.
    let nodeXY = null;
    for (const entry of entries) {
      const info = segmentInfo.get(entry.road.id);
      if (!info?.worldGeometry?.length) continue;
      const idx = entry.isStart ? 0 : info.worldGeometry.length - 1;
      nodeXY = [info.worldGeometry[idx][0], info.worldGeometry[idx][1]];
      break;
    }
    if (!nodeXY) continue;

    const approaches = [];
    for (const entry of entries) {
      const info = segmentInfo.get(entry.road.id);
      if (!info?.worldGeometry?.length || !Number.isFinite(info.halfWidth)) continue;
      const end = entry.isStart ? 'start' : 'end';
      const inbound = inboundTangent(info.worldGeometry, end);
      if (inbound[0] === 0 && inbound[1] === 0) continue;
      approaches.push({
        segmentId: entry.road.id,
        end,
        worldGeometry: info.worldGeometry,
        halfWidth: info.halfWidth,
        outbound: [-inbound[0], -inbound[1]],
      });
    }
    if (approaches.length < MIN_JUNCTION_SEGMENTS) continue;

    approaches.sort((a, b) =>
      Math.atan2(a.outbound[1], a.outbound[0]) - Math.atan2(b.outbound[1], b.outbound[0])
    );

    const N = approaches.length;
    const clipsL = new Array(N).fill(0);
    const clipsR = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      const a = approaches[(i - 1 + N) % N];
      const b = approaches[i];
      const { distA, distB } = solveWedge(nodeXY, a.outbound, a.halfWidth, b.outbound, b.halfWidth);
      clipsL[(i - 1 + N) % N] = distA;
      clipsR[i] = distB;
    }

    // Cap-and-continue: if the desired miter clip would consume more than
    // MAX_CLIPBACK_RATIO of a segment (acute-angle junctions, very-mismatched
    // widths), clamp this one approach's clip rather than aborting the whole
    // junction. The Pass-2 polygon is built from actual post-pipeline endpoints
    // so a capped approach still gets a correct prism corner — at worst the
    // road overlaps a few cm into the prism (the JUNCTION_COLLISION_OVERLAP
    // mechanism is already designed for exactly this).
    for (let i = 0; i < N; i++) {
      const segLen = polylineLength2D(approaches[i].worldGeometry);
      if (segLen <= 0) continue;
      const desired = Math.max(clipsL[i], clipsR[i]);
      const clip = Math.min(desired, segLen * MAX_CLIPBACK_RATIO);
      recordClip(approaches[i].segmentId, approaches[i].end, clip);
    }
  }

  return segmentClips;
}

// ─── Pass 2 — polygon construction from actual MeshRoad endpoints ─────────

/**
 * Build the junction polygon list from the actual emitted MeshRoad endpoint
 * data. Called after generateMeshRoads so the polygon perimeter exactly matches
 * the visible road cross-sections — no approximation.
 *
 * junctionEndpoints: Map<`${segmentId}|${'start'|'end'}`, {
 *   pos:      [x, y, z],   // actual first/last MeshRoad node (world metres)
 *   outbound: [dx, dy],    // unit vec AWAY from junction (last-edge direction)
 *   halfWidth: number,
 * }>
 *
 * Returns [{ position, polygon }] for all valid junctions.
 */
export function buildJunctionPolygons(roadNetwork, junctionEndpoints) {
  const junctions = [];
  if (!roadNetwork?.intersections || !junctionEndpoints) return junctions;

  for (const [, entries] of roadNetwork.intersections) {
    if (!Array.isArray(entries) || entries.length < MIN_JUNCTION_SEGMENTS) continue;

    // Collect approaches that have actual endpoint data (road was emitted and
    // clipped for this junction end).
    const approaches = [];
    for (const entry of entries) {
      const key = `${entry.road.id}|${entry.isStart ? 'start' : 'end'}`;
      const ep = junctionEndpoints.get(key);
      if (!ep) continue;
      if (ep.outbound[0] === 0 && ep.outbound[1] === 0) continue;
      approaches.push({ ...ep, key });
    }
    if (approaches.length < MIN_JUNCTION_SEGMENTS) continue;

    // Sort CCW by outbound angle so the polygon walk is counter-clockwise.
    approaches.sort((a, b) =>
      Math.atan2(a.outbound[1], a.outbound[0]) - Math.atan2(b.outbound[1], b.outbound[0])
    );

    // Per approach push both cross-section corners: RIGHT (CW perp, shared with
    // the CCW-previous neighbour) then LEFT (CCW perp, shared with the next).
    // This gives a 2N-vertex polygon whose perimeter edges are either:
    //   — a road cross-section (matches the MeshRoad end cap exactly), or
    //   — a short connector between the adjacent roads' touching corners.
    const polygon = [];
    for (const a of approaches) {
      const perpR = [ a.outbound[1], -a.outbound[0]];
      const perpL = [-a.outbound[1],  a.outbound[0]];
      polygon.push([
        a.pos[0] + perpR[0] * a.halfWidth,
        a.pos[1] + perpR[1] * a.halfWidth,
        a.pos[2],
      ]);
      polygon.push([
        a.pos[0] + perpL[0] * a.halfWidth,
        a.pos[1] + perpL[1] * a.halfWidth,
        a.pos[2],
      ]);
    }

    // Dedup consecutive XY-coincident vertices (within 1 cm). Symmetric miters
    // produce identical adjacent corners; sliver-free triangulation requires
    // removing them. Average their Z to preserve slope.
    const deduped = [];
    for (const v of polygon) {
      const prev = deduped[deduped.length - 1];
      if (prev && dist2D(prev, v) < 0.01) { prev[2] = (prev[2] + v[2]) * 0.5; continue; }
      deduped.push([v[0], v[1], v[2]]);
    }
    // Wrap-around dedup between last and first.
    if (deduped.length >= 2 && dist2D(deduped[0], deduped[deduped.length - 1]) < 0.01) {
      deduped[0][2] = (deduped[0][2] + deduped[deduped.length - 1][2]) * 0.5;
      deduped.pop();
    }
    if (deduped.length < 3) continue;

    let cx = 0, cy = 0, cz = 0;
    for (const v of deduped) { cx += v[0]; cy += v[1]; cz += v[2]; }
    cx /= deduped.length;
    cy /= deduped.length;
    cz /= deduped.length;

    junctions.push({ position: [cx, cy, cz], polygon: deduped });
  }

  return junctions;
}

// ─── cluster merge ────────────────────────────────────────────────────────

function convexHullXY(points) {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Clamp every polygon vertex's Z so the overall range never exceeds maxRangeM.
 * The clamp band is centred on the median Z, so a single outlier (e.g. an
 * approach endpoint that was lerped uphill by clipPolylineEnds) gets pulled
 * back to the surface the rest of the junction sits on. Prevents the
 * spike-pyramid pathology that breaks both rendering and vehicle collision.
 */
export function clampPolygonZRange(polygon, maxRangeM = JUNCTION_POLYGON_Z_CLAMP_RANGE_M) {
  if (!Array.isArray(polygon) || polygon.length === 0) return polygon;
  const zs = polygon.map((v) => v[2]).filter(Number.isFinite).sort((a, b) => a - b);
  if (zs.length === 0) return polygon;
  const median = zs[Math.floor(zs.length / 2)];
  const half = maxRangeM * 0.5;
  return polygon.map((v) => [
    v[0],
    v[1],
    Math.max(median - half, Math.min(median + half, v[2])),
  ]);
}

/**
 * Validate a junction polygon against export-time sanity rules. Returns
 * { ok: true, area, bboxDiag, zRange } on pass, or { ok: false, reason } with
 * a short reason code on fail. Used to drop polygons that would produce
 * invalid prisms or break BeamNG collision.
 *
 * Failure reasons:
 *   too_few_vertices, non_finite, area_too_small, edge_too_short,
 *   bbox_too_large, z_range_too_large
 */
export function validateJunctionPolygon(polygon, options = {}) {
  const minArea     = options.minAreaM2     ?? JUNCTION_VALIDATE_MIN_AREA_M2;
  const minEdgeLen  = options.minEdgeLenM   ?? JUNCTION_VALIDATE_MIN_EDGE_M;
  const maxBboxDiag = options.maxBboxDiagM  ?? JUNCTION_VALIDATE_MAX_BBOX_DIAG_M;
  const maxZRange   = options.maxZRangeM    ?? JUNCTION_MERGE_MAX_Z_RANGE_M;

  if (!Array.isArray(polygon) || polygon.length < 3) return { ok: false, reason: 'too_few_vertices' };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const v of polygon) {
    if (!Array.isArray(v) || v.length < 3) return { ok: false, reason: 'non_finite' };
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) {
      return { ok: false, reason: 'non_finite' };
    }
    if (v[0] < minX) minX = v[0];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[1] > maxY) maxY = v[1];
    if (v[2] < minZ) minZ = v[2];
    if (v[2] > maxZ) maxZ = v[2];
  }

  const bboxDiag = Math.hypot(maxX - minX, maxY - minY);
  if (bboxDiag > maxBboxDiag) return { ok: false, reason: 'bbox_too_large' };

  const zRange = maxZ - minZ;
  if (zRange > maxZRange) return { ok: false, reason: 'z_range_too_large' };

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < minEdgeLen) {
      return { ok: false, reason: 'edge_too_short' };
    }
  }

  // Shoelace 2D area.
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  const area = Math.abs(twiceArea) * 0.5;
  if (area < minArea) return { ok: false, reason: 'area_too_small' };

  return { ok: true, area, bboxDiag, zRange };
}

export function mergeJunctionClusters(junctions) {
  if (!Array.isArray(junctions) || junctions.length === 0) return [];

  // Note: no length-1 fast path — even a single polygon must run through the
  // finalize step so the Z clamp applies to spike-vertex outliers.
  const N = junctions.length;
  const parent = new Array(N).fill(0).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  // Precompute slop-expanded XY bboxes so polygon-overlap clustering is cheap.
  // The bbox test catches the case where two junctions' centroids are >R apart
  // but their footprints overlap anyway (common when a big raster-gap patch
  // sits next to a small OSM-node prism).
  const bboxes = new Array(N);
  for (let i = 0; i < N; i++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of junctions[i].polygon) {
      if (v[0] < minX) minX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] > maxY) maxY = v[1];
    }
    bboxes[i] = {
      minX: minX - JUNCTION_MERGE_BBOX_SLOP_M,
      minY: minY - JUNCTION_MERGE_BBOX_SLOP_M,
      maxX: maxX + JUNCTION_MERGE_BBOX_SLOP_M,
      maxY: maxY + JUNCTION_MERGE_BBOX_SLOP_M,
    };
  }

  const r2 = JUNCTION_MERGE_RADIUS_M * JUNCTION_MERGE_RADIUS_M;
  for (let i = 0; i < N; i++) {
    const bi = bboxes[i];
    for (let j = i + 1; j < N; j++) {
      const bj = bboxes[j];
      const bboxOverlap = bi.minX <= bj.maxX && bi.maxX >= bj.minX &&
                         bi.minY <= bj.maxY && bi.maxY >= bj.minY;
      if (bboxOverlap) { union(i, j); continue; }
      const dx = junctions[i].position[0] - junctions[j].position[0];
      const dy = junctions[i].position[1] - junctions[j].position[1];
      if (dx * dx + dy * dy <= r2) union(i, j);
    }
  }

  const buckets = new Map();
  for (let i = 0; i < N; i++) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(junctions[i]);
  }

  // finalize convex-hulls every output polygon. Singletons go through here
  // too — the buildJunctionPolygons RIGHT/LEFT 2N-vertex pattern can be
  // non-convex on acute-angled or width-mismatched junctions, and a
  // non-convex polygon breaks the earcut-based prism builder's assumption
  // that vertices fall inside the polygon's footprint. Convex collision is
  // also the cheapest/most stable shape for BeamNG vehicle physics.
  //
  // Z is preserved per vertex (no clamp) so the junction's perimeter Z
  // exactly matches each adjacent MeshRoad's seam Z — tires don't catch on a
  // step. Spike-pyramid outliers are still caught downstream by
  // validateJunctionPolygon's z_range_too_large rule.
  const finalize = (polygon) => {
    const hull = convexHullXY(polygon);
    if (!Array.isArray(hull) || hull.length < 3) return null;
    let cx = 0, cy = 0, cz = 0;
    for (const v of hull) { cx += v[0]; cy += v[1]; cz += v[2]; }
    cx /= hull.length;
    cy /= hull.length;
    cz /= hull.length;
    return { position: [cx, cy, cz], polygon: hull };
  };

  const pushFinal = (polygon) => {
    const f = finalize(polygon);
    if (f) out.push(f);
  };

  const out = [];
  for (const members of buckets.values()) {
    if (members.length === 1) { pushFinal(members[0].polygon); continue; }

    const allVerts = [];
    for (const m of members) for (const v of m.polygon) allVerts.push(v);

    let zMin = Infinity, zMax = -Infinity;
    for (const v of allVerts) { if (v[2] < zMin) zMin = v[2]; if (v[2] > zMax) zMax = v[2]; }
    if (zMax - zMin > JUNCTION_MERGE_MAX_Z_RANGE_M) {
      for (const m of members) pushFinal(m.polygon);
      continue;
    }

    pushFinal(allVerts);
  }

  return out;
}

// ─── polyline cleanup ─────────────────────────────────────────────────────

function lerpNode(a, b, t) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

export function clipPolylineEnds(nodes, startClip, endClip) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes ? nodes.slice() : [];
  const total = polylineLength2D(nodes);
  if (startClip + endClip >= total) return [];

  let work = nodes;

  if (startClip > 0) {
    let acc = 0, cutIdx = -1, cutT = 0;
    for (let i = 1; i < work.length; i++) {
      const seg = dist2D(work[i - 1], work[i]);
      if (seg < EPS) continue;
      if (acc + seg >= startClip) { cutIdx = i; cutT = (startClip - acc) / seg; break; }
      acc += seg;
    }
    if (cutIdx < 0) return [];
    work = [lerpNode(work[cutIdx - 1], work[cutIdx], cutT), ...work.slice(cutIdx)];
  }

  if (endClip > 0) {
    const total2 = polylineLength2D(work);
    if (endClip >= total2) return [];
    const target = total2 - endClip;
    let acc = 0, cutIdx = -1, cutT = 0;
    for (let i = 1; i < work.length; i++) {
      const seg = dist2D(work[i - 1], work[i]);
      if (seg < EPS) continue;
      if (acc + seg >= target) { cutIdx = i; cutT = (target - acc) / seg; break; }
      acc += seg;
    }
    if (cutIdx < 0) return [];
    work = [...work.slice(0, cutIdx), lerpNode(work[cutIdx - 1], work[cutIdx], cutT)];
  }

  return work.length >= 2 ? work : [];
}

export function pruneShortEndEdges(nodes, minEdge = END_EDGE_PRUNE_MIN_M) {
  if (!Array.isArray(nodes) || nodes.length < 3) return nodes ? nodes.slice() : [];
  const out = nodes.slice();
  while (out.length >= 3 && dist2D(out[0], out[1]) < minEdge) out.splice(1, 1);
  while (out.length >= 3 && dist2D(out[out.length - 2], out[out.length - 1]) < minEdge) out.splice(out.length - 2, 1);
  return out;
}

export function balanceEndEdges(nodes, ratio = END_EDGE_RATIO_THRESHOLD, kinkDeg = END_EDGE_KINK_DEG) {
  if (!Array.isArray(nodes) || nodes.length < 3) return nodes ? nodes.slice() : [];
  const out = nodes.slice();

  while (out.length >= 3) {
    const firstLen = dist2D(out[0], out[1]);
    const nextLen  = dist2D(out[1], out[2]);
    if (firstLen >= nextLen * ratio) break;
    if (angleChangeDeg(out[0], out[1], out[2]) <= kinkDeg) break;
    out.splice(1, 1);
  }
  while (out.length >= 3) {
    const N = out.length;
    const lastLen = dist2D(out[N - 2], out[N - 1]);
    const prevLen = dist2D(out[N - 3], out[N - 2]);
    if (lastLen >= prevLen * ratio) break;
    if (angleChangeDeg(out[N - 3], out[N - 2], out[N - 1]) <= kinkDeg) break;
    out.splice(N - 2, 1);
  }
  return out;
}

export function smoothSharpKinks(
  nodes,
  thresholdDeg     = KINK_SMOOTH_THRESHOLD_DEG,
  tightThresholdDeg = KINK_SMOOTH_THRESHOLD_TIGHT_DEG,
  shortEdgeM       = KINK_SHORT_EDGE_M,
  offsetM          = KINK_SMOOTH_OFFSET_M,
) {
  if (!Array.isArray(nodes) || nodes.length < 3) return nodes ? nodes.slice() : [];
  const out = [nodes[0]];
  for (let i = 1; i < nodes.length - 1; i++) {
    const prev = nodes[i - 1], cur = nodes[i], next = nodes[i + 1];
    const prevLen = dist2D(prev, cur), nextLen = dist2D(cur, next);
    const angle = angleChangeDeg(prev, cur, next);
    const isShort = prevLen < shortEdgeM || nextLen < shortEdgeM;
    const threshold = isShort ? tightThresholdDeg : thresholdDeg;
    if (angle <= threshold) { out.push(cur); continue; }
    if (isShort) continue;
    const cap = Math.min(prevLen, nextLen) * KINK_OFFSET_MAX_RATIO;
    const off = Math.min(offsetM, cap);
    if (off < EPS) { out.push(cur); continue; }
    out.push(lerpNode(prev, cur, 1 - off / prevLen));
    out.push(lerpNode(cur, next, off / nextLen));
  }
  out.push(nodes[nodes.length - 1]);
  return out;
}

export function uniformResamplePolyline(nodes, spacing = MESH_ROAD_RESAMPLE_SPACING_M) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes ? nodes.slice() : [];
  const total = polylineLength2D(nodes);
  if (total < spacing) return [nodes[0], nodes[nodes.length - 1]];

  const numSegments = Math.max(2, Math.round(total / spacing));
  const actualSpacing = total / numSegments;

  const out = [nodes[0]];
  let segIdx = 1;
  let segStart = 0;
  let segLen = dist2D(nodes[0], nodes[1]);

  for (let k = 1; k < numSegments; k++) {
    const target = k * actualSpacing;
    while (segIdx < nodes.length - 1 && segStart + segLen < target) {
      segStart += segLen;
      segIdx++;
      segLen = dist2D(nodes[segIdx - 1], nodes[segIdx]);
    }
    const t = (target - segStart) / (segLen < EPS ? 1 : segLen);
    out.push(lerpNode(nodes[segIdx - 1], nodes[segIdx], Math.max(0, Math.min(1, t))));
  }
  out.push(nodes[nodes.length - 1]);
  return out;
}

// zAtClipBack kept for any callers that still use it.
export function zAtClipBack(worldGeometry, end, distance) {
  if (!Array.isArray(worldGeometry) || worldGeometry.length === 0) return 0;
  if (worldGeometry.length === 1) return worldGeometry[0][2];
  if (distance <= 0)
    return end === 'start' ? worldGeometry[0][2] : worldGeometry[worldGeometry.length - 1][2];
  const total = polylineLength2D(worldGeometry);
  if (distance >= total)
    return end === 'start' ? worldGeometry[worldGeometry.length - 1][2] : worldGeometry[0][2];
  const seq = end === 'start' ? worldGeometry : [...worldGeometry].reverse();
  let acc = 0;
  for (let i = 1; i < seq.length; i++) {
    const seg = dist2D(seq[i - 1], seq[i]);
    if (seg < EPS) continue;
    if (acc + seg >= distance) {
      const t = (distance - acc) / seg;
      return seq[i - 1][2] + (seq[i][2] - seq[i - 1][2]) * t;
    }
    acc += seg;
  }
  return seq[seq.length - 1][2];
}
