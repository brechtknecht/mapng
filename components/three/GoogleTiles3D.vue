<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useGoogleTilesStore } from '../../stores/googleTilesStore.js';
import { computeUnitsPerMeter, sampleHeightAtScene } from '../../services/google3dTiles.js';

const props = defineProps({
  terrainData: { required: true },
});

const store = useGoogleTilesStore();
const { group, show, showCameras, status } = storeToRefs(store);

// Bake output Y is in real metres above the .ter datum; the preview terrain
// mesh uses (h - minHeight) * unitsPerMeter scene units. Scaling Y by
// unitsPerMeter makes the two formulas identical.
const upm = computed(() => {
  const data = props.terrainData;
  if (!data?.bounds) return 1;
  return computeUnitsPerMeter(data);
});

const MARKER_COLORS = {
  overview: '#ffffff',
  oblique: '#a855f7',
  grid: '#3b82f6',
  road: '#FF6600',
};

// Camera-station overlay: the bake records each station's ENU footprint
// (east/north metres from the AOI centre + height above ground). Convert to
// preview scene coordinates: X = e·upm, Z = -n·upm (north is -Z), Y = local
// terrain height + AGL, both scaled by upm.
const cameraMarkers = computed(() => {
  const data = props.terrainData;
  const stations = group.value?.userData?.bakeStations;
  if (!data?.heightMap || !Array.isArray(stations)) return [];
  const u = upm.value;
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  return stations.map((s) => {
    const x = s.e * u;
    const z = -s.n * u;
    const terrain = sampleHeightAtScene(data, x, z);
    return {
      position: [x, ((terrain - minH) + s.aglM) * u, z],
      color: MARKER_COLORS[s.kind] ?? '#ffffff',
      // Distant overview/oblique cameras get bigger dots so they stay visible.
      radius: s.kind === 'road' ? 0.35 : s.kind === 'grid' ? 0.5 : 1.0,
    };
  });
});

// NOTE: no dispose-on-unmount here, unlike OSMFeatures3D — the group is owned
// by the bake cache in services/google3dTiles.js and must survive detach so
// the export paths (and re-toggling) can reuse it.
</script>

<template>
  <TresGroup v-if="status === 'ready' && show && group" :scale="[1, upm, 1]">
    <primitive :object="group" />
  </TresGroup>
  <TresGroup v-if="status === 'ready' && showCameras">
    <TresMesh v-for="(m, i) in cameraMarkers" :key="i" :position="m.position">
      <TresSphereGeometry :args="[m.radius, 10, 8]" />
      <TresMeshBasicMaterial :color="m.color" />
    </TresMesh>
  </TresGroup>
</template>
