/** @layer io */
// Canvas orchestrator: paints all OSM features (landcover, water, coastlines,
// roads, junctions, buildings, barriers) onto a 2D context in draw order, plus
// the cached procedural noise pattern (refactor doc 06 step 6). Moved verbatim
// from osmTexture.js.
import { buildRoadNetwork, getEffectiveRoadLayer, mergeLinearRoadSegments } from "../roadNetwork.js";
import { COLORS, getFeatureColor, isBoundaryOnlyArea } from "./osmColors.js";
import { getFeatureArea, subdivideAndSmooth } from "./pathGeometry.js";
import {
  getTextureCorridorStyleKey,
  buildStableTextureWidthMap,
  getStableTextureRoadWidth,
} from "./roadWidths.js";
import { buildJunctionMap, buildJunctionCaps } from "./junctionCaps.js";
import { drawPathData, renderJunctions } from "./roadDraw.js";

export const renderFeaturesToCanvas = (
  ctx,
  features,
  toPixel,
  SCALE_FACTOR,
  options = {},
) => {
  const drawPath = (points) => {
    if (points.length < 2) return;
    const start = toPixel(points[0].lat, points[0].lng);
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i < points.length; i++) {
      const p = toPixel(points[i].lat, points[i].lng);
      ctx.lineTo(p.x, p.y);
    }
  };

  const drawPolygon = (feature) => {
    ctx.beginPath();
    const pts = feature.geometry.map((p) => toPixel(p.lat, p.lng));
    if (pts.length > 0) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
    }
    ctx.closePath();

    if (feature.holes) {
      for (const hole of feature.holes) {
        const holePts = hole.map((p) => toPixel(p.lat, p.lng));
        if (holePts.length > 0) {
          ctx.moveTo(holePts[0].x, holePts[0].y);
          for (let i = 1; i < holePts.length; i++) {
            ctx.lineTo(holePts[i].x, holePts[i].y);
          }
        }
        ctx.closePath();
      }
    }
  };

  const baseColor = options.baseColor || COLORS.defaultLanduse;

  // 1. Draw Landcover & Landuse (Sorted by area, with Grass/Water priority layers)
  const landcover = features.filter(
    (f) =>
      ["vegetation", "water", "landuse", "bridge_infra"].includes(f.type) &&
      !isBoundaryOnlyArea(f.tags),
  );

  const isGrass = (tags) => {
    if (!tags) return false;
    const surface =
      tags.surface ||
      tags.material ||
      tags.landcover ||
      tags.landuse ||
      tags.natural ||
      tags.leisure ||
      tags.golf ||
      tags.recreation ||
      tags.tourism;
    return [
      "grass",
      "meadow",
      "grassland",
      "fell",
      "park",
      "village_green",
      "garden",
      "recreation_ground",
      "common",
      "greenfield",
      "dog_park",
      "fairway",
      "green",
      "tee",
    ].includes(surface);
  };

  const isWater = (tags) => {
    if (!tags) return false;
    if (
      tags.natural === "water" ||
      tags.waterway ||
      tags.landuse === "reservoir" ||
      tags.landuse === "basin" ||
      tags.water ||
      tags.leisure === "marina" ||
      tags.water === "harbour" ||
      tags.water === "dock" ||
      tags.harbour === "yes" ||
      tags["seamark:type"] === "harbour" ||
      tags["seamark:type"] === "harbour_basin" ||
      tags["seamark:harbour:category"] === "marina"
    )
      return true;
    if (tags.natural === "wetland" || tags.wetland) return true;
    if (tags.natural === "glacier") return true;
    return false;
  };

  const waterFeatures = [];
  const beachFeatures = [];
  const bareFeatures = [];
  const grassFeatures = [];
  const otherFeatures = [];

  const isBeach = (tags) => {
    if (!tags) return false;
    const surface =
      tags.surface ||
      tags.material ||
      tags.landcover ||
      tags.landuse ||
      tags.natural ||
      tags.leisure ||
      tags.golf ||
      tags.recreation ||
      tags.tourism;
    return ["beach", "sand", "shoal", "dune", "coastline"].includes(surface);
  };

  const isBare = (tags) => {
    if (!tags) return false;
    const surface =
      tags.surface ||
      tags.material ||
      tags.landcover ||
      tags.landuse ||
      tags.natural ||
      tags.leisure ||
      tags.golf ||
      tags.recreation ||
      tags.tourism;
    return [
      "bare_rock",
      "rock",
      "scree",
      "shingle",
      "shells",
      "marble",
      "stone",
      "blockfield",
    ].includes(surface);
  };

  landcover.forEach((f) => {
    const item = { f, area: getFeatureArea(f) };
    if (isWater(f.tags)) {
      waterFeatures.push(item);
    } else if (isBeach(f.tags)) {
      beachFeatures.push(item);
    } else if (isBare(f.tags)) {
      bareFeatures.push(item);
    } else if (isGrass(f.tags)) {
      grassFeatures.push(item);
    } else {
      otherFeatures.push(item);
    }
  });

  // Sort each group by area descending
  const byArea = (a, b) => b.area - a.area;
  otherFeatures.sort(byArea);
  grassFeatures.sort(byArea);
  bareFeatures.sort(byArea);
  waterFeatures.sort(byArea);
  beachFeatures.sort(byArea);

  // Combine in draw order: Others -> Grass -> Bare -> Water -> Beach
  // Bare terrain should sit above generic vegetation but below explicit shoreline/water overlays.
  const sortedLC = [
    ...otherFeatures,
    ...grassFeatures,
    ...bareFeatures,
    ...waterFeatures,
    ...beachFeatures,
  ];

  if (options.alpha) ctx.globalAlpha = options.alpha;
  for (const { f } of sortedLC) {
    ctx.fillStyle = getFeatureColor(f.tags, baseColor);
    if (f.geometry.length === 1) {
      // Skip vegetation points (trees, shrubs) as they are rendered as 3D models
      if (
        f.type === "vegetation" ||
        f.tags.natural === "tree" ||
        f.tags.natural === "shrub"
      )
        continue;

      const p = toPixel(f.geometry[0].lat, f.geometry[0].lng);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5 * SCALE_FACTOR, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Fix for waterways flooding land:
      // If it's a linear waterway (stream/river centerline) and NOT an area, draw as line.
      const isLinearWater =
        f.tags.waterway &&
        !["riverbank", "dock", "boatyard", "dam"].includes(f.tags.waterway) &&
        f.tags.area !== "yes";

      // Geometry check: is closed?
      const p1 = f.geometry[0];
      const p2 = f.geometry[f.geometry.length - 1];
      const isClosed =
        Math.abs(p1.lat - p2.lat) < 1e-9 && Math.abs(p1.lng - p2.lng) < 1e-9;

      if (isLinearWater && !isClosed) {
        let pts = f.geometry.map((p) => toPixel(p.lat, p.lng));
        pts = subdivideAndSmooth(pts, 3);

        ctx.beginPath();
        drawPathData(ctx, pts);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = ctx.fillStyle; // Use same color

        // Width adaptivity
        let w = 1.5; // Stream default
        if (f.tags.width) w = parseFloat(f.tags.width);
        else if (f.tags.waterway === "river") w = 6;
        else if (f.tags.waterway === "canal") w = 4;
        else if (f.tags.waterway === "drain" || f.tags.waterway === "ditch")
          w = 1;

        ctx.lineWidth = w * SCALE_FACTOR;
        ctx.stroke();
      } else {
        drawPolygon(f);
        ctx.fill("evenodd");
      }
    }
  }
  ctx.globalAlpha = 1.0;

  // 1b. Draw coastlines as sandy shoreline strokes
  const coastlines = features.filter((f) => f.type === "coastline");
  if (coastlines.length > 0) {
    ctx.strokeStyle = COLORS.coastline;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.0 * SCALE_FACTOR;
    coastlines.forEach((f) => {
      let pts = f.geometry.map((p) => toPixel(p.lat, p.lng));
      pts = subdivideAndSmooth(pts, 1);
      ctx.beginPath();
      drawPathData(ctx, pts);
      ctx.stroke();
    });
  }

  // 2. Draw Roads (with priority sorting)
  const roads = features.filter((f) => f.type === "road");
  const roadPriority = {
    motorway: 100,
    motorway_link: 100,
    trunk: 90,
    trunk_link: 90,
    primary: 80,
    primary_link: 80,
    secondary: 70,
    secondary_link: 70,
    tertiary: 60,
    tertiary_link: 60,
    residential: 50,
    unclassified: 40,
    service: 30,
    path: 20,
    footway: 20,
    cycleway: 20,
    pedestrian: 20,
    track: 15,
    steps: 10,
  };
  roads.sort((a, b) => {
    const layerA = getEffectiveRoadLayer(a.tags || {});
    const layerB = getEffectiveRoadLayer(b.tags || {});
    if (layerA !== layerB) return layerA - layerB;
    return (
      (roadPriority[a.tags.highway] || 10) -
      (roadPriority[b.tags.highway] || 10)
    );
  });

  // Separate vehicle roads from footways/paths for junction detection.
  const vehicleRoads = roads.filter(
    (f) => !["footway", "path", "pedestrian", "cycleway", "steps", "track"].includes(f.tags?.highway)
  );
  const vehicleRoadNetwork = buildRoadNetwork(vehicleRoads, {
    layerResolver: getEffectiveRoadLayer,
  });
  const vehicleRoadSegments = mergeLinearRoadSegments(
    vehicleRoadNetwork.segments,
    vehicleRoadNetwork.intersections,
    { styleKeyResolver: getTextureCorridorStyleKey },
  );
  const drivableRoads = vehicleRoadSegments.length > 0 ? vehicleRoadSegments : vehicleRoads;
  const stableWidthMap = buildStableTextureWidthMap(drivableRoads);

  // Build junction map for vehicle roads
  const junctions = buildJunctionMap(vehicleRoads, (lat, lng) => toPixel(lat, lng));
  const junctionCaps = buildJunctionCaps(junctions, (lat, lng) => toPixel(lat, lng), SCALE_FACTOR, stableWidthMap);

  // Pass 1: Draw footways/paths (BEFORE roads so pavement paints over crossings)
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  roads.forEach((f) => {
    const highway = f.tags?.highway;
    if (
      ["footway", "path", "pedestrian", "cycleway", "steps", "track"].includes(highway)
    ) {
      let pts = f.geometry.map((p) => toPixel(p.lat, p.lng));
      pts = subdivideAndSmooth(pts, 3);

      ctx.beginPath();
      drawPathData(ctx, pts);
      if (f.tags?.footway === "sidewalk" || f.tags?.surface === "concrete") {
        ctx.strokeStyle = COLORS.sidewalk;
      } else if (["footway", "path", "track"].includes(highway)) {
        ctx.strokeStyle = COLORS.track;
      } else {
        ctx.strokeStyle = COLORS.path;
      }
      ctx.lineWidth = 1.5 * SCALE_FACTOR;
      ctx.stroke();
    }
  });

  // Pass 2: Draw vehicle road base pavement (no markings yet)
  drivableRoads.forEach((f) => {
    const geometry = f.geometry;
    let centerPoints = geometry.map((p) => toPixel(p.lat, p.lng));
    centerPoints = subdivideAndSmooth(centerPoints, 3);

    ctx.beginPath();
    drawPathData(ctx, centerPoints);
    ctx.strokeStyle = COLORS.road;
    ctx.lineWidth = getStableTextureRoadWidth(f, stableWidthMap) * SCALE_FACTOR;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  });

  // Pass 3: Keep junction pavement fill behavior for cleaner intersections.
  renderJunctions(ctx, junctionCaps);

  // 3. Draw Buildings
  const buildings = features.filter((f) => f.type === "building");
  ctx.lineWidth = 0.5 * SCALE_FACTOR;
  buildings.forEach((f) => {
    ctx.fillStyle = "#CDB8A6";
    ctx.strokeStyle = COLORS.buildingStroke;
    drawPolygon(f);
    ctx.fill("evenodd");
    ctx.stroke();
  });

  // 4. Draw Barriers
  const barriers = features.filter((f) => f.type === "barrier");
  ctx.strokeStyle = COLORS.barrier;
  ctx.lineWidth = 1 * SCALE_FACTOR;
  barriers.forEach((f) => {
    ctx.beginPath();
    drawPath(f.geometry);
    ctx.stroke();
  });
};

// Cache noise patterns by color to avoid regenerating each time
const _noiseCache = new Map();
export const createNoisePattern = (baseColor) => {
  const key = baseColor || COLORS.defaultLanduse;
  if (_noiseCache.has(key)) return _noiseCache.get(key);

  const size = 256; // 256px is sufficient for a repeating noise tile
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  // Base fill
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, size, size);

  // Add noise — use pixel buffer directly for speed
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const val = (Math.random() - 0.5) * 20;
    data[i] = Math.max(0, Math.min(255, data[i] + val));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + val));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + val));
  }

  ctx.putImageData(imageData, 0, 0);

  // Larger grit
  ctx.fillStyle = "rgba(0,0,0,0.03)";
  for (let i = 0; i < 50; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * 2 + 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _noiseCache.set(key, canvas);
  return canvas;
};
