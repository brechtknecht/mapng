/** @layer core */
// Shared 2D polyline primitives for junction geometry + polyline cleanup
// (refactor doc 06 step 10). Pure numeric helpers over plain [x,y,z] arrays in
// BeamNG world space; moved verbatim from junctionGeometry.js.

export const EPS = 1e-9;

export function dist2D(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return Math.sqrt(dx * dx + dy * dy);
}

export function polylineLength2D(nodes) {
  let total = 0;
  for (let i = 1; i < nodes.length; i++) total += dist2D(nodes[i - 1], nodes[i]);
  return total;
}

export function unit2D(dx, dy) {
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < EPS) return [0, 0];
  return [dx / len, dy / len];
}

export function angleChangeDeg(a, b, c) {
  const v1 = unit2D(b[0] - a[0], b[1] - a[1]);
  const v2 = unit2D(c[0] - b[0], c[1] - b[1]);
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1]));
  return (Math.acos(dot) * 180) / Math.PI;
}

export function lerpNode(a, b, t) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}
