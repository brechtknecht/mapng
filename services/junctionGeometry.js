/**
 * Junction geometry analysis for road network intersections.
 *
 * For every intersection in a road network, this module computes:
 *   1. How far back each connected road segment should be clipped (so its end
 *      doesn't overlap with the adjacent road).
 *   2. The CCW polygon outline of the asphalt area that fills the junction
 *      between the clipped road ends.
 *
 * The math is the standard angle-bisector / miter-join approach used by
 * vector-graphics stroke joins and procedural road tools (Cities: Skylines, etc).
 *
 * Pure functions over plain coordinate arrays. No THREE.js, no DOM, no
 * BeamNG-specific types. Callers convert their lat/lng geometry to world-space
 * [x, y, z] meters before calling, and provide a per-segment half-width.
 *
 * ## Algorithm sketch (per intersection node)
 *
 *   a) Build a list of "incoming" segment descriptors, each with an outbound
 *      tangent pointing AWAY from the junction node and a half-width.
 *   b) Sort segments CCW around the node by outbound-tangent angle.
 *   c) For each adjacent pair (i, i+1) in the sorted order:
 *        - Solve where segment i's LEFT edge line meets segment (i+1)'s RIGHT
 *          edge line. The distance from node-along-outbound to that
 *          intersection is the natural ("miter") clip distance for those edges.
 *        - If the distance exceeds a miter limit (acute angles blow up), clamp
 *          it. The polygon will then have two distinct corners on that side
 *          (a "bevel cut") instead of one shared miter point.
 *   d) Per segment, the centerline clip-back is max(leftEdgeClip, rightEdgeClip)
 *      from its two adjacent pairs. Pick the larger so neither edge extends
 *      past its bisector intersection.
 *   e) Walk segments CCW and emit two polygon corners each (right corner then
 *      left corner of the perpendicular cut at the clip-back distance). The
 *      polygon between consecutive segments closes naturally by connecting
 *      "left corner of segment i" → "right corner of segment i+1".
 *
 * ## Output shape
 *
 *   {
 *     junctions: [{
 *       nodeKey,        // original roadNetwork intersection key
 *       position,       // [x, y, z] of the junction node, world meters
 *       polygon,        // CCW [[x, y, z], ...] of the asphalt fill outline
 *       degree,         // number of connected segments (= polygon.length / 2)
 *     }, ...],
 *     segmentClips: Map<segmentId, { startClipBack, endClipBack }>,
 *                     // meters to shorten each end of each segment's centerline
 *   }
 */

/** Acute-angle safety: never let the miter clip distance exceed this × halfWidth. */
export const MITER_LIMIT_FACTOR = 4.0;

/** Walk back at least this far along the segment when computing tangents (meters). */
const MIN_TANGENT_DISTANCE = 3.0;

/** Smallest junction we generate geometry for. 2-way joins are skipped (v1). */
const MIN_JUNCTION_SEGMENTS = 3;

/** Never eat more than this fraction of a segment's length when clipping back. */
const MAX_CLIPBACK_RATIO = 0.4;

/**
 * Junctions whose centers are closer than this (meters) are merged into a
 * single super-junction. OSM commonly represents one real-world intersection
 * as several closely-spaced nodes (short connector segments between adjacent
 * intersection nodes); without merging, each spawns its own prism and they
 * stack as visible concentric rings.
 */
const JUNCTION_MERGE_RADIUS_M = 8.0;

/**
 * Analyze all junctions in a built road network and return per-junction polygons
 * plus per-segment centerline clip-back distances.
 *
 * @param {object} roadNetwork           Output of `buildRoadNetwork()`.
 * @param {Map<string, {worldGeometry: number[][], halfWidth: number}>} segmentInfo
 *        For each segment id (matching `roadNetwork.segments[].id`), provide the
 *        segment's world-space geometry as an array of [x, y, z] in meters, and
 *        the segment's half-width in meters. Callers compute these.
 * @returns {{ junctions: object[], segmentClips: Map<string, {startClipBack: number, endClipBack: number}> }}
 */
export function analyzeJunctions(roadNetwork, segmentInfo) {
  const junctions = [];
  const segmentClips = new Map();

  for (const [nodeKey, entries] of roadNetwork.intersections) {
    if (!Array.isArray(entries) || entries.length < MIN_JUNCTION_SEGMENTS) continue;

    const incoming = buildIncomingList(entries, segmentInfo);
    if (incoming.length < MIN_JUNCTION_SEGMENTS) continue;

    // Sort CCW around the junction node by outbound-tangent angle.
    incoming.sort(
      (a, b) =>
        Math.atan2(a.outbound[1], a.outbound[0]) -
        Math.atan2(b.outbound[1], b.outbound[0]),
    );

    // Pull the world-space junction position from any segment's touching endpoint.
    // All segments meet here, so any of them works.
    const sample = incoming[0];
    const sampleGeom = sample.worldGeometry;
    const nodePos =
      sample.end === 'start'
        ? sampleGeom[0]
        : sampleGeom[sampleGeom.length - 1];

    // Compute per-edge clip distances from each adjacent pair (i, i+1 mod N).
    const N = incoming.length;
    const leftEdgeDist = new Array(N).fill(0);
    const rightEdgeDist = new Array(N).fill(0);
    let degenerate = false;

    for (let i = 0; i < N; i++) {
      const a = incoming[i];
      const b = incoming[(i + 1) % N];
      const pair = computePairwiseClip(nodePos, a, b);
      if (pair.degenerate) {
        degenerate = true;
        break;
      }
      // pair.distA = how far along A's outbound A's LEFT edge runs before
      //              hitting B's RIGHT edge (after miter clamp).
      // pair.distB = same, mirrored: how far B's RIGHT edge runs before hitting A's left.
      leftEdgeDist[i] = Math.max(leftEdgeDist[i], pair.distA);
      rightEdgeDist[(i + 1) % N] = Math.max(rightEdgeDist[(i + 1) % N], pair.distB);
    }

    if (degenerate) continue;

    // For each segment, the centerline cut distance is the larger of its two
    // adjacent edge clips. Cutting at max() ensures neither edge over-extends.
    const centerlineClip = new Array(N);
    for (let i = 0; i < N; i++) {
      centerlineClip[i] = Math.max(leftEdgeDist[i], rightEdgeDist[i]);
    }

    // Safety clamp: never consume more than MAX_CLIPBACK_RATIO of a segment.
    // If we'd over-clip, skip this junction entirely (current overlap remains
    // for it — better than producing a degenerate or negative-length road).
    let overClipped = false;
    for (let i = 0; i < N; i++) {
      const segLen = polylineLength(incoming[i].worldGeometry);
      if (centerlineClip[i] > segLen * MAX_CLIPBACK_RATIO) {
        overClipped = true;
        break;
      }
    }
    if (overClipped) continue;

    // Assemble the polygon. Walk segments in CCW order; each contributes its
    // right corner then left corner of the perpendicular cut at d. Between
    // consecutive segments, the polygon edge from "left of i" → "right of i+1"
    // closes the open wedge between them.
    const polygon = [];
    for (let i = 0; i < N; i++) {
      const seg = incoming[i];
      const d = centerlineClip[i];
      const out = seg.outbound;
      const w = seg.halfWidth;
      // Left normal (CCW 90° rotation): (-y, x).
      // Right normal (CW 90° rotation): (y, -x).
      const leftN = [-out[1], out[0]];
      const rightN = [out[1], -out[0]];

      const rightCorner = [
        nodePos[0] + rightN[0] * w + out[0] * d,
        nodePos[1] + rightN[1] * w + out[1] * d,
        nodePos[2],
      ];
      const leftCorner = [
        nodePos[0] + leftN[0] * w + out[0] * d,
        nodePos[1] + leftN[1] * w + out[1] * d,
        nodePos[2],
      ];

      polygon.push(rightCorner);
      polygon.push(leftCorner);
    }

    // Dedup consecutive (and wrap-around) duplicate vertices. In symmetric
    // miters the leftCorner of segment i and the rightCorner of segment i+1
    // coincide; without dedup the polygon contains zero-area triangle pairs
    // that render as UV-stretched slivers and confuse downstream meshers.
    const cleaned = dedupClosedPolygon(polygon, 0.01);
    if (cleaned.length < 3) continue;

    // Record clip-back per segment-end. A segment may participate in two
    // junctions (one per end), so we accumulate into a per-segment record.
    for (let i = 0; i < N; i++) {
      const seg = incoming[i];
      const existing = segmentClips.get(seg.segmentId) || {
        startClipBack: 0,
        endClipBack: 0,
      };
      if (seg.end === 'start') {
        existing.startClipBack = Math.max(existing.startClipBack, centerlineClip[i]);
      } else {
        existing.endClipBack = Math.max(existing.endClipBack, centerlineClip[i]);
      }
      segmentClips.set(seg.segmentId, existing);
    }

    junctions.push({
      nodeKey,
      position: nodePos,
      polygon: cleaned,
      degree: N,
    });
  }

  // Merge nearby junctions (closely-spaced OSM nodes that model one real
  // intersection) so we get one prism per real intersection rather than a
  // stack of overlapping prisms.
  const mergedJunctions = mergeNearbyJunctions(junctions, JUNCTION_MERGE_RADIUS_M);

  return { junctions: mergedJunctions, segmentClips };
}

/**
 * Cluster junctions whose centers are within `radius` meters and replace each
 * cluster with a single junction whose polygon is the 2D convex hull of all
 * member polygon vertices. Z coordinate is the cluster average.
 *
 * Convex hull is fine here because a real intersection's footprint is always
 * a convex region — it's the bounding shape of where multiple roads meet.
 * Using the hull also smooths over per-segment clip-back asymmetries that
 * would otherwise produce jagged inter-junction boundaries.
 */
function mergeNearbyJunctions(junctions, radius) {
  if (junctions.length <= 1) return junctions;
  const radiusSq = radius * radius;

  // Greedy single-link clustering.
  const clusterIdx = new Array(junctions.length).fill(-1);
  const clusters = [];
  for (let i = 0; i < junctions.length; i++) {
    if (clusterIdx[i] !== -1) continue;
    const queue = [i];
    const clusterId = clusters.length;
    clusters.push([]);
    while (queue.length > 0) {
      const k = queue.shift();
      if (clusterIdx[k] !== -1) continue;
      clusterIdx[k] = clusterId;
      clusters[clusterId].push(junctions[k]);
      for (let j = 0; j < junctions.length; j++) {
        if (clusterIdx[j] !== -1) continue;
        const dx = junctions[k].position[0] - junctions[j].position[0];
        const dy = junctions[k].position[1] - junctions[j].position[1];
        if (dx * dx + dy * dy < radiusSq) queue.push(j);
      }
    }
  }

  const merged = [];
  for (const cluster of clusters) {
    if (cluster.length === 1) {
      merged.push(cluster[0]);
      continue;
    }

    // Collect every polygon vertex from every junction in the cluster.
    const allVerts = [];
    let zSum = 0;
    let xSum = 0;
    let ySum = 0;
    let degree = 0;
    let nodeKey = cluster[0].nodeKey;
    for (const j of cluster) {
      for (const v of j.polygon) {
        allVerts.push(v);
        zSum += v[2];
      }
      xSum += j.position[0];
      ySum += j.position[1];
      degree += j.degree;
    }
    const avgZ = zSum / allVerts.length;
    const hull = convexHull2D(allVerts);
    if (hull.length < 3) {
      // Pathological case (all input vertices collinear) — fall back to the
      // first cluster member rather than emitting a degenerate junction.
      merged.push(cluster[0]);
      continue;
    }
    // Stamp the cluster's average Z onto every hull vertex so the merged
    // top face stays flat (member junctions may have slightly different
    // terrain elevations).
    const polygon = hull.map((p) => [p[0], p[1], avgZ]);
    merged.push({
      nodeKey: `${nodeKey}*${cluster.length}`,
      position: [xSum / cluster.length, ySum / cluster.length, avgZ],
      polygon,
      degree,
    });
  }
  return merged;
}

/**
 * 2D convex hull via Andrew's monotone chain. Returns vertices in CCW order.
 * Operates on the first two array fields (x, y) — extra fields are dropped;
 * the caller is responsible for re-attaching them.
 */
function convexHull2D(points) {
  if (points.length < 3) return points.slice();
  // Dedup near-coincident inputs (cm precision is plenty for hull math).
  const seen = new Set();
  const pts = [];
  for (const p of points) {
    const key = `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push(p);
  }
  if (pts.length < 3) return pts;

  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (O, A, B) =>
    (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);

  const lower = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Convert roadNetwork intersection entries into a list of "incoming" segment
 * descriptors usable for bisector math. Drops entries with no segmentInfo
 * (terrain-clipped, missing geometry, etc).
 */
function buildIncomingList(entries, segmentInfo) {
  const out = [];
  for (const entry of entries) {
    const info = segmentInfo.get(entry.road.id);
    if (!info || !Array.isArray(info.worldGeometry) || info.worldGeometry.length < 2) continue;
    const inbound = computeInboundTangent(info.worldGeometry, entry.isStart);
    if (!inbound) continue;
    out.push({
      segmentId: entry.road.id,
      end: entry.isStart ? 'start' : 'end',
      outbound: [-inbound[0], -inbound[1]],
      halfWidth: info.halfWidth,
      worldGeometry: info.worldGeometry,
    });
  }
  return out;
}

/**
 * Compute the inbound tangent of a segment at the end touching a junction.
 *
 * Walks back along the polyline until we've covered MIN_TANGENT_DISTANCE meters
 * (or we run out of polyline), then returns the unit vector from that interior
 * point to the junction node. Using a small look-back distance instead of just
 * the last edge gives a stable direction even when the polyline has dense
 * tessellation near the junction (e.g. from MeshRoad breakAngle subdivisions).
 *
 * @returns {[number, number] | null} 2D unit vector, or null if the segment is degenerate.
 */
function computeInboundTangent(geometry, isStart) {
  const N = geometry.length;
  if (N < 2) return null;

  const junctionIdx = isStart ? 0 : N - 1;
  const step = isStart ? 1 : -1;
  const junctionPt = geometry[junctionIdx];

  let i = junctionIdx + step;
  let farPt = geometry[i];
  while (i >= 0 && i < N) {
    const dx = geometry[i][0] - junctionPt[0];
    const dy = geometry[i][1] - junctionPt[1];
    farPt = geometry[i];
    if (Math.hypot(dx, dy) >= MIN_TANGENT_DISTANCE) break;
    i += step;
  }

  const dx = junctionPt[0] - farPt[0];
  const dy = junctionPt[1] - farPt[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return [dx / len, dy / len];
}

/**
 * Solve the bisector clip for one adjacent pair of segments (a, b) sorted CCW.
 *
 * Returns the distances along each segment's outbound where its edge facing the
 * neighbor terminates. Applies a miter limit to cap acute-angle blow-up:
 * beyond the limit we clamp distA/distB to the limit, which produces a bevel
 * cut in the final polygon (the two corner points end up distinct).
 *
 * @returns {{ degenerate: true } | { degenerate: false, distA: number, distB: number, isBevel: boolean }}
 */
function computePairwiseClip(nodePos, a, b) {
  const aOut = a.outbound;
  const bOut = b.outbound;

  // a's LEFT edge: line through (node + aLeftNormal * w_a) in direction aOut.
  // b's RIGHT edge: line through (node + bRightNormal * w_b) in direction bOut.
  // aLeftNormal  = (-aOut.y,  aOut.x)
  // bRightNormal = ( bOut.y, -bOut.x)
  const Px = nodePos[0] + -aOut[1] * a.halfWidth;
  const Py = nodePos[1] + aOut[0] * a.halfWidth;
  const Qx = nodePos[0] + bOut[1] * b.halfWidth;
  const Qy = nodePos[1] + -bOut[0] * b.halfWidth;

  // Solve  P + s * aOut = Q + t * bOut   ⇒
  //   [aOut.x  -bOut.x] [s]   [Qx - Px]
  //   [aOut.y  -bOut.y] [t] = [Qy - Py]
  const det = aOut[0] * -bOut[1] - -bOut[0] * aOut[1];
  if (Math.abs(det) < 1e-6) {
    // Parallel offset lines — adjacent segments run anti-collinear (180°)
    // through the junction. This is the normal case for the "straight
    // through" side of a T-junction (main road continues; side road taps in).
    // The pair simply contributes no edge clip on this side; the polygon
    // corners on this side come from segment widths alone via the other
    // adjacent pair. Returning degenerate would (incorrectly) kill the entire
    // junction, leaving a visible gap in the mesh.
    return { degenerate: false, distA: 0, distB: 0, isBevel: false };
  }

  const dx = Qx - Px;
  const dy = Qy - Py;
  let s = (dx * -bOut[1] - -bOut[0] * dy) / det;
  let t = (aOut[0] * dy - dx * aOut[1]) / det;

  if (s < 0 || t < 0) {
    // One edge's natural bisector intersection sits BEHIND that segment along
    // its own outbound. This happens with very asymmetric pairs — e.g. a
    // narrow side road meeting a wide main road. The wide road's offset edge
    // is far enough out that the geometric meet-point lands past the junction
    // node, not in front of it.
    //
    // Marking this degenerate (older behavior) would skip the entire junction
    // and leave the connecting road dangling with no fill mesh — visible as
    // "one road has heavy glitches at the end" of a 3+ way junction.
    //
    // Correct behavior: clamp the negative side to 0 (that edge doesn't need
    // to retract beyond the node), keep the other side's natural clip, then
    // run the same miter-limit clamp on the positive side below.
    s = Math.max(0, s);
    t = Math.max(0, t);
  }

  // Apply miter limit (cap by the wider segment so a narrow road meeting a
  // motorway doesn't get a tiny clip just because IT is narrow).
  const maxHalfWidth = Math.max(a.halfWidth, b.halfWidth);
  const miterLimit = MITER_LIMIT_FACTOR * maxHalfWidth;

  if (s > miterLimit || t > miterLimit) {
    return {
      degenerate: false,
      distA: Math.min(s, miterLimit),
      distB: Math.min(t, miterLimit),
      isBevel: true,
    };
  }

  return {
    degenerate: false,
    distA: s,
    distB: t,
    isBevel: false,
  };
}

/**
 * Total length of a polyline in meters.
 */
function polylineLength(geometry) {
  let total = 0;
  for (let i = 1; i < geometry.length; i++) {
    const dx = geometry[i][0] - geometry[i - 1][0];
    const dy = geometry[i][1] - geometry[i - 1][1];
    total += Math.hypot(dx, dy);
  }
  return total;
}

/**
 * Trim a polyline at both ends by a given arc-length (meters) measured along
 * the XY plane (the first two array fields). All additional per-node fields
 * (width, depth, normals, etc.) are linearly interpolated at the cut points.
 *
 * Returns a new array; the input is not mutated. Returns `[]` if the requested
 * trim consumes the entire polyline.
 *
 * @param {number[][]} nodes               Polyline nodes; first 2 fields = [x, y].
 * @param {number}     clipFromStart       Meters to remove from the start (>= 0).
 * @param {number}     clipFromEnd         Meters to remove from the end (>= 0).
 */
export function clipPolylineEnds(nodes, clipFromStart, clipFromEnd) {
  if (clipFromStart <= 0 && clipFromEnd <= 0) return nodes.map((n) => [...n]);
  if (!Array.isArray(nodes) || nodes.length < 2) return [];

  const cum = [0];
  for (let i = 1; i < nodes.length; i++) {
    cum.push(
      cum[i - 1] +
        Math.hypot(nodes[i][0] - nodes[i - 1][0], nodes[i][1] - nodes[i - 1][1]),
    );
  }
  const totalLen = cum[cum.length - 1];

  const startTarget = Math.max(0, clipFromStart);
  const endTarget = Math.max(0, totalLen - Math.max(0, clipFromEnd));
  if (startTarget >= endTarget) return [];

  const out = [];
  out.push(nodeAtArcLength(nodes, cum, startTarget));
  for (let i = 0; i < nodes.length; i++) {
    if (cum[i] > startTarget && cum[i] < endTarget) {
      out.push([...nodes[i]]);
    }
  }
  out.push(nodeAtArcLength(nodes, cum, endTarget));
  return out;
}

function nodeAtArcLength(nodes, cum, target) {
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= target) {
      const span = cum[i] - cum[i - 1];
      const t = span > 1e-9 ? (target - cum[i - 1]) / span : 0;
      return lerpNode(nodes[i - 1], nodes[i], t);
    }
  }
  return [...nodes[nodes.length - 1]];
}

function lerpNode(a, b, t) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] + (b[i] - a[i]) * t;
  }
  return out;
}

/**
 * Remove consecutive (including wrap-around) near-duplicate vertices from a
 * closed polygon. Two vertices are considered duplicates if their XY distance
 * is below `eps` meters.
 */
function dedupClosedPolygon(vertices, eps) {
  const epsSq = eps * eps;
  const out = [];
  for (const v of vertices) {
    const last = out[out.length - 1];
    if (last) {
      const dx = v[0] - last[0];
      const dy = v[1] - last[1];
      if (dx * dx + dy * dy < epsSq) continue;
    }
    out.push(v);
  }
  // Wrap-around check
  if (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    const dx = first[0] - last[0];
    const dy = first[1] - last[1];
    if (dx * dx + dy * dy < epsSq) out.pop();
  }
  return out;
}
