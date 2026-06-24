/** @layer core */
// Pure THREE geometry primitives used by createOSMGroup: road/barrier ribbons,
// vertex colouring, polygon-ring simplification, procedural street-furniture +
// tree meshes, and the instance-stamping merger. No canvas, no network.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ensureCache, getCachedUnitsPerMeter, getHeightAtScenePos } from "./sceneProjection.js";

export const addColor = (geo, colorHex) => {
  const count = geo.attributes.position.count,
    colors = new Float32Array(count * 3),
    c = new THREE.Color(colorHex);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
};

export const createRoadGeometry = (data, points, width, offset = 0, options = {}) => {
  const geometry = new THREE.BufferGeometry();
  const vertices = [];
  const uvs = [];
  const indices = [];

  ensureCache(data);
  const unitsPerMeter = getCachedUnitsPerMeter();

  // Reuse Vector3 objects to avoid allocation per iteration
  const forward = new THREE.Vector3();

  let accumulatedDist = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i > 0) accumulatedDist += p.distanceTo(points[i - 1]);

    const isDashGap =
      options.dashed &&
      Math.floor(accumulatedDist / (4 * unitsPerMeter)) % 2 === 1;

    if (i < points.length - 1) {
      forward.subVectors(points[i + 1], points[i]).normalize();
    } else {
      forward.subVectors(points[i], points[i - 1]).normalize();
    }

    const perpX = -forward.z;
    const perpZ = forward.x;
    const halfWidth = (width / 2) * unitsPerMeter;
    const off = offset * unitsPerMeter;

    const lx = p.x + perpX * (off - halfWidth);
    const lz = p.z + perpZ * (off - halfWidth);
    const rx = p.x + perpX * (off + halfWidth);
    const rz = p.z + perpZ * (off + halfWidth);

    const ly = getHeightAtScenePos(data, lx, lz);
    const ry = getHeightAtScenePos(data, rx, rz);

    const elev = (options.type === "sidewalk" ? 0.15 : 0.02) * unitsPerMeter;
    vertices.push(lx, ly + elev, lz);
    vertices.push(rx, ry + elev, rz);

    const v = accumulatedDist / (5 * unitsPerMeter);
    uvs.push(0, v);
    uvs.push(1, v);

    if (i < points.length - 1 && !isDashGap) {
      const base = i * 2;
      indices.push(base, base + 2, base + 1);
      indices.push(base + 1, base + 2, base + 3);
    }
  }

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
};

export const createBarrierGeometry = (data, points, width, height) => {
  const roadGeo = createRoadGeometry(data, points, width);
  const pos = roadGeo.attributes.position;
  const count = pos.count;

  const newVertices = [];
  const newIndices = [];

  for (let i = 0; i < count; i++) {
    newVertices.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  for (let i = 0; i < count; i++) {
    newVertices.push(pos.getX(i), pos.getY(i) + height, pos.getZ(i));
  }

  const indexAttr = roadGeo.index;
  for (let i = 0; i < indexAttr.count; i += 3) {
    const a = indexAttr.getX(i);
    const b = indexAttr.getX(i + 1);
    const c = indexAttr.getX(i + 2);
    newIndices.push(a + count, b + count, c + count);
    newIndices.push(a, c, b);
  }

  const numPoints = points.length;
  for (let i = 0; i < numPoints - 1; i++) {
    const base = i * 2;
    const next = base + 2;
    newIndices.push(base, next, next + count);
    newIndices.push(base, next + count, base + count);
    newIndices.push(base + 1, base + 1 + count, next + 1 + count);
    newIndices.push(base + 1, next + 1 + count, next + 1);
  }

  newIndices.push(0, 1 + count, 1);
  newIndices.push(0, 0 + count, 1 + count);
  const last = (numPoints - 1) * 2;
  newIndices.push(last, last + 1, last + 1 + count);
  newIndices.push(last, last + 1 + count, last + count);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newVertices, 3),
  );
  geo.setIndex(newIndices);
  geo.computeVertexNormals();

  roadGeo.dispose();
  return geo;
};

// === Street Furniture Procedural Model Generators ===

/**
 * Street lamp: tapered pole + lamp head.
 * OSM2World: pole 0.16→0.08m radius, 5m tall, inverted pyramid lamp.
 */
export const createStreetLampMesh = (unitsPerMeter) => {
  const poleH = 5.0 * unitsPerMeter;
  const lampH = 0.8 * unitsPerMeter;
  const totalH = poleH;

  // Tapered pole
  let pole = new THREE.CylinderGeometry(
    0.06 * unitsPerMeter, 0.12 * unitsPerMeter, poleH - lampH, 6,
  );
  if (pole.index) pole = pole.toNonIndexed();
  pole.translate(0, (poleH - lampH) / 2, 0);
  addColor(pole, 0x888888);

  // Lamp housing (inverted cone)
  let lampBase = new THREE.CylinderGeometry(
    0.02 * unitsPerMeter, 0.3 * unitsPerMeter, lampH * 0.6, 6,
  );
  if (lampBase.index) lampBase = lampBase.toNonIndexed();
  lampBase.translate(0, poleH - lampH + lampH * 0.3, 0);
  addColor(lampBase, 0x444444);

  // Lamp globe (bright cap)
  let lampGlobe = new THREE.SphereGeometry(0.15 * unitsPerMeter, 6, 4);
  if (lampGlobe.index) lampGlobe = lampGlobe.toNonIndexed();
  lampGlobe.translate(0, poleH - lampH * 0.15, 0);
  addColor(lampGlobe, 0xfff8dc);

  const merged = mergeGeometries([pole, lampBase, lampGlobe]);
  pole.dispose(); lampBase.dispose(); lampGlobe.dispose();
  return merged;
};

/**
 * Bollard: simple cylinder.
 * OSM2World: r=0.15m, h=1.0m, STEEL.
 */
export const createBollardMesh = (unitsPerMeter) => {
  const h = 1.0 * unitsPerMeter;
  const r = 0.12 * unitsPerMeter;
  let geo = new THREE.CylinderGeometry(r * 0.85, r, h, 6);
  if (geo.index) geo = geo.toNonIndexed();
  geo.translate(0, h / 2, 0);
  addColor(geo, 0x777777);
  return geo;
};

/**
 * Bench: seat + backrest + 4 legs.
 * OSM2World: seat 2m × 0.5m × 0.05m at 0.5m, backrest 0.5m tall, legs 0.08m.
 */
export const createBenchMesh = (unitsPerMeter) => {
  const benchW = 1.5 * unitsPerMeter;
  const seatD = 0.45 * unitsPerMeter;
  const seatH = 0.5 * unitsPerMeter;
  const seatThk = 0.04 * unitsPerMeter;
  const legSz = 0.06 * unitsPerMeter;
  const backH = 0.4 * unitsPerMeter;
  const backThk = 0.03 * unitsPerMeter;
  const parts = [];

  // Seat
  let seat = new THREE.BoxGeometry(benchW, seatThk, seatD);
  if (seat.index) seat = seat.toNonIndexed();
  seat.translate(0, seatH, 0);
  addColor(seat, 0x8B6914);
  parts.push(seat);

  // Backrest
  let back = new THREE.BoxGeometry(benchW, backH, backThk);
  if (back.index) back = back.toNonIndexed();
  back.translate(0, seatH + backH / 2, -seatD / 2 + backThk / 2);
  addColor(back, 0x8B6914);
  parts.push(back);

  // 4 Legs
  const legPositions = [
    [-benchW / 2 + legSz, -seatD / 2 + legSz],
    [benchW / 2 - legSz, -seatD / 2 + legSz],
    [-benchW / 2 + legSz, seatD / 2 - legSz],
    [benchW / 2 - legSz, seatD / 2 - legSz],
  ];
  for (const [lx, lz] of legPositions) {
    let leg = new THREE.BoxGeometry(legSz, seatH, legSz);
    if (leg.index) leg = leg.toNonIndexed();
    leg.translate(lx, seatH / 2, lz);
    addColor(leg, 0x555555);
    parts.push(leg);
  }

  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return merged;
};

/**
 * Traffic sign: pole + sign face (octagon for stop, triangle for give_way, rectangle default).
 * OSM2World: pole r=0.05m h=2.0m, sign ~0.6m.
 */
export const createTrafficSignMesh = (signType, unitsPerMeter) => {
  const poleH = 2.5 * unitsPerMeter;
  const poleR = 0.04 * unitsPerMeter;
  const signSize = 0.5 * unitsPerMeter;
  const signThk = 0.02 * unitsPerMeter;
  const parts = [];

  // Pole
  let pole = new THREE.CylinderGeometry(poleR, poleR, poleH, 6);
  if (pole.index) pole = pole.toNonIndexed();
  pole.translate(0, poleH / 2, 0);
  addColor(pole, 0x888888);
  parts.push(pole);

  // Sign face
  let signColor = 0xcc0000; // red for stop
  if (signType === "give_way" || signType === "yield") {
    signColor = 0xcc0000; // red border triangle
  } else if (signType === "generic") {
    signColor = 0x2255cc; // blue info sign
  }

  // Regular sign: flat box
  let signGeo = new THREE.BoxGeometry(signSize, signSize, signThk);
  if (signGeo.index) signGeo = signGeo.toNonIndexed();
  signGeo.translate(0, poleH + signSize * 0.1, signThk);
  addColor(signGeo, signColor);
  parts.push(signGeo);

  const merged = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return merged;
};

export const createTreeMesh = (type, unitsPerMeter, options = {}) => {
  try {
    const { lightweightVegetationMode = false } = options;
    const trunkRadialSegments = lightweightVegetationMode ? 5 : 8;
    const palmFrondsCount = lightweightVegetationMode ? 5 : 8;
    const palmFrondRadialSegments = lightweightVegetationMode ? 3 : 4;
    const coniferRadialSegments = lightweightVegetationMode ? 6 : 8;
    const deciduousDetail = lightweightVegetationMode ? 0 : 1;

    const trunkHeight = (type === "palm" ? 5 : 6) * unitsPerMeter;
    let trunkGeo = new THREE.CylinderGeometry(
      0.15 * unitsPerMeter,
      0.25 * unitsPerMeter,
      trunkHeight,
      trunkRadialSegments,
    );
    if (trunkGeo.index) trunkGeo = trunkGeo.toNonIndexed();
    trunkGeo.translate(0, trunkHeight / 2, 0);
    addColor(trunkGeo, 0x5d4037);

    if (type === "palm") {
      const fronds = [];
      for (let i = 0; i < palmFrondsCount; i++) {
        let frondGeo = new THREE.CylinderGeometry(
          0.01 * unitsPerMeter,
          0.2 * unitsPerMeter,
          3.5 * unitsPerMeter,
          palmFrondRadialSegments,
        );
        if (frondGeo.index) frondGeo = frondGeo.toNonIndexed();
        frondGeo.translate(0, 1.75 * unitsPerMeter, 0);
        frondGeo.rotateZ(-Math.PI / 4); // Droop down
        frondGeo.rotateY((i / palmFrondsCount) * Math.PI * 2);
        frondGeo.translate(0, trunkHeight * 0.95, 0);
        addColor(frondGeo, 0x15803d);
        fronds.push(frondGeo);
      }
      const merged = mergeGeometries([trunkGeo, ...fronds]);
      fronds.forEach((f) => f.dispose());
      trunkGeo.dispose();
      return merged;
    } else if (type === "coniferous") {
      let crownGeo = new THREE.CylinderGeometry(
        0,
        2.5 * unitsPerMeter,
        7 * unitsPerMeter,
        coniferRadialSegments,
      );
      if (crownGeo.index) crownGeo = crownGeo.toNonIndexed();
      crownGeo.translate(0, 6.5 * unitsPerMeter, 0);
      addColor(crownGeo, 0x064e3b);
      const merged = mergeGeometries([trunkGeo, crownGeo]);
      crownGeo.dispose();
      trunkGeo.dispose();
      return merged;
    } else {
      let crownGeo = new THREE.IcosahedronGeometry(
        3 * unitsPerMeter,
        deciduousDetail,
      );
      if (crownGeo.index) crownGeo = crownGeo.toNonIndexed();
      crownGeo.scale(1, 1.2, 1);
      crownGeo.translate(0, 7 * unitsPerMeter, 0);
      addColor(crownGeo, 0x166534);
      const merged = mergeGeometries([trunkGeo, crownGeo]);
      crownGeo.dispose();
      trunkGeo.dispose();
      return merged;
    }
  } catch (e) {
    console.warn("Failed to create tree mesh:", e);
    return null;
  }
};

export const isPointInPolygon = (point, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      zi = poly[i].z;
    const xj = poly[j].x,
      zj = poly[j].z;
    const intersect =
      zi > point.z !== zj > point.z &&
      point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const simplifyPointToSegmentDistance = (p, a, b) => {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const apx = p.x - a.x;
  const apz = p.z - a.z;
  const abLen2 = abx * abx + abz * abz;
  if (abLen2 < 1e-9) {
    const dx = p.x - a.x;
    const dz = p.z - a.z;
    return Math.sqrt(dx * dx + dz * dz);
  }
  let t = (apx * abx + apz * abz) / abLen2;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * abx;
  const pz = a.z + t * abz;
  const dx = p.x - px;
  const dz = p.z - pz;
  return Math.sqrt(dx * dx + dz * dz);
};

const simplifyRingDouglasPeucker = (points, tolerance) => {
  if (!Array.isArray(points) || points.length <= 4 || tolerance <= 0) return points;

  const result = [];
  const recurse = (start, end) => {
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = simplifyPointToSegmentDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      recurse(start, index);
      recurse(index, end);
    } else {
      result.push(points[start]);
    }
  };

  recurse(0, points.length - 1);
  result.push(points[points.length - 1]);
  return result;
};

export const normalizeClosedRing = (points) => {
  if (!Array.isArray(points) || points.length < 3) return [];
  const ring = points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (Math.abs(first.x - last.x) > 1e-6 || Math.abs(first.z - last.z) > 1e-6) {
    ring.push(new THREE.Vector3(first.x, first.y, first.z));
  }
  return ring;
};

export const simplifyClosedRing = (points, tolerance) => {
  const ring = normalizeClosedRing(points);
  if (ring.length < 4 || tolerance <= 0) return ring;

  const open = ring.slice(0, -1);
  if (open.length < 3) return ring;

  const simplifiedOpen = simplifyRingDouglasPeucker(open, tolerance);
  if (simplifiedOpen.length < 3) return ring;

  const out = simplifiedOpen.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  out.push(new THREE.Vector3(out[0].x, out[0].y, out[0].z));
  return out.length >= 4 ? out : ring;
};

// Optimized vegetation/furniture instancing: pre-allocate a combined buffer and
// stamp each instance's transform instead of cloning the base geometry N times.
export const stampInstances = (baseGeo, instances, getMat) => {
  const basePos = baseGeo.attributes.position;
  const baseCol = baseGeo.attributes.color;
  const vertCount = basePos.count;
  const totalVerts = vertCount * instances.length;
  const combinedPos = new Float32Array(totalVerts * 3);
  const combinedCol = new Float32Array(totalVerts * 3);
  const tmpV = new THREE.Vector3();

  for (let i = 0; i < instances.length; i++) {
    const mat = getMat(instances[i]);
    const off = i * vertCount * 3;
    for (let v = 0; v < vertCount; v++) {
      tmpV.set(basePos.getX(v), basePos.getY(v), basePos.getZ(v));
      tmpV.applyMatrix4(mat);
      combinedPos[off + v * 3] = tmpV.x;
      combinedPos[off + v * 3 + 1] = tmpV.y;
      combinedPos[off + v * 3 + 2] = tmpV.z;
      combinedCol[off + v * 3] = baseCol.getX(v);
      combinedCol[off + v * 3 + 1] = baseCol.getY(v);
      combinedCol[off + v * 3 + 2] = baseCol.getZ(v);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(combinedPos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(combinedCol, 3));
  geo.computeVertexNormals();
  return geo;
};
