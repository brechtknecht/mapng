<script setup>
// Live 3D preview of the extracted drivable ground (.ter) — re-extracts the
// bare-earth ground from the cached Google-tiles bake whenever the Scene-settings
// strategy changes, so the user can SEE and tune it against the tiles. Rendered
// in SCENE UNITS (Y already scene units), dropping straight into the preview
// scene next to GoogleTiles3D. Debug overlay only — never touches the export.
import { shallowRef, watch, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useGoogleTilesStore } from '../../stores/googleTilesStore.js';
import { buildGroundMesh } from '@mapng/bake/ground/extractTileGround';

const props = defineProps({ terrainData: { required: true } });
const store = useGoogleTilesStore();
const { group, status, ground, groundPreviewShow } = storeToRefs(store);

const mesh = shallowRef(null);
let timer = null;

function disposeMesh(m) {
  if (!m) return;
  m.geometry?.dispose();
  const mats = Array.isArray(m.material) ? m.material : [m.material];
  for (const mat of mats) { mat?.map?.dispose(); mat?.dispose(); }
}

function rebuild() {
  const g = group.value;
  const data = props.terrainData;
  const live = groundPreviewShow.value
    && status.value === 'ready'
    && g && data?.heightMap
    && ground.value.source === 'tiles';
  if (!live) {
    if (mesh.value) { disposeMesh(mesh.value); mesh.value = null; }
    return;
  }
  try {
    const strategy = {
      filterId: ground.value.filterId,
      filterParams: { ...ground.value.filterParams },
      postId: ground.value.postOn ? ground.value.postId : null,
      postParams: { ...ground.value.postParams },
      maxSeg: 192, // coarser than the export → snappy live re-extraction
    };
    const m = buildGroundMesh(g, data, strategy, { color: 0x34d399 });
    m.material.transparent = true;
    m.material.opacity = 0.7; // see the tiles through the ground to judge alignment
    if (mesh.value) disposeMesh(mesh.value);
    mesh.value = m;
  } catch (e) {
    console.warn('[ground-preview] build failed:', e);
  }
}

// Debounce — extraction is ~100ms+, so coalesce slider drags.
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 200);
}

watch([group, status, () => props.terrainData, groundPreviewShow], schedule, { immediate: true });
watch(ground, schedule, { deep: true });
onUnmounted(() => { clearTimeout(timer); if (mesh.value) disposeMesh(mesh.value); });
</script>

<template>
  <primitive v-if="mesh" :object="mesh" />
</template>
