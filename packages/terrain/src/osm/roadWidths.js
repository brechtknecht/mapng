/** @layer core */
// Stable per-corridor road-width resolution for the OSM texture painter
// (refactor doc 06 step 6). Groups segments of the same named corridor so major
// roads don't visibly pinch at short turn-lane transitions. Pure; moved verbatim
// from osmTexture.js.
import { getEffectiveRoadLayer } from "../roadNetwork.js";
import { getLaneLayout, getDefaultLaneWidth } from "./laneInference.js";

export const getTextureCorridorStyleKey = (segment) => {
  const tags = segment?.tags || {};
  return JSON.stringify([
    segment?.highway || '',
    segment?.layer ?? '',
    tags.name || '',
    tags.ref || '',
    tags.surface || '',
    tags.oneway || '',
  ]);
};

const STABLE_TEXTURE_WIDTH_HIGHWAYS = new Set([
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
]);

const getTextureWidthCorridorKey = (road) => {
  const tags = road?.tags || {};
  return JSON.stringify([
    road?.highway || tags.highway || '',
    road?.layer ?? getEffectiveRoadLayer(tags),
    tags.name || '',
    tags.ref || '',
    tags.oneway || '',
  ]);
};

export const buildStableTextureWidthMap = (roads) => {
  const widthGroups = new Map();

  roads.forEach((road) => {
    const highway = road?.tags?.highway;
    if (!STABLE_TEXTURE_WIDTH_HIGHWAYS.has(highway)) return;

    const members = Array.isArray(road.members) && road.members.length > 0 ? road.members : [road];
    const key = getTextureWidthCorridorKey(road);
    const widths = widthGroups.get(key) || [];
    for (const member of members) {
      const width = getLaneLayout(member.tags || {}).totalWidth;
      if (Number.isFinite(width) && width > 0) widths.push(width);
    }
    widthGroups.set(key, widths);
  });

  const stableWidths = new Map();
  for (const [key, widths] of widthGroups.entries()) {
    if (widths.length === 0) continue;
    const highway = JSON.parse(key)[0];
    const laneWidth = getDefaultLaneWidth(highway);
    const minWidth = Math.min(...widths);
    const maxWidth = Math.max(...widths);
    // Major-road texture rendering should not visibly pinch when OSM encodes
    // short turn-lane transitions or inconsistent shoulder/cycle-lane tagging.
    if ((maxWidth - minWidth) <= (laneWidth * 2 + 0.75)) {
      stableWidths.set(key, maxWidth);
    }
  }

  return stableWidths;
};

export const getStableTextureRoadWidth = (road, stableWidthMap = null) => {
  const layout = getLaneLayout(road.tags || {});
  const baseWidth = layout.totalWidth;
  const highway = road.tags?.highway;
  if (!STABLE_TEXTURE_WIDTH_HIGHWAYS.has(highway)) {
    return baseWidth;
  }

  const stableWidth = stableWidthMap?.get(getTextureWidthCorridorKey(road));
  if (Number.isFinite(stableWidth) && stableWidth > 0) {
    return stableWidth;
  }

  return baseWidth;
};
