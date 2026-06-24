/** @layer core */
// DecalRoad geometry: margin clipping, node decimation/offsetting, layered decal
// assembly, and the OSM→DecalRoad generator. Extracted verbatim from
// exportBeamNGLevel.js (06 step 9).
import { buildRoadNetwork } from '@mapng/terrain/roadNetwork';
import { generatePersistentId, geoToWorld } from './worldMath.js';
import {
  ROAD_TEMPLATES,
  HIGHWAY_STYLE,
  DEFAULT_ROAD_STYLE,
  ROAD_SKIP,
  MAJOR_ROAD_MARKINGS,
  UNPAVED_SURFACES,
  shouldUseLaneMarkings,
  shouldUseGrassEdgeBlend,
  shouldGenerateDecalRoads,
  isOneWayRoad,
  estimateRoadHalfWidth,
} from './roadStyle.js';

export const ROAD_EDGE_MARGIN = 0.015; // ≈ 15 m for a 1024-pixel terrain

/**
 * Liang-Barsky clip of segment (u0,v0)→(u1,v1) against the axis-aligned box
 * [lo,hi]×[lo,hi].  Returns [tEnter, tExit] ∈ [0,1] or null if no intersection.
 */
export function lbClip(u0, v0, u1, v1, lo, hi) {
  let tEnter = 0, tExit = 1;
  const du = u1 - u0, dv = v1 - v0;
  for (const [p, q] of [[-du, u0 - lo], [du, hi - u0], [-dv, v0 - lo], [dv, hi - v0]]) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; }
    else if (p < 0) tEnter = Math.max(tEnter, q / p);
    else            tExit  = Math.min(tExit,  q / p);
  }
  return tEnter <= tExit + 1e-12 ? [tEnter, tExit] : null;
}

/** Linearly interpolate between two {lat,lng} points at parameter t. */
export function lerpLatLng(a, b, t) {
  return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) };
}

/**
 * Clip an OSM geometry polyline to the terrain's safe inner boundary (minus
 * ROAD_EDGE_MARGIN on each side).  Returns an array of sub-polylines; each
 * sub-polyline has ≥ 2 points and lies entirely within the margin.
 * Segments that cross the boundary are split and the crossing point added,
 * so roads meet the edge cleanly rather than jumping inward.
 */
export function clipGeometryToMargin(geometry, bounds) {
  const lo = ROAD_EDGE_MARGIN, hi = 1 - ROAD_EDGE_MARGIN;
  const uvOf = pt => [
    (pt.lng  - bounds.west)  / (bounds.east  - bounds.west),
    (bounds.north - pt.lat)  / (bounds.north - bounds.south),
  ];
  const inside = (u, v) => u >= lo && u <= hi && v >= lo && v <= hi;

  const segments = [];
  let current = [];

  for (let i = 0; i < geometry.length; i++) {
    const pt = geometry[i];
    const [u, v] = uvOf(pt);
    const inNow = inside(u, v);

    if (i === 0) {
      if (inNow) current.push(pt);
      continue;
    }

    const prev  = geometry[i - 1];
    const [pu, pv] = uvOf(prev);
    const inPrev = inside(pu, pv);

    if (inPrev && inNow) {
      // Both inside — normal case.
      current.push(pt);
    } else if (inPrev && !inNow) {
      // Exiting: add the exit point on the margin boundary, then break.
      const clip = lbClip(pu, pv, u, v, lo, hi);
      if (clip) current.push(lerpLatLng(prev, pt, clip[1]));
      if (current.length >= 2) segments.push(current);
      current = [];
    } else if (!inPrev && inNow) {
      // Entering: start new segment at the entry point on the margin boundary.
      const clip = lbClip(pu, pv, u, v, lo, hi);
      current = [clip ? lerpLatLng(prev, pt, clip[0]) : pt, pt];
    } else {
      // Both outside: the segment might still pass through the box.
      const clip = lbClip(pu, pv, u, v, lo, hi);
      if (clip) {
        if (current.length >= 2) segments.push(current);
        segments.push([lerpLatLng(prev, pt, clip[0]), lerpLatLng(prev, pt, clip[1])]);
        current = [];
      }
    }
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}

/**
 * Split a polyline (array of points) into chunks of at most maxNodes nodes.
 * Adjacent chunks overlap by one node so there is no visible gap between the
 * resulting DecalRoad objects.
 */
export function chunkPolyline(points, maxNodes = 50) {
  if (points.length <= maxNodes) return [points];
  const chunks = [];
  for (let i = 0; i < points.length - 1; i += maxNodes - 1) {
    chunks.push(points.slice(i, i + maxNodes));
  }
  return chunks;
}

// Minimum world-space distance (metres) between consecutive DecalRoad nodes.
// OSM data can have nodes every 1–2 m in urban areas; at that density, BeamNG's
// spline creates visible facets between every pair of nodes.  Decimating to a
// coarser spacing lets the spline interpolate a smooth curve instead.
export const MIN_NODE_SPACING_M = 4.0;

/**
 * Remove DecalRoad nodes that are closer than MIN_NODE_SPACING_M to the
 * previous kept node (measured in XY world-space metres).  Always keeps the
 * first and last node so the road reaches its endpoints exactly.
 */
export function decimateNodes(nodes) {
  if (nodes.length <= 2) return nodes;
  const out = [nodes[0]];
  for (let i = 1; i < nodes.length - 1; i++) {
    const prev = out[out.length - 1];
    const dx = nodes[i][0] - prev[0];
    const dy = nodes[i][1] - prev[1];
    if (Math.sqrt(dx * dx + dy * dy) >= MIN_NODE_SPACING_M) {
      out.push(nodes[i]);
    }
  }
  out.push(nodes[nodes.length - 1]);
  return out;
}

/**
 * Create a parallel offset of road nodes in world-space.
 *
 * Input and output node format: [x, y, z, halfWidth].
 */
export function offsetNodes(nodes, offset, halfWidth) {
  if (nodes.length < 2) return [];
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const prev = nodes[Math.max(0, i - 1)];
    const next = nodes[Math.min(nodes.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dy = next[1] - prev[1];

    const len = Math.hypot(dx, dy);
    const nx = len > 1e-6 ? -dy / len : 0;
    const ny = len > 1e-6 ? dx / len : 0;
    out.push([
      Math.round((nodes[i][0] + nx * offset) * 1000) / 1000,
      Math.round((nodes[i][1] + ny * offset) * 1000) / 1000,
      nodes[i][2],
      halfWidth,
    ]);
  }
  return decimateNodes(out);
}

/**
 * Build one BeamNG DecalRoad object from prepared spline nodes and style props.
 */
export function makeRoadDecal(nodes, name, parentName, props, materialOverride) {
  if (nodes.length < 2) return null;
  const decal = {
    name,
    class: 'DecalRoad',
    persistentId: generatePersistentId(),
    __parent: parentName || 'Decal_roads',
    position: [nodes[0][0], nodes[0][1], nodes[0][2]],
    improvedSpline: true,
    material: materialOverride || props.material,
    nodes,
    breakAngle: props.breakAngle,
    renderPriority: props.renderPriority,
    textureLength: props.textureLength,
    startEndFade: props.startEndFade,
  };
  if (Number.isFinite(props.detail)) decal.detail = props.detail;
  return decal;
}

export function maybeReverseDecalNodes(nodes, layer) {
  if (!Array.isArray(nodes) || nodes.length < 2) return nodes;
  if (!layer?.mirrorByReversingNodes) return nodes;
  return [...nodes].reverse();
}

export function getLayeredRoadDecals(centerNodes, highway, tags, styleHalfWidth, parentName) {
  const isUnpaved = UNPAVED_SURFACES.has(tags.surface) || highway === 'track';
  const laneMarkingsEnabled = shouldUseLaneMarkings(highway, tags);
  const grassEdgeBlendEnabled = shouldUseGrassEdgeBlend(highway, tags);
  const majorRoad = MAJOR_ROAD_MARKINGS.has(highway);

  let templateKey = 'default';
  if (isUnpaved) templateKey = 'unpaved';
  else if (majorRoad && laneMarkingsEnabled) templateKey = 'major';
  else if (laneMarkingsEnabled) templateKey = 'minor';

  const layers = (ROAD_TEMPLATES[templateKey] || ROAD_TEMPLATES.default).filter((layer) => {
    if (layer.name.startsWith('edge_')) return grassEdgeBlendEnabled;
    if (layer.name.startsWith('line_')) return laneMarkingsEnabled;
    return true;
  });
  const decals = [];

  for (const layer of layers) {
    let offset = layer.offset;
    let width = layer.width || (styleHalfWidth * (layer.widthScale || 1.0));

    // Handle offsets relative to the road edge (typical for line markings)
    if (layer.isEdgeRelative) {
      // Offset is multiplier of styleHalfWidth
      offset = layer.offset * styleHalfWidth;
    } else if (layer.isEdge) {
      // Keep the hard edge close to the pavement and let the soft fade run outward.
      offset = layer.offset * (styleHalfWidth + (width / 2) - 0.15);
    }

    const layeredNodes = maybeReverseDecalNodes(offsetNodes(centerNodes, offset, width), layer);
    if (layeredNodes.length < 2) continue;

    // Use names that the BeamNG Road Spline Tool recognizes.
    let levelName = 'Layer';
    if (layer.name === 'asphalt' || layer.name === 'dirt') levelName = 'Base';
    else if (layer.name === 'line_center') levelName = 'Center Line';
    else if (layer.name === 'line_left') levelName = 'Edge Line - Left';
    else if (layer.name === 'line_right') levelName = 'Edge Line - Right';
    else if (layer.name === 'edge_left') levelName = 'Edge Blend - Left';
    else if (layer.name === 'edge_right') levelName = 'Edge Blend - Right';

    const decal = makeRoadDecal(layeredNodes, levelName, parentName, {
      material: layer.material,
      renderPriority: layer.priority,
      breakAngle: 1.0,
      textureLength: 5,
      startEndFade: [1, 1],
      detail: 0.1,
    });

    if (decal) decals.push(decal);
  }

  return decals;
}

/**
 * Convert OSM road features to BeamNG DecalRoad marking/edge objects.
 *
 * Each OSM way is clipped to the terrain's safe inner boundary before export.
 * Ways that cross the boundary are split into multiple DecalRoads at the
 * crossing point, so no node lands outside or too near the TerrainBlock edge
 * (which causes BeamNG's improvedSpline to float those segments in the air).
 *
 * DecalRoad nodes format: [x, y, z, halfWidth].
 *
 * Returns an empty array when no OSM data is available.
 */
export function generateDecalRoads(terrainData, squareSize) {
  if (!terrainData.osmFeatures?.length) return [];

  const roadNetwork = buildRoadNetwork(terrainData.osmFeatures.filter((feature) => {
    if (feature?.type !== 'road' || !feature.geometry?.length) return false;
    const highway = feature.tags?.highway;
    return !!highway && !ROAD_SKIP.has(highway);
  }));

  const roadSplinesByName = new Map();
  const segmentCounterByName = new Map();

  const getOrCreateSplineGroup = (groupName) => {
    if (roadSplinesByName.has(groupName)) return roadSplinesByName.get(groupName);
    const group = {
      class: 'SimGroup',
      name: groupName,
      persistentId: generatePersistentId(),
      __parent: 'Decal_Roads',
      __items: [],
    };
    roadSplinesByName.set(groupName, group);
    return group;
  };

  for (const segmentFeature of roadNetwork.segments) {
    const feature = segmentFeature.sourceFeature;
    const highway = segmentFeature.highway;
    if (!shouldGenerateDecalRoads(highway, feature.tags || {})) continue;
    const rawName = feature.tags?.name || feature.tags?.ref || `Road_${feature.id}`;
    const cleanName = rawName.replace(/[^\w\s-]/g, '').trim() || `Road_${feature.id}`;

    const style = HIGHWAY_STYLE[highway] ?? DEFAULT_ROAD_STYLE;
    const isOneWay = isOneWayRoad(feature.tags || {});
    const styleHalfWidth = estimateRoadHalfWidth(feature.tags || {}, highway, isOneWay, style.width);

    // Clip to the terrain's safe inner boundary, splitting at crossings.
    // Then further chunk each segment so no single DecalRoad is too long.
    const clippedSegments = clipGeometryToMargin(segmentFeature.geometry, terrainData.bounds)
      .flatMap(s => chunkPolyline(s));

    if (clippedSegments.length === 0) continue;

    const splineGroup = getOrCreateSplineGroup(cleanName);

    for (let i = 0; i < clippedSegments.length; i++) {
      const segment = clippedSegments[i];
      const rawNodes = [];
      for (const pt of segment) {
        const [wx, wy, wz] = geoToWorld(pt.lat, pt.lng, terrainData, squareSize, 0.1);
        rawNodes.push([
          Math.round(wx * 1000) / 1000,
          Math.round(wy * 1000) / 1000,
          Math.round(wz * 1000) / 1000,
          styleHalfWidth,
        ]);
      }

      const centerNodes = decimateNodes(rawNodes);
      if (centerNodes.length < 2) continue;

      const layeredDecals = getLayeredRoadDecals(
        centerNodes,
        highway,
        feature.tags || {},
        styleHalfWidth,
        cleanName
      );

      if (layeredDecals.length > 0) {
        const segCount = (segmentCounterByName.get(cleanName) || 0) + 1;
        segmentCounterByName.set(cleanName, segCount);
        const nameSuffix = `S${segCount}`;
        const roadNamePrefix = cleanName.replace(/\s+/g, '_');
        for (let d = 0; d < layeredDecals.length; d++) {
          const decal = layeredDecals[d];
          decal.name = `${roadNamePrefix}__${decal.name}__${nameSuffix}__L${d + 1}`;
          splineGroup.__items.push(decal);
        }
      }
    }
  }

  return Array.from(roadSplinesByName.values()).filter((g) => g.__items.length > 0);
}
