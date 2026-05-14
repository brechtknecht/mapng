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
 * Sample Z (and only Z) at a given 2D arc-length distance from one end of a
 * polyline. `worldGeometry` is an array of [x, y, z] in metres.
 *
 * end = 'start' walks forward from index 0; 'end' walks backward from the last
 * index. If `distance` exceeds total length, returns the Z of the far end
 * rather than extrapolating.
 */
export function zAtClipBack(worldGeometry, end, distance) {
  if (!Array.isArray(worldGeometry) || worldGeometry.length === 0) return 0;
  if (worldGeometry.length === 1) return worldGeometry[0][2];
  if (distance <= 0) {
    return end === 'start' ? worldGeometry[0][2] : worldGeometry[worldGeometry.length - 1][2];
  }

  const total = polylineLength2D(worldGeometry);
  if (distance >= total) {
    return end === 'start' ? worldGeometry[worldGeometry.length - 1][2] : worldGeometry[0][2];
  }

  const sequence = end === 'start' ? worldGeometry : [...worldGeometry].reverse();
  let acc = 0;
  for (let i = 1; i < sequence.length; i++) {
    const seg = dist2D(sequence[i - 1], sequence[i]);
    if (seg < EPS) continue;
    if (acc + seg >= distance) {
      const t = (distance - acc) / seg;
      return sequence[i - 1][2] + (sequence[i][2] - sequence[i - 1][2]) * t;
    }
    acc += seg;
  }
  return sequence[sequence.length - 1][2];
}

/**
 * Walk along a segment's worldGeometry from the indicated end, accumulating 2D
 * distance, and return a unit vector pointing TOWARD the junction node from
 * the first sample at least `MIN_TANGENT_DISTANCE` away. Stabilises tangent
 * direction against dense polyline tessellation near the node.
 */
function inboundTangent(worldGeometry, end) {
  if (!Array.isArray(worldGeometry) || worldGeometry.length < 2) return [0, 0];
  const sequence = end === 'start' ? worldGeometry : [...worldGeometry].reverse();
  const node = sequence[0];
  let acc = 0;
  let from = sequence[sequence.length - 1];
  for (let i = 1; i < sequence.length; i++) {
    acc += dist2D(sequence[i - 1], sequence[i]);
    if (acc >= MIN_TANGENT_DISTANCE) {
      from = sequence[i];
      break;
    }
  }
  return unit2D(node[0] - from[0], node[1] - from[1]);
}

/**
 * Solve for the wedge corner where segment A's LEFT edge meets segment B's
 * RIGHT edge. Returns { distA, distB, wedgeXY } — distA/B are along-outbound
 * clip distances from the node; wedgeXY is the [x, y] meeting point.
 *
 * Handles three special cases:
 *  - parallel offset lines (T-junction main road): distA = distB = 0,
 *    wedgeXY averaged from the two offset starts.
 *  - negative bisector (asymmetric widths): negatives clamped to 0.
 *  - extreme miters: clamped to MITER_LIMIT_FACTOR × max half-width.
 */
function solveWedge(nodeXY, outA, halfWidthA, outB, halfWidthB) {
  const leftA = [-outA[1], outA[0]];
  const rightB = [outB[1], -outB[0]];
  const Px = nodeXY[0] + leftA[0] * halfWidthA;
  const Py = nodeXY[1] + leftA[1] * halfWidthA;
  const Qx = nodeXY[0] + rightB[0] * halfWidthB;
  const Qy = nodeXY[1] + rightB[1] * halfWidthB;

  // Solve P + s·outA = Q + t·outB →  s·outA - t·outB = Q - P
  const det = outB[0] * outA[1] - outA[0] * outB[1];

  if (Math.abs(det) < 1e-6) {
    // Parallel (typically anti-collinear → T-junction continuation).
    return {
      distA: 0,
      distB: 0,
      wedgeXY: [(Px + Qx) * 0.5, (Py + Qy) * 0.5],
    };
  }

  const dx = Qx - Px;
  const dy = Qy - Py;
  let s = (-dx * outB[1] + outB[0] * dy) / det;
  let t = (outA[0] * dy - dx * outA[1]) / det;

  const limit = Math.max(halfWidthA, halfWidthB) * MITER_LIMIT_FACTOR;
  if (s < 0) s = 0;
  if (t < 0) t = 0;
  if (s > limit) s = limit;
  if (t > limit) t = limit;

  // Recompute wedge XY from segment A's edge with the (possibly clamped) s.
  const wedgeAX = Px + outA[0] * s;
  const wedgeAY = Py + outA[1] * s;
  const wedgeBX = Qx + outB[0] * t;
  const wedgeBY = Qy + outB[1] * t;

  // If clamping pulled the two solutions apart (acute miter / one-sided
  // negative case), average them so the corner stays on the bisector.
  return {
    distA: s,
    distB: t,
    wedgeXY: [(wedgeAX + wedgeBX) * 0.5, (wedgeAY + wedgeBY) * 0.5],
  };
}

function junctionNodeXY(entries, segmentInfo) {
  // All entries share a node; pull XY from any segment's touching endpoint.
  for (const entry of entries) {
    const info = segmentInfo.get(entry.road.id);
    if (!info?.worldGeometry?.length) continue;
    const idx = entry.isStart ? 0 : info.worldGeometry.length - 1;
    return [info.worldGeometry[idx][0], info.worldGeometry[idx][1]];
  }
  return null;
}

/**
 * Per-junction analysis. Returns:
 *  - junctions: [{ position: [x,y,z], polygon: [[x,y,z], …] }]
 *  - segmentClips: Map<segmentId, { start: number, end: number }>
 *
 * `segmentInfo` is Map<segmentId, { worldGeometry: [[x,y,z],…], halfWidth }>.
 * worldGeometry must already include the MESH_ROAD_SURFACE_LIFT.
 */
export function analyzeJunctions(roadNetwork, segmentInfo) {
  const junctions = [];
  const segmentClips = new Map();

  if (!roadNetwork?.intersections) return { junctions, segmentClips };

  const recordClip = (segId, end, dist) => {
    const cur = segmentClips.get(segId) || { start: 0, end: 0 };
    if (dist > cur[end]) cur[end] = dist;
    segmentClips.set(segId, cur);
  };

  for (const [, entries] of roadNetwork.intersections) {
    if (!Array.isArray(entries) || entries.length < MIN_JUNCTION_SEGMENTS) continue;

    const nodeXY = junctionNodeXY(entries, segmentInfo);
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

    approaches.sort((a, b) => Math.atan2(a.outbound[1], a.outbound[0]) - Math.atan2(b.outbound[1], b.outbound[0]));

    const N = approaches.length;
    const wedges = new Array(N); // wedges[i] = corner between approach i-1 and i
    const clipsLeft = new Array(N).fill(0);  // clip on segment i contributed by wedge with (i-1)
    const clipsRight = new Array(N).fill(0); // clip on segment i contributed by wedge with (i+1)

    for (let i = 0; i < N; i++) {
      const a = approaches[(i - 1 + N) % N];
      const b = approaches[i];
      const { distA, distB, wedgeXY } = solveWedge(nodeXY, a.outbound, a.halfWidth, b.outbound, b.halfWidth);
      const zA = zAtClipBack(a.worldGeometry, a.end, distA);
      const zB = zAtClipBack(b.worldGeometry, b.end, distB);
      wedges[i] = [wedgeXY[0], wedgeXY[1], (zA + zB) * 0.5];
      clipsLeft[(i - 1 + N) % N] = distA;
      clipsRight[i] = distB;
    }

    // Per-segment centerline clip = max of its two adjacent contributions.
    let abort = false;
    const perApproachClip = new Array(N);
    for (let i = 0; i < N; i++) {
      const clip = Math.max(clipsLeft[i], clipsRight[i]);
      perApproachClip[i] = clip;
      const segLen = polylineLength2D(approaches[i].worldGeometry);
      if (segLen <= 0 || clip > segLen * MAX_CLIPBACK_RATIO) {
        abort = true;
        break;
      }
    }
    if (abort) continue;

    // Polygon CCW: one wedge corner per segment, taken as the corner shared
    // with its CCW-previous neighbour (wedges[i] sits between i-1 and i, so
    // it's segment i's right corner / segment i-1's left corner).
    const polygon = wedges.slice();
    if (polygon.length < 3) continue;

    let cx = 0, cy = 0, cz = 0;
    for (const v of polygon) { cx += v[0]; cy += v[1]; cz += v[2]; }
    cx /= polygon.length;
    cy /= polygon.length;
    cz /= polygon.length;

    junctions.push({
      position: [cx, cy, cz],
      polygon,
      contributingSegments: approaches.map(a => ({ segmentId: a.segmentId, end: a.end })),
    });

    for (let i = 0; i < N; i++) {
      recordClip(approaches[i].segmentId, approaches[i].end, perApproachClip[i]);
    }
  }

  return { junctions, segmentClips };
}

// ─── cluster merge ────────────────────────────────────────────────────────

function convexHullXY(points) {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

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
 * Single-link cluster junctions whose XY centres are within
 * JUNCTION_MERGE_RADIUS_M. Each cluster of ≥ 2 members is replaced by a single
 * junction whose polygon is the convex hull of all member polygon vertices —
 * preserving per-vertex Z so hillside clusters stay seam-aligned with their
 * surrounding roads.
 *
 * If the cluster's Z range exceeds JUNCTION_MERGE_MAX_Z_RANGE_M, the merge is
 * refused and members are emitted unchanged (small overlapping prisms beat a
 * big vertical step).
 */
export function mergeJunctionClusters(junctions) {
  if (junctions.length <= 1) return junctions.slice();

  const N = junctions.length;
  const parent = new Array(N).fill(0).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

  const r2 = JUNCTION_MERGE_RADIUS_M * JUNCTION_MERGE_RADIUS_M;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
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

  const out = [];
  for (const members of buckets.values()) {
    if (members.length === 1) { out.push(members[0]); continue; }

    const allVerts = [];
    for (const m of members) for (const v of m.polygon) allVerts.push(v);

    let zMin = Infinity, zMax = -Infinity;
    for (const v of allVerts) { if (v[2] < zMin) zMin = v[2]; if (v[2] > zMax) zMax = v[2]; }
    if (zMax - zMin > JUNCTION_MERGE_MAX_Z_RANGE_M) {
      // Refuse merge — let members render as separate prisms.
      for (const m of members) out.push(m);
      continue;
    }

    const hull = convexHullXY(allVerts);
    if (hull.length < 3) { for (const m of members) out.push(m); continue; }

    let cx = 0, cy = 0, cz = 0;
    for (const v of hull) { cx += v[0]; cy += v[1]; cz += v[2]; }
    cx /= hull.length;
    cy /= hull.length;
    cz /= hull.length;

    out.push({
      position: [cx, cy, cz],
      polygon: hull,
      contributingSegments: members.flatMap(m => m.contributingSegments || []),
    });
  }

  return out;
}

// ─── polyline cleanup ─────────────────────────────────────────────────────

function lerpNode(a, b, t) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/**
 * Trim `startClip` metres off the front and `endClip` off the back of a
 * polyline (XY arc length). All node fields (xyz, width, depth, normal) are
 * linearly interpolated. Returns [] if the trim consumes the whole road.
 */
export function clipPolylineEnds(nodes, startClip, endClip) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes ? nodes.slice() : [];
  const total = polylineLength2D(nodes);
  if (startClip + endClip >= total) return [];

  let work = nodes;

  if (startClip > 0) {
    let acc = 0;
    let cutIdx = -1;
    let cutT = 0;
    for (let i = 1; i < work.length; i++) {
      const seg = dist2D(work[i - 1], work[i]);
      if (seg < EPS) continue;
      if (acc + seg >= startClip) {
        cutIdx = i;
        cutT = (startClip - acc) / seg;
        break;
      }
      acc += seg;
    }
    if (cutIdx < 0) return [];
    const newFirst = lerpNode(work[cutIdx - 1], work[cutIdx], cutT);
    work = [newFirst, ...work.slice(cutIdx)];
  }

  if (endClip > 0) {
    const total2 = polylineLength2D(work);
    if (endClip >= total2) return [];
    const target = total2 - endClip;
    let acc = 0;
    let cutIdx = -1;
    let cutT = 0;
    for (let i = 1; i < work.length; i++) {
      const seg = dist2D(work[i - 1], work[i]);
      if (seg < EPS) continue;
      if (acc + seg >= target) {
        cutIdx = i;
        cutT = (target - acc) / seg;
        break;
      }
      acc += seg;
    }
    if (cutIdx < 0) return [];
    const newLast = lerpNode(work[cutIdx - 1], work[cutIdx], cutT);
    work = [...work.slice(0, cutIdx), newLast];
  }

  return work.length >= 2 ? work : [];
}

/**
 * Iteratively drop the interior neighbour of either endpoint while the end
 * edge is shorter than `minEdge`. Single-pass would leave slivers when
 * multiple consecutive interior nodes are close to the endpoint.
 */
export function pruneShortEndEdges(nodes, minEdge = END_EDGE_PRUNE_MIN_M) {
  if (!Array.isArray(nodes) || nodes.length < 3) return nodes ? nodes.slice() : [];
  const out = nodes.slice();

  while (out.length >= 3 && dist2D(out[0], out[1]) < minEdge) out.splice(1, 1);
  while (out.length >= 3 && dist2D(out[out.length - 2], out[out.length - 1]) < minEdge) out.splice(out.length - 2, 1);

  return out;
}

/**
 * Drop the joining node when an end edge is much shorter than its neighbour
 * AND there's a kink at the joining node — the configuration most likely to
 * cause Catmull-Rom tangent overshoot at the spline end.
 */
export function balanceEndEdges(nodes, ratio = END_EDGE_RATIO_THRESHOLD, kinkDeg = END_EDGE_KINK_DEG) {
  if (!Array.isArray(nodes) || nodes.length < 3) return nodes ? nodes.slice() : [];
  const out = nodes.slice();

  while (out.length >= 3) {
    const firstLen = dist2D(out[0], out[1]);
    const nextLen = dist2D(out[1], out[2]);
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

/**
 * Adaptive sharp-kink handler. In long-edge regions, replace a kinked node
 * with two chamfered nodes offset back along each adjacent edge. In
 * short-edge regions, the chamfer offset would be comparable to the edge
 * itself, so just drop the kinked node instead.
 */
export function smoothSharpKinks(
  nodes,
  thresholdDeg = KINK_SMOOTH_THRESHOLD_DEG,
  tightThresholdDeg = KINK_SMOOTH_THRESHOLD_TIGHT_DEG,
  shortEdgeM = KINK_SHORT_EDGE_M,
  offsetM = KINK_SMOOTH_OFFSET_M,
) {
  if (!Array.isArray(nodes) || nodes.length < 3) return nodes ? nodes.slice() : [];

  const out = [nodes[0]];
  for (let i = 1; i < nodes.length - 1; i++) {
    const prev = nodes[i - 1];
    const cur = nodes[i];
    const next = nodes[i + 1];
    const prevLen = dist2D(prev, cur);
    const nextLen = dist2D(cur, next);
    const angle = angleChangeDeg(prev, cur, next);
    const isShort = prevLen < shortEdgeM || nextLen < shortEdgeM;
    const threshold = isShort ? tightThresholdDeg : thresholdDeg;

    if (angle <= threshold) { out.push(cur); continue; }

    if (isShort) continue; // drop the kinked node entirely

    // Chamfer offset capped to keep both new nodes strictly inside their edges.
    const cap = Math.min(prevLen, nextLen) * KINK_OFFSET_MAX_RATIO;
    const off = Math.min(offsetM, cap);
    if (off < EPS) { out.push(cur); continue; }

    const dirIn = unit2D(cur[0] - prev[0], cur[1] - prev[1]);
    const dirOut = unit2D(next[0] - cur[0], next[1] - cur[1]);
    const tIn = 1 - off / prevLen;
    const tOut = off / nextLen;
    out.push(lerpNode(prev, cur, tIn));
    out.push(lerpNode(cur, next, tOut));
    void dirIn; void dirOut;
  }
  out.push(nodes[nodes.length - 1]);
  return out;
}

/**
 * Resample a polyline to uniform spacing along its 2D arc length. THE fix for
 * Catmull-Rom tangent overshoot — equal edge lengths produce equal tangent
 * magnitudes, eliminating spline corkscrews. All node fields are interpolated.
 *
 * Polylines shorter than one spacing return just their two endpoints.
 */
export function uniformResamplePolyline(nodes, spacing = MESH_ROAD_RESAMPLE_SPACING_M) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes ? nodes.slice() : [];
  const total = polylineLength2D(nodes);
  if (total < spacing) return [nodes[0], nodes[nodes.length - 1]];

  const numSegments = Math.max(2, Math.round(total / spacing));
  const actualSpacing = total / numSegments;

  const out = [nodes[0]];
  let segIdx = 1;
  let segStart = 0; // arc length at segStart-of-segIdx
  let segLen = dist2D(nodes[0], nodes[1]);

  for (let k = 1; k < numSegments; k++) {
    const target = k * actualSpacing;
    while (segIdx < nodes.length - 1 && segStart + segLen < target) {
      segStart += segLen;
      segIdx += 1;
      segLen = dist2D(nodes[segIdx - 1], nodes[segIdx]);
    }
    const localLen = segLen < EPS ? 1 : segLen;
    const t = (target - segStart) / localLen;
    out.push(lerpNode(nodes[segIdx - 1], nodes[segIdx], Math.max(0, Math.min(1, t))));
  }
  out.push(nodes[nodes.length - 1]);
  return out;
}
