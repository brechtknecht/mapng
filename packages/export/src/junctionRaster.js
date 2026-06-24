// Raster-based detector + patcher for MeshRoad gaps the OSM-node walk missed.
//
// Two masks, same world→pixel transform:
//
//   reference  = OSM segment centerlines at TRUE mesh width, ROUND caps/joins.
//                Represents what coverage *would* be if every visual junction
//                were filled — round caps overlap at meeting endpoints so any
//                real junction area is solid.
//
//   coverage   = emitted MeshRoad polylines at their actual width, BUTT caps
//                (matches the perpendicular cross-section BeamNG actually
//                renders), plus filled junction polygons we already emit.
//
//   gaps       = reference AND NOT coverage  →  connected components
//
// Each component above MIN_HOLE_AREA_M2 that is bordered by ≥ 2 distinct
// segment endpoints becomes a junction polygon directly: convex hull of the
// hole pixels, expanded outward so the polygon overlaps adjacent MeshRoad
// butt-ends (matches JUNCTION_COLLISION_OVERLAP semantics). Z is taken from
// nearby MeshRoad node Zs so the patch sits at the right elevation.
//
// No synthetic injection into roadNetwork.intersections — that path can't
// work because analyzeJunctions assumes shared endpoints and falls apart when
// approaches are scattered.

const DEFAULT_PIXELS_PER_METRE = 2;        // 0.5 m / px
const MAX_CANVAS_DIMENSION = 8192;
const RASTER_PADDING_PX = 4;
const MIN_HOLE_AREA_M2 = 1.5;
const PATCH_OUTSET_M = 0.25;               // overlap MeshRoad butt-ends a little
const MAX_PATCH_Z_RANGE_M = 1.5;           // overpass guard (skip if Z spread too wide)
const ENDPOINT_PROXIMITY_FACTOR = 1.4;     // hole bbox-half-diag × this = "nearby endpoint" radius
const MIN_BORDERING_SEGMENTS = 2;          // suppress isolated dead-end round-cap halos

// ─── canvas helpers ───────────────────────────────────────────────────────

function makeCanvas(widthPx, heightPx) {
  if (widthPx <= 0 || heightPx <= 0) return null;
  if (widthPx > MAX_CANVAS_DIMENSION || heightPx > MAX_CANVAS_DIMENSION) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, widthPx, heightPx);
    return { canvas, ctx };
  } catch {
    return null;
  }
}

function computeWorldBoundsFromSegments(segmentInfo, padMetres) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, info] of segmentInfo) {
    if (!info?.worldGeometry?.length) continue;
    for (const p of info.worldGeometry) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return null;
  return {
    minX: minX - padMetres, minY: minY - padMetres,
    maxX: maxX + padMetres, maxY: maxY + padMetres,
  };
}

function makeTransform(bounds, pixelsPerMetre, paddingPx) {
  const widthPx  = Math.ceil((bounds.maxX - bounds.minX) * pixelsPerMetre) + paddingPx * 2;
  const heightPx = Math.ceil((bounds.maxY - bounds.minY) * pixelsPerMetre) + paddingPx * 2;
  const toPixel = (wx, wy) => [
    (wx - bounds.minX) * pixelsPerMetre + paddingPx,
    (bounds.maxY - wy) * pixelsPerMetre + paddingPx,
  ];
  const toWorld = (u, v) => [
    (u - paddingPx) / pixelsPerMetre + bounds.minX,
    bounds.maxY - (v - paddingPx) / pixelsPerMetre,
  ];
  return { widthPx, heightPx, toPixel, toWorld, pixelsPerMetre, bounds };
}

function paintPolyline(ctx, points, halfWidthMetres, pixelsPerMetre, toPixel) {
  if (!Array.isArray(points) || points.length < 2) return;
  if (!Number.isFinite(halfWidthMetres) || halfWidthMetres <= 0) return;
  ctx.lineWidth = Math.max(1, halfWidthMetres * 2 * pixelsPerMetre);
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const [u, v] = toPixel(points[i][0], points[i][1]);
    if (i === 0) ctx.moveTo(u, v);
    else ctx.lineTo(u, v);
  }
  ctx.stroke();
}

function paintFilledPolygon(ctx, polygon, toPixel) {
  if (!Array.isArray(polygon) || polygon.length < 3) return;
  ctx.beginPath();
  for (let i = 0; i < polygon.length; i++) {
    const [u, v] = toPixel(polygon[i][0], polygon[i][1]);
    if (i === 0) ctx.moveTo(u, v);
    else ctx.lineTo(u, v);
  }
  ctx.closePath();
  ctx.fill();
}

function binarize(ctx, widthPx, heightPx) {
  const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
  const out = new Uint8Array(widthPx * heightPx);
  const src = imageData.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = src[j] >= 128 ? 1 : 0;
  }
  return { width: widthPx, height: heightPx, data: out };
}

function rasterizeReferenceMask(segmentInfo, transform) {
  const surface = makeCanvas(transform.widthPx, transform.heightPx);
  if (!surface) return null;
  const { ctx } = surface;
  ctx.strokeStyle = 'white';
  ctx.lineCap = 'round';      // round caps fill junction areas where endpoints meet
  ctx.lineJoin = 'round';
  for (const [, info] of segmentInfo) {
    paintPolyline(ctx, info?.worldGeometry, info?.halfWidth, transform.pixelsPerMetre, transform.toPixel);
  }
  return binarize(ctx, transform.widthPx, transform.heightPx);
}

function rasterizeCoverageMask(meshRoads, junctions, transform) {
  const surface = makeCanvas(transform.widthPx, transform.heightPx);
  if (!surface) return null;
  const { ctx } = surface;
  ctx.strokeStyle = 'white';
  ctx.fillStyle = 'white';
  ctx.lineCap = 'butt';       // BeamNG MeshRoad ends are flat perpendicular cuts
  ctx.lineJoin = 'round';
  for (const road of meshRoads || []) {
    if (!Array.isArray(road?.nodes) || road.nodes.length < 2) continue;
    const fullWidth = road.nodes[0][3];
    if (!Number.isFinite(fullWidth) || fullWidth <= 0) continue;
    paintPolyline(ctx, road.nodes, fullWidth / 2, transform.pixelsPerMetre, transform.toPixel);
  }
  for (const j of junctions || []) {
    paintFilledPolygon(ctx, j?.polygon, transform.toPixel);
  }
  return binarize(ctx, transform.widthPx, transform.heightPx);
}

// ─── diff & components ────────────────────────────────────────────────────

function computeHoleBitmap(reference, coverage) {
  if (!reference || !coverage) return null;
  if (reference.width !== coverage.width || reference.height !== coverage.height) return null;
  const n = reference.data.length;
  const holes = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (reference.data[i] === 1 && coverage.data[i] === 0) holes[i] = 1;
  }
  return { width: reference.width, height: reference.height, data: holes };
}

function floodFillComponents(bitmap, minAreaPx) {
  const { width, height, data } = bitmap;
  const seen = new Uint8Array(data.length);
  const out = [];
  const stack = [];
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const pixels = [];
    while (stack.length) {
      const idx = stack.pop();
      pixels.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      if (x > 0)          { const n = idx - 1;     if (data[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (x < width - 1)  { const n = idx + 1;     if (data[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (y > 0)          { const n = idx - width; if (data[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
      if (y < height - 1) { const n = idx + width; if (data[n] && !seen[n]) { seen[n] = 1; stack.push(n); } }
    }
    if (pixels.length >= minAreaPx) out.push(pixels);
  }
  return out;
}

// ─── geometry helpers ─────────────────────────────────────────────────────

function convexHullXY(points) {
  if (points.length <= 2) return points.slice();
  const pts = points.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper); // CCW
}

function expandPolygonFromCentroid(polygonXY, offsetMetres) {
  if (polygonXY.length < 3) return polygonXY;
  let cx = 0, cy = 0;
  for (const p of polygonXY) { cx += p[0]; cy += p[1]; }
  cx /= polygonXY.length;
  cy /= polygonXY.length;
  return polygonXY.map(([x, y]) => {
    const dx = x - cx, dy = y - cy;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return [x, y];
    return [x + (dx / len) * offsetMetres, y + (dy / len) * offsetMetres];
  });
}

// ─── endpoint indexing ────────────────────────────────────────────────────

function buildSegmentEndpointIndex(segmentInfo) {
  const out = [];
  for (const [segmentId, info] of segmentInfo) {
    if (!info?.worldGeometry?.length) continue;
    const first = info.worldGeometry[0];
    const last  = info.worldGeometry[info.worldGeometry.length - 1];
    out.push({ segmentId, isStart: true,  x: first[0], y: first[1], z: first[2], halfWidth: info.halfWidth });
    out.push({ segmentId, isStart: false, x: last[0],  y: last[1],  z: last[2],  halfWidth: info.halfWidth });
  }
  return out;
}

function buildMeshRoadNodeIndex(meshRoads) {
  // Flat list of every emitted MeshRoad node — used to look up Z for patch
  // vertices, since the patch sits on the same surface the road tops do.
  const out = [];
  for (const road of meshRoads || []) {
    if (!Array.isArray(road?.nodes)) continue;
    for (const n of road.nodes) out.push([n[0], n[1], n[2]]);
  }
  return out;
}

function nearestZFromNodes(x, y, nodeList) {
  let bestD2 = Infinity;
  let bestZ = 0;
  for (const n of nodeList) {
    const dx = n[0] - x, dy = n[1] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; bestZ = n[2]; }
  }
  return Number.isFinite(bestZ) ? bestZ : 0;
}

// ─── public entry ─────────────────────────────────────────────────────────

/**
 * Detect coverage gaps and return junction polygons that fill them. Caller
 * concatenates the returned polygons with the OSM-derived rawJunctions before
 * mergeJunctionClusters, so close-to-OSM patches merge naturally.
 *
 * @returns Array<{ position: [x,y,z], polygon: Array<[x,y,z]> }>
 */
export function detectGapJunctions(segmentInfo, meshRoads, existingJunctions, options = {}) {
  if (!segmentInfo || segmentInfo.size === 0) return [];

  const pixelsPerMetre = options.pixelsPerMetre ?? DEFAULT_PIXELS_PER_METRE;
  let maxHalfWidth = 0;
  for (const [, info] of segmentInfo) {
    if (Number.isFinite(info?.halfWidth) && info.halfWidth > maxHalfWidth) maxHalfWidth = info.halfWidth;
  }
  const rasterBounds = computeWorldBoundsFromSegments(segmentInfo, maxHalfWidth + 1);
  if (!rasterBounds) return [];

  const transform = makeTransform(rasterBounds, pixelsPerMetre, RASTER_PADDING_PX);
  if (transform.widthPx > MAX_CANVAS_DIMENSION || transform.heightPx > MAX_CANVAS_DIMENSION) return [];

  const reference = rasterizeReferenceMask(segmentInfo, transform);
  const coverage  = rasterizeCoverageMask(meshRoads, existingJunctions, transform);
  if (!reference || !coverage) return [];

  const holes = computeHoleBitmap(reference, coverage);
  if (!holes) return [];

  const minAreaPx = Math.max(1, Math.round(MIN_HOLE_AREA_M2 * pixelsPerMetre * pixelsPerMetre));
  const components = floodFillComponents(holes, minAreaPx);
  if (components.length === 0) return [];

  const endpoints = buildSegmentEndpointIndex(segmentInfo);
  const nodes = buildMeshRoadNodeIndex(meshRoads);
  if (nodes.length === 0) return [];

  const worldBounds = options.worldBounds;
  const inBounds = worldBounds ? ((x, y) =>
    x >= worldBounds.minX && x <= worldBounds.maxX &&
    y >= worldBounds.minY && y <= worldBounds.maxY
  ) : () => true;

  const patches = [];

  for (const pixels of components) {
    // Reproject pixels → world points for hull construction.
    const worldPts = new Array(pixels.length);
    let cxPx = 0, cyPx = 0;
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (let i = 0; i < pixels.length; i++) {
      const idx = pixels[i];
      const u = idx % holes.width;
      const v = (idx - u) / holes.width;
      cxPx += u; cyPx += v;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
      worldPts[i] = transform.toWorld(u + 0.5, v + 0.5);
    }
    const [centroidX, centroidY] = transform.toWorld(cxPx / pixels.length + 0.5, cyPx / pixels.length + 0.5);
    if (!inBounds(centroidX, centroidY)) continue;

    // Bordering-segment test: require ≥ MIN_BORDERING_SEGMENTS unique segments
    // with an endpoint within proximity of the hole. Suppresses the round-cap
    // halo at lone road dead-ends (which would otherwise generate a phantom
    // junction at every cul-de-sac).
    const [wMinX, wMaxY] = transform.toWorld(minU, minV);
    const [wMaxX, wMinY] = transform.toWorld(maxU + 1, maxV + 1);
    const bboxDiag = Math.hypot(wMaxX - wMinX, wMaxY - wMinY);
    const proximity = Math.max(bboxDiag * 0.5, maxHalfWidth) * ENDPOINT_PROXIMITY_FACTOR;
    const prox2 = proximity * proximity;

    const nearbySegments = new Set();
    let zMin = Infinity, zMax = -Infinity;
    for (const ep of endpoints) {
      const dx = ep.x - centroidX, dy = ep.y - centroidY;
      if (dx * dx + dy * dy <= prox2) {
        nearbySegments.add(ep.segmentId);
        if (ep.z < zMin) zMin = ep.z;
        if (ep.z > zMax) zMax = ep.z;
      }
    }
    if (nearbySegments.size < MIN_BORDERING_SEGMENTS) continue;
    if (Number.isFinite(zMin) && (zMax - zMin) > MAX_PATCH_Z_RANGE_M) continue;

    // Build the patch: convex hull of hole pixels, outset to overlap road ends.
    const hull2D = convexHullXY(worldPts);
    if (hull2D.length < 3) continue;
    const expanded2D = expandPolygonFromCentroid(hull2D, PATCH_OUTSET_M);

    // Per-vertex Z from nearest MeshRoad node — keeps the patch sitting on the
    // road surface where it bends with terrain.
    const polygon = expanded2D.map(([x, y]) => [x, y, nearestZFromNodes(x, y, nodes)]);
    let cz = 0;
    for (const v of polygon) cz += v[2];
    cz /= polygon.length;

    let cxOut = 0, cyOut = 0;
    for (const v of polygon) { cxOut += v[0]; cyOut += v[1]; }
    cxOut /= polygon.length; cyOut /= polygon.length;

    patches.push({ position: [cxOut, cyOut, cz], polygon });
  }

  return patches;
}
