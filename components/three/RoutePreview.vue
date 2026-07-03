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
      <!-- Drag rectangles on the map → tile-vs-.ter gap reports (copyable). -->
      <AreaInspector
        ref="inspector"
        :chunks="loaded"
        :active="inspectMode && !flyMode"
        :z-offset-m="zOffsetM"
        @areas-changed="inspectAreas = $event"
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

      <!-- Area inspect: drag rectangles over problem spots, copy the gap report. -->
      <button
        v-if="!flyMode"
        @click="inspectMode = !inspectMode"
        :class="[
          'absolute bottom-4 right-28 z-20 flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg shadow-xl backdrop-blur transition-colors',
          inspectMode ? 'bg-[#FF6600]/90 hover:bg-[#e05c00] text-white' : 'bg-gray-900/80 hover:bg-black text-white',
        ]"
        title="Drag rectangles on the map to measure the tile-vs-.ter gap there"
      >
        <Crosshair :size="14" />
        {{ inspectMode ? 'Inspecting — drag a box' : 'Inspect' }}
      </button>

      <!-- Inspected areas panel -->
      <div
        v-if="inspectAreas.length"
        class="absolute bottom-16 right-4 z-20 w-72 max-h-[50%] overflow-auto rounded-lg bg-gray-900/85 backdrop-blur shadow-xl border border-gray-700 p-3 text-white"
      >
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-bold">Inspected areas</span>
          <div class="flex gap-1.5">
            <button
              @click="copyInspectReport"
              class="px-2 py-1 text-[10px] font-bold rounded bg-[#FF6600] hover:bg-[#e05c00] transition-colors"
            >{{ inspectCopied ? 'Copied ✓' : 'Copy report' }}</button>
            <button
              @click="inspector?.clear()"
              class="px-2 py-1 text-[10px] font-medium rounded bg-gray-700 hover:bg-gray-600 transition-colors"
            >Clear</button>
          </div>
        </div>
        <div v-for="a in inspectAreas" :key="a.id" class="flex items-center gap-2 py-1 border-t border-gray-800 text-[10px]">
          <span class="w-2 h-2 rounded-sm shrink-0" :style="{ background: a.colorHex }" />
          <span class="font-medium">{{ a.label }}</span>
          <span class="text-gray-400">{{ a.sizeM.w }}×{{ a.sizeM.d }}m</span>
          <span v-if="a.gapM" class="tabular-nums" :class="Math.abs(a.gapM.p50) > 0.5 ? 'text-orange-400' : 'text-green-400'">
            gap p50 {{ a.gapM.p50 }}m / max {{ a.gapM.max }}m
          </span>
          <span v-else class="text-gray-500">no hits</span>
          <button @click="inspector?.removeArea(a.id)" class="ml-auto text-gray-500 hover:text-white">×</button>
        </div>
      </div>

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

    <!-- Drivable-ground strategy controls — steer the .ter bare-earth strategy
         live in the route preview (same store the export reads). -->
    <div
      v-if="!loading && !loadError && store.apiKey"
      class="absolute top-4 left-4 z-20 w-60 max-h-[80%] overflow-auto rounded-lg bg-white/90 dark:bg-gray-900/85 backdrop-blur shadow-xl border border-gray-200 dark:border-gray-700 p-3"
    >
      <GroundStrategyControls />
      <p class="text-[10px] text-gray-400 dark:text-gray-500 leading-tight mt-2">Live preview of the exported .ter driving surface.</p>
    </div>

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
import { Loader2, Plane, Crosshair } from 'lucide-vue-next';
import CSMLight from './CSMLight.vue';
import FlyControls3D from './FlyControls3D.vue';
import GroundStrategyControls from './GroundStrategyControls.vue';
import AreaInspector from './AreaInspector.vue';
import { TILE_RENDER_BIAS_M } from '@mapng/bake/google3dTiles';
import { extractTileGround } from '@mapng/bake/ground/extractTileGround';
import { buildMeshFromHeights } from '@mapng/bake/ground/heightField';
import { buildRoadProfiles, carveRoadProfiles } from '@mapng/bake/roadProfiles';
import { computeUnitsPerMeter } from '@mapng/bake/googleBakeCore';
import { useGoogleTilesStore } from '../../stores/googleTilesStore.js';

const { t } = useI18n({ useScope: 'global' });
const store = useGoogleTilesStore();

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

// Area inspect: drag rectangles → per-area tile-vs-.ter gap reports.
const inspectMode = ref(false);
const inspector = ref(null);
const inspectAreas = ref([]);
const inspectCopied = ref(false);
const copyInspectReport = async () => {
  const report = {
    type: 'mapng-area-report',
    version: 1,
    when: new Date().toISOString(),
    // Everything a debugging session needs to reproduce the setup.
    groundStrategy: JSON.parse(JSON.stringify(store.ground)),
    zOffsetM: props.zOffsetM,
    renderBiasM: TILE_RENDER_BIAS_M,
    note: 'gapM = tile surface − extracted .ter floor − intended lift; 0 = perfect, >0 tiles float, <0 tiles sink. grid rows run north→south, cols west→east, null = no tile/ground hit.',
    areas: inspectAreas.value.map(({ _overlay, ...a }) => a),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 1));
    inspectCopied.value = true;
    setTimeout(() => { inspectCopied.value = false; }, 1500);
  } catch (e) {
    console.warn('[RoutePreview] clipboard write failed:', e);
  }
};

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
// Includes TILE_RENDER_BIAS_M — the fixed lift that seats the opaque Google tiles
// just above the terrain mesh so they OCCLUDE it instead of z-fighting on roads
// (the single-tile preview applies the same bias; without it the route view sits
// the tiles coplanar with the terrain → the street z-fight you were seeing).
const applyTileZOffset = () => {
  for (const c of loaded.value) {
    if (!c.tilesNode || !(c.placement?.scale > 0)) continue;
    c.tilesNode.position.y = (props.zOffsetM + TILE_RENDER_BIAS_M) / c.placement.scale;
  }
};

// --- Live drivable-ground (.ter) preview --------------------------------------
// Re-extract each chunk's bare-earth ground from its RESIDENT Google tiles (the
// GoogleTiles3D wrapper inside the loaded GLB) and show it in place of the DEM
// terrain mesh, so the preview floor IS the exported .ter and tracks the tiles
// (the geoid drift that made the DEM floor diverge from the tiles disappears).
// extractTileGround's groupInv strips the wrapper's upm scale + z-lift, so this is
// the SAME engine the single-tile preview uses; the result (scene units) drops
// straight into c.object alongside the original terrain mesh. Bound to the shared
// googleTilesStore.ground strategy, so the controls re-extract live.
const GROUND_NAME = '__ter_ground';
const GROUND_MAXSEG = 128; // coarse live grid for snappy re-extraction

const disposeMesh = (m) => {
  if (!m) return;
  m.geometry?.dispose?.();
  const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
  for (const mat of mats) mat?.dispose?.(); // keep the SHARED terrain texture alive
};

const groundStrategyOpts = () => {
  const g = store.ground;
  return {
    filterId: g.filterId,
    filterParams: { ...g.filterParams },
    postId: g.postOn ? g.postId : null,
    postParams: { ...g.postParams },
    ...(Number.isFinite(g.minNormalY) ? { minNormalY: g.minNormalY } : {}),
    maxSeg: GROUND_MAXSEG,
  };
};

// Debug wireframe: one polyline per road profile, floating just above the
// floor. Orange = resolved road (this is what gets carved), cyan = bridge/
// tunnel segment (throughStructure — never carved, raw reference heights),
// red = unresolved. depthTest off so lines read through tiles and decks.
const disposeLines = (grp) => grp?.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
const applyProfileLines = (c, prof) => {
  if (c.profileLines) { c.object.remove(c.profileLines); disposeLines(c.profileLines); c.profileLines = null; }
  if (!store.groundProfilesShow || !prof) return;
  const upm = computeUnitsPerMeter(c._stub) || 1;
  const grp = new THREE.Group();
  grp.name = '__road_profile_lines';
  const liftU = 0.6 * upm; // 0.6 m visual lift off the floor
  for (const r of prof.roads) {
    const pos = new Float32Array(r.pts.length * 3);
    for (let i = 0; i < r.pts.length; i++) {
      pos[i * 3] = r.pts[i].x;
      pos[i * 3 + 1] = (r.pts[i].h - c.minHeight) * upm + liftU;
      pos[i * 3 + 2] = r.pts[i].z;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const color = r.throughStructure ? 0x38bdf8 : (r.resolved ? 0xff6600 : 0xef4444);
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true }));
    line.renderOrder = 999;
    grp.add(line);
  }
  c.object.add(grp);
  c.profileLines = grp;
};

const extractChunkGround = (c) => {
  if (c.groundMesh) { c.object.remove(c.groundMesh); disposeMesh(c.groundMesh); c.groundMesh = null; }
  if (store.ground.source !== 'tiles') { if (c.terrainNode) c.terrainNode.visible = true; return; }
  if (!c.tilesNode || !c.bounds) return;
  if (!c._stub) {
    // Flat DEM stub at the chunk datum: the live extraction only needs bounds
    // (→ unitsPerMeter) + a datum; the filters work on the tile min-surface. The
    // EXPORT uses the real per-chunk DEM (worker-side) for band gating.
    const N = GROUND_MAXSEG + 1;
    c._stub = { bounds: c.bounds, width: N, height: N, minHeight: c.minHeight, heightMap: new Float32Array(N * N).fill(c.minHeight) };
  }
  const mat = Array.isArray(c.terrainNode?.material) ? c.terrainNode.material[0] : c.terrainNode?.material;
  // Full extraction (not just the mesh): the heightMap + rawMin + coveredMask
  // feed the SAME profile carve the export worker runs, so the preview floor —
  // and everything the AreaInspector measures — includes carved underpasses.
  const g = extractTileGround(c.tilesNode, c._stub, groundStrategyOpts());
  let prof = null;
  if (Array.isArray(c.osmRoads) && c.osmRoads.length
      && (store.ground.carveRoads !== false || store.groundProfilesShow)) {
    prof = buildRoadProfiles(c.osmRoads, c._stub, g);
  }
  if (prof && store.ground.carveRoads !== false) {
    const cs = carveRoadProfiles(prof, c._stub, g);
    if (cs.carvedCells > 0) {
      console.info(`[RoutePreview] chunk ${c.index}: carved ${cs.carvedCells} cells (max shift ${cs.maxShiftM}m)`);
    }
  }
  applyProfileLines(c, prof);
  const upm = computeUnitsPerMeter(c._stub) || 1;
  const heights = new Float32Array(g.heightMap.length);
  for (let i = 0; i < heights.length; i++) heights[i] = (g.heightMap[i] - c.minHeight) * upm;
  const field = { nx: g.width, nz: g.height, segX: g.width - 1, segZ: g.height - 1 };
  const mesh = buildMeshFromHeights(field, heights, { texture: mat?.map || null, color: 0x9aa0a6 });
  mesh.name = GROUND_NAME;
  c.object.add(mesh);
  c.groundMesh = mesh;
  if (c.terrainNode) c.terrainNode.visible = false; // ground replaces the DEM floor
};

const applyGround = () => {
  for (const c of loaded.value) {
    try { extractChunkGround(c); }
    catch (e) { console.warn(`[RoutePreview] ground extract failed for chunk ${c.index}:`, e); }
  }
};

let _groundTimer = null;
const scheduleGround = () => { clearTimeout(_groundTimer); _groundTimer = setTimeout(applyGround, 220); };
watch(() => store.ground, scheduleGround, { deep: true });
watch(() => store.groundProfilesShow, scheduleGround);

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
      const terrainNode = object.getObjectByName('center_terrain') || null;
      out.push({
        index: c.index, object, placement: c.placement, tilesNode, terrainNode,
        bounds: c.bounds || null, minHeight: Number(c.minHeight) || 0,
        osmRoads: c.osmRoads || [], groundMesh: null, _stub: null,
      });
      loaded.value = [...out]; // progressive reveal
    }
    applyTileZOffset();
    applyGround();
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
  clearTimeout(_groundTimer);
  loaded.value.forEach((c) => disposeObject(c.object));
  loaded.value = [];
});
</script>
