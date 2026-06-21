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
        v-if="!flyMode"
        make-default
        :min-distance="2"
        :max-distance="maxDistance"
        :max-polar-angle="Math.PI * 0.49"
        :enable-damping="true"
        :damping-factor="0.05"
      />
      <FlyControls3D
        v-if="flyMode"
        :fov="flyFov"
        @locked-change="flyLocked = $event"
      />
    </TresCanvas>

    <!-- Fly-mode toggle + HUD: ego-camera fly with keyboard + gamepad, same as
         the single-tile preview (route chunks are pre-baked, so no refine). -->
    <template v-if="!loading && !loadError">
      <button
        @click="flyMode = !flyMode"
        :class="[
          'absolute bottom-4 right-4 z-20 flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg shadow-xl backdrop-blur transition-colors',
          flyMode ? 'bg-gray-900/80 hover:bg-black text-white' : 'bg-[#0f766e]/90 hover:bg-[#0c5d56] text-white',
        ]"
      >
        <Plane :size="14" />
        {{ flyMode ? t('route.flyExit') : t('route.fly') }}
      </button>

      <div
        v-if="flyMode"
        class="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2 pointer-events-none"
      >
        <div
          v-if="!flyLocked"
          class="px-3 py-1.5 bg-black/70 backdrop-blur rounded-md text-xs text-white font-medium"
        >
          {{ t('route.flyClickToLook') }}
        </div>
        <div class="flex items-center gap-3 px-4 py-2.5 bg-black/70 backdrop-blur rounded-lg shadow-xl pointer-events-auto">
          <label class="flex items-center gap-1.5 text-[10px] text-gray-300">
            {{ t('preview.flyFov') }}
            <input type="range" min="30" max="110" step="1" v-model.number="flyFov" class="w-20 accent-[#0f766e]" />
            <span class="w-6 text-right tabular-nums">{{ flyFov }}°</span>
          </label>
          <button
            @click="flyMode = false"
            class="px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-[10px] font-medium rounded-md transition-colors"
          >
            {{ t('route.flyExit') }}
          </button>
        </div>
        <div class="px-3 py-1 bg-black/50 backdrop-blur rounded text-[10px] text-gray-300">
          {{ t('route.flyHint') }}
        </div>
      </div>
    </template>

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
import { useI18n } from 'vue-i18n';
import * as THREE from 'three';
import { TresCanvas } from '@tresjs/core';
import { OrbitControls, Environment } from '@tresjs/cientos';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Loader2, Plane } from 'lucide-vue-next';
import CSMLight from './CSMLight.vue';
import FlyControls3D from './FlyControls3D.vue';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps({
  chunks: { type: Array, default: () => [] }, // [{ index, blob, placement }]
  worldBounds: { type: Object, default: null }, // { minX, maxX, minZ, maxZ, widthM, depthM }
  zOffsetM: { type: Number, default: 0 }, // live tile height offset (metres)
});

const hdrFile = '/hdr/kloofendal_48d_partly_cloudy_puresky_4k.hdr';

const loaded = shallowRef([]); // [{ index, object, placement }]
const loading = ref(true);
const loadError = ref('');

// Fly mode: swap OrbitControls for the ego-camera (keyboard + gamepad).
const flyMode = ref(false);
const flyLocked = ref(false);
const flyFov = ref(70);

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

// Live tile height: shift ONLY the GoogleTiles3D subgroup (not the terrain).
// Scene-unit Y = metres ÷ placement.scale (placement.scale = 1/unitsPerMeter).
const applyTileZOffset = () => {
  for (const c of loaded.value) {
    if (!c.tilesNode || !(c.placement?.scale > 0)) continue;
    c.tilesNode.position.y = props.zOffsetM / c.placement.scale;
  }
};

const loadAll = async () => {
  loading.value = true;
  loadError.value = '';
  const out = [];
  try {
    for (const c of props.chunks) {
      if (!c?.blob) continue;
      const buf = await c.blob.arrayBuffer();
      const object = await parseChunk(buf);
      const tilesNode = object.getObjectByName('GoogleTiles3D') || null;
      out.push({ index: c.index, object, placement: c.placement, tilesNode });
      loaded.value = [...out]; // progressive reveal
    }
    applyTileZOffset();
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

// Live drag of the tile height offset from the route panel slider.
watch(() => props.zOffsetM, applyTileZOffset);

onUnmounted(() => {
  loaded.value.forEach((c) => disposeObject(c.object));
  loaded.value = [];
});
</script>
