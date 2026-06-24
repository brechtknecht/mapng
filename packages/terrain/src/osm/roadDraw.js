/** @layer io */
// Canvas drawing primitives for OSM roads: path stroking, junction caps,
// crosswalk zebra markings, and lane-marking overlays (refactor doc 06 step 6).
// Operates on a 2D canvas context; moved verbatim from osmTexture.js.
import { COLORS } from "./osmColors.js";
import { getLaneLayout, shouldSkipLaneDetail } from "./laneInference.js";
import { subdivideAndSmooth, getOffsetPath, trimPolylineByDistance } from "./pathGeometry.js";

export const drawPathData = (ctx, points) => {
  if (points.length < 2) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
};

/**
 * Render junction areas as smooth polygons with curved corners.
 * Inspired by OSM2World's RoadJunction: connects road border edges with
 * quadratic bezier curves whose control points lie at the intersection
 * of adjacent road edge lines, creating natural rounded‐corner shapes.
 * Also covers the center area so that any lane markings drawn through the
 * junction are cleanly erased.
 */
export const renderJunctions = (ctx, junctionCaps) => {
  for (const cap of junctionCaps) {
    ctx.beginPath();
    for (const command of cap.commands) {
      if (command.type === 'move') ctx.moveTo(command.x, command.y);
      else if (command.type === 'line') ctx.lineTo(command.x, command.y);
      else if (command.type === 'quad') ctx.quadraticCurveTo(command.cx, command.cy, command.x, command.y);
    }
    ctx.closePath();
    ctx.fillStyle = COLORS.road;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cap.center.x, cap.center.y, cap.centerRadius, 0, Math.PI * 2);
    ctx.fill();
  }
};

// --- Crosswalk Rendering ---

/**
 * Detect where footways/paths cross roads and draw crosswalk markings.
 * Also checks OSM highway=crossing nodes.
 */
export const renderCrosswalks = (ctx, roads, allFeatures, toPixel, SCALE_FACTOR) => {
  // Collect footway/path features
  const footways = allFeatures.filter(
    (f) => f.type === "road" && ["footway", "path", "pedestrian", "cycleway"].includes(f.tags?.highway)
  );

  const crossingPoints = [];
  const crossingKeys = new Set();

  const addCrossingPoint = (x, y, nx, ny, roadWidth) => {
    const key = `${Math.round(x / 3)},${Math.round(y / 3)}`;
    if (crossingKeys.has(key)) return;
    crossingKeys.add(key);
    crossingPoints.push({ x, y, nx, ny, roadWidth });
  };

  const segmentIntersection = (a, b, c, d) => {
    const rX = b.x - a.x;
    const rY = b.y - a.y;
    const sX = d.x - c.x;
    const sY = d.y - c.y;

    const denom = rX * sY - rY * sX;
    if (Math.abs(denom) < 1e-6) return null;

    const uNum = (c.x - a.x) * rY - (c.y - a.y) * rX;
    const tNum = (c.x - a.x) * sY - (c.y - a.y) * sX;
    const u = uNum / denom;
    const t = tNum / denom;

    if (t < 0 || t > 1 || u < 0 || u > 1) return null;

    return {
      x: a.x + t * rX,
      y: a.y + t * rY,
    };
  };

  // Method 1: Exact polyline intersections between sidewalks and vehicle roads.
  footways.forEach((fw) => {
    const fwGeom = fw.geometry;
    if (!fwGeom || fwGeom.length < 2) return;

    roads.forEach((road) => {
      const roadLayout = getLaneLayout(road.tags || {});
      const roadHalfW = roadLayout.totalWidth / 2;
      const roadGeom = road.geometry;
      if (!roadGeom || roadGeom.length < 2) return;

      for (let i = 0; i < fwGeom.length - 1; i++) {
        const fA = toPixel(fwGeom[i].lat, fwGeom[i].lng);
        const fB = toPixel(fwGeom[i + 1].lat, fwGeom[i + 1].lng);

        for (let j = 0; j < roadGeom.length - 1; j++) {
          const rA = toPixel(roadGeom[j].lat, roadGeom[j].lng);
          const rB = toPixel(roadGeom[j + 1].lat, roadGeom[j + 1].lng);
          const hit = segmentIntersection(fA, fB, rA, rB);
          if (!hit) continue;

          const segDx = rB.x - rA.x;
          const segDy = rB.y - rA.y;
          const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
          if (segLen < 1e-6) continue;

          const rdx = segDx / segLen;
          const rdy = segDy / segLen;
          addCrossingPoint(
            hit.x,
            hit.y,
            -rdy,
            rdx,
            roadHalfW * SCALE_FACTOR,
          );
        }
      }
    });
  });

  // Method 2: Endpoint-near-road fallback for imperfectly snapped OSM geometries.
  footways.forEach((fw) => {
    const fwGeom = fw.geometry;
    if (!fwGeom || fwGeom.length < 2) return;

    [fwGeom[0], fwGeom[fwGeom.length - 1]].forEach((fwPt) => {
      const fwPx = toPixel(fwPt.lat, fwPt.lng);

      roads.forEach((road) => {
        const layout = getLaneLayout(road.tags || {});
        const halfW = layout.totalWidth / 2;
        const geom = road.geometry;
        if (!geom || geom.length < 2) return;

        for (let i = 0; i < geom.length - 1; i++) {
          const a = toPixel(geom[i].lat, geom[i].lng);
          const b = toPixel(geom[i + 1].lat, geom[i + 1].lng);

          const segDx = b.x - a.x;
          const segDy = b.y - a.y;
          const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
          if (segLen < 1e-6) continue;

          const t = Math.max(0, Math.min(1,
            ((fwPx.x - a.x) * segDx + (fwPx.y - a.y) * segDy) / (segLen * segLen)
          ));
          const projX = a.x + t * segDx;
          const projY = a.y + t * segDy;
          const dist = Math.sqrt((fwPx.x - projX) ** 2 + (fwPx.y - projY) ** 2);

          if (dist < halfW * SCALE_FACTOR * 1.25) {
            const rdx = segDx / segLen;
            const rdy = segDy / segLen;
            addCrossingPoint(
              projX,
              projY,
              -rdy,
              rdx,
              halfW * SCALE_FACTOR,
            );
            break;
          }
        }
      });
    });
  });

  // Draw crosswalk markings (zebra pattern)
  crossingPoints.forEach(({ x, y, nx, ny, roadWidth }) => {
    const stripeWidth = 0.5 * SCALE_FACTOR;
    const stripeGap = 0.5 * SCALE_FACTOR;
    const crosswalkLength = roadWidth * 2; // span full road width
    const crosswalkWidth = 3.0 * SCALE_FACTOR; // 3m wide crossing
    const numStripes = Math.floor(crosswalkWidth / (stripeWidth + stripeGap));

    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";

    for (let s = 0; s < numStripes; s++) {
      const offsetAlong = -crosswalkWidth / 2 + s * (stripeWidth + stripeGap) + stripeWidth / 2;

      // Direction along road (perpendicular to nx,ny)
      const alx = -ny;
      const aly = nx;

      const cx = x + alx * offsetAlong;
      const cy = y + aly * offsetAlong;

      // Draw stripe as a rotated rectangle
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2(ny, nx));
      ctx.fillRect(-crosswalkLength / 2, -stripeWidth / 2, crosswalkLength, stripeWidth);
      ctx.restore();
    }
  });
};

export const drawRoadWithMarkings = (ctx, feature, toPixel, SCALE_FACTOR) => {
  const layout = getLaneLayout(feature.tags || {});
  const geometry = feature.geometry;

  let centerPoints = geometry.map((p) => toPixel(p.lat, p.lng));
  centerPoints = subdivideAndSmooth(centerPoints, 3);

  const trimDistPx = Math.max(1.5 * SCALE_FACTOR, layout.totalWidth * SCALE_FACTOR * 0.8);
  centerPoints = trimPolylineByDistance(centerPoints, trimDistPx, trimDistPx);
  if (centerPoints.length < 2) return;

  // If unmarked surface, skip all lane markings
  if (layout.unmarked || shouldSkipLaneDetail(feature.tags || {}, layout)) return;

  // Draw Individual Lane Features (markings only — base pavement drawn in Pass 2)
  layout.lanes.forEach((lane) => {
    if (lane.type === "vehicle") return; // Pavement already covers it

    ctx.beginPath();
    const offsetPath = getOffsetPath(centerPoints, lane.offset, SCALE_FACTOR);
    drawPathData(ctx, offsetPath);

    ctx.strokeStyle = lane.color || COLORS.road;
    ctx.lineWidth = lane.width * SCALE_FACTOR;
    ctx.lineCap = "butt";

    if (lane.type === "divider") {
      if (lane.double) {
        // Double line (solid or dashed)
        ctx.lineWidth = 0.1 * SCALE_FACTOR;
        if (lane.dash) {
          ctx.setLineDash(lane.dash.map((d) => d * SCALE_FACTOR));
        } else {
          ctx.setLineDash([]);
        }

        ctx.beginPath();
        drawPathData(ctx, getOffsetPath(centerPoints, lane.offset - 0.15, SCALE_FACTOR));
        ctx.stroke();

        ctx.beginPath();
        drawPathData(ctx, getOffsetPath(centerPoints, lane.offset + 0.15, SCALE_FACTOR));
        ctx.stroke();
      } else {
        // Single center line
        ctx.lineWidth = 0.1 * SCALE_FACTOR;
        if (lane.dash) {
          ctx.setLineDash(lane.dash.map((d) => d * SCALE_FACTOR));
        } else {
          ctx.setLineDash([]);
        }
        ctx.stroke();
      }
    } else if (lane.type === "edge") {
      ctx.setLineDash([]);
      ctx.stroke();
    } else if (lane.type === "sidewalk") {
      // Draw sidewalk as a separate surface color (slightly raised look)
      ctx.setLineDash([]);
      ctx.stroke();
    } else {
      if (lane.dash) {
        ctx.setLineDash(lane.dash.map((d) => d * SCALE_FACTOR));
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke();
    }
  });

  ctx.setLineDash([]);
};
