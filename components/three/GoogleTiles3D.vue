<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useGoogleTilesStore } from '../../stores/googleTilesStore.js';
import { computeUnitsPerMeter } from '../../services/google3dTiles.js';

const props = defineProps({
  terrainData: { required: true },
});

const store = useGoogleTilesStore();
const { group, show, status } = storeToRefs(store);

// Bake output Y is in real metres above the .ter datum; the preview terrain
// mesh uses (h - minHeight) * unitsPerMeter scene units. Scaling Y by
// unitsPerMeter makes the two formulas identical.
const upm = computed(() => {
  const data = props.terrainData;
  if (!data?.bounds) return 1;
  return computeUnitsPerMeter(data);
});

// NOTE: no dispose-on-unmount here, unlike OSMFeatures3D — the group is owned
// by the bake cache in services/google3dTiles.js and must survive detach so
// the export paths (and re-toggling) can reuse it.
</script>

<template>
  <TresGroup v-if="status === 'ready' && show && group" :scale="[1, upm, 1]">
    <primitive :object="group" />
  </TresGroup>
</template>
