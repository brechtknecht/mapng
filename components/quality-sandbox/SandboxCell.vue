<template>
  <div class="relative w-full h-full rounded-lg overflow-hidden border border-white/10 bg-[#0f0f12]">
    <!-- WebGL canvas mounts here -->
    <div ref="host" class="absolute inset-0" />

    <!-- Top bar: label + setting chips + actions -->
    <div class="absolute top-0 inset-x-0 p-2 flex items-start justify-between gap-2 bg-gradient-to-b from-black/75 to-transparent pointer-events-none">
      <div class="min-w-0 pointer-events-auto">
        <div class="text-xs font-semibold text-white truncate">{{ variant.label }}</div>
        <div class="mt-1 flex flex-wrap gap-1">
          <span class="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-teal-200 font-mono">q:{{ variant.options.quality }}</span>
          <span class="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-teal-200 font-mono">err:{{ variant.options.errorTarget }}</span>
          <span class="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-teal-200 font-mono">sensor:{{ variant.options.sensorSize }}</span>
          <span v-if="!variant.options.cameraSweep" class="px-1.5 py-0.5 rounded bg-amber-500/20 text-[10px] text-amber-200 font-mono">no-sweep</span>
          <span v-if="variant.options.stripGround" class="px-1.5 py-0.5 rounded bg-sky-500/20 text-[10px] text-sky-200 font-mono">strip→.ter</span>
          <span v-if="!variant.options.weld" class="px-1.5 py-0.5 rounded bg-rose-500/20 text-[10px] text-rose-200 font-mono">no-weld</span>
          <span v-if="!variant.options.conform" class="px-1.5 py-0.5 rounded bg-rose-500/20 text-[10px] text-rose-200 font-mono">no-conform</span>
          <span v-if="!variant.options.roadmask" class="px-1.5 py-0.5 rounded bg-rose-500/20 text-[10px] text-rose-200 font-mono">no-roadmask</span>
        </div>
      </div>
      <div class="flex gap-1 pointer-events-auto">
        <button :class="BTN" title="Edit settings" @click="editing = !editing">⚙</button>
        <button :class="BTN" title="Re-bake this cell" :disabled="variant.status === 'baking'" @click="bake">⟳</button>
        <button :class="[BTN, 'hover:!text-red-300']" title="Remove" @click="$emit('remove')">✕</button>
      </div>
    </div>

    <!-- Inline settings editor -->
    <div v-if="editing" class="absolute top-14 left-2 z-20 w-56 rounded-lg bg-zinc-900/95 border border-white/15 p-3 space-y-2 text-[11px] text-zinc-200 shadow-xl">
      <label class="block">
        <span class="text-zinc-400">Quality tier (camera distance)</span>
        <select v-model="variant.options.quality" class="mt-0.5 w-full bg-zinc-800 rounded px-1.5 py-1">
          <option v-for="q in QUALITY_TIERS" :key="q" :value="q">{{ q }}</option>
        </select>
      </label>
      <label class="block">
        <span class="text-zinc-400">errorTarget (lower = finer)</span>
        <input v-model.number="variant.options.errorTarget" type="number" min="1" max="40" step="1" class="mt-0.5 w-full bg-zinc-800 rounded px-1.5 py-1" />
      </label>
      <label class="block">
        <span class="text-zinc-400">sensorSize (px)</span>
        <select v-model.number="variant.options.sensorSize" class="mt-0.5 w-full bg-zinc-800 rounded px-1.5 py-1">
          <option v-for="s in SENSOR_SIZES" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label class="flex items-center gap-2">
        <input v-model="variant.options.cameraSweep" type="checkbox" />
        <span class="text-zinc-400">camera sweep</span>
      </label>
      <label class="flex items-center gap-2">
        <input v-model="variant.options.stripGround" type="checkbox" />
        <span class="text-zinc-400">strip ground (.ter road, = export)</span>
      </label>
      <div class="pt-1 mt-1 border-t border-white/10 text-zinc-500">assembly passes</div>
      <label class="flex items-center gap-2">
        <input v-model="variant.options.weld" type="checkbox" />
        <span class="text-zinc-400">weld seams</span>
      </label>
      <label class="flex items-center gap-2">
        <input v-model="variant.options.conform" type="checkbox" />
        <span class="text-zinc-400">conform to floor</span>
      </label>
      <label class="flex items-center gap-2">
        <input v-model="variant.options.roadmask" type="checkbox" />
        <span class="text-zinc-400">road-mask snap</span>
      </label>
      <input v-model="variant.label" class="w-full bg-zinc-800 rounded px-1.5 py-1" placeholder="label" />
      <button class="w-full mt-1 rounded bg-teal-600 hover:bg-teal-500 text-white py-1 font-medium" @click="bake(); editing = false">Re-bake</button>
    </div>

    <!-- Status overlay (idle / baking / error) -->
    <div v-if="variant.status !== 'done'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 pointer-events-none">
      <template v-if="variant.status === 'baking'">
        <div class="w-6 h-6 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
        <div class="text-[11px] text-zinc-300">{{ variant.progress || 'baking…' }}</div>
      </template>
      <template v-else-if="variant.status === 'error'">
        <div class="text-[11px] text-red-300 max-w-xs">{{ variant.error }}</div>
        <button :class="[BTN, 'px-2 pointer-events-auto']" @click="bake">retry</button>
      </template>
      <template v-else>
        <div class="text-[11px] text-zinc-500">idle — Bake all, or ⟳</div>
      </template>
    </div>

    <!-- Quality metrics strip. stations/selected are the bug-vs-ceiling tell:
         equal `selected` across different settings = Google's LOD ceiling. -->
    <div v-if="variant.stats" class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2 grid grid-cols-4 gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-300 pointer-events-none">
      <div><span class="text-zinc-500">tris</span> {{ fmt(variant.stats.triangles) }}</div>
      <div><span class="text-zinc-500">verts</span> {{ fmt(variant.stats.vertices) }}</div>
      <div><span class="text-zinc-500">tiles</span> {{ variant.stats.meshes }}</div>
      <div><span class="text-zinc-500">bake</span> {{ variant.bakeMs != null ? (variant.bakeMs / 1000).toFixed(1) + 's' : '—' }}</div>
      <div :class="{ 'text-amber-300': variant.stats.stations != null }"><span class="text-zinc-500">stations</span> {{ variant.stats.stations ?? '—' }}</div>
      <div :class="{ 'text-amber-300': variant.stats.selected != null }"><span class="text-zinc-500">selected</span> {{ variant.stats.selected ?? '—' }}</div>
      <div><span class="text-zinc-500">texMP</span> {{ variant.stats.texMegapixels }}</div>
      <div><span class="text-zinc-500">maxTex</span> {{ variant.stats.maxTexDim }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  bakeVariant, computeGroupStats, disposeGroup, fmt,
  QUALITY_TIERS, SENSOR_SIZES,
} from './sandbox.js';

const props = defineProps({
  variant: { type: Object, required: true },
  aoi: { type: Object, required: true }, // { lat, lng, sizeM }
  pose: { type: Object, required: true }, // shared reactive camera pose
  syncEnabled: { type: Boolean, default: true },
  toneMapping: { type: Boolean, default: false },
  exposure: { type: Number, default: 1 },
  wireframe: { type: Boolean, default: false },
  forceRebake: { type: Boolean, default: false },
});
defineEmits(['remove']);

const host = ref(null);
const editing = ref(false);
const BTN = 'w-6 h-6 grid place-items-center rounded bg-white/10 hover:bg-white/20 text-zinc-200 text-xs leading-none disabled:opacity-40';

let renderer, scene, camera, controls, raf;
let resizeObs;
let currentGroup = null;
let abortCtrl = null;
let applyingRemote = false;
let lastPoseVersion = -1;
const wireMat = new THREE.MeshBasicMaterial({ color: 0x5eead4, wireframe: true });

function applyToneMapping() {
  if (!renderer) return;
  renderer.toneMapping = props.toneMapping ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
  renderer.toneMappingExposure = props.exposure;
  // toneMapping is compiled into the shader — force a recompile so a toggle takes effect.
  markMaterialsDirty();
}

function markMaterialsDirty() {
  currentGroup?.traverse((n) => {
    if (!n.isMesh) return;
    const mats = Array.isArray(n.material) ? n.material : [n.material];
    for (const m of mats) if (m) m.needsUpdate = true;
  });
}

function applyWireframe() {
  if (!currentGroup) return;
  currentGroup.traverse((n) => {
    if (!n.isMesh) return;
    if (props.wireframe) {
      if (!n.userData._origMat) n.userData._origMat = n.material;
      n.material = wireMat;
    } else if (n.userData._origMat) {
      n.material = n.userData._origMat;
      n.userData._origMat = null;
    }
  });
}

// --- shared camera sync -----------------------------------------------------
function publishPose() {
  if (!props.syncEnabled || applyingRemote) return;
  const p = props.pose;
  p.px = camera.position.x; p.py = camera.position.y; p.pz = camera.position.z;
  p.tx = controls.target.x; p.ty = controls.target.y; p.tz = controls.target.z;
  p.version++;
  p.source = props.variant.id;
}

function applyRemotePose() {
  if (!props.syncEnabled) return;
  const p = props.pose;
  if (p.version === lastPoseVersion) return;
  lastPoseVersion = p.version;
  if (p.source === props.variant.id) return; // we authored it
  applyingRemote = true;
  camera.position.set(p.px, p.py, p.pz);
  controls.target.set(p.tx, p.ty, p.tz);
  controls.update();
  applyingRemote = false;
}

function resize() {
  if (!host.value || !renderer) return;
  const w = host.value.clientWidth || 1;
  const h = host.value.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function bake() {
  if (props.variant.status === 'baking') return;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  const ctrl = abortCtrl;
  const v = props.variant;
  v.status = 'baking';
  v.error = '';
  v.progress = '';
  const t0 = performance.now();
  try {
    const { group } = await bakeVariant(props.aoi, { ...v.options }, {
      onProgress: (m) => { if (ctrl === abortCtrl) v.progress = m; },
      forceRebake: props.forceRebake,
      signal: ctrl.signal,
    });
    if (ctrl.signal.aborted) { disposeGroup(group); return; }
    swapGroup(group);
    v.stats = computeGroupStats(group);
    v.bakeMs = Math.round(performance.now() - t0);
    v.status = 'done';
  } catch (err) {
    if (ctrl.signal.aborted || err?.name === 'AbortError') return;
    v.status = 'error';
    v.error = err?.message ?? String(err);
    console.error(`[quality-sandbox] bake failed (${v.label}):`, err);
  }
}

function swapGroup(group) {
  if (currentGroup) { scene.remove(currentGroup); disposeGroup(currentGroup); }
  currentGroup = group;
  scene.add(group);
  applyWireframe();
  applyToneMapping();
}

onMounted(() => {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f12);
  scene.add(new THREE.GridHelper(100, 10, 0x2a2a30, 0x1c1c22)); // marks the [-50,50] AOI box

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  camera.position.set(props.pose.px, props.pose.py, props.pose.pz);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.value.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minDistance = 2;
  controls.maxDistance = 800;
  controls.target.set(props.pose.tx, props.pose.ty, props.pose.tz);
  controls.update();
  controls.addEventListener('change', publishPose);

  applyToneMapping();
  resize();
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(host.value);

  const loop = () => {
    raf = requestAnimationFrame(loop);
    applyRemotePose();
    renderer.render(scene, camera);
  };
  loop();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  abortCtrl?.abort();
  resizeObs?.disconnect();
  controls?.removeEventListener('change', publishPose);
  controls?.dispose();
  if (currentGroup) disposeGroup(currentGroup);
  wireMat.dispose();
  renderer?.dispose();
  renderer?.domElement?.remove();
});

watch(() => props.variant.bakeNonce, (n) => { if (n > 0) bake(); });
watch(() => props.wireframe, applyWireframe);
watch([() => props.toneMapping, () => props.exposure], applyToneMapping);
</script>
