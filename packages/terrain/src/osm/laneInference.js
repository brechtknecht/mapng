/** @layer core */
// Pure lane-layout inference + marking styles for the OSM road texture painter
// (refactor doc 06 step 6). Tags → a lane layout (widths, offsets, marking
// colours) following OSM2World conventions. Moved verbatim from osmTexture.js.
import { getEffectiveRoadLayer } from "../roadNetwork.js";
import { COLORS } from "./osmColors.js";

/**
 * Determine if a road surface is "unmarked" (no lane markings).
 * Follows OSM2World: gravel, earth, sand, dirt, grass, etc. get no markings.
 */
const isUnmarkedSurface = (tags) => {
  const surface = tags.surface;
  if (tags.lane_markings === "no") return true;
  if (tags.lane_markings === "yes") return false;
  const unmarkedSurfaces = [
    "gravel", "dirt", "earth", "ground", "grass", "sand", "mud",
    "unpaved", "compacted", "fine_gravel", "pebblestone", "rock", "snow", "ice",
  ];
  if (surface && unmarkedSurfaces.includes(surface)) return true;
  // Tracks are typically unmarked unless explicitly tagged
  if (tags.highway === "track") return true;
  return false;
};

/**
 * Determine the center line marking style based on road classification.
 * Based on OSM2World's approach + real-world conventions:
 *  - Motorways/trunks: solid white edge lines, white dashed lane separators
 *  - Primary/secondary with 2+ lanes each direction: double yellow
 *  - Tertiary/unclassified 2-lane undivided: dashed yellow (passing allowed)
 *  - Residential/service: no center line (unless 4+ lanes)
 *  - One-way: no center divider at all
 */
const getCenterLineStyle = (tags, lanesTotal, isOneWay) => {
  if (isOneWay) return null;

  const highway = tags.highway;

  // Link roads / ramps typically do not carry centerline markings in map textures.
  if (typeof highway === "string" && highway.endsWith("_link")) {
    return null;
  }

  // Motorways use white markings, not yellow
  if (highway === "motorway" || highway === "trunk" ||
      highway === "motorway_link" || highway === "trunk_link") {
    return { color: COLORS.markingWhite, style: "solid", double: false };
  }

  // Major roads (primary/secondary) with enough lanes → double yellow
  if (highway === "primary" || highway === "secondary" ||
      highway === "primary_link" || highway === "secondary_link") {
    if (lanesTotal >= 4) {
      return { color: COLORS.markingYellow, style: "solid", double: true };
    }
    // 2-lane primary/secondary → dashed yellow (passing zone)
    return { color: COLORS.markingYellow, style: "dashed", double: false };
  }

  // Tertiary → dashed yellow center line
  if (highway === "tertiary" || highway === "tertiary_link") {
    return { color: COLORS.markingYellow, style: "dashed", double: false };
  }

  // Residential/unclassified — only mark if 4+ lanes
  if (highway === "residential" || highway === "unclassified") {
    if (lanesTotal >= 4) {
      return { color: COLORS.markingYellow, style: "dashed", double: false };
    }
    return null; // no center line
  }

  // Service roads → no center line
  return null;
};

/**
 * Determine edge line style. Motorways/trunks get solid white edge lines.
 * Primary/secondary get thin white edge lines.
 */
const getEdgeLineStyle = (tags) => {
  const highway = tags.highway;
  if (highway === "motorway" || highway === "trunk" ||
      highway === "motorway_link" || highway === "trunk_link") {
    return { color: COLORS.markingWhite, width: 0.15 };
  }
  if (highway === "primary" || highway === "secondary") {
    return { color: COLORS.markingWhite, width: 0.1 };
  }
  return null;
};

const parseNumeric = (value) => {
  if (value == null) return null;
  const num = Number.parseFloat(String(value).trim());
  return Number.isFinite(num) ? num : null;
};

const parsePositiveInt = (value) => {
  if (value == null) return null;
  const num = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(num) && num > 0 ? num : null;
};

const countLanesFromDelimited = (value) => {
  if (!value) return null;
  const tokens = String(value)
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  return tokens.length > 0 ? tokens.length : null;
};

const parseWidthMeters = (value) => {
  if (!value) return null;
  const raw = String(value).trim().toLowerCase();

  if (raw.includes("ft")) {
    const n = parseNumeric(raw.replace("ft", "").trim());
    return n != null ? n * 0.3048 : null;
  }

  if (raw.includes("m")) {
    return parseNumeric(raw.replace("m", "").trim());
  }

  const plain = parseNumeric(raw);
  if (plain == null) return null;

  // Heuristic: values > 40 are usually feet when no unit is provided.
  return plain > 40 ? plain * 0.3048 : plain;
};

export const getDefaultLaneWidth = (highway) => {
  if (["motorway", "motorway_link", "trunk", "trunk_link"].includes(highway)) {
    return 3.7;
  }
  if (["primary", "primary_link", "secondary", "secondary_link"].includes(highway)) {
    return 3.5;
  }
  if (["tertiary", "tertiary_link"].includes(highway)) {
    return 3.25;
  }
  if (["residential", "unclassified", "living_street"].includes(highway)) {
    return 3.0;
  }
  if (["service"].includes(highway)) {
    return 2.8;
  }
  return 3.0;
};

const getMaxReasonableLanes = (highway, isOneWay) => {
  if (["motorway", "trunk"].includes(highway)) {
    return isOneWay ? 6 : 10;
  }
  if (["motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"].includes(highway)) {
    return isOneWay ? 3 : 4;
  }
  if (["primary", "secondary"].includes(highway)) {
    return isOneWay ? 5 : 8;
  }
  return isOneWay ? 4 : 6;
};

const inferLaneCounts = (tags, isOneWay, highway) => {
  const explicitTotal = parsePositiveInt(tags.lanes);

  let lanesForward =
    parsePositiveInt(tags["lanes:forward"]) ||
    countLanesFromDelimited(tags["turn:lanes:forward"]);
  let lanesBackward =
    parsePositiveInt(tags["lanes:backward"]) ||
    countLanesFromDelimited(tags["turn:lanes:backward"]);

  const maxLanes = getMaxReasonableLanes(highway, isOneWay);

  if (isOneWay) {
    if (!lanesForward) {
      lanesForward =
        explicitTotal ||
        countLanesFromDelimited(tags["turn:lanes"]) ||
        (highway === "motorway" || highway === "trunk" ? 2 : 1);
    }
    lanesForward = Math.min(maxLanes, Math.max(1, lanesForward));
    return {
      lanesTotal: Math.max(1, lanesForward),
      lanesForward: Math.max(1, lanesForward),
      lanesBackward: 0,
    };
  }

  if (explicitTotal) {
    if (!lanesForward && !lanesBackward) {
      lanesForward = Math.ceil(explicitTotal / 2);
      lanesBackward = explicitTotal - lanesForward;
    } else if (!lanesForward) {
      lanesForward = Math.max(1, explicitTotal - lanesBackward);
    } else if (!lanesBackward) {
      lanesBackward = Math.max(1, explicitTotal - lanesForward);
    }
  }

  if (!lanesForward && !lanesBackward) {
    const inferredTotal =
      explicitTotal ||
      (highway === "motorway" || highway === "trunk" ? 4 :
       ["motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"].includes(highway) ? 1 :
       ["service", "track"].includes(highway) ? 1 : 2);
    lanesForward = Math.ceil(inferredTotal / 2);
    lanesBackward = Math.max(1, inferredTotal - lanesForward);
  }

  lanesForward = Math.max(1, lanesForward || 1);
  lanesBackward = Math.max(1, lanesBackward || 1);

  let lanesTotal = lanesForward + lanesBackward;
  if (lanesTotal > maxLanes) {
    const scale = maxLanes / lanesTotal;
    lanesForward = Math.max(1, Math.round(lanesForward * scale));
    lanesBackward = Math.max(1, maxLanes - lanesForward);
    lanesTotal = lanesForward + lanesBackward;
  }

  lanesTotal = Math.max(2, lanesTotal);
  return {
    lanesTotal,
    lanesForward,
    lanesBackward,
  };
};

export const shouldSkipLaneDetail = (tags = {}, layout = null) => {
  const highway = tags.highway;
  const layer = getEffectiveRoadLayer(tags);

  if (["motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"].includes(highway)) {
    return true;
  }

  if (layer !== 0 || tags.bridge === "yes" || tags.tunnel === "yes" || tags.covered === "yes") {
    return true;
  }

  if (layout && layout.lanesTotal >= 6) {
    return true;
  }

  return false;
};

export const getLaneLayout = (tags) => {
  const highway = tags.highway;
  const explicitNoOneway = tags.oneway === "no" || tags.oneway === "0";
  const explicitYesOneway =
    tags.oneway === "yes" || tags.oneway === "1" || tags.oneway === "true";
  const impliedLinkOneway =
    [
      "motorway_link",
      "trunk_link",
      "primary_link",
      "secondary_link",
      "tertiary_link",
    ].includes(highway) && !explicitNoOneway;
  const isOneWay =
    explicitYesOneway ||
    impliedLinkOneway ||
    highway === "motorway";
  const laneCounts = inferLaneCounts(tags, isOneWay, highway);
  const lanesT = laneCounts.lanesTotal;
  const lanesF = laneCounts.lanesForward;
  const lanesB = laneCounts.lanesBackward;
  const defaultLaneWidth = getDefaultLaneWidth(highway);

  const layout = {
    totalWidth: parseWidthMeters(tags.width) || 0,
    lanes: [],
    highway,
    isOneWay,
    lanesTotal: lanesT,
    unmarked: isUnmarkedSurface(tags),
  };

  // Width estimation (following OSM2World's defaults)
  if (layout.totalWidth === 0) {
    if (highway === "service") {
      layout.totalWidth = Math.max(lanesT * defaultLaneWidth, 4.0);
    } else {
      layout.totalWidth = lanesT * defaultLaneWidth;
    }
  }

  // Skip lane detail for unmarked surfaces
  if (layout.unmarked) return layout;

  if (shouldSkipLaneDetail(tags, layout)) {
    return layout;
  }

  const hasLeftSidewalk = tags.sidewalk === "left" || tags.sidewalk === "both";
  const hasRightSidewalk =
    tags.sidewalk === "right" || tags.sidewalk === "both";
  const hasLeftCycleway =
    tags["cycleway:left"] === "lane" || tags.cycleway === "lane";
  const hasRightCycleway =
    tags["cycleway:right"] === "lane" || tags.cycleway === "lane";

  // Build lane list (Left to Right)
  if (hasLeftSidewalk)
    layout.lanes.push({ type: "sidewalk", width: 2.0, color: COLORS.sidewalk });
  if (hasLeftCycleway)
    layout.lanes.push({ type: "cycleway", width: 1.5, color: "#704444" });

  const edgeLine = getEdgeLineStyle(tags);
  if (edgeLine)
    layout.lanes.push({ type: "edge", width: edgeLine.width, color: edgeLine.color });

  // Vehicle Lanes (Backward)
  if (!isOneWay) {
    for (let i = 0; i < lanesB; i++) {
      if (i > 0)
        layout.lanes.push({
          type: "separator",
          width: 0.12,
          color: COLORS.markingWhite,
          dash: [3, 6],
        });
      layout.lanes.push({ type: "vehicle", width: defaultLaneWidth });
    }
    // Center Divider
    const centerStyle = getCenterLineStyle(tags, lanesT, isOneWay);
    if (centerStyle) {
      layout.lanes.push({
        type: "divider",
        width: 0.12,
        color: centerStyle.color,
        double: centerStyle.double,
        dash: centerStyle.style === "dashed" ? [3, 6] : null,
      });
    }
  }

  // Vehicle Lanes (Forward)
  for (let i = 0; i < (isOneWay ? lanesT : lanesF); i++) {
    if (i > 0)
      layout.lanes.push({
        type: "separator",
        width: 0.12,
        color: COLORS.markingWhite,
        dash: [3, 6],
      });
    layout.lanes.push({ type: "vehicle", width: defaultLaneWidth });
  }

  if (edgeLine)
    layout.lanes.push({ type: "edge", width: edgeLine.width, color: edgeLine.color });
  if (hasRightCycleway)
    layout.lanes.push({ type: "cycleway", width: 1.5, color: "#704444" });
  if (hasRightSidewalk)
    layout.lanes.push({ type: "sidewalk", width: 2.0, color: COLORS.sidewalk });

  // Normalize widths to fit total width
  let currentSum = layout.lanes.reduce((sum, l) => sum + l.width, 0);
  if (currentSum > 0) {
    const scale = layout.totalWidth / currentSum;
    layout.lanes.forEach((l) => (l.width *= scale));
  }

  // Calculate offsets from center
  let offset = -layout.totalWidth / 2;
  layout.lanes.forEach((l) => {
    l.offset = offset + l.width / 2;
    offset += l.width;
  });

  return layout;
};
