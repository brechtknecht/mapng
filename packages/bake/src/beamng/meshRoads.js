/** @layer core */
// MeshRoad emission: per-segment world-space prep, full junction analysis, and
// the junction-aware MeshRoad generator (clip-back, decimate, prune, balance,
// smooth, resample). Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import { buildRoadNetwork } from '../roadNetwork.js';
import {
  analyzeJunctions,
  clipPolylineEnds,
  pruneShortEndEdges,
  balanceEndEdges,
  smoothSharpKinks,
  uniformResamplePolyline,
  MESH_ROAD_SURFACE_LIFT,
  MESH_ROAD_DEPTH,
  JUNCTION_COLLISION_OVERLAP,
  MIN_MESH_ROAD_LENGTH,
} from '../junctionGeometry.js';
import { geoToWorld, generatePersistentId } from './worldMath.js';
import {
  HIGHWAY_STYLE,
  DEFAULT_ROAD_STYLE,
  isOneWayRoad,
  estimateRoadHalfWidth,
  ROAD_SKIP,
} from './roadStyle.js';
import { clipGeometryToMargin, chunkPolyline, decimateNodes } from './decalRoads.js';

export function buildSegmentWorldInfo(roadNetwork, terrainData, squareSize) {
  const out = new Map();
  for (const segment of roadNetwork.segments) {
    const feature = segment.sourceFeature;
    const tags = feature?.tags || {};
    const highway = segment.highway;
    const style = HIGHWAY_STYLE[highway] ?? DEFAULT_ROAD_STYLE;
    const isOneWay = isOneWayRoad(tags);
    const halfWidth = estimateRoadHalfWidth(tags, highway, isOneWay, style.width);

    const worldGeometry = segment.geometry.map((pt) => {
      const [wx, wy, wz] = geoToWorld(pt.lat, pt.lng, terrainData, squareSize, 0);
      return [wx, wy, wz + MESH_ROAD_SURFACE_LIFT];
    });

    out.set(segment.id, { worldGeometry, halfWidth, feature });
  }
  return out;
}

/**
 * Run the full junction analysis (network → per-junction polygons + per-end
 * clip-back amounts), merge nearby clusters, and return everything the
 * downstream MeshRoad and TSStatic emitters need.
 */
export function buildMeshRoadAnalysis(terrainData, squareSize) {
  if (!terrainData?.osmFeatures?.length) {
    return { roadNetwork: null, segmentInfo: new Map(), segmentClips: new Map() };
  }
  const roadNetwork = buildRoadNetwork(terrainData.osmFeatures.filter((feature) => {
    if (feature?.type !== 'road' || !Array.isArray(feature.geometry) || feature.geometry.length < 2) return false;
    const highway = feature.tags?.highway;
    return !!highway && !ROAD_SKIP.has(highway);
  }));

  const segmentInfo = buildSegmentWorldInfo(roadNetwork, terrainData, squareSize);
  const segmentClips = analyzeJunctions(roadNetwork, segmentInfo);

  return { roadNetwork, segmentInfo, segmentClips };
}

/**
 * Convert OSM road features to BeamNG MeshRoad objects, clipped back at each
 * junction so adjacent MeshRoads leave a gap that the junction prism fills.
 *
 * Pipeline per piece (after clipGeometryToMargin + chunkPolyline):
 *   1. world-space conversion with explicit MESH_ROAD_SURFACE_LIFT
 *   2. clipPolylineEnds — applied only on piece ends that match the segment's
 *      original lat/lng; the trim amount is reduced by
 *      JUNCTION_COLLISION_OVERLAP so the MeshRoad extends slightly into the
 *      prism (avoids coplanar collision instakill).
 *   3. decimateNodes (4 m minimum spacing)
 *   4. pruneShortEndEdges (iterative)
 *   5. balanceEndEdges (iterative ratio + kink test)
 *   6. min-length filter
 *   7. smoothSharpKinks (adaptive)
 *   8. uniformResamplePolyline (4 m) — fixes Catmull-Rom tangent overshoot
 *
 * Node format: [x, y, z, fullWidth, depth, nx, ny, nz].
 */
export function generateMeshRoads(terrainData, squareSize, analysis) {
  if (!terrainData?.osmFeatures?.length) return { meshRoads: [], junctionEndpoints: new Map() };
  const ctx = analysis || buildMeshRoadAnalysis(terrainData, squareSize);
  const { roadNetwork, segmentClips } = ctx;
  if (!roadNetwork) return { meshRoads: [], junctionEndpoints: new Map() };

  const meshRoads = [];
  const junctionEndpoints = new Map();
  let roadIndex = 0;

  const sameLatLng = (a, b) => a && b && a.lat === b.lat && a.lng === b.lng;

  for (const segment of roadNetwork.segments) {
    const feature = segment.sourceFeature;
    const tags = feature?.tags || {};
    const highway = segment.highway;
    if (!highway || ROAD_SKIP.has(highway)) continue;

    const style = HIGHWAY_STYLE[highway] ?? DEFAULT_ROAD_STYLE;
    const isOneWay = isOneWayRoad(tags);
    const halfWidth = estimateRoadHalfWidth(tags, highway, isOneWay, style.width);
    const fullWidth = halfWidth * 2;

    const clip = segmentClips.get(segment.id) || { start: 0, end: 0 };
    const segStartPt = segment.geometry[0];
    const segEndPt = segment.geometry[segment.geometry.length - 1];

    const clippedSegments = clipGeometryToMargin(segment.geometry, terrainData.bounds)
      .flatMap((s) => chunkPolyline(s));

    for (const piece of clippedSegments) {
      const pieceStartPt = piece[0];
      const pieceEndPt = piece[piece.length - 1];
      const applyStartClip = sameLatLng(pieceStartPt, segStartPt) && clip.start > 0;
      const applyEndClip = sameLatLng(pieceEndPt, segEndPt) && clip.end > 0;

      const rawNodes = piece.map((pt) => {
        const [wx, wy, wz] = geoToWorld(pt.lat, pt.lng, terrainData, squareSize, 0);
        return [
          wx,
          wy,
          wz + MESH_ROAD_SURFACE_LIFT,
          fullWidth,
          MESH_ROAD_DEPTH,
          0, 0, 1,
        ];
      });

      const startTrim = applyStartClip ? Math.max(0, clip.start - JUNCTION_COLLISION_OVERLAP) : 0;
      const endTrim = applyEndClip ? Math.max(0, clip.end - JUNCTION_COLLISION_OVERLAP) : 0;
      let nodes = clipPolylineEnds(rawNodes, startTrim, endTrim);
      if (nodes.length < 2) continue;

      // Round positions to mm after clipping so interpolated nodes are stable.
      nodes = nodes.map((n) => [
        Math.round(n[0] * 1000) / 1000,
        Math.round(n[1] * 1000) / 1000,
        Math.round(n[2] * 1000) / 1000,
        n[3], n[4], n[5], n[6], n[7],
      ]);

      // decimateNodes operates on [x,y,z,w] — strip then reattach depth/normal.
      const decStripped = decimateNodes(nodes.map((n) => [n[0], n[1], n[2], n[3]]));
      if (decStripped.length < 2) continue;
      nodes = decStripped.map((n) => [n[0], n[1], n[2], n[3], MESH_ROAD_DEPTH, 0, 0, 1]);

      nodes = pruneShortEndEdges(nodes);
      if (nodes.length < 2) continue;
      nodes = balanceEndEdges(nodes);
      if (nodes.length < 2) continue;

      // Drop tiny roads that can't render meaningfully.
      let totalLen = 0;
      for (let i = 1; i < nodes.length; i++) {
        const dx = nodes[i][0] - nodes[i - 1][0];
        const dy = nodes[i][1] - nodes[i - 1][1];
        totalLen += Math.sqrt(dx * dx + dy * dy);
      }
      if (totalLen < MIN_MESH_ROAD_LENGTH) continue;

      nodes = smoothSharpKinks(nodes);
      if (nodes.length < 2) continue;
      nodes = uniformResamplePolyline(nodes);
      if (nodes.length < 2) continue;

      // Reattach depth and normal after the final resample (interpolation will
      // have averaged them but explicit values keep the JSON output clean).
      nodes = nodes.map((n) => [n[0], n[1], n[2], n[3], MESH_ROAD_DEPTH, 0, 0, 1]);

      // Record the actual post-pipeline endpoint for each junction-touching end
      // so buildJunctionPolygons can use the exact MeshRoad cross-section position.
      if (applyStartClip && nodes.length >= 2) {
        const dx = nodes[1][0] - nodes[0][0];
        const dy = nodes[1][1] - nodes[0][1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          junctionEndpoints.set(`${segment.id}|start`, {
            pos: [nodes[0][0], nodes[0][1], nodes[0][2]],
            outbound: [dx / len, dy / len],
            halfWidth: nodes[0][3] / 2,
          });
        }
      }
      if (applyEndClip && nodes.length >= 2) {
        const last = nodes.length - 1;
        const dx = nodes[last - 1][0] - nodes[last][0];
        const dy = nodes[last - 1][1] - nodes[last][1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 0) {
          junctionEndpoints.set(`${segment.id}|end`, {
            pos: [nodes[last][0], nodes[last][1], nodes[last][2]],
            outbound: [dx / len, dy / len],
            halfWidth: nodes[last][3] / 2,
          });
        }
      }

      meshRoads.push({
        class: 'MeshRoad',
        name: `MeshRoad_${roadIndex++}`,
        persistentId: generatePersistentId(),
        __parent: 'Mesh_roads',
        position: [nodes[0][0], nodes[0][1], nodes[0][2]],
        topMaterial: 'm_asphalt_new_01',
        sideMaterial: 'm_asphalt_new_01',
        bottomMaterial: 'm_asphalt_new_01',
        textureLength: 16,
        nodes,
      });
    }
  }

  return { meshRoads, junctionEndpoints };
}
