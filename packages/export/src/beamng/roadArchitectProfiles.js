/** @layer core */
// Road Architect profile/layer/node builders: the default urban profile, ped
// crossing + traffic boom layers, crossroads-approach and sidewalk-only
// profiles. Extracted verbatim from exportBeamNGLevel.js (06 step 9).
import { roundTo } from './format.js';
import { geoToWorldPoint } from './worldMath.js';

export function createRoadArchitectDefaultProfile() {
  const persistentBaseLayer = {
    boxXLeft: 1,
    boxXRight: 1,
    boxYLeft: 1,
    boxYRight: 1,
    boxZLeft: 1,
    boxZRight: 1,
    doNotDelete: true,
    extentsH: 1,
    extentsL: 1,
    extentsW: 1,
    fadeE: 0,
    fadeS: 0,
    frame: 0,
    isDisplay: false,
    isHidden: false,
    isSpanLong: true,
    jitter: 0,
    laneMax: 1,
    laneMin: 1,
    latOffset: 0,
    matDisplay: '[None]',
    nMax: 1,
    nMin: 1,
    numCols: 1,
    numRows: 1,
    pos: 0,
    rot: 0,
    size: 3,
    spacing: 5,
    type: 1,
    useWorldZ: false,
    vertOffset: 0,
  };

  const layers = [
    {
      ...persistentBaseLayer,
      isLeft: true,
      isPaint: true,
      isReverse: false,
      lane: -1,
      mat: 'm_line_white',
      name: 'Edge Line L',
      off: 0.25,
      texLen: 5,
      width: 0.25,
    },
    {
      ...persistentBaseLayer,
      isLeft: false,
      isPaint: true,
      isReverse: false,
      lane: 1,
      mat: 'm_line_white',
      name: 'Edge Line R',
      off: -0.25,
      texLen: 5,
      width: 0.25,
    },
    {
      ...persistentBaseLayer,
      isDisplay: true,
      isLeft: true,
      isPaint: false,
      isReverse: true,
      lane: -1,
      mat: 'm_road_asphalt_edge',
      name: 'Edge Blend L',
      off: -0.5,
      texLen: 18,
      width: 2.000000238,
    },
    {
      ...persistentBaseLayer,
      isDisplay: true,
      isLeft: false,
      isPaint: false,
      isReverse: false,
      lane: 1,
      mat: 'm_road_asphalt_edge',
      name: 'Edge Blend R',
      off: 0.5,
      texLen: 18.00003433,
      width: 2.000000238,
    },
    {
      ...persistentBaseLayer,
      isLeft: true,
      isPaint: true,
      isReverse: false,
      lane: 1,
      mat: 'm_line_yellow_double_discontinue',
      name: 'Centerline',
      off: 0,
      texLen: 5,
      width: 0.400000006,
    },
  ];

  return {
    '-1': {
      cornerDrop: 0,
      cornerLatOff: 0,
      heightL: 0.01,
      heightR: 0.01,
      isLeftSide: true,
      kerbWidth: 0.12,
      type: 'road_lane',
      vStart: 0,
      width: 3.5,
    },
    '1': {
      cornerDrop: 0,
      cornerLatOff: 0,
      heightL: 0.01,
      heightR: 0.01,
      isLeftSide: true,
      kerbWidth: 0.12,
      type: 'road_lane',
      vStart: 0,
      width: 3.5,
    },
    autoBankingFactor: 1,
    blendLeftMat: 'm_road_asphalt_edge',
    blendLeftWidth: 1,
    blendRightMat: 'm_road_asphalt_edge',
    blendRightWidth: 1,
    centerlineMat: 'm_line_yellow_double_discontinue',
    class: 'urban',
    condition: 0.3,
    conditionCenterline: true,
    conditionEdgesL: true,
    conditionEdgesR: true,
    conditionEndStopE: true,
    conditionEndStopS: true,
    conditionLaneMarkings: true,
    conditionSeed: 41235,
    continueLinesToEnd: false,
    dirtMat: 'm_dirt_variation_04',
    edgeLineGapL: 0.25,
    edgeLineGapR: 0.25,
    edgeMatL: 'm_line_white',
    edgeMatR: 'm_line_white',
    endStopMatE: 'm_line_white',
    endStopMatS: 'm_line_white',
    fadeE: 0,
    fadeS: 0,
    gutterMargin: 0.02,
    gutterMat: 'gutter1',
    gutterWidth: 0.2,
    isAutoBanking: false,
    isDeletable: true,
    isEdgeBlendL: true,
    isEdgeBlendR: true,
    isExtraWidth: false,
    isGutter: false,
    isGutterShow: false,
    isShowEdgeBlend: true,
    isStopDecalE: false,
    isStopDecalS: false,
    laneMarkingsMat: 'm_line_yellow_discontinue',
    layers,
  };
}

/**
 * Convert a geographic node into one Road Architect node entry.
 */
export function makeRoadArchitectNode(pt, terrainData, squareSize, halfWidth, laneCount) {
  const [x, y, z] = geoToWorldPoint(pt.lat, pt.lng, terrainData, squareSize, 0.1);
  const laneWidth = Math.max(2.6, Math.min(4.5, (halfWidth * 2) / Math.max(1, laneCount)));
  return {
    heightsL: {
      '1': 0.01,
      '-1': 0.01,
    },
    heightsR: {
      '1': 0.01,
      '-1': 0.01,
    },
    incircleRad: 1,
    isAutoBanked: false,
    isLocked: false,
    offset: 0,
    posX: roundTo(x, 6),
    posY: roundTo(y, 6),
    posZ: roundTo(z, 6),
    rot: 0,
    widths: {
      '1': laneWidth,
      '-1': laneWidth,
    },
  };
}

/**
 * Build a stable key for a lat/lng point to support node identity matching.
 */
/**
 * Create a Road Architect profile layer representing a pedestrian crossing.
 */
export function createRoadArchitectPedCrossingLayer(name = 'Ped X - R1') {
  return {
    boxXLeft: 1,
    boxXRight: 1,
    boxYLeft: 1,
    boxYRight: 1,
    boxZLeft: 1,
    boxZRight: 1,
    doNotDelete: true,
    extentsH: 1,
    extentsL: 1,
    extentsW: 1,
    fadeE: 0,
    fadeS: 0,
    frame: 0,
    isDisplay: true,
    isHidden: false,
    isLeft: true,
    isPaint: false,
    isReverse: false,
    isSpanLong: true,
    jitter: 0,
    lane: 1,
    laneMax: 1,
    laneMin: -1,
    latOffset: 0,
    mat: 'crossing_white',
    matDisplay: '[None]',
    nMax: 1,
    nMin: 1,
    name,
    numCols: 0,
    numRows: 0,
    off: 0,
    pos: 0,
    rot: 0,
    size: 0,
    spacing: 0,
    texLen: 5,
    type: 2,
    useWorldZ: false,
    vertOffset: 0,
    width: 2,
  };
}

/**
 * Create a Road Architect profile layer that places a traffic boom object.
 */
export function createRoadArchitectTrafficBoomLayer(name = 'traffic boom A') {
  return {
    boxXLeft: 1,
    boxXRight: 1,
    boxYLeft: 1,
    boxYRight: 1,
    boxZLeft: 1,
    boxZRight: 1,
    doNotDelete: true,
    extentsH: 1,
    extentsL: 1,
    extentsW: 1,
    fadeE: 0,
    fadeS: 0,
    frame: 0,
    isDisplay: true,
    isHidden: false,
    isLeft: true,
    isPaint: false,
    isReverse: false,
    isSpanLong: true,
    jitter: 0,
    lane: -1,
    laneMax: -1,
    laneMin: -1,
    latOffset: 0,
    mat: '/art/shapes/objects/s_trafficlight_boom_sn.dae',
    matDisplay: 's_trafficlight_boom_ns.dae',
    nMax: 1,
    nMin: 1,
    name,
    numCols: 1,
    numRows: 1,
    off: 0,
    pos: 0,
    rot: 3,
    size: 3,
    spacing: 0,
    texLen: 5,
    type: 5,
    useWorldZ: false,
    vertOffset: 0,
    width: 1,
  };
}

/**
 * Build a reduced-marking profile for road approaches at 4-way intersections.
 */
export function createRoadArchitectCrossroadsApproachProfile(pedName) {
  const profile = createRoadArchitectDefaultProfile();
  profile.condition = 0.2;
  profile.conditionCenterline = false;
  profile.conditionEdgesL = false;
  profile.conditionEdgesR = false;
  profile.conditionLaneMarkings = false;
  profile.conditionEndStopE = false;
  profile.conditionEndStopS = false;
  profile.fadeE = 3;
  profile.fadeS = 3;
  profile.isEdgeBlendL = false;
  profile.isEdgeBlendR = false;
  profile.layers = [
    createRoadArchitectPedCrossingLayer(pedName),
    createRoadArchitectTrafficBoomLayer(),
  ];
  return profile;
}

/**
 * Build a profile that emits only sidewalk geometry for intersection corners.
 */
export function createRoadArchitectSidewalkOnlyProfile() {
  return {
    '1': {
      cornerDrop: 0,
      cornerLatOff: 0,
      heightL: 0.01,
      heightR: 0.12,
      isLeftSide: false,
      kerbWidth: 0.12,
      type: 'sidewalk',
      vStart: 0,
      width: 2,
    },
    autoBankingFactor: 1,
    blendLeftMat: 'm_road_asphalt_edge',
    blendLeftWidth: 1,
    blendRightMat: 'm_road_asphalt_edge',
    blendRightWidth: 1,
    centerlineMat: 'm_line_yellow_double_discontinue',
    class: 'urban',
    condition: 0.2,
    conditionCenterline: true,
    conditionEdgesL: true,
    conditionEdgesR: true,
    conditionEndStopE: true,
    conditionEndStopS: true,
    conditionLaneMarkings: true,
    conditionSeed: 41234,
    continueLinesToEnd: false,
    dirtMat: 'm_dirt_variation_04',
    edgeLineGapL: 0.25,
    edgeLineGapR: 0.25,
    edgeMatL: 'm_line_white',
    edgeMatR: 'm_line_white',
    endStopMatE: 'm_line_white',
    endStopMatS: 'm_line_white',
    fadeE: 3,
    fadeS: 3,
    gutterMargin: 0.02,
    gutterMat: 'gutter1',
    gutterWidth: 0.2,
    isAutoBanking: false,
    isDeletable: true,
    isEdgeBlendL: false,
    isEdgeBlendR: false,
    isExtraWidth: false,
    isGutter: false,
    isGutterShow: false,
    isShowEdgeBlend: true,
    isStopDecalE: false,
    isStopDecalS: false,
    laneMarkingsMat: 'm_line_yellow_discontinue',
    layers: {},
    name: 'New Profile',
    numPatches: 2,
    numPotholes: 0,
    stopGapE: 0.2,
    stopGapS: 0.2,
    styleType: 0,
  };
}

/**
 * Create one locked Road Architect node for generated sidewalk arcs.
 */
export function makeRoadArchitectSidewalkNode(worldX, worldY, worldZ) {
  return {
    heightsL: { '1': 0.01 },
    heightsR: { '1': 0.12 },
    incircleRad: 1,
    isAutoBanked: false,
    isLocked: true,
    offset: 0,
    posX: roundTo(worldX, 6),
    posY: roundTo(worldY, 6),
    posZ: roundTo(worldZ, 6),
    rot: 0,
    widths: { '1': 2 },
  };
}
