<template>
  <div class="w-full h-full bg-black relative overflow-hidden">
    <div v-if="loadError" class="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gray-900 text-center px-6">
      <p class="text-sm font-semibold text-gray-300">Route preview failed</p>
      <p class="text-xs text-gray-500 max-w-md">{{ loadError }}</p>
    </div>

    <TresCanvas
      v-else
      window-size
      clear-color="#000000"
      shadows
      :tone-mapping="THREE.ACESFilmicToneMapping"
      :tone-mapping-exposure="0.8"
      :renderer="{ logarithmicDepthBuffer: true }"
    >
      <TresPerspectiveCamera :args="cameraArgs" :position="cameraPosition" />
      <CSMLight
        :light-direction="[-1, -0.45, -0.55]"
        :cascades="4"
        :shadow-map-size="4096"
        :max-far="shadowFar"
        :light-intensity="2.8"
        :ambient-intensity="0.05"
        light-color="#ffe6bf"
        ambient-color="#fff5e6"
        :shadow-bias="0.00045"
        :shadow-normal-bias="0.035"
        :light-margin="500"
      />
      <Environment :files="hdrFile" :background="true" :environment-intensity="0.025" />

      <!-- Route centered at the origin so OrbitControls frames the whole thing -->
      <TresGroup :position="rootOffset">
        <TresGroup
          v-for="c in loaded"
          :key="c.index"
          :position="[c.placement.translationM.x, c.placement.translationM.y, c.placement.translationM.z]"
          :scale="[c.placement.scale, c.placement.scale, c.placement.scale]"
        >
          <primitive :object="c.object" />
        </TresGroup>
      </TresGroup>

      <OrbitControls
        make-default
        :min-distance="2"
        :max-distance="maxDistance"
        :max-polar-angle="Math.PI * 0.49"
        :enable-damping="true"
        :damping-factor="0.05"
      />
    </TresCanvas>

    <!-- Loading overlay -->
    <div v-if="loading" class="absolute inset-0 z-10 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
      <div class="text-center text-white">
        <Loader2 :size="40" class="animate-spin text-[#FF6600] mx-auto mb-3" />
        <div class="text-sm font-medium">Assembling route — {{ loaded.length }}/{{ chunks.length }} chunks</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, shallowRef, onMounted, onUnmounted, watch } from 'vue';
import * as THREE from 'three';
import { TresCanvas } from '@tresjs/core';
import { OrbitControls, Environment } from '@tresjs/cientos';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Loader2 } from 'lucide-vue-next';
import CSMLight from './CSMLight.vue';

const props = defineProps({
  chunks: { type: Array, default: () => [] }, // [{ index, blob, placement }]
  worldBounds: { type: Object, default: null }, // { minX, maxX, minZ, maxZ, widthM, depthM }
});

const hdrFile = '/hdr/kloofendal_48d_partly_cloudy_puresky_4k.hdr';

const loaded = shallowRef([]); // [{ index, object, placement }]
const loading = ref(true);
const loadError = ref('');

// Center the route at the origin so the camera/controls frame it.
const rootOffset = computed(() => {
  const b = props.worldBounds;
  if (!b) return [0, 0, 0];
  return [-(b.minX + b.maxX) / 2, 0, -(b.minZ + b.maxZ) / 2];
});

const span = computed(() => {
  const b = props.worldBounds;
  return b ? Math.max(b.widthM || 0, b.depthM || 0, 200) : 1000;
});
const cameraPosition = computed(() => [0, span.value * 0.7, span.value * 0.9]);
const cameraArgs = computed(() => [50, 1, 1, span.value * 6 + 2000]);
const maxDistance = computed(() => span.value * 4 + 1000);
const shadowFar = computed(() => Math.min(span.value * 3 + 1000, 8000));

const loader = new GLTFLoader();

const disposeObject = (obj) => {
  obj?.traverse?.((o) => {
    if (o.geometry) o.geometry.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k in m) {
        if (m[k] && m[k].isTexture) m[k].dispose?.();
      }
      m.dispose?.();
    }
  });
};

const parseChunk = (arrayBuffer) =>
  new Promise((resolve, reject) => loader.parse(arrayBuffer, '', (gltf) => resolve(gltf.scene), reject));

const loadAll = async () => {
  loading.value = true;
  loadError.value = '';
  const out = [];
  try {
    for (const c of props.chunks) {
      if (!c?.blob) continue;
      const buf = await c.blob.arrayBuffer();
      const object = await parseChunk(buf);
      out.push({ index: c.index, object, placement: c.placement });
      loaded.value = [...out]; // progressive reveal
    }
  } catch (err) {
    console.error('RoutePreview load failed', err);
    loadError.value = err?.message || String(err);
  } finally {
    loading.value = false;
  }
};

onMounted(loadAll);

watch(
  () => props.chunks,
  () => {
    loaded.value.forEach((c) => disposeObject(c.object));
    loaded.value = [];
    loadAll();
  },
);

onUnmounted(() => {
  loaded.value.forEach((c) => disposeObject(c.object));
  loaded.value = [];
});
</script>
