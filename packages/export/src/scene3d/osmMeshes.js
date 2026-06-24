/** @layer core */
// createOSMGroup — builds the THREE.Group of OSM-derived meshes (buildings,
// barriers, vegetation, street furniture) for a tile. Shared by the 3D preview
// and every exporter. The feature-collection pass and geometry primitives live
// in sibling modules; this file owns the setup + per-category mesh assembly.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SCENE_SIZE } from "./sceneProjection.js";
import {
  addColor,
  createBarrierGeometry,
  stampInstances,
  createTreeMesh,
  createStreetLampMesh,
  createBollardMesh,
  createBenchMesh,
  createTrafficSignMesh,
} from "./osmGeometry.js";
import { collectOSMFeatures } from "./osmFeatureCollect.js";

export const createOSMGroup = (data, options = {}) => {
  // NOTE: This function is shared by both preview and export code paths.
  // Building geometry uses the unified lightweight pipeline everywhere.
  // Memory-budget options below remain primarily useful for preview callers.
  const {
    includeBuildings = true,
    includeVegetation = true,
    includeBarriers = true,
    includeStreetFurniture = true,
    maxBuildings = Number.POSITIVE_INFINITY,
    maxBarriers = Number.POSITIVE_INFINITY,
    maxTrees = 5000,
    maxBushes = 5000,
    maxStreetFurniture = 3000,
    simplifyBuildingFootprints = false,
    footprintSimplifyTolerance = 0,
    lightweightVegetationMode = false,
  } = options;
  const group = new THREE.Group();
  if (!data.osmFeatures || data.osmFeatures.length === 0) return group;

  const latRad =
    (((data.bounds.north + data.bounds.south) / 2) * Math.PI) / 180;
  const metersPerDegree = 111320 * Math.cos(latRad);
  const realWidthMeters =
    (data.bounds.east - data.bounds.west) * metersPerDegree;
  const unitsPerMeter = SCENE_SIZE / realWidthMeters;
  const footprintSimplifyToleranceScene = Math.max(0, Number(footprintSimplifyTolerance) || 0) * unitsPerMeter;

  const { buildingsList, treesList, bushesList, barriersList, streetFurnitureList, roadSegments } =
    collectOSMFeatures(
      data,
      {
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
      },
      unitsPerMeter,
    );

  if (buildingsList.length > 0) {
    const geos = [];

    buildingsList.forEach((b) => {
      const shape = new THREE.Shape();
      b.points.forEach((p, i) => {
        if (i === 0) shape.moveTo(p.x, -p.z);
        else shape.lineTo(p.x, -p.z);
      });
      b.holes.forEach((holePoints) => {
        const holePath = new THREE.Path();
        holePoints.forEach((p, i) => {
          if (i === 0) holePath.moveTo(p.x, -p.z);
          else holePath.lineTo(p.x, -p.z);
        });
        shape.holes.push(holePath);
      });

      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: b.height,
        bevelEnabled: false,
      });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, b.y, 0);

      const nonIndexed = geo.index ? geo.toNonIndexed() : geo;
      if (geo !== nonIndexed) geo.dispose();

      const pos = nonIndexed.attributes.position;
      const normals = nonIndexed.attributes.normal;
      const colors = new Float32Array(pos.count * 3);
      const wallC = new THREE.Color(b.wallColor);
      const roofC = new THREE.Color(b.roofColor);
      const roofNormalThreshold = 0.9;

      for (let i = 0; i < pos.count; i++) {
        const normalY = normals.getY(i);

        if (normalY >= roofNormalThreshold) {
          colors[i * 3] = roofC.r;
          colors[i * 3 + 1] = roofC.g;
          colors[i * 3 + 2] = roofC.b;
        } else {
          colors[i * 3] = wallC.r;
          colors[i * 3 + 1] = wallC.g;
          colors[i * 3 + 2] = wallC.b;
        }
      }

      nonIndexed.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geos.push(nonIndexed);
    });

    const merged = geos.length > 0 ? mergeGeometries(geos) : null;
    if (merged) {
      const buildingMesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.85,
          metalness: 0.03,
        }),
      );
      buildingMesh.castShadow = true;
      buildingMesh.receiveShadow = true;
      buildingMesh.name = "buildings";
      group.add(buildingMesh);
    }

    geos.forEach((g) => g.dispose());
  }

  if (barriersList.length > 0) {
    const geos = [];
    barriersList.forEach((b) => {
      const geo = createBarrierGeometry(data, b.points, b.width, b.height);
      addColor(geo, b.color);
      geos.push(geo);
    });
    const compatibleGeos = geos.map((g) => g.index ? g.toNonIndexed() : g);
    const merged = mergeGeometries(compatibleGeos);
    if (merged) {
      const barrierMesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
        }),
      );
      barrierMesh.castShadow = true;
      barrierMesh.receiveShadow = true;
      barrierMesh.name = "barriers";
      group.add(barrierMesh);
    }
    compatibleGeos.forEach((g) => g.dispose());
    geos.forEach((g) => g.dispose());
  }

  const matrix = new THREE.Matrix4(),
    quaternion = new THREE.Quaternion(),
    scale = new THREE.Vector3(1, 1, 1),
    position = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);

  if (treesList.length > 0) {
    const types = ["deciduous", "coniferous", "palm"];
    types.forEach((type) => {
      const list = treesList.filter((t) => t.type === type);
      if (list.length === 0) return;
      const baseGeo = createTreeMesh(type, unitsPerMeter, {
        lightweightVegetationMode,
      });
      if (!baseGeo) return;

      const combined = stampInstances(baseGeo, list, (tree) => {
        const seed = Math.abs((tree.pos.x * 123.45 + tree.pos.z * 678.9) % 1);
        const s = 0.95 + seed * 0.1;
        position.set(tree.pos.x, tree.pos.y, tree.pos.z);
        scale.set(s, s, s);
        quaternion.setFromAxisAngle(yAxis, seed * Math.PI * 2);
        return matrix.compose(position, quaternion, scale).clone();
      });

      if (combined) {
        const treeMesh = new THREE.Mesh(
          combined,
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.8,
          }),
        );
        treeMesh.castShadow = true;
        treeMesh.receiveShadow = true;
        treeMesh.name = "vegetation";
        group.add(treeMesh);
      }
      baseGeo.dispose();
    });
  }

  if (bushesList.length > 0) {
    let baseB = new THREE.IcosahedronGeometry(1.2 * unitsPerMeter, 0);
    if (baseB.index) baseB = baseB.toNonIndexed();
    addColor(baseB, 0x166534);

    const combined = stampInstances(baseB, bushesList, (pos) => {
      const seed = (pos.x * 543.21 + pos.z * 123.4) % 1;
      const s = 0.7 + seed * 0.6;
      scale.set(s, s * 0.8, s);
      quaternion.setFromAxisAngle(yAxis, seed * Math.PI * 2);
      position.set(pos.x, pos.y + 0.5 * s * unitsPerMeter, pos.z);
      return matrix.compose(position, quaternion, scale).clone();
    });

    if (combined) {
      const bushMesh = new THREE.Mesh(
        combined,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
      );
      bushMesh.castShadow = true;
      bushMesh.receiveShadow = true;
      bushMesh.name = "vegetation";
      group.add(bushMesh);
    }
    baseB.dispose();
  }

  // === Street Furniture Rendering ===
  if (includeStreetFurniture && streetFurnitureList.length > 0) {
    if (Number.isFinite(maxStreetFurniture) && streetFurnitureList.length > maxStreetFurniture) {
      console.warn(`[OSM] Street furniture capped at ${maxStreetFurniture} (had ${streetFurnitureList.length})`);
      streetFurnitureList.length = maxStreetFurniture;
    }

    // Build base geometries for each subtype
    const baseGeos = {
      street_lamp: createStreetLampMesh(unitsPerMeter),
      bollard: createBollardMesh(unitsPerMeter),
      bench: createBenchMesh(unitsPerMeter),
      give_way: createTrafficSignMesh("give_way", unitsPerMeter),
      generic: createTrafficSignMesh("generic", unitsPerMeter),
    };

    // Group furniture by subtype and stamp instances
    const subtypes = Object.keys(baseGeos);
    for (const st of subtypes) {
      const items = streetFurnitureList.filter((f) => f.subtype === st);
      if (items.length === 0) continue;
      const baseGeo = baseGeos[st];
      if (!baseGeo) continue;

      const combined = stampInstances(baseGeo, items, (item) => {
        // For traffic signals, offset the pole base to the roadside.
        // The arm extends along +Z in local space, so we move the base
        // backward (-Z local) so the pole sits at the road edge and
        // the arm hangs over the intersection center.
        let angle = 0;
        if (item.tags && item.tags.direction) {
          const deg = parseFloat(item.tags.direction);
          if (!isNaN(deg)) angle = (deg * Math.PI) / 180;
          else angle = Math.random() * Math.PI * 2;
        } else if ((st === "bench" || st === "street_lamp") && roadSegments.length >= 4) {
          // Orient benches/lamps to face the nearest road segment
          const px = item.pos.x, pz = item.pos.z;
          let bestDistSq = Infinity, bestAngle = 0;
          for (let si = 0; si < roadSegments.length; si += 4) {
            const ax = roadSegments[si], az = roadSegments[si + 1];
            const bx = roadSegments[si + 2], bz = roadSegments[si + 3];
            const abx = bx - ax, abz = bz - az;
            const lenSq = abx * abx + abz * abz;
            if (lenSq < 1e-8) continue;
            let t = ((px - ax) * abx + (pz - az) * abz) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const cx = ax + t * abx - px, cz = az + t * abz - pz;
            const dSq = cx * cx + cz * cz;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              // Bench: back faces away from road → orient along the road
              // Street lamp: face the road
              bestAngle = Math.atan2(abx, abz);
            }
          }
          angle = bestAngle;
          if (st === "bench") {
            // Bench faces the road: rotate 90° so seat faces road
            angle += Math.PI / 2;
          }
        } else {
          angle = Math.random() * Math.PI * 2;
        }

        position.set(item.pos.x, item.pos.y, item.pos.z);
        quaternion.setFromAxisAngle(yAxis, angle);
        scale.set(1, 1, 1);
        return matrix.compose(position, quaternion, scale).clone();
      });

      if (combined) {
        const furnitureMesh = new THREE.Mesh(
          combined,
          new THREE.MeshStandardMaterial({
            vertexColors: true,
            roughness: 0.6,
            metalness: 0.3,
          }),
        );
        furnitureMesh.castShadow = true;
        furnitureMesh.receiveShadow = true;
        furnitureMesh.name = "street_furniture";
        group.add(furnitureMesh);
      }
    }

    // Dispose base geometries
    for (const geo of Object.values(baseGeos)) {
      if (geo) geo.dispose();
    }

    console.log(`[OSM] Rendered ${streetFurnitureList.length} street furniture items`);
  }

  return group;
};
