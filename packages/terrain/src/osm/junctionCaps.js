/** @layer core */
// Pure junction-cap geometry for the OSM texture painter (refactor doc 06 step
// 6): detect road intersections and build smooth rounded-corner cap polygons as
// draw-command lists (move/line/quad). No canvas — the command lists are stroked
// by featureRender. Moved verbatim from osmTexture.js.
import { buildRoadNetwork, getEffectiveRoadLayer } from "../roadNetwork.js";
import { getStableTextureRoadWidth } from "./roadWidths.js";

/**
 * Build a spatial index of road endpoints for fast junction detection.
 * Groups nearby endpoints (within tolerance) at shared OSM nodes.
 */
export const buildJunctionMap = (roads, toPixel) => {
  const network = buildRoadNetwork(roads, { layerResolver: getEffectiveRoadLayer });
  const result = new Map();
  for (const [key, roadsAtLayer] of network.intersections.entries()) {
    const sample = roadsAtLayer[0];
    const pt = sample?.isStart ? sample.road.geometry[0] : sample.road.geometry[sample.road.geometry.length - 1];
    if (!pt) continue;
    result.set(key, {
      lat: pt.lat,
      lng: pt.lng,
      roads: roadsAtLayer,
      pixel: toPixel(pt.lat, pt.lng),
    });
  }

  // Keep per-layer junction groups with 2+ connecting roads.
  for (const [key, junction] of Array.from(result.entries())) {
    if (!junction.roads || junction.roads.length < 2) {
      result.delete(key);
    }
  }

  return result;
};

const buildJunctionCap = (junction, toPixel, SCALE_FACTOR, stableWidthMap) => {
  const center = junction.pixel;
  const arms = [];
  let maxHalfW = 0;

  junction.roads.forEach(({ road, isStart }) => {
    const halfW = (getStableTextureRoadWidth(road, stableWidthMap) / 2) * SCALE_FACTOR;
    maxHalfW = Math.max(maxHalfW, halfW);
    const geom = road.geometry;
    if (geom.length < 2) return;

    let p0;
    let p1;
    if (isStart) {
      p0 = toPixel(geom[0].lat, geom[0].lng);
      p1 = toPixel(geom[1].lat, geom[1].lng);
    } else {
      p0 = toPixel(geom[geom.length - 1].lat, geom[geom.length - 1].lng);
      p1 = toPixel(geom[geom.length - 2].lat, geom[geom.length - 2].lng);
    }

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return;

    const dirX = dx / len;
    const dirY = dy / len;
    const nx = -dirY;
    const ny = dirX;
    const outAngle = Math.atan2(dy, dx);

    arms.push({
      halfW,
      dirX,
      dirY,
      outAngle,
      cw: { x: p0.x + nx * halfW, y: p0.y + ny * halfW },
      ccw: { x: p0.x - nx * halfW, y: p0.y - ny * halfW },
    });
  });

  if (arms.length < 3) return null;
  arms.sort((a, b) => a.outAngle - b.outAngle);

  const commands = [];
  for (let i = 0; i < arms.length; i++) {
    const curr = arms[i];
    const next = arms[(i + 1) % arms.length];

    if (i === 0) commands.push({ type: 'move', x: curr.ccw.x, y: curr.ccw.y });
    commands.push({ type: 'line', x: curr.cw.x, y: curr.cw.y });

    const det = curr.dirX * (-next.dirY) - curr.dirY * (-next.dirX);
    if (Math.abs(det) < 0.001) {
      commands.push({ type: 'line', x: next.ccw.x, y: next.ccw.y });
      continue;
    }

    const dX = next.ccw.x - curr.cw.x;
    const dY = next.ccw.y - curr.cw.y;
    const t = (-dX * next.dirY + dY * next.dirX) / det;

    let cpX = curr.cw.x + t * curr.dirX;
    let cpY = curr.cw.y + t * curr.dirY;
    const cornerDist = Math.sqrt((cpX - center.x) ** 2 + (cpY - center.y) ** 2);
    if (cornerDist > maxHalfW * 4) {
      const midX = (curr.cw.x + next.ccw.x) / 2;
      const midY = (curr.cw.y + next.ccw.y) / 2;
      cpX = midX * 0.4 + center.x * 0.6;
      cpY = midY * 0.4 + center.y * 0.6;
    }

    commands.push({ type: 'quad', cx: cpX, cy: cpY, x: next.ccw.x, y: next.ccw.y });
  }

  return {
    center,
    centerRadius: maxHalfW * 0.28,
    commands,
  };
};

export const buildJunctionCaps = (junctions, toPixel, SCALE_FACTOR, stableWidthMap) => {
  const caps = [];
  for (const [, junction] of junctions) {
    const cap = buildJunctionCap(junction, toPixel, SCALE_FACTOR, stableWidthMap);
    if (cap) caps.push(cap);
  }
  return caps;
};
