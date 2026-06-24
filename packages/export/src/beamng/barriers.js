/** @layer core */
// Native BeamNG barrier emission: OSM barrier→asset preset resolution, repeated
// TSStatic panel/post/endcap placement, and folder-item cloning. Extracted
// verbatim from exportBeamNGLevel.js (06 step 9).
import { roundTo } from './format.js';
import {
  geoToWorldPoint,
  generatePersistentId,
  rotationMatrixFromYaw,
  getTerrainHeightWorld,
  isClosedRing,
} from './worldMath.js';

export const NATIVE_BARRIER_ASSETS = {
  guardrail: {
    shapeName: '/levels/west_coast_usa/art/shapes/objects/guardrail1.dae',
    postShapeName: '/levels/west_coast_usa/art/shapes/objects/guardrailpost.dae',
    endShapeName: '/levels/west_coast_usa/art/shapes/objects/guardrail_end.dae',
    segmentLength: 3.8,
    zOffset: 0.15,
    postZOffset: 0.02,
    endZOffset: 0.08,
    yawOffset: Math.PI * 0.5,
  },
  concrete: {
    shapeName: '/levels/west_coast_usa/art/shapes/objects/jerseybarrier_3m.dae',
    segmentLength: 3,
    zOffset: 0.05,
    yawOffset: Math.PI * 0.5,
  },
  fence: {
    shapeName: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_wood_fence_a.DAE',
    segmentLength: 2,
    zOffset: 0.05,
    yawOffset: 0,
  },
  chainLinkFence: {
    shapeName: '/levels/west_coast_usa/art/shapes/objects/screenfence1.dae',
    segmentLength: 3.5,
    // In official mesh data, min Z is about -1.52.
    zOffset: 1.55,
    yawOffset: Math.PI * 0.5,
  },
};

export const EAST_COAST_FENCE_MATERIAL_DEFS = {
  eca_bld_trim_wood: {
    class: 'Material',
    name: 'eca_bld_trim_wood',
    mapTo: 'eca_bld_trim_wood',
    annotation: 'BUILDINGS',
    Stages: [{
      colorMap: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_trim_wood_d.dds',
      normalMap: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_trim_wood_n.dds',
      specularMap: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_trim_wood_s.dds',
      diffuseColor: [1, 1, 1, 1],
    }],
    translucentBlendOp: 'None',
  },
  eca_bld_wood: {
    class: 'Material',
    name: 'eca_bld_wood',
    mapTo: 'eca_bld_wood',
    annotation: 'BUILDINGS',
    Stages: [{
      colorMap: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_wood_d.dds',
      normalMap: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_wood_n.dds',
      specularMap: '/levels/east_coast_usa/art/shapes/buildings/eca_bld_wood_s.dds',
      diffuseColor: [1, 1, 1, 1],
    }],
    translucentBlendOp: 'None',
  },
  lumber_raw: {
    class: 'Material',
    name: 'lumber_raw',
    mapTo: 'lumber_raw',
    annotation: 'BUILDINGS',
    Stages: [{
      colorMap: '/levels/east_coast_usa/art/shapes/misc/lumber_raw_d.dds',
      normalMap: '/levels/east_coast_usa/art/shapes/misc/lumber_raw_n.dds',
      specularMap: '/levels/east_coast_usa/art/shapes/misc/lumber_raw_s.dds',
      diffuseColor: [1, 1, 1, 1],
    }],
    translucentBlendOp: 'None',
  },
};

export const MAX_NATIVE_BARRIER_OBJECTS = 8000;

/**
 * Resolve OSM barrier tags to one of the native BeamNG barrier asset presets.
 */
export function resolveNativeBarrierAsset(tags = {}) {
  const barrierType = String(tags.barrier ?? '').trim().toLowerCase();
  const material = String(tags.material ?? '').trim().toLowerCase();

  if (!barrierType || barrierType === 'hedge') return null;

  if (barrierType === 'guard_rail' || barrierType === 'guardrail' || barrierType === 'handrail') {
    return NATIVE_BARRIER_ASSETS.guardrail;
  }

  if (
    barrierType === 'jersey_barrier'
    || barrierType === 'concrete_barrier'
  ) {
    return NATIVE_BARRIER_ASSETS.concrete;
  }

  if (
    barrierType === 'fence'
    || barrierType === 'chain'
    || barrierType === 'wall'
    || barrierType === 'city_wall'
    || barrierType === 'retaining_wall'
    || barrierType === 'block'
    || barrierType === 'cable_barrier'
    || barrierType === 'wire_fence'
    || barrierType === 'gate'
  ) {
    return NATIVE_BARRIER_ASSETS.fence;
  }

  if (barrierType === 'chain_link' || material === 'chain_link') {
    return NATIVE_BARRIER_ASSETS.chainLinkFence;
  }

  return NATIVE_BARRIER_ASSETS.guardrail;
}

/**
 * Convert OSM barrier features into BeamNG TSStatic barrier objects.
 *
 * Includes repeated segment placement and optional post/endcap meshes where
 * the selected barrier asset defines them.
 */
export function buildNativeBarrierObjects(terrainData, squareSize) {
  const features = terrainData.osmFeatures?.filter((feature) => (
    feature.type === 'barrier' && Array.isArray(feature.geometry) && feature.geometry.length >= 2
  )) ?? [];

  const objects = [];

  /**
   * Add one TSStatic barrier instance at a geographic point with yaw.
   */
  const pushInstanceAtGeo = (pt, yaw, asset, name, zOffsetOverride) => {
    if (objects.length >= MAX_NATIVE_BARRIER_OBJECTS) return;
    const rotationYaw = yaw + (Number.isFinite(asset.yawOffset) ? asset.yawOffset : 0);
    const world = geoToWorldPoint(
      pt.lat,
      pt.lng,
      terrainData,
      squareSize,
      Number.isFinite(zOffsetOverride) ? zOffsetOverride : asset.zOffset,
    );
    objects.push({
      __parent: 'Barriers',
      class: 'TSStatic',
      name,
      persistentId: generatePersistentId(),
      position: [roundTo(world[0], 3), roundTo(world[1], 3), roundTo(world[2], 3)],
        rotationMatrix: rotationMatrixFromYaw(rotationYaw),
      shapeName: asset.shapeName,
      useInstanceRenderData: true,
    });
  };

  /**
   * Place repeated barrier panels along one OSM barrier polyline.
   */
  const pushFeatureInstances = (feature, asset, namePrefix) => {
    const geometry = Array.isArray(feature?.geometry) ? feature.geometry : [];
    if (geometry.length < 2) return;

    const segmentStarts = [];
    const segmentLengths = [];
    const cumulative = [0];
    let totalLen = 0;

    for (let i = 0; i < geometry.length - 1; i++) {
      const a = geometry[i];
      const b = geometry[i + 1];
      const wa = geoToWorldPoint(a.lat, a.lng, terrainData, squareSize, 0);
      const wb = geoToWorldPoint(b.lat, b.lng, terrainData, squareSize, 0);
      const dx = wb[0] - wa[0];
      const dy = wb[1] - wa[1];
      const len = Math.hypot(dx, dy);
      if (!Number.isFinite(len) || len < 0.01) continue;
      segmentStarts.push(i);
      segmentLengths.push(len);
      totalLen += len;
      cumulative.push(totalLen);
    }

    if (!Number.isFinite(totalLen) || totalLen < 0.5 || segmentStarts.length < 1) return;

    const isFenceAsset = String(asset?.shapeName || '').toLowerCase().includes('wood_fence');
    const nominalSpacing = Math.max(0.75, Number(asset.segmentLength) || 2);
    const panelCount = Math.max(1, Math.round(totalLen / nominalSpacing));
    const panelSpacing = totalLen / panelCount;

    /**
     * Sample interpolated geo/world coordinates and tangent at path distance.
     */
    const sampleAtDistance = (distance) => {
      const d = Math.max(0, Math.min(totalLen, distance));
      let segIdx = segmentLengths.length - 1;
      for (let i = 0; i < segmentLengths.length; i++) {
        if (d <= cumulative[i + 1]) {
          segIdx = i;
          break;
        }
      }
      const baseIdx = segmentStarts[segIdx];
      const a = geometry[baseIdx];
      const b = geometry[baseIdx + 1];
      const segStartDist = cumulative[segIdx];
      const segLen = segmentLengths[segIdx];
      const t = segLen > 1e-6 ? (d - segStartDist) / segLen : 0;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      const world = geoToWorldPoint(lat, lng, terrainData, squareSize, 0);
      const yaw = Math.atan2(b.lat - a.lat, b.lng - a.lng);
      return {
        lat,
        lng,
        x: world[0],
        y: world[1],
        terrainZ: getTerrainHeightWorld(lat, lng, terrainData),
        yaw,
      };
    };

    for (let i = 0; i < panelCount; i++) {
      if (objects.length >= MAX_NATIVE_BARRIER_OBJECTS) return;
      const startSample = sampleAtDistance(i * panelSpacing);
      const endSample = sampleAtDistance((i + 1) * panelSpacing);
      const centerSample = sampleAtDistance((i + 0.5) * panelSpacing);
      const rotationYaw = centerSample.yaw + (Number.isFinite(asset.yawOffset) ? asset.yawOffset : 0);
      const panelTerrainZ = isFenceAsset
        ? Math.max(startSample.terrainZ, endSample.terrainZ, centerSample.terrainZ)
        : centerSample.terrainZ;
      objects.push({
        __parent: 'Barriers',
        class: 'TSStatic',
        name: `${namePrefix}_${i + 1}`,
        persistentId: generatePersistentId(),
        position: [
          roundTo(centerSample.x, 3),
          roundTo(centerSample.y, 3),
          roundTo(panelTerrainZ + (Number.isFinite(asset.zOffset) ? asset.zOffset : 0), 3),
        ],
        rotationMatrix: rotationMatrixFromYaw(rotationYaw),
        shapeName: asset.shapeName,
        useInstanceRenderData: true,
      });
    }

    if (asset.postShapeName) {
      const isClosed = isClosedRing(geometry);
      const postCount = isClosed ? panelCount : panelCount + 1;
      for (let i = 0; i < postCount; i++) {
        if (objects.length >= MAX_NATIVE_BARRIER_OBJECTS) return;
        const sample = sampleAtDistance(i * panelSpacing);
        const rotationYaw = sample.yaw + (Number.isFinite(asset.yawOffset) ? asset.yawOffset : 0);
        objects.push({
          __parent: 'Barriers',
          class: 'TSStatic',
          name: `${namePrefix}_post_${i + 1}`,
          persistentId: generatePersistentId(),
          position: [
            roundTo(sample.x, 3),
            roundTo(sample.y, 3),
            roundTo(sample.terrainZ + (Number.isFinite(asset.postZOffset) ? asset.postZOffset : asset.zOffset), 3),
          ],
          rotationMatrix: rotationMatrixFromYaw(rotationYaw),
          shapeName: asset.postShapeName,
          useInstanceRenderData: true,
        });
      }
    }
  };

  /**
   * Place optional guardrail endcap meshes at both barrier endpoints.
   */
  const pushGuardrailEndcaps = (feature, asset, featureIndex) => {
    if (!asset.endShapeName || !Array.isArray(feature.geometry) || feature.geometry.length < 2) return;
    const startPt = feature.geometry[0];
    const nextPt = feature.geometry[1];
    const endPt = feature.geometry[feature.geometry.length - 1];
    const prevPt = feature.geometry[feature.geometry.length - 2];

    const startYaw = Math.atan2(nextPt.lat - startPt.lat, nextPt.lng - startPt.lng);
    const endYaw = Math.atan2(endPt.lat - prevPt.lat, endPt.lng - prevPt.lng);
    const rotationStartYaw = startYaw + (Number.isFinite(asset.yawOffset) ? asset.yawOffset : 0);
    const rotationEndYaw = endYaw + (Number.isFinite(asset.yawOffset) ? asset.yawOffset : 0);

    if (objects.length < MAX_NATIVE_BARRIER_OBJECTS) {
      const worldStart = geoToWorldPoint(
        startPt.lat,
        startPt.lng,
        terrainData,
        squareSize,
        Number.isFinite(asset.endZOffset) ? asset.endZOffset : asset.zOffset,
      );
      objects.push({
        __parent: 'Barriers',
        class: 'TSStatic',
        name: `barrier_${featureIndex}_end_start`,
        persistentId: generatePersistentId(),
        position: [roundTo(worldStart[0], 3), roundTo(worldStart[1], 3), roundTo(worldStart[2], 3)],
        rotationMatrix: rotationMatrixFromYaw(rotationStartYaw),
        shapeName: asset.endShapeName,
        useInstanceRenderData: true,
      });
    }

    if (objects.length < MAX_NATIVE_BARRIER_OBJECTS) {
      const worldEnd = geoToWorldPoint(
        endPt.lat,
        endPt.lng,
        terrainData,
        squareSize,
        Number.isFinite(asset.endZOffset) ? asset.endZOffset : asset.zOffset,
      );
      objects.push({
        __parent: 'Barriers',
        class: 'TSStatic',
        name: `barrier_${featureIndex}_end_finish`,
        persistentId: generatePersistentId(),
        position: [roundTo(worldEnd[0], 3), roundTo(worldEnd[1], 3), roundTo(worldEnd[2], 3)],
        rotationMatrix: rotationMatrixFromYaw(rotationEndYaw),
        shapeName: asset.endShapeName,
        useInstanceRenderData: true,
      });
    }
  };

  for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
    if (objects.length >= MAX_NATIVE_BARRIER_OBJECTS) break;
    const feature = features[featureIndex];
    const asset = resolveNativeBarrierAsset(feature.tags || {});
    if (!asset) continue;

    pushFeatureInstances(feature, asset, `barrier_${featureIndex}`);

    if (asset.endShapeName && objects.length < MAX_NATIVE_BARRIER_OBJECTS) {
      pushGuardrailEndcaps(feature, asset, featureIndex);
    }
  }

  return objects;
}

/**
 * Clone barrier TSStatic objects for folder-level JSON items output.
 */
export function buildBarrierFolderItems(barrierObjects) {
  if (!Array.isArray(barrierObjects) || barrierObjects.length === 0) return [];
  return barrierObjects.map((obj, index) => ({
    ...obj,
    __parent: 'barriers',
    name: String(obj?.name || `barrier_${index + 1}`),
    isRenderEnabled: false,
  }));
}
