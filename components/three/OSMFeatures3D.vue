<script setup>
import { shallowRef, watch, toRaw, onUnmounted } from 'vue';
import { createOSMGroup } from '@mapng/bake/export3d';

const props = defineProps({
  terrainData: { required: true },
  featureVisibility: { 
    type: Object, 
    default: () => ({ buildings: true, vegetation: true, barriers: true }) 
  }
});

const group = shallowRef(null);

const disposeGroup = (grp) => {
  if (!grp) return;
  grp.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    }
  });
};

const buildPreviewOptions = (data) => {
  // PREVIEW-ONLY SAFETY PROFILE:
  // These limits intentionally reduce 3D preview memory usage for dense OSM areas.
  // Do not reuse this profile for export pipelines (GLB/DAE/BeamNG), which must
  // preserve full export quality.
  const osmCount = Array.isArray(data?.osmFeatures) ? data.osmFeatures.length : 0;
  const maxDim = Math.max(Number(data?.width || 0), Number(data?.height || 0));
  const dense = osmCount >= 9000 || (maxDim >= 8192 && osmCount >= 5000);
  const veryDense = osmCount >= 18000 || (maxDim >= 8192 && osmCount >= 10000);

  return {
    includeBuildings: props.featureVisibility?.buildings !== false,
    includeVegetation: props.featureVisibility?.vegetation !== false,
    includeBarriers: props.featureVisibility?.barriers !== false,
    includeStreetFurniture: !dense,
    maxBuildings: Number.POSITIVE_INFINITY,
    maxBarriers: veryDense ? 800 : dense ? 1800 : 5000,
    maxTrees: veryDense ? 600 : dense ? 1200 : 3000,
    maxBushes: veryDense ? 400 : dense ? 800 : 3000,
    maxStreetFurniture: veryDense ? 0 : dense ? 300 : 1500,
    simplifyBuildingFootprints: true,
    footprintSimplifyTolerance: veryDense ? 1.9 : dense ? 1.2 : 0.6,
    lightweightVegetationMode: true,
  };
};

const rebuildGroup = (data) => {
  if (group.value) {
    disposeGroup(group.value);
    group.value = null;
  }

  if (data) {
    const rawData = toRaw(data);
    group.value = createOSMGroup(rawData, buildPreviewOptions(rawData));
  }
};

watch(
  [
    () => props.terrainData,
    () => props.featureVisibility?.buildings,
    () => props.featureVisibility?.vegetation,
    () => props.featureVisibility?.barriers,
  ],
  ([data]) => rebuildGroup(data),
  { immediate: true }
);

onUnmounted(() => {
  if (group.value) {
    disposeGroup(group.value);
    group.value = null;
  }
});
</script>

<template>
  <primitive v-if="group" :object="group" />
</template>
