/** @layer core */
// OSM tag → geometry config parsers for createOSMGroup. Extracted from the
// closures inside createOSMGroup; `unitsPerMeter` (a closure variable there) is
// now an explicit parameter. Bodies are otherwise verbatim.
import * as THREE from "three";

export const getBarrierConfig = (tags, unitsPerMeter) => {
  const type = tags.barrier;
  let height = 1.5 * unitsPerMeter;
  let width = 0.2 * unitsPerMeter;
  let color = 0x888888;

  if (type === "wall" || type === "city_wall" || type === "retaining_wall") {
    color = 0xaaaaaa;
    height = (type === "city_wall" ? 4 : 2) * unitsPerMeter;
    width = 0.5 * unitsPerMeter;
  } else if (type === "fence" || type === "gate") {
    color = 0x8b4513;
    if (tags.material === "metal" || tags.material === "chain_link")
      color = 0x555555;
    height = 1.5 * unitsPerMeter;
    width = 0.1 * unitsPerMeter;
  } else if (type === "hedge") {
    color = 0x228b22;
    height = 1.2 * unitsPerMeter;
    width = 0.8 * unitsPerMeter;
  }
  return { height, width, color };
};

/**
 * Advanced Building Configuration Parser
 * Inspired by OSM2World's LevelAndHeightData and BuildingDefaults
 */
export const getBuildingConfig = (tags, areaMeters = 0, unitsPerMeter) => {
  const DEFAULT_HEIGHT_LEVEL = 3.0;

  let buildingLevels =
    parseFloat(tags["building:levels"] || tags.levels) || 0;
  let minLevel =
    parseFloat(tags["building:min_level"] || tags.min_level) || 0;
  let roofLevels =
    parseFloat(tags["roof:levels"] || tags["building:roof:levels"]) || 0;
  let roofHeight =
    parseFloat(tags["roof:height"] || tags["building:roof:height"]) || 0;

  const type = tags.building || tags["building:part"] || "yes";
  let defaultLevels = 1;
  if (["house", "detached", "duplex", "terrace"].includes(type))
    defaultLevels = 2;
  else if (
    ["apartments", "office", "commercial", "retail", "hotel"].includes(type)
  )
    defaultLevels = 4;

  if (buildingLevels === 0) {
    if (tags.height)
      buildingLevels = Math.max(
        1,
        Math.round(parseFloat(tags.height) / DEFAULT_HEIGHT_LEVEL),
      );
    else if (areaMeters > 2000) buildingLevels = 5;
    else buildingLevels = defaultLevels;
  }

  let height = 0;
  if (tags.height) {
    height = parseFloat(tags.height);
  } else {
    height = (buildingLevels + roofLevels) * DEFAULT_HEIGHT_LEVEL;
    if (type === "church" || type === "cathedral")
      height = 20 + Math.random() * 10;
    else if (type === "garage" || type === "shed") height = 3.5;
    else if (type === "roof") height = 4;
  }

  let minHeight = 0;
  if (tags.min_height) minHeight = parseFloat(tags.min_height);
  else if (minLevel > 0) minHeight = minLevel * DEFAULT_HEIGHT_LEVEL;

  const roofShape =
    tags["roof:shape"] || tags["building:roof:shape"] || "flat";
  if (roofHeight === 0 && roofShape !== "flat") {
    roofHeight = roofLevels > 0 ? roofLevels * DEFAULT_HEIGHT_LEVEL : 3.0;
  }

  // --- Color & Material Logic (OSM2World inspired) ---
  const BUILDING_COLORS = {
    white: 0xfcfcfc,
    black: 0x4c4c4c,
    grey: 0x646464,
    gray: 0x646464,
    red: 0xffbebe, // Soft pink/red for buildings
    green: 0xbeffbe,
    blue: 0xbebeff,
    yellow: 0xffffaf,
    pink: 0xe1afe1,
    orange: 0xffe196,
    brown: 0xaa8250,
  };

  const ROOF_COLORS = {
    red: 0xcc0000,
    green: 0x96c882,
    blue: 0x6432c8,
    brown: 0x786e6e,
  };

  const MATERIAL_COLORS = {
    brick: 0xb91c1c,
    concrete: 0x9ca3af,
    stone: 0x6b7280,
    wood: 0x92400e,
    glass: 0x1e293b,
    metal: 0x4b5563,
  };

  const parseO2WColor = (colorTag, colorPalette, defaultColor) => {
    if (!colorTag) return defaultColor;
    if (colorPalette[colorTag.toLowerCase()])
      return colorPalette[colorTag.toLowerCase()];
    try {
      return new THREE.Color(colorTag).getHex();
    } catch (e) {
      return defaultColor;
    }
  };

  // Material overrides
  const wallMaterial = tags["building:material"] || tags["material"];
  const roofMaterial =
    tags["roof:material"] || tags["building:roof:material"];

  let wallColor = parseO2WColor(
    tags["building:colour"] ||
      tags["building:color"] ||
      tags.colour ||
      tags.color,
    BUILDING_COLORS,
    0xefd1a1,
  );
  if (
    wallMaterial &&
    MATERIAL_COLORS[wallMaterial.toLowerCase()] &&
    !tags["building:colour"]
  ) {
    wallColor = MATERIAL_COLORS[wallMaterial.toLowerCase()];
  }

  let roofColor = parseO2WColor(
    tags["roof:colour"] || tags["roof:color"] || tags["building:roof:colour"],
    ROOF_COLORS,
    0x9b3131,
  );
  if (
    roofMaterial &&
    MATERIAL_COLORS[roofMaterial.toLowerCase()] &&
    !tags["roof:colour"]
  ) {
    roofColor = MATERIAL_COLORS[roofMaterial.toLowerCase()];
  }

  return {
    height: height * unitsPerMeter,
    minHeight: minHeight * unitsPerMeter,
    wallColor,
    roofColor,
    roofShape,
    roofHeight: roofHeight * unitsPerMeter,
    levels: buildingLevels,
  };
};
