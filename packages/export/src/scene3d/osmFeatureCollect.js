/** @layer core */
// Feature-collection pass for createOSMGroup: walk data.osmFeatures once and
// bucket them into scene-space lists (buildings, trees, bushes, barriers, street
// furniture) + road centreline segments for furniture orientation. Extracted
// verbatim from createOSMGroup's forEach; `unitsPerMeter` and the config/sampler
// helpers are now explicit imports/params instead of closure variables.
import * as THREE from "three";
import {
  latLngToScene,
  latLngToSceneFast,
  getTerrainHeight,
  getHeightAtScenePos,
} from "./sceneProjection.js";
import { getBarrierConfig, getBuildingConfig } from "./osmFeatureConfig.js";
import { isPointInPolygon, simplifyClosedRing, normalizeClosedRing } from "./osmGeometry.js";

export const collectOSMFeatures = (data, opts, unitsPerMeter) => {
  const {
    includeBuildings,
    includeVegetation,
    includeBarriers,
    includeStreetFurniture,
    maxBuildings,
    maxBarriers,
    maxTrees,
    maxBushes,
    maxStreetFurniture,
    simplifyBuildingFootprints,
    footprintSimplifyToleranceScene,
  } = opts;

  const buildingsList = [];
  const treesList = [];
  const bushesList = [];
  const barriersList = [];
  const streetFurnitureList = [];
  // Collect road/path centerline segments in scene coords for orienting furniture
  const roadSegments = [];

  data.osmFeatures.forEach((f) => {
    if (!f.geometry[0]) return;

    // Collect road/path segments for furniture orientation
    if (f.type === "road" && f.geometry.length >= 2) {
      let prev = latLngToSceneFast(data, f.geometry[0].lat, f.geometry[0].lng);
      let prevX = prev.x, prevZ = prev.z;
      for (let i = 1; i < f.geometry.length; i++) {
        const cur = latLngToSceneFast(data, f.geometry[i].lat, f.geometry[i].lng);
        roadSegments.push(prevX, prevZ, cur.x, cur.z);
        prevX = cur.x;
        prevZ = cur.z;
      }
    }

    if (includeBuildings && f.type === "building" && f.geometry.length > 2) {
      if (buildingsList.length >= maxBuildings) return;
      const rawPoints = f.geometry.map((p) => latLngToScene(data, p.lat, p.lng));
      const points = simplifyBuildingFootprints
        ? simplifyClosedRing(rawPoints, footprintSimplifyToleranceScene)
        : normalizeClosedRing(rawPoints);
      if (points.length < 4) return;
      let area = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const j = i + 1;
        area += points[i].x * points[j].z - points[j].x * points[i].z;
      }
      const areaMeters = Math.abs(area) / 2 / (unitsPerMeter * unitsPerMeter);

      // Safeguard: Skip extruding buildings that are impossibly large (likely landuse errors)
      // 50,000 sqm is a very large building (like a massive mall or factory)
      const isLargeIndustry = [
        "industrial",
        "warehouse",
        "retail",
        "commercial",
      ].includes(f.tags.building);
      if (areaMeters > 50000 && !isLargeIndustry) {
        return;
      }

      const config = getBuildingConfig(f.tags, areaMeters, unitsPerMeter);
      const holes = (f.holes || [])
        .map((h) => {
          const rawHole = h.map((p) => latLngToScene(data, p.lat, p.lng));
          return simplifyBuildingFootprints
            ? simplifyClosedRing(rawHole, footprintSimplifyToleranceScene)
            : normalizeClosedRing(rawHole);
        })
        .filter((h) => h.length >= 4);
      let avgH = 0;
      f.geometry.forEach((p) => (avgH += getTerrainHeight(data, p.lat, p.lng)));
      buildingsList.push({
        points,
        holes,
        y: avgH / f.geometry.length + config.minHeight,
        height: Math.max(0.1, config.height - config.minHeight),
        ...config,
      });
    } else if (includeBarriers && f.type === "barrier" && f.geometry.length >= 2) {
      if (barriersList.length >= maxBarriers) return;
      const config = getBarrierConfig(f.tags, unitsPerMeter);
      const points = f.geometry.map((p) => {
        const v = latLngToScene(data, p.lat, p.lng);
        v.y = getTerrainHeight(data, p.lat, p.lng);
        return v;
      });
      barriersList.push({
        points,
        originalPoints: f.geometry,
        width: config.width,
        height: config.height,
        color: config.color,
      });
    } else if (includeStreetFurniture && f.type === "street_furniture" && f.geometry.length === 1) {
      if (streetFurnitureList.length >= maxStreetFurniture) return;
      const v = latLngToScene(data, f.geometry[0].lat, f.geometry[0].lng);
      v.y = getHeightAtScenePos(data, v.x, v.z);
      let subtype = "generic";
      if (f.tags.highway === "street_lamp") subtype = "street_lamp";
      else if (f.tags.barrier === "bollard") subtype = "bollard";
      else if (f.tags.amenity === "bench") subtype = "bench";
      else if (f.tags.highway === "give_way") subtype = "give_way";
      else if (f.tags.traffic_sign) subtype = "generic";
      streetFurnitureList.push({ pos: v, subtype, tags: f.tags });
    } else if (includeVegetation && f.type === "vegetation") {
      const isTree =
        f.tags.natural === "tree" ||
        f.tags.natural === "wood" ||
        f.tags.landuse === "forest" ||
        f.tags.natural === "tree_row" ||
        f.tags.natural === "tree_group";
      const isBush =
        f.tags.natural === "scrub" ||
        f.tags.natural === "heath" ||
        f.tags.barrier === "hedge";
      if (isTree) {
        let treeType = "deciduous";
        if (f.tags.leaf_type === "needleleaved" || f.tags.wood === "coniferous")
          treeType = "coniferous";
        if (
          f.tags.leaf_type === "palm" ||
          (f.tags.species && f.tags.species.toLowerCase().includes("palm"))
        )
          treeType = "palm";

        if (
          f.geometry.length > 3 &&
          f.geometry[0].lat === f.geometry[f.geometry.length - 1].lat
        ) {
          const points = f.geometry.map((p) =>
            latLngToScene(data, p.lat, p.lng),
          );
          let minX = Infinity,
            maxX = -Infinity,
            minZ = Infinity,
            maxZ = -Infinity;
          points.forEach((p) => {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
          });
          const density = 0.04 / (unitsPerMeter * unitsPerMeter);
          const remaining = maxTrees - treesList.length;
          if (remaining <= 0) return;
          const count = Math.min(
            remaining,
            250,
            Math.floor((maxX - minX) * (maxZ - minZ) * density),
          );
          for (let i = 0; i < count; i++) {
            const rx = minX + Math.random() * (maxX - minX),
              rz = minZ + Math.random() * (maxZ - minZ);
            if (isPointInPolygon({ x: rx, z: rz }, points)) {
              treesList.push({
                pos: new THREE.Vector3(
                  rx,
                  getHeightAtScenePos(data, rx, rz),
                  rz,
                ),
                type: treeType,
              });
            }
          }
        } else {
          f.geometry.forEach((p) => {
            if (treesList.length >= maxTrees) return;
            const v = latLngToScene(data, p.lat, p.lng);
            v.y = getHeightAtScenePos(data, v.x, v.z);
            treesList.push({ pos: v, type: treeType });
          });
        }
      } else if (isBush) {
        if (
          f.geometry.length > 3 &&
          f.geometry[0].lat === f.geometry[f.geometry.length - 1].lat
        ) {
          const points = f.geometry.map((p) =>
            latLngToScene(data, p.lat, p.lng),
          );
          let minX = Infinity,
            maxX = -Infinity,
            minZ = Infinity,
            maxZ = -Infinity;
          points.forEach((p) => {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minZ = Math.min(minZ, p.z);
            maxZ = Math.max(maxZ, p.z);
          });
          const density = 0.02 / (unitsPerMeter * unitsPerMeter);
          const bushRemaining = maxBushes - bushesList.length;
          if (bushRemaining <= 0) return;
          const count = Math.min(
            bushRemaining,
            250,
            Math.floor((maxX - minX) * (maxZ - minZ) * density),
          );
          for (let i = 0; i < count; i++) {
            const rx = minX + Math.random() * (maxX - minX),
              rz = minZ + Math.random() * (maxZ - minZ);
            if (isPointInPolygon({ x: rx, z: rz }, points)) {
              bushesList.push(
                new THREE.Vector3(rx, getHeightAtScenePos(data, rx, rz), rz),
              );
            }
          }
        } else {
          f.geometry.forEach((p) => {
            if (bushesList.length >= maxBushes) return;
            const v = latLngToScene(data, p.lat, p.lng);
            v.y = getHeightAtScenePos(data, v.x, v.z);
            bushesList.push(v);
          });
        }
      }
    }
  });

  if (Number.isFinite(maxTrees) && treesList.length >= maxTrees) {
    console.warn(`[OSM] Tree count capped at ${maxTrees} to prevent memory issues`);
  }
  if (Number.isFinite(maxBushes) && bushesList.length >= maxBushes) {
    console.warn(`[OSM] Bush count capped at ${maxBushes} to prevent memory issues`);
  }
  if (Number.isFinite(maxBuildings) && buildingsList.length >= maxBuildings) {
    console.warn(`[OSM] Building count capped at ${maxBuildings} for memory safety`);
  }
  if (Number.isFinite(maxBarriers) && barriersList.length >= maxBarriers) {
    console.warn(`[OSM] Barrier count capped at ${maxBarriers} for memory safety`);
  }

  return { buildingsList, treesList, bushesList, barriersList, streetFurnitureList, roadSegments };
};
