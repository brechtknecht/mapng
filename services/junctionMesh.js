/**
 * Junction mesh assembly.
 *
 * Each junction polygon (CCW, world-space, [x, y, z] meters — produced by
 * `junctionGeometry.analyzeJunctions`) is extruded into a closed 3D prism
 * that fills the bisector-clipped gap between MeshRoad ends. The prism has:
 *   - A top face at the polygon's elevation (matches MeshRoad top surface).
 *   - A bottom face `depth` meters below (matches MeshRoad bottom = terrain).
 *   - N vertical side walls (one per polygon edge) sealing the top/bottom.
 *
 * The prism is a closed manifold — there's no "skin without volume" through
 * which a fast-moving vehicle could pierce. The side walls also butt cleanly
 * against the MeshRoad slabs' perpendicular end-caps where adjacent.
 *
 * Triangulation: fan from the polygon's centroid for top + bottom; two
 * triangles per side quad. Junction polygons are always star-shaped about
 * their centroid (vertices are placed radially from the junction node by the
 * bisector analyzer), so a centroid fan is always valid.
 *
 * UVs: top-down planar projection on top and bottom faces (asphalt texture
 * grain flows continuously between adjacent junctions). Side walls use
 * (edge_arc_length, vertical_distance) — same texture but mapped to the
 * vertical band so the side reads as a thin asphalt edge.
 *
 * Coordinates are emitted directly in BeamNG world space (Z-up, meters). The
 * caller wraps in `base00 > start01` and serializes via ColladaExporter with
 * `upAxis: 'Z_UP'`. No additional coordinate transform is needed.
 */

import * as THREE from 'three';

/**
 * BeamNG material name to bind on the junction mesh.
 *
 * Currently set to `'osm_object'` — the same material the OSM buildings DAE
 * uses. We know this name resolves correctly at runtime (buildings render
 * with their texture), so any rendering issue we still see in BeamNG can be
 * attributed to geometry, not material binding.
 *
 * Once junction geometry is verified correct via the in-app debug view, this
 * should be switched back to `'m_asphalt_new_01'` so the junction surface
 * visually matches the surrounding MeshRoads.
 */
const ASPHALT_MATERIAL_NAME = 'osm_object';

/** UV tile size in meters. Smaller = denser texture pattern across junction. */
const ASPHALT_TILE_SIZE_M = 5.0;

/** Default prism depth (meters) — should match MeshRoad's `depth` parameter. */
const DEFAULT_DEPTH_M = 0.5;

/**
 * Build a THREE.Group containing a single merged mesh of all junction prisms.
 *
 * @param {Array<{polygon: number[][]}>} junctions
 *        Each polygon is a CCW array of [x, y, z] points in world meters.
 *        Polygons with fewer than 3 vertices are skipped silently.
 * @param {object} [options]
 * @param {number} [options.depth=0.5]  Prism depth — make this match MeshRoad
 *        depth so the side walls align with MeshRoad slab end-caps.
 * @returns {THREE.Group | null} `null` if there's nothing to mesh.
 */
export function buildJunctionMeshGroup(junctions, options = {}) {
  if (!Array.isArray(junctions) || junctions.length === 0) return null;
  const depth = Number.isFinite(options.depth) ? options.depth : DEFAULT_DEPTH_M;

  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];
  let baseIndex = 0;

  for (const junction of junctions) {
    const polygon = junction?.polygon;
    if (!Array.isArray(polygon) || polygon.length < 3) continue;

    const N = polygon.length;

    // ── Fan center (shared by top and bottom fans) ────────────────────────
    // Prefer the original junction node position when available: it's
    // guaranteed to be inside the polygon (the polygon was built radially
    // outward from this point), so the centroid fan never produces inverted
    // or overlapping triangles. Fall back to the vertex average for safety.
    let cx;
    let cy;
    let cz;
    if (Array.isArray(junction.position) && junction.position.length >= 3) {
      cx = junction.position[0];
      cy = junction.position[1];
      cz = junction.position[2];
    } else {
      cx = 0;
      cy = 0;
      cz = 0;
      for (const v of polygon) {
        cx += v[0];
        cy += v[1];
        cz += v[2];
      }
      cx /= N;
      cy /= N;
      cz /= N;
    }
    const topZ = cz;
    const botZ = cz - depth;

    // ── Top face: centroid + N perimeter vertices, fan triangulation ────
    const topCentroidIdx = baseIndex;
    positions.push(cx, cy, topZ);
    uvs.push(cx / ASPHALT_TILE_SIZE_M, cy / ASPHALT_TILE_SIZE_M);
    normals.push(0, 0, 1);
    baseIndex += 1;

    const topRingStart = baseIndex;
    for (const v of polygon) {
      positions.push(v[0], v[1], topZ);
      uvs.push(v[0] / ASPHALT_TILE_SIZE_M, v[1] / ASPHALT_TILE_SIZE_M);
      normals.push(0, 0, 1);
    }
    baseIndex += N;

    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      // CCW from above → normal +Z (matches the +Z attribute we set).
      indices.push(topCentroidIdx, topRingStart + i, topRingStart + next);
    }

    // ── Bottom face: centroid + N perimeter vertices, fan, reversed winding
    const botCentroidIdx = baseIndex;
    positions.push(cx, cy, botZ);
    uvs.push(cx / ASPHALT_TILE_SIZE_M, cy / ASPHALT_TILE_SIZE_M);
    normals.push(0, 0, -1);
    baseIndex += 1;

    const botRingStart = baseIndex;
    for (const v of polygon) {
      positions.push(v[0], v[1], botZ);
      uvs.push(v[0] / ASPHALT_TILE_SIZE_M, v[1] / ASPHALT_TILE_SIZE_M);
      normals.push(0, 0, -1);
    }
    baseIndex += N;

    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      // Reverse winding so normal points -Z (visible from below).
      indices.push(botCentroidIdx, botRingStart + next, botRingStart + i);
    }

    // ── Side walls: one quad per polygon edge ────────────────────────────
    // Each quad needs its own 4 vertices (with outward-facing normals and
    // edge-aligned UVs distinct from the top/bottom planar UVs). Sharing the
    // top/bottom ring vertices would force a single normal per vertex and
    // produce smooth-shaded seams; duplicating gives clean flat side walls.
    let arcSoFar = 0;
    for (let i = 0; i < N; i++) {
      const next = (i + 1) % N;
      const v0 = polygon[i];
      const v1 = polygon[next];
      const ex = v1[0] - v0[0];
      const ey = v1[1] - v0[1];
      const edgeLen = Math.hypot(ex, ey);
      if (edgeLen < 1e-6) continue;

      // Outward-facing normal: 90° CW rotation of the edge direction (because
      // polygon vertices are CCW, the inside is on the left of each edge, so
      // the outside is on the right → CW rotation of the edge tangent).
      const nx = ey / edgeLen;
      const ny = -ex / edgeLen;

      // V coordinate spans 0..(depth / ASPHALT_TILE_SIZE_M) vertically.
      // U spans cumulative arc length so adjacent side quads share their seam UV.
      const u0 = arcSoFar / ASPHALT_TILE_SIZE_M;
      const u1 = (arcSoFar + edgeLen) / ASPHALT_TILE_SIZE_M;
      const vTop = 0;
      const vBot = depth / ASPHALT_TILE_SIZE_M;

      const base = baseIndex;
      // 0: top-left (v0, top)
      positions.push(v0[0], v0[1], topZ);
      uvs.push(u0, vTop);
      normals.push(nx, ny, 0);
      // 1: top-right (v1, top)
      positions.push(v1[0], v1[1], topZ);
      uvs.push(u1, vTop);
      normals.push(nx, ny, 0);
      // 2: bottom-right (v1, bot)
      positions.push(v1[0], v1[1], botZ);
      uvs.push(u1, vBot);
      normals.push(nx, ny, 0);
      // 3: bottom-left (v0, bot)
      positions.push(v0[0], v0[1], botZ);
      uvs.push(u0, vBot);
      normals.push(nx, ny, 0);
      baseIndex += 4;

      // Two triangles, outward-facing.
      // Quad seen from outside: top-left, top-right, bot-right, bot-left.
      // CCW order from outside (outward normal): TL → BL → BR → TR ?
      // Actually: looking from outside, polygon is CCW interior is hidden.
      // Vertices in 3D: TL above v0, TR above v1, BR below v1, BL below v0.
      // From outside (looking inward along -normal), going around CCW:
      //   TL → TR (along top edge to the right)
      //   TR → BR (down)
      //   BR → BL (back to the left)
      //   BL → TL (up)
      // CCW from outside → indices: TL, BL, BR  and  TL, BR, TR
      indices.push(base + 0, base + 3, base + 2);
      indices.push(base + 0, base + 2, base + 1);

      arcSoFar += edgeLen;
    }
  }

  if (indices.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.name = 'road_junctions';

  // Material name is what BeamNG looks up at runtime when binding this mesh
  // to a registered TerrainMaterial — same lookup the OSM DAE pipeline uses.
  const material = new THREE.MeshBasicMaterial({
    name: ASPHALT_MATERIAL_NAME,
    color: 0xffffff,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'road_junctions';

  const group = new THREE.Group();
  group.name = 'road_junctions';
  group.add(mesh);
  return group;
}
