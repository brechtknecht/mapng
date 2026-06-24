/** @layer core */
// Road Architect session assembly: builds the plugin session JSON (roads,
// profiles, placedGroups) from clipped OSM roads, and decorates four-way
// intersections with approach profiles + sidewalk arcs. Extracted verbatim
// from exportBeamNGLevel.js (06 step 9).
import { buildRoadNetwork } from '@mapng/terrain/roadNetwork';
import { normalize2D, generatePersistentId } from './worldMath.js';
import {
  createRoadArchitectCrossroadsApproachProfile,
  makeRoadArchitectSidewalkNode,
  createRoadArchitectSidewalkOnlyProfile,
  createRoadArchitectDefaultProfile,
  makeRoadArchitectNode,
} from './roadArchitectProfiles.js';
import {
  ROAD_SKIP,
  HIGHWAY_STYLE,
  DEFAULT_ROAD_STYLE,
  isOneWayRoad,
  estimateRoadHalfWidth,
  getDefaultLaneCount,
} from './roadStyle.js';
import { clipGeometryToMargin, chunkPolyline } from './decalRoads.js';
import { sanitizeRoadFolderName } from './levelZip.js';

/**
 * Decorate four-way intersections with approach profiles and sidewalk arcs.
 *
 * Returns extra sidewalk roads and the next available sidewalk index counter.
 */
export function enrichRoadArchitectCrossroads(roads, intersectionEntries, startSidewalkIndex = 1) {
  if (!Array.isArray(roads) || !intersectionEntries || intersectionEntries.size === 0) {
    return { sidewalkRoads: [], nextSidewalkIndex: startSidewalkIndex };
  }

  const sidewalkRoads = [];
  let sidewalkIndex = startSidewalkIndex;

  for (const entries of intersectionEntries.values()) {
    const uniqueByRoad = new Map();
    for (const entry of entries) {
      if (!uniqueByRoad.has(entry.roadIndex)) uniqueByRoad.set(entry.roadIndex, entry);
    }
    const candidates = Array.from(uniqueByRoad.values());
    if (candidates.length < 4) continue;

    const selected = candidates.slice(0, 4);

    for (let i = 0; i < selected.length; i++) {
      const sel = selected[i];
      const road = roads[sel.roadIndex];
      if (!road) continue;
      road.profile = createRoadArchitectCrossroadsApproachProfile(`Ped X - R${i + 1}`);

      const nodes = road.nodes;
      if (Array.isArray(nodes) && nodes.length >= 2) {
        if (sel.endpoint === 'start') nodes[0].isLocked = true;
        else nodes[nodes.length - 1].isLocked = true;
      }
    }

    const centerX = selected.reduce((sum, sel) => sum + sel.endX, 0) / selected.length;
    const centerY = selected.reduce((sum, sel) => sum + sel.endY, 0) / selected.length;
    const centerZ = selected.reduce((sum, sel) => sum + sel.endZ, 0) / selected.length;
    const laneHalf = selected.reduce((sum, sel) => sum + sel.laneHalfWidth, 0) / selected.length;
    const sidewalkRadius = Math.max(4.5, laneHalf + 2.5);

    selected.sort((a, b) => Math.atan2(a.dirY, a.dirX) - Math.atan2(b.dirY, b.dirX));

    for (let i = 0; i < selected.length; i++) {
      const a = selected[i];
      const b = selected[(i + 1) % selected.length];
      const ax = centerX + a.dirX * sidewalkRadius;
      const ay = centerY + a.dirY * sidewalkRadius;
      const bx = centerX + b.dirX * sidewalkRadius;
      const by = centerY + b.dirY * sidewalkRadius;
      const bis = normalize2D(a.dirX + b.dirX, a.dirY + b.dirY);
      const mx = centerX + bis.x * sidewalkRadius * 1.2;
      const my = centerY + bis.y * sidewalkRadius * 1.2;

      sidewalkRoads.push({
        bridgeArch: -6,
        bridgeDepth: 4,
        bridgeWidth: 5.5,
        displayName: `Crossroads Sidewalk ${sidewalkIndex++}`,
        extraE: 2,
        extraS: 2,
        forceField: 1,
        granFactor: 2,
        groupIdx: {},
        isAllowTunnels: false,
        isArc: true,
        isBridge: false,
        isCivilEngRoads: false,
        isConformRoadToTerrain: false,
        isDisplayLaneInfo: true,
        isDisplayNodeNumbers: false,
        isDisplayNodeSpheres: true,
        isDisplayRefLine: true,
        isDisplayRoadOutline: true,
        isDisplayRoadSurface: true,
        isDrivable: false,
        isHidden: false,
        isJctRoad: false,
        isOverObject: true,
        isOverlay: false,
        isRigidTranslation: false,
        isVis: true,
        name: generatePersistentId(),
        nodes: [
          makeRoadArchitectSidewalkNode(ax, ay, centerZ),
          makeRoadArchitectSidewalkNode(mx, my, centerZ),
          makeRoadArchitectSidewalkNode(bx, by, centerZ),
        ],
        overlayMat: 'm_tread_marks_clean',
        profile: createRoadArchitectSidewalkOnlyProfile(),
        protrudeE: 0,
        protrudeS: 0,
        radGran: 15,
        radOffset: 0,
        thickness: 1,
        treatAsInvisibleInEdit: false,
        zOffsetFromRoad: 0,
      });
    }
  }

  return { sidewalkRoads, nextSidewalkIndex: sidewalkIndex };
}

/**
 * Build a Road Architect session JSON object from clipped OSM roads.
 *
 * The output matches the plugin session schema under `data.{roads,profiles,...}`
 * and is written into the exported level so users can edit generated roads in
 * BeamNG's Road Architect tools.
 */
export function generateRoadArchitectSession(terrainData, squareSize, levelName) {
  if (!terrainData?.osmFeatures?.length) return null;

  const roadNetwork = buildRoadNetwork(terrainData.osmFeatures.filter((feature) => {
    if (feature?.type !== 'road' || !Array.isArray(feature.geometry) || feature.geometry.length < 2) return false;
    const highway = feature.tags?.highway;
    return !!highway && !ROAD_SKIP.has(highway);
  }));

  const fourWayNodeKeys = new Set();
  for (const [nodeKey, entries] of roadNetwork.intersections.entries()) {
    const uniqueSegments = new Set(entries.map((entry) => entry.road.id));
    if (uniqueSegments.size >= 4) fourWayNodeKeys.add(nodeKey);
  }

  const roads = [];
  const intersectionEntries = new Map();

  for (const segmentFeature of roadNetwork.segments) {
    const feature = segmentFeature.sourceFeature;
    const tags = feature.tags || {};
    const highway = segmentFeature.highway;

    const style = HIGHWAY_STYLE[highway] ?? DEFAULT_ROAD_STYLE;
    const isOneWay = isOneWayRoad(tags);
    const halfWidth = estimateRoadHalfWidth(tags, highway, isOneWay, style.width);
    const laneCount = Math.max(1, getDefaultLaneCount(highway, isOneWay));
    const clippedSegments = clipGeometryToMargin(segmentFeature.geometry, terrainData.bounds)
      .flatMap((segment) => chunkPolyline(segment, 80));

    for (let segmentIndex = 0; segmentIndex < clippedSegments.length; segmentIndex++) {
      const segment = clippedSegments[segmentIndex];
      const nodes = segment.map((pt) => makeRoadArchitectNode(pt, terrainData, squareSize, halfWidth, laneCount));
      if (nodes.length < 2) continue;

      const roadIndex = roads.length;

      roads.push({
        bridgeArch: 0,
        bridgeDepth: 8,
        bridgeWidth: 8,
        displayName: String(tags.name || `${highway}_${roads.length + 1}`),
        extraE: 0,
        extraS: 0,
        forceField: 1.0,
        granFactor: 1,
        groupIdx: [],
        isAllowTunnels: false,
        isArc: false,
        isBridge: false,
        isCivilEngRoads: false,
        isConformRoadToTerrain: true,
        isDisplayLaneInfo: true,
        isDisplayNodeNumbers: false,
        isDisplayNodeSpheres: true,
        isDisplayRefLine: true,
        isDisplayRoadOutline: true,
        isDisplayRoadSurface: true,
        isDrivable: true,
        isHidden: false,
        isJctRoad: false,
        isOverObject: true,
        isOverlay: false,
        isRigidTranslation: false,
        isVis: true,
        name: generatePersistentId(),
        nodes,
        overlayMat: 'm_tread_marks_clean',
        profile: createRoadArchitectDefaultProfile(),
        protrudeE: 0,
        protrudeS: 0,
        radGran: 15,
        radOffset: 0,
        thickness: 1.0,
        treatAsInvisibleInEdit: false,
        zOffsetFromRoad: 0,
      });

      /**
       * Register one road endpoint as a candidate 4-way intersection approach.
       */
        const addIntersectionEntry = (nodeKey, endpoint) => {
        if (!fourWayNodeKeys.has(nodeKey)) return;
        const road = roads[roadIndex];
        if (!road || !Array.isArray(road.nodes) || road.nodes.length < 2) return;
        const endNode = endpoint === 'start' ? road.nodes[0] : road.nodes[road.nodes.length - 1];
        const nearNode = endpoint === 'start' ? road.nodes[1] : road.nodes[road.nodes.length - 2];
        const dir = endpoint === 'start'
          ? normalize2D(nearNode.posX - endNode.posX, nearNode.posY - endNode.posY)
          : normalize2D(endNode.posX - nearNode.posX, endNode.posY - nearNode.posY);
        const list = intersectionEntries.get(nodeKey) || [];
        list.push({
          roadIndex,
          endpoint,
          dirX: dir.x,
          dirY: dir.y,
          endX: endNode.posX,
          endY: endNode.posY,
          endZ: endNode.posZ,
          laneHalfWidth: Number(endNode?.widths?.['1']) || 3.5,
        });
        intersectionEntries.set(nodeKey, list);
      };

      if (segmentIndex === 0) addIntersectionEntry(segmentFeature.startKey, 'start');
      if (segmentIndex === clippedSegments.length - 1) addIntersectionEntry(segmentFeature.endKey, 'end');
    }
  }

  if (roads.length === 0) return null;

  const usedGroupNames = new Map();
  const placedGroups = roads.map((road, index) => {
    const baseName = sanitizeRoadFolderName(road?.displayName, `road_${index + 1}`);
    const used = usedGroupNames.get(baseName) || 0;
    usedGroupNames.set(baseName, used + 1);
    const groupName = used > 0 ? `${baseName}_${used + 1}` : baseName;
    const groupIndex = index + 1;
    road.groupIdx = [groupIndex];

    return {
      name: groupName,
      list: road.nodes.map((_, nodeIndex) => ({ r: road.name, n: nodeIndex + 1 })),
    };
  });

  return {
    data: {
      groups: [],
      junctions: [],
      mapName: String(levelName || 'mapng').toLowerCase(),
      placedGroups,
      profiles: [createRoadArchitectDefaultProfile()],
      roads,
    },
  };
}
