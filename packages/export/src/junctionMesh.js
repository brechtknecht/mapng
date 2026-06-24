// THREE.js assembly of road-junction prisms into a single Collada file. The
// emitted DAE mirrors the OSM-objects pattern (base00 > start01 > visual mesh
// + Colmesh-1 clone) so BeamNG picks up both rendering and collision from one
// TSStatic. Material name is "osm_object" — the only material the level's
// art/shapes/main.materials.json registers.

import * as THREE from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ColladaExporter } from './ColladaExporter.js';
import { MESH_ROAD_DEPTH } from './junctionGeometry.js';

/**
 * Build an extruded prism for one junction polygon.
 *
 * The polygon is CCW in BeamNG world XY with per-vertex Z. The prism has:
 *  - top face: earcut triangulation of the polygon XY with per-vertex Z
 *  - bottom face: same triangulation, reversed winding, Z - depth
 *  - N side walls: one trapezoid per polygon edge (slope follows perimeter Zs)
 *
 * Earcut handles arbitrary simple polygons (convex or not) without introducing
 * a centroid vertex. The old centroid-fan approach failed silently when the
 * polygon's centroid fell outside the polygon, producing holes in the top
 * face and exposed bottom faces from below — those are tire-poppers in BeamNG.
 *
 * Vertices are duplicated per face so each face owns its outward normal and
 * UV space — no shared verts between top/bottom/sides.
 */
function buildJunctionPrismGeometry(polygon, depth) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;

  const N = polygon.length;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of polygon) {
    if (v[0] < minX) minX = v[0];
    if (v[1] < minY) minY = v[1];
    if (v[0] > maxX) maxX = v[0];
    if (v[1] > maxY) maxY = v[1];
  }
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;
  const uvOf = (v) => [(v[0] - minX) / spanX, (v[1] - minY) / spanY];

  // Flat XY array for earcut; preserves polygon vertex order so the returned
  // indices match polygon[] directly.
  const flat = new Array(N * 2);
  for (let i = 0; i < N; i++) {
    flat[i * 2]     = polygon[i][0];
    flat[i * 2 + 1] = polygon[i][1];
  }
  const triIdx = Earcut.triangulate(flat, null, 2);
  if (!triIdx || triIdx.length === 0) return null;

  const positions = [];
  const normals = [];
  const uvs = [];

  const pushTri = (a, b, c, n, uvA, uvB, uvC) => {
    positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    normals.push(n[0], n[1], n[2], n[0], n[1], n[2], n[0], n[1], n[2]);
    uvs.push(uvA[0], uvA[1], uvB[0], uvB[1], uvC[0], uvC[1]);
  };

  // Top face — earcut returns CCW indices for CCW input → +Z normal.
  for (let i = 0; i < triIdx.length; i += 3) {
    const a = polygon[triIdx[i]];
    const b = polygon[triIdx[i + 1]];
    const c = polygon[triIdx[i + 2]];
    pushTri(a, b, c, [0, 0, 1], uvOf(a), uvOf(b), uvOf(c));
  }

  // Bottom face — same triangulation, Z - depth, winding reversed so -Z normal.
  for (let i = 0; i < triIdx.length; i += 3) {
    const a = polygon[triIdx[i]];
    const b = polygon[triIdx[i + 1]];
    const c = polygon[triIdx[i + 2]];
    const aB = [a[0], a[1], a[2] - depth];
    const bB = [b[0], b[1], b[2] - depth];
    const cB = [c[0], c[1], c[2] - depth];
    pushTri(aB, cB, bB, [0, 0, -1], uvOf(a), uvOf(c), uvOf(b));
  }

  // Side walls — one trapezoid per polygon edge.
  for (let i = 0; i < N; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % N];
    const aTop = [a[0], a[1], a[2]];
    const bTop = [b[0], b[1], b[2]];
    const aBot = [a[0], a[1], a[2] - depth];
    const bBot = [b[0], b[1], b[2] - depth];

    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const elen = Math.sqrt(ex * ex + ey * ey) || 1;
    // Outward normal: right-perpendicular of edge direction for CCW polygon.
    const nx = ey / elen;
    const ny = -ex / elen;
    const normal = [nx, ny, 0];

    pushTri(aBot, bBot, bTop, normal, [0, 0], [1, 0], [1, 1]);
    pushTri(aBot, bTop, aTop, normal, [0, 0], [1, 1], [0, 1]);
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geom;
}

/**
 * Build a single Collada file containing all junction prisms, plus a Colmesh-1
 * clone for collision. Returns a string of DAE XML, or null if there are no
 * valid polygons.
 */
export async function generateJunctionsDAE(junctions) {
  if (!Array.isArray(junctions) || junctions.length === 0) return null;

  const geometries = [];
  for (const j of junctions) {
    const g = buildJunctionPrismGeometry(j.polygon, MESH_ROAD_DEPTH);
    if (g) geometries.push(g);
  }
  if (geometries.length === 0) return null;

  const merged = mergeGeometries(geometries, false);
  geometries.forEach(g => g.dispose());
  if (!merged) return null;

  // Visual mesh — geometry name must NOT start with "Col" or BeamNG treats it
  // as collision-only and skips rendering.
  merged.name = 'road_junctions';
  const visualMaterial = new THREE.MeshBasicMaterial({ name: 'osm_object', color: 0xffffff });
  const visualMesh = new THREE.Mesh(merged, visualMaterial);
  visualMesh.name = 'road_junctions';

  // Collision sibling — geometry name MUST start with "Col" for BeamNG to
  // bind it as the TSStatic's collision proxy.
  const collisionGeom = merged.clone();
  collisionGeom.name = 'Colmesh-1';
  const collisionMaterial = new THREE.MeshBasicMaterial({ name: 'osm_object', color: 0xffffff });
  const collisionMesh = new THREE.Mesh(collisionGeom, collisionMaterial);
  collisionMesh.name = 'Colmesh-1';

  const base00 = new THREE.Group();
  base00.name = 'base00';
  const start01 = new THREE.Group();
  start01.name = 'start01';
  start01.add(visualMesh);
  start01.add(collisionMesh);
  base00.add(start01);
  base00.updateMatrixWorld(true);

  const result = new ColladaExporter().parse(base00, undefined, { version: '1.4.1', upAxis: 'Z_UP' });
  if (!result?.data) return null;
  return result.data;
}
