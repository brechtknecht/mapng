<script setup>
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useGoogleTilesStore } from '../../stores/googleTilesStore.js';
import { computeUnitsPerMeter, sampleHeightAtScene } from '../../services/google3dTiles.js';

const props = defineProps({
  terrainData: { required: true },
});

const store = useGoogleTilesStore();
const { group, show, showCameras, status, zOffset } = storeToRefs(store);

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
  user: '#22d3ee', // fly-mode refinement stations
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
      radius: s.kind === 'road' || s.kind === 'user' ? 0.35 : s.kind === 'grid' ? 0.5 : 1.0,
    };
  });
});

// Manual vertical lift: zOffset is real metres; the group's Y is scaled by upm
// (TresGroup scale below), so the parent-space offset is metres·upm.
const offsetY = computed(() => zOffset.value * upm.value);

// Debug overlay for the LAST refinement: the worker reports the scene-space
// footprints of every tile the refine actually ADDED (rects are already in
// scene units, X/Z; the rect's "key" question is WHERE, not how tall). Shown
// with the camera-position overlay so a "nothing changed in front of me"
// report becomes a 5-second diagnosis: the boxes are where new detail landed.
const refineRects = computed(() => {
  const data = props.terrainData;
  const dbg = group.value?.userData?.lastRefineDebug;
  if (!data?.heightMap || !Array.isArray(dbg?.addedRects)) return [];
  const u = upm.value;
  const minH = Number.isFinite(data.minHeight) ? data.minHeight : 0;
  return dbg.addedRects.map((r) => {
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const terrain = sampleHeightAtScene(data, cx, cz);
    return {
      position: [cx, ((terrain - minH) + 15) * u, cz],
      size: [Math.max(0.3, r.maxX - r.minX), 30 * u, Math.max(0.3, r.maxZ - r.minZ)],
    };
  });
});

// NOTE: no dispose-on-unmount here, unlike OSMFeatures3D — the group is owned
// by the bake cache in services/google3dTiles.js and must survive detach so
// the export paths (and re-toggling) can reuse it.
</script>

<template>
  <TresGroup v-if="status === 'ready' && show && group" :position="[0, offsetY, 0]" :scale="[1, upm, 1]">
    <primitive :object="group" />
  </TresGroup>
  <TresGroup v-if="status === 'ready' && showCameras">
    <TresMesh v-for="(m, i) in cameraMarkers" :key="i" :position="m.position">
      <TresSphereGeometry :args="[m.radius, 10, 8]" />
      <TresMeshBasicMaterial :color="m.color" />
    </TresMesh>
    <TresMesh v-for="(r, i) in refineRects" :key="`rr-${i}`" :position="r.position">
      <TresBoxGeometry :args="r.size" />
      <TresMeshBasicMaterial color="#22d3ee" wireframe :depth-test="false" transparent :opacity="0.8" />
    </TresMesh>
  </TresGroup>
</template>
