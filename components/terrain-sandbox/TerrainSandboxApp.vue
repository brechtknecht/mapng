<template>
  <div class="min-h-screen bg-[#0a0a0c] text-zinc-200">
    <!-- Toolbar -->
    <header class="sticky top-0 z-30 bg-[#0a0a0c]/95 backdrop-blur border-b border-white/10">
      <div class="px-4 py-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div class="mr-2">
          <div class="text-sm font-semibold text-white">Terrain Elevation Sandbox</div>
          <a href="/" class="text-[11px] text-teal-400 hover:underline">← back to app</a>
        </div>

        <!-- AOI -->
        <div class="flex items-end gap-2">
          <label class="block text-[11px]">
            <span class="text-zinc-400">Location</span>
            <select :value="presetId" class="mt-0.5 block bg-zinc-800 rounded px-2 py-1 text-xs" @change="selectPreset($event.target.value)">
              <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
              <option value="custom">custom…</option>
            </select>
          </label>
          <label class="block text-[11px]">
            <span class="text-zinc-400">lat</span>
            <input v-model.number="lat" type="number" step="0.0005" class="mt-0.5 w-24 bg-zinc-800 rounded px-2 py-1 text-xs font-mono" @input="presetId = 'custom'" />
          </label>
          <label class="block text-[11px]">
            <span class="text-zinc-400">lng</span>
            <input v-model.number="lng" type="number" step="0.0005" class="mt-0.5 w-24 bg-zinc-800 rounded px-2 py-1 text-xs font-mono" @input="presetId = 'custom'" />
          </label>
          <label class="block text-[11px]">
            <span class="text-zinc-400">tile (m)</span>
            <select v-model.number="sizeM" class="mt-0.5 block bg-zinc-800 rounded px-2 py-1 text-xs">
              <option v-for="s in TILE_SIZES" :key="s" :value="s">{{ s }}</option>
            </select>
          </label>
        </div>

        <!-- Layer / render toggles (live, no re-bake) -->
        <div class="flex items-center gap-3 text-[11px]">
          <label class="flex items-center gap-1.5"><input v-model="showTiles" type="checkbox" /> <span>tiles</span></label>
          <label class="flex items-center gap-1.5"><input v-model="tilesWire" type="checkbox" /> <span>tiles wire</span></label>
          <label class="flex items-center gap-1.5"><input v-model="showGround" type="checkbox" /> <span>ground</span></label>
          <label class="flex items-center gap-1.5"><input v-model="groundWire" type="checkbox" /> <span>ground wire</span></label>
          <label class="flex items-center gap-1.5">
            <span class="text-zinc-400">α</span>
            <input v-model.number="groundOpacity" type="range" min="0.1" max="1" step="0.05" class="w-16 accent-teal-500" />
          </label>
          <label class="flex items-center gap-1.5">
            <span class="text-zinc-400">tex</span>
            <select v-model="terrainTexture" class="bg-zinc-800 rounded px-1.5 py-1">
              <option value="satellite">satellite</option>
              <option value="osm">osm</option>
              <option value="solid">solid</option>
            </select>
          </label>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" @click="resetView">reset view</button>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" @click="showParams = !showParams">{{ showParams ? 'hide' : 'tune' }} params</button>
          <button class="px-2 py-1 rounded" :class="flyMode ? 'bg-teal-600 text-white' : 'bg-white/10 hover:bg-white/20'" @click="toggleFly">fly: {{ flyMode ? 'on' : 'off' }}</button>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-2 ml-auto text-xs">
          <label class="flex items-center gap-1.5 text-[11px]"><input v-model="forceRebake" type="checkbox" /> <span>force rebake</span></label>
          <button class="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40" :disabled="!apiKey || status === 'baking'" @click="bake">Bake</button>
        </div>
      </div>
      <p class="px-4 pb-2 text-[11px] text-zinc-500">
        Same tiles in every pane; each pane derives the drivable <span class="font-mono text-zinc-400">.ter</span> ground a different way.
        Synced camera. Drag <span class="text-zinc-300">tune params</span> to tune a filter live (recomputes just that pane).
      </p>
    </header>

    <!-- Missing key banner -->
    <div v-if="!apiKey" class="m-4 p-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-200">
      <code>VITE_GOOGLE_MAPS_API_KEY</code> is not set — set it in <code>.env.local</code> and reload to bake tiles.
    </div>

    <!-- Preview: one canvas, one scissor viewport per approach, shared camera -->
    <main class="p-3">
      <div class="relative w-full h-[calc(100vh-150px)] rounded-lg overflow-hidden border border-white/10 bg-[#0f0f12]">
        <div ref="host" class="absolute inset-0" />

        <!-- Fly-mode hint -->
        <div v-if="flyMode" class="absolute top-2 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded bg-black/70 text-[11px] text-teal-200 pointer-events-none">
          <span v-if="!pointerLocked">click to look · </span>WASD flies where you look · Shift boost · Esc release
        </div>

        <!-- Pane labels overlaid on the matching grid cell -->
        <div
          class="absolute inset-0 grid pointer-events-none"
          :style="{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)`, gridTemplateRows: `repeat(${grid.rows}, 1fr)` }"
        >
          <div v-for="(p, i) in panes" :key="p.id" class="relative">
            <div class="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/60 text-[10px] font-mono">
              <span class="inline-block w-2 h-2 rounded-sm" :style="{ background: p.css }" />
              <span class="text-zinc-200">{{ p.label }}</span>
              <span v-if="p.relief != null" class="text-zinc-500">· relief {{ p.relief }}m</span>
              <span v-if="p.delta != null" :class="Math.abs(p.delta) > 3 ? 'text-amber-400' : 'text-zinc-500'">· Δdem {{ p.delta > 0 ? '+' : '' }}{{ p.delta }}m</span>
            </div>
          </div>
          <!-- vertical grid separators -->
          <div
            v-for="c in grid.cols - 1" :key="'v' + c"
            class="absolute inset-y-0 w-px bg-white/15"
            :style="{ left: `${(c / grid.cols) * 100}%` }"
          />
          <div
            v-for="r in grid.rows - 1" :key="'h' + r"
            class="absolute inset-x-0 h-px bg-white/15"
            :style="{ top: `${(r / grid.rows) * 100}%` }"
          />
        </div>

        <!-- Live param panel -->
        <div v-if="showParams" class="absolute top-2 right-2 z-20 w-64 max-h-[80%] overflow-y-auto rounded-lg bg-zinc-900/95 border border-white/15 p-3 space-y-3 text-[11px] shadow-xl pointer-events-auto">
          <div v-for="p in filterPanes" :key="p.id" class="space-y-1.5">
            <div class="flex items-center gap-1.5 font-semibold text-zinc-200">
              <span class="inline-block w-2 h-2 rounded-sm" :style="{ background: p.css }" />{{ p.label }}
            </div>
            <label v-for="d in p.mod.meta.params" :key="d.key" class="block">
              <span class="flex justify-between text-zinc-400">
                <span>{{ d.label }}</span><span class="font-mono text-zinc-300">{{ p.params[d.key] }}</span>
              </span>
              <input
                v-model.number="p.params[d.key]" type="range" :min="d.min" :max="d.max" :step="d.step"
                class="w-full accent-teal-500" @input="recompute(p.id)"
              />
            </label>
          </div>
          <p v-if="!field" class="text-zinc-500">Bake first, then tune.</p>
        </div>

        <!-- Status overlay -->
        <div v-if="status !== 'done'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 pointer-events-none">
          <template v-if="status === 'baking'">
            <div class="w-6 h-6 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
            <div class="text-[11px] text-zinc-300">{{ progress || 'baking…' }}</div>
          </template>
          <template v-else-if="status === 'error'">
            <div class="text-[11px] text-red-300 max-w-md">{{ error }}</div>
            <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 pointer-events-auto text-xs" @click="bake">retry</button>
          </template>
          <template v-else>
            <div class="text-[11px] text-zinc-500">idle — click Bake</div>
          </template>
        </div>

        <!-- Stat strip -->
        <div v-if="stats" class="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent p-2 grid grid-cols-4 gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-300 pointer-events-none">
          <div><span class="text-zinc-500">tris</span> {{ fmt(stats.triangles) }}</div>
          <div><span class="text-zinc-500">tiles</span> {{ stats.meshes }}</div>
          <div><span class="text-zinc-500">grid</span> {{ stats.grid }}</div>
          <div><span class="text-zinc-500">tile cover</span> {{ (stats.coverage * 100).toFixed(0) }}%</div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { getTilesApiKey } from '@mapng/pipelines/credentials';
import {
  PRESETS, TILE_SIZES, fmt, disposeGroup, computeGroupStats, bakeTerrainScene,
} from './terrainSandbox.js';
import { buildMeshFromHeights, reliefMeters, meanOffsetVsDem } from './groundRaster.js';
import { FILTERS, defaultParams } from './filters/index.js';
import { loadSatelliteTexture } from './textureLoader.js';

const apiKey = getTilesApiKey();

// --- approach panes ---------------------------------------------------------
// Two built-in baselines + the pluggable filters. Pane index → render layer
// (i+1); layer 0 is the shared tiles. Each pane owns a reactive params object.
const COLORS = {
  dem: 0x8a7f6f, raw: 0xef4444, pmf: 0x4fd1c5, demAnchor: 0xa78bfa, csf: 0xf59e0b,
};
const cssColor = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

const panes = reactive([
  { id: 'dem', label: 'DEM (baseline)', kind: 'builtin', color: COLORS.dem, relief: null, delta: null },
  { id: 'raw', label: 'Raw min-Y (tiles)', kind: 'builtin', color: COLORS.raw, relief: null, delta: null },
  ...FILTERS.map((mod) => ({
    id: mod.meta.id,
    label: mod.meta.label,
    kind: 'filter',
    mod,
    color: COLORS[mod.meta.id] ?? 0x60a5fa,
    params: reactive(defaultParams(mod)),
    relief: null,
    delta: null,
  })),
]);
for (const p of panes) p.css = cssColor(p.color);
const filterPanes = computed(() => panes.filter((p) => p.kind === 'filter'));

const grid = computed(() => {
  const n = panes.length;
  const cols = Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
});

const presetId = ref(PRESETS[0].id);
const lat = ref(PRESETS[0].lat);
const lng = ref(PRESETS[0].lng);
const sizeM = ref(512);

const showTiles = ref(true);
const showGround = ref(true);
const groundWire = ref(false);
const tilesWire = ref(false);
const groundOpacity = ref(1);
const terrainTexture = ref('satellite');
const showParams = ref(false);
const forceRebake = ref(false);
const flyMode = ref(false);
const pointerLocked = ref(false);

const status = ref('idle');
const progress = ref('');
const error = ref('');
const stats = ref(null);
const field = ref(null); // reactive flag for the param panel; data lives in S

const aoi = computed(() => ({ lat: lat.value, lng: lng.value, sizeM: sizeM.value }));

function selectPreset(id) {
  presetId.value = id;
  const p = PRESETS.find((x) => x.id === id);
  if (p) { lat.value = p.lat; lng.value = p.lng; }
}

// --- non-reactive scene state (THREE objects must stay out of Vue reactivity) -
const host = ref(null);
let renderer, scene, camera, controls, raf, resizeObs;
let flyControls = null;
let flyLastT = 0;
const flyKeys = new Set();
const _flyFwd = new THREE.Vector3();
const _flyRight = new THREE.Vector3();
let abortCtrl = null;
const S = { field: null, terrain: null, texture: null, tilesGroup: null, groups: {} };
const DEFAULT_POSE = { px: 70, py: 55, pz: 70, tx: 0, ty: 5, tz: 0 };

// Per-approach heights (scene units) from the shared field.
function computeHeights(pane) {
  const f = S.field;
  if (pane.id === 'dem') return f.demH.slice();
  if (pane.id === 'raw') {
    const out = new Float32Array(f.minH.length);
    for (let i = 0; i < out.length; i++) out[i] = f.covered[i] ? f.minH[i] : f.demH[i];
    return out;
  }
  return pane.mod.apply(f, { ...pane.params });
}

function buildPaneGroup(pane, layer) {
  const heights = computeHeights(pane);
  const mesh = buildMeshFromHeights(S.field, heights, {
    texture: terrainTexture.value === 'solid' ? null : S.texture,
    color: pane.color,
  });
  pane.relief = reliefMeters(S.field, heights);
  pane.delta = meanOffsetVsDem(S.field, heights);
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.mesh = mesh;
  group.traverse((n) => n.layers.set(layer));
  group.visible = showGround.value;
  applyMeshMaterial(mesh);
  return group;
}

function applyMeshMaterial(mesh) {
  const m = mesh.material;
  m.wireframe = groundWire.value;
  m.opacity = groundOpacity.value;
  m.transparent = groundOpacity.value < 1;
  m.needsUpdate = true;
}

function disposePaneGroups() {
  for (const id of Object.keys(S.groups)) {
    const g = S.groups[id];
    scene.remove(g);
    disposeGroup(g);
    delete S.groups[id];
  }
}

// Recompute one pane in place (param tweak) — no re-bake, field is cached.
function recompute(id) {
  if (!S.field) return;
  const pane = panes.find((p) => p.id === id);
  const layer = panes.indexOf(pane) + 1;
  const old = S.groups[id];
  if (old) { scene.remove(old); disposeGroup(old); }
  const group = buildPaneGroup(pane, layer);
  S.groups[id] = group;
  scene.add(group);
}

function buildAllPanes() {
  disposePaneGroups();
  panes.forEach((pane, i) => {
    const group = buildPaneGroup(pane, i + 1);
    S.groups[pane.id] = group;
    scene.add(group);
  });
}

function resize() {
  if (!host.value || !renderer) return;
  const w = host.value.clientWidth || 2;
  const h = host.value.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = (w / grid.value.cols) / (h / grid.value.rows);
  camera.updateProjectionMatrix();
}

function applyVisibility() {
  if (S.tilesGroup) S.tilesGroup.visible = showTiles.value;
  for (const id of Object.keys(S.groups)) S.groups[id].visible = showGround.value;
}

function applyTilesWireframe() {
  if (!S.tilesGroup) return;
  S.tilesGroup.traverse((nd) => {
    if (!nd.isMesh) return;
    const mats = Array.isArray(nd.material) ? nd.material : [nd.material];
    for (const m of mats) if (m) m.wireframe = tilesWire.value;
  });
}

function applyGroundMaterial() {
  for (const id of Object.keys(S.groups)) {
    const mesh = S.groups[id].userData.mesh;
    if (mesh) applyMeshMaterial(mesh);
  }
}

async function bake() {
  if (status.value === 'baking') return;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  const ctrl = abortCtrl;
  status.value = 'baking';
  error.value = '';
  progress.value = '';
  try {
    const res = await bakeTerrainScene(aoi.value, {
      onProgress: (m) => { if (ctrl === abortCtrl) progress.value = m; },
      forceRebake: forceRebake.value,
      signal: ctrl.signal,
      terrainTexture: terrainTexture.value,
    });
    if (ctrl.signal.aborted) { disposeGroup(res.tilesGroup); return; }

    if (S.tilesGroup) { scene.remove(S.tilesGroup); disposeGroup(S.tilesGroup); }
    S.tilesGroup = res.tilesGroup;
    S.tilesGroup.traverse((n) => n.layers.set(0)); // layer 0 = shared by all panes
    S.tilesGroup.visible = showTiles.value;
    scene.add(S.tilesGroup);
    applyTilesWireframe();

    S.field = res.field;
    S.terrain = res.terrain;
    S.texture = res.texture;
    field.value = res.field; // unblocks the param panel

    buildAllPanes();

    stats.value = {
      ...computeGroupStats(res.tilesGroup),
      grid: `${res.field.nx}×${res.field.nz}`,
      coverage: res.coverage,
    };
    status.value = 'done';
  } catch (err) {
    if (ctrl.signal.aborted || err?.name === 'AbortError') return;
    status.value = 'error';
    error.value = err?.message ?? String(err);
    console.error('[terrain-sandbox] bake failed:', err);
  }
}

function resetView() {
  camera.position.set(DEFAULT_POSE.px, DEFAULT_POSE.py, DEFAULT_POSE.pz);
  controls.target.set(DEFAULT_POSE.tx, DEFAULT_POSE.ty, DEFAULT_POSE.tz);
  controls.update();
}

// --- WASD fly camera (debug) -----------------------------------------------
function toggleFly() {
  flyMode.value = !flyMode.value;
  if (flyMode.value) {
    controls.enabled = false; // hand the camera to the fly controls
    window.addEventListener('keydown', onFlyKeyDown);
    window.addEventListener('keyup', onFlyKeyUp);
    flyLastT = performance.now();
  } else {
    flyControls?.unlock();
    flyKeys.clear();
    window.removeEventListener('keydown', onFlyKeyDown);
    window.removeEventListener('keyup', onFlyKeyUp);
    controls.enabled = true;
    // resync orbit target to a point in front of where we ended up
    controls.target.copy(camera.position).add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(20));
    controls.update();
  }
}

function onFlyKeyDown(e) {
  flyKeys.add(e.code);
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
}
function onFlyKeyUp(e) { flyKeys.delete(e.code); }

function updateFly() {
  const now = performance.now();
  const dt = Math.min((now - flyLastT) / 1000, 0.1);
  flyLastT = now;
  if (!flyControls?.isLocked) return;
  const boost = flyKeys.has('ShiftLeft') || flyKeys.has('ShiftRight') ? 4 : 1;
  const speed = 35 * boost * dt; // scene units/sec (scene spans 100 units)
  // Move along the actual look direction (incl. pitch) — fly where you point.
  const fwd = camera.getWorldDirection(_flyFwd);
  const right = _flyRight.crossVectors(fwd, camera.up).normalize();
  if (flyKeys.has('KeyW')) camera.position.addScaledVector(fwd, speed);
  if (flyKeys.has('KeyS')) camera.position.addScaledVector(fwd, -speed);
  if (flyKeys.has('KeyD')) camera.position.addScaledVector(right, speed);
  if (flyKeys.has('KeyA')) camera.position.addScaledVector(right, -speed);
}

// Texture choice changes only the ground material — reload + rebuild meshes,
// no re-bake (the field is cached).
async function onTextureChange() {
  if (!S.field) return;
  if (terrainTexture.value === 'osm') S.texture = await loadSatelliteTexture(S.terrain.osmTextureUrl || S.terrain.satelliteTextureUrl);
  else if (terrainTexture.value === 'satellite') S.texture = await loadSatelliteTexture(S.terrain.satelliteTextureUrl);
  buildAllPanes();
}

onMounted(() => {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f12);
  const grd = new THREE.GridHelper(100, 10, 0x2a2a30, 0x1c1c22);
  grd.layers.enableAll();
  scene.add(grd);

  const ambient = new THREE.AmbientLight(0xffffff, 1.1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(60, 120, 40);
  ambient.layers.enableAll();
  sun.layers.enableAll();
  scene.add(ambient, sun);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  camera.position.set(DEFAULT_POSE.px, DEFAULT_POSE.py, DEFAULT_POSE.pz);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false; // we clear the full canvas once per frame, then draw panes
  host.value.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.minDistance = 2;
  controls.maxDistance = 1500;
  controls.target.set(DEFAULT_POSE.tx, DEFAULT_POSE.ty, DEFAULT_POSE.tz);
  controls.update();

  // Fly camera (pointer-lock + WASD), engaged via the toolbar toggle.
  flyControls = new PointerLockControls(camera, renderer.domElement);
  flyControls.addEventListener('lock', () => { pointerLocked.value = true; });
  flyControls.addEventListener('unlock', () => { pointerLocked.value = false; });
  renderer.domElement.addEventListener('click', () => { if (flyMode.value && !flyControls.isLocked) flyControls.lock(); });

  resize();
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(host.value);

  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (flyMode.value) updateFly();
    const pr = renderer.getPixelRatio();
    const W = renderer.domElement.width / pr;
    const H = renderer.domElement.height / pr;
    const { cols, rows } = grid.value;
    const pw = W / cols;
    const ph = H / rows;

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.clear();
    renderer.setScissorTest(true);

    for (let i = 0; i < panes.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const vx = col * pw;
      const vy = H - (row + 1) * ph; // WebGL viewport origin is bottom-left
      renderer.setViewport(vx, vy, pw, ph);
      renderer.setScissor(vx, vy, pw, ph);
      camera.layers.mask = (1 << 0) | (1 << (i + 1));
      renderer.render(scene, camera);
    }
  };
  loop();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  abortCtrl?.abort();
  resizeObs?.disconnect();
  window.removeEventListener('keydown', onFlyKeyDown);
  window.removeEventListener('keyup', onFlyKeyUp);
  flyControls?.dispose();
  controls?.dispose();
  disposePaneGroups();
  if (S.tilesGroup) disposeGroup(S.tilesGroup);
  renderer?.dispose();
  renderer?.domElement?.remove();
});

watch([showTiles, showGround], applyVisibility);
watch(tilesWire, applyTilesWireframe);
watch([groundWire, groundOpacity], applyGroundMaterial);
watch(terrainTexture, onTextureChange);
</script>
