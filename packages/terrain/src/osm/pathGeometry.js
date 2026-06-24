/** @layer core */
// Pure 2D path geometry for the OSM texture painter (refactor doc 06 step 6):
// feature area, Chaikin smoothing, centreline offsetting, distance trimming, and
// road border extraction. Operates on {x,y} pixel points (or {lat,lng} for area).
// Moved verbatim from osmTexture.js.

// Helper to calculate approximate area of a LatLng feature for Z-sorting
export const getFeatureArea = (feature) => {
  const points = feature.geometry;
  if (points.length < 3) return 0;

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    area += (p2.lng - p1.lng) * (p2.lat + p1.lat);
  }
  return Math.abs(area);
};

// --- Path Smoothing Helpers ---

export const subdivideAndSmooth = (points, iterations = 1) => {
  if (points.length < 3) return points;
  let current = points;
  for (let i = 0; i < iterations; i++) {
    const next = [];
    // Keep start point
    next.push(current[0]);
    for (let j = 0; j < current.length - 1; j++) {
      const p1 = current[j];
      const p2 = current[j + 1];

      // Chaikin's algorithm: generate two new points at 1/4 and 3/4 positions
      next.push({
        x: p1.x * 0.75 + p2.x * 0.25,
        y: p1.y * 0.75 + p2.y * 0.25,
      });
      next.push({
        x: p1.x * 0.25 + p2.x * 0.75,
        y: p1.y * 0.25 + p2.y * 0.75,
      });
    }
    // Keep end point
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
};

// --- Road Geometry Helpers ---

export const getOffsetPath = (projected, offsetMeters, SCALE_FACTOR) => {
  if (projected.length < 2) return [];
  const offsetPath = [];

  for (let i = 0; i < projected.length; i++) {
    const p = projected[i];
    let dx, dy;

    if (i === 0) {
      dx = projected[i + 1].x - projected[i].x;
      dy = projected[i + 1].y - projected[i].y;
    } else if (i === projected.length - 1) {
      dx = projected[i].x - projected[i - 1].x;
      dy = projected[i].y - projected[i - 1].y;
    } else {
      dx = projected[i + 1].x - projected[i - 1].x;
      dy = projected[i + 1].y - projected[i - 1].y;
    }

    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) {
      offsetPath.push(p);
      continue;
    }

    const nx = -dy / len;
    const ny = dx / len;

    offsetPath.push({
      x: p.x + nx * offsetMeters * SCALE_FACTOR,
      y: p.y + ny * offsetMeters * SCALE_FACTOR,
    });
  }
  return offsetPath;
};

export const trimPolylineByDistance = (points, trimStartPx, trimEndPx) => {
  if (!points || points.length < 2) return points || [];

  const segmentLengths = [];
  let totalLength = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x;
    const dy = points[i + 1].y - points[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    segmentLengths.push(len);
    totalLength += len;
  }

  if (totalLength <= trimStartPx + trimEndPx + 1e-6) return [];

  const carve = (fromStart, distancePx) => {
    if (distancePx <= 0) {
      return { index: fromStart ? 0 : points.length - 1, t: 0 };
    }

    let acc = 0;
    if (fromStart) {
      for (let i = 0; i < segmentLengths.length; i++) {
        const len = segmentLengths[i];
        if (acc + len >= distancePx) {
          return { index: i, t: (distancePx - acc) / Math.max(len, 1e-9) };
        }
        acc += len;
      }
      return { index: segmentLengths.length - 1, t: 1 };
    }

    for (let i = segmentLengths.length - 1; i >= 0; i--) {
      const len = segmentLengths[i];
      if (acc + len >= distancePx) {
        // From end: t=0 means point i, t=1 means point i+1
        const tFromEnd = (distancePx - acc) / Math.max(len, 1e-9);
        return { index: i, t: 1 - tFromEnd };
      }
      acc += len;
    }
    return { index: 0, t: 0 };
  };

  const startCut = carve(true, trimStartPx);
  const endCut = carve(false, trimEndPx);

  const makePoint = (segIndex, t) => {
    const a = points[segIndex];
    const b = points[segIndex + 1];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    };
  };

  const startPoint = makePoint(startCut.index, startCut.t);
  const endPoint = makePoint(endCut.index, endCut.t);

  // If cuts crossed, return empty.
  if (startCut.index > endCut.index || (startCut.index === endCut.index && startCut.t >= endCut.t)) {
    return [];
  }

  const trimmed = [startPoint];
  for (let i = startCut.index + 1; i <= endCut.index; i++) {
    trimmed.push(points[i]);
  }
  trimmed.push(endPoint);
  return trimmed;
};

/**
 * Get the left and right border polylines of a road, by offsetting the
 * centerline by half the road width on each side.
 */
export const getRoadBorders = (centerPoints, halfWidth, SCALE_FACTOR) => {
  const left = getOffsetPath(centerPoints, -halfWidth, SCALE_FACTOR);
  const right = getOffsetPath(centerPoints, halfWidth, SCALE_FACTOR);
  return { left, right };
};
