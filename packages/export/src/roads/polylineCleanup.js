/** @layer core */
// MeshRoad polyline cleanup: end clipping, short-edge prune, end-edge balance,
// sharp-kink smoothing, uniform resample, and Z-at-clipback (refactor doc 06
// step 10). Pure — operates on plain [x,y,z] arrays. Moved verbatim from
// junctionGeometry.js.
import { EPS, dist2D, polylineLength2D, angleChangeDeg, lerpNode } from './geomPrimitives.js';
import {
  MESH_ROAD_RESAMPLE_SPACING_M,
  KINK_SMOOTH_THRESHOLD_DEG,
  KINK_SMOOTH_THRESHOLD_TIGHT_DEG,
  KINK_SHORT_EDGE_M,
  KINK_SMOOTH_OFFSET_M,
  KINK_OFFSET_MAX_RATIO,
  END_EDGE_RATIO_THRESHOLD,
  END_EDGE_KINK_DEG,
  END_EDGE_PRUNE_MIN_M,
} from './junctionConstants.js';

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
