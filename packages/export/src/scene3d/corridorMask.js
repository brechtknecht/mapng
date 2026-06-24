/** @layer core */
// Corridor masking (route mode): drop mesh triangles whose XZ centroid lies more
// than halfWidthM (perpendicular) from the route polyline, then COMPACT the
// geometry so dropped vertices actually leave the file (an index-only trim keeps
// the big position buffers). Operates in the shared scene XZ frame produced by
// latLngToScene — the frame the Google group's geometry is already in.
import * as THREE from "three";
import { ensureCache, getCachedUnitsPerMeter, latLngToScene } from "./sceneProjection.js";

const _distSqPointToSeg2D = (px, pz, ax, az, bx, bz) => {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cz = az + t * dz;
  const ex = px - cx;
  const ez = pz - cz;
  return ex * ex + ez * ez;
};

const _distSqPointToPolyline2D = (px, pz, route) => {
  if (route.length === 1) {
    const ex = px - route[0].x;
    const ez = pz - route[0].z;
    return ex * ex + ez * ez;
  }
  let min = Infinity;
  for (let i = 1; i < route.length; i++) {
    const d = _distSqPointToSeg2D(px, pz, route[i - 1].x, route[i - 1].z, route[i].x, route[i].z);
    if (d < min) min = d;
  }
  return min;
};

// Rebuild a geometry keeping only triangles for which keepTri(t, vAt) is true,
// remapping to a compact vertex set. Returns null if nothing is kept.
const _compactGeometryByTriangles = (geo, keepTri) => {
  const idx = geo.index;
  const posCount = geo.attributes.position.count;
  const triCount = idx ? idx.count / 3 : posCount / 3;
  const vAt = (t, k) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);

  const remap = new Map();
  const newIndices = [];
  let next = 0;
  for (let t = 0; t < triCount; t++) {
    if (!keepTri(t, vAt)) continue;
    for (let k = 0; k < 3; k++) {
      const v = vAt(t, k);
      let nv = remap.get(v);
      if (nv === undefined) { nv = next++; remap.set(v, nv); }
      newIndices.push(nv);
    }
  }
  if (next === 0) return null;

  const newGeo = new THREE.BufferGeometry();
  for (const name in geo.attributes) {
    const attr = geo.attributes[name];
    const is = attr.itemSize;
    const out = new attr.array.constructor(next * is);
    for (const [oldV, newV] of remap) {
      for (let c = 0; c < is; c++) out[newV * is + c] = attr.array[oldV * is + c];
    }
    newGeo.setAttribute(name, new THREE.BufferAttribute(out, is, attr.normalized));
  }
  newGeo.setIndex(newIndices);
  return newGeo;
};

// Clip every mesh in `group` (scene XZ frame) to within halfWidthM of the route.
export const clipGroupToCorridorXZ = (group, data, segment, halfWidthM, onProgress) => {
  if (!segment?.length || !(halfWidthM > 0)) {
    const stats = { ran: false, reason: !segment?.length ? 'empty-segment' : 'bad-halfWidth', segmentLen: segment?.length ?? 0 };
    console.warn('[corridorMask] skipped', JSON.stringify(stats));
    return stats;
  }
  ensureCache(data);
  const route = segment.map((p) => {
    const s = latLngToScene(data, p.lat, p.lng);
    return { x: s.x, z: s.z };
  });
  const halfScene = halfWidthM * getCachedUnitsPerMeter();
  const half2 = halfScene * halfScene;

  // route XZ bbox — to confirm the route lands in the [-50,50] tile frame
  const rb = { xmin: Infinity, xmax: -Infinity, zmin: Infinity, zmax: -Infinity };
  for (const p of route) {
    if (p.x < rb.xmin) rb.xmin = p.x; if (p.x > rb.xmax) rb.xmax = p.x;
    if (p.z < rb.zmin) rb.zmin = p.z; if (p.z > rb.zmax) rb.zmax = p.z;
  }

  const meshes = [];
  group.traverse((o) => { if (o.isMesh && o.geometry) meshes.push(o); });

  let before = 0;
  let after = 0;
  let meshesRemoved = 0;
  const gb = { xmin: Infinity, xmax: -Infinity, zmin: Infinity, zmax: -Infinity };
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    before += posAttr.count;
    const keep = (t, vAt) => {
      let cx = 0;
      let cz = 0;
      for (let k = 0; k < 3; k++) {
        const vi = vAt(t, k);
        const x = posAttr.getX(vi);
        const z = posAttr.getZ(vi);
        cx += x; cz += z;
        if (x < gb.xmin) gb.xmin = x; if (x > gb.xmax) gb.xmax = x;
        if (z < gb.zmin) gb.zmin = z; if (z > gb.zmax) gb.zmax = z;
      }
      return _distSqPointToPolyline2D(cx / 3, cz / 3, route) <= half2;
    };
    const compact = _compactGeometryByTriangles(geo, keep);
    if (compact) {
      mesh.geometry = compact; // clone shared geometry with the bake cache — replace, never mutate/dispose
      after += compact.attributes.position.count;
    } else {
      mesh.parent?.remove(mesh); // whole mesh outside the corridor
      meshesRemoved++;
    }
  }
  const round = (n) => Math.round(n * 10) / 10;
  const stats = {
    ran: true,
    routePoints: route.length,
    halfWidthM,
    halfScene: round(halfScene),
    vertsBefore: before,
    vertsAfter: after,
    keptPct: before ? Math.round((after / before) * 100) : 0,
    meshesIn: meshes.length,
    meshesRemoved,
    routeBBox: { xmin: round(rb.xmin), xmax: round(rb.xmax), zmin: round(rb.zmin), zmax: round(rb.zmax) },
    geomBBox: { xmin: round(gb.xmin), xmax: round(gb.xmax), zmin: round(gb.zmin), zmax: round(gb.zmax) },
  };
  console.log('[corridorMask]', JSON.stringify(stats));
  onProgress?.(`Corridor mask: kept ${after}/${before} verts (${stats.keptPct}%)`);
  return stats;
};
