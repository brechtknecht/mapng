<!--
  /road-profile-bench — road elevation profile bench on REAL Google tiles.

  Bake one AOI (cached like the terrain sandbox), draw the road where you
  believe it is (click vertices onto the mesh, or adopt the nearest OSM way),
  and the bench reads the tile surface across that corridor and fits the
  elevation profile two ways:

    • production   — roadProfiles.buildRoadProfiles on the production ground
                     extraction (orange)
    • candidate    — asymmetric Whittaker baseline (cyan): the road is the
                     smooth curve UNDER the cars / trees / decks

  Every observation the fits consume is shown on the mesh (cross-section taps)
  and in the profile chart, so a wrong profile can be traced to the exact tile
  geometry that misled it. No synthetic data anywhere.
-->
<template>
  <div class="min-h-screen bg-[#0a0a0c] text-zinc-200">
    <header class="sticky top-0 z-30 bg-[#0a0a0c]/95 backdrop-blur border-b border-white/10">
      <div class="px-4 py-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div class="mr-2">
          <div class="text-sm font-semibold text-white">Road Profile Bench</div>
          <a href="/" class="text-[11px] text-teal-400 hover:underline">← back to app</a>
        </div>

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

        <div class="flex items-center gap-3 text-[11px]">
          <label class="flex items-center gap-1.5"><input v-model="showTiles" type="checkbox" /> <span>tiles</span></label>
          <label class="flex items-center gap-1.5"><input v-model="tilesWire" type="checkbox" /> <span>tiles wire</span></label>
          <label class="flex items-center gap-1.5"><input v-model="showGround" type="checkbox" /> <span class="text-teal-300">.ter ground surface</span></label>
          <label class="flex items-center gap-1.5"><input v-model="groundWire" type="checkbox" /> <span>ground wire</span></label>
          <label class="flex items-center gap-1.5">
            <span class="text-zinc-400">ground tex</span>
            <select v-model="groundTexture" class="bg-zinc-800 rounded px-1.5 py-1">
              <option value="solid">solid teal</option>
              <option value="satellite">satellite</option>
            </select>
          </label>
          <label class="flex items-center gap-1.5">
            <span class="text-zinc-400">α</span>
            <input v-model.number="groundOpacity" type="range" min="0.1" max="1" step="0.05" class="w-16 accent-teal-500" />
          </label>
          <label class="flex items-center gap-1.5"><input v-model="showOsm" type="checkbox" /> <span>OSM roads</span></label>
          <label class="flex items-center gap-1.5"><input v-model="linesThroughMesh" type="checkbox" /> <span>lines through mesh</span></label>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" @click="resetView">reset view</button>
          <button class="px-2 py-1 rounded" :class="showHelp ? 'bg-teal-700 text-white' : 'bg-white/10 hover:bg-white/20'" @click="showHelp = !showHelp">help</button>
        </div>

        <div class="flex items-center gap-2 text-[11px]">
          <button class="px-2 py-1 rounded" :class="drawMode ? 'bg-amber-600 text-white' : 'bg-white/10 hover:bg-white/20'" @click="drawMode = !drawMode">
            draw: {{ drawMode ? 'on (click mesh)' : 'off' }}
          </button>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" :disabled="!line.length" @click="undoVertex">undo</button>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" :disabled="!line.length" @click="clearLine">clear</button>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" :disabled="!S.terrain" @click="adoptNearestOsm">adopt nearest OSM way</button>
          <label class="block">
            <span class="text-zinc-400">class</span>
            <select v-model="highway" class="ml-1 bg-zinc-800 rounded px-1.5 py-1">
              <option v-for="h in HIGHWAY_CLASSES" :key="h" :value="h">{{ h }} ({{ halfWidthForHighway(h) * 2 }} m)</option>
            </select>
          </label>
        </div>

        <div class="flex items-center gap-2 ml-auto text-xs">
          <label class="flex items-center gap-1.5 text-[11px]"><input v-model="forceRebake" type="checkbox" /> <span>force rebake</span></label>
          <button class="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40" :disabled="!apiKey || status === 'baking'" @click="bake">Bake</button>
        </div>
      </div>
      <p class="px-4 pb-2 text-[11px] text-zinc-500">
        Draw the road onto the tiles (or adopt the nearest OSM way). Grey dots = cross-section taps of the per-cell tile minimum,
        <span class="text-fuchsia-400">magenta</span> = chosen aggregate, <span class="text-zinc-300">grey line</span> = DEM,
        <span class="text-orange-400">orange</span> = production profile, <span class="text-cyan-300">cyan</span> = asymmetric Whittaker baseline (+ ribbon).
        Hover the chart to place the marker on the mesh; click the chart to look there.
      </p>
    </header>

    <div v-if="!apiKey" class="m-4 p-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-200">
      <code>VITE_GOOGLE_MAPS_API_KEY</code> is not set — set it in <code>.env.local</code> and reload to bake tiles.
    </div>

    <main class="p-3 flex gap-3">
      <div class="flex-1 min-w-0 flex flex-col gap-3">
        <div class="relative w-full h-[calc(100vh-420px)] min-h-[360px] rounded-lg overflow-hidden border border-white/10 bg-[#0f0f12]">
          <div ref="host" class="absolute inset-0" :class="drawMode ? 'cursor-crosshair' : ''" />
          <div v-if="status !== 'done'" class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 pointer-events-none">
            <template v-if="status === 'baking'">
              <div class="w-6 h-6 border-2 border-teal-400 border-t-transparent rounded-full animate-spin" />
              <div class="text-[11px] text-zinc-300">{{ progress || 'baking…' }}</div>
            </template>
            <template v-else-if="status === 'error'">
              <div class="text-[11px] text-red-300 max-w-md">{{ error }}</div>
              <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 pointer-events-auto text-xs" @click="bake">retry</button>
            </template>
            <template v-else><div class="text-[11px] text-zinc-500">idle — click Bake</div></template>
          </div>
          <div v-if="status === 'done' && !line.length" class="absolute top-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-black/70 text-[11px] text-amber-200 pointer-events-none">
            press <b>D</b> (or the draw button) and left-click vertices along a road — or adopt the nearest OSM way
          </div>
          <div v-if="showHelp" class="absolute top-2 left-2 z-20 w-72 rounded-lg bg-zinc-900/95 border border-teal-500/30 p-3 text-[11px] space-y-2 shadow-xl">
            <div class="flex items-center justify-between font-semibold text-teal-300">
              <span>How to use</span>
              <button class="text-zinc-400 hover:text-white" @click="showHelp = false">✕</button>
            </div>
            <div class="space-y-1 text-zinc-300">
              <div class="text-zinc-400 font-semibold">Camera (fly)</div>
              <div><b>right mouse</b> hold + move: look around</div>
              <div><b>W A S D</b> move · <b>Q / E</b> down / up · <b>Shift</b> boost</div>
              <div><b>mouse wheel</b>: fly speed ({{ flySpeedM }} m/s)</div>
            </div>
            <div class="space-y-1 text-zinc-300">
              <div class="text-zinc-400 font-semibold">Drawing the road</div>
              <div><b>D</b> toggles draw mode; <b>left click</b> on the mesh adds a vertex</div>
              <div><b>Backspace</b> undo last vertex · <b>Esc</b> leave draw mode</div>
              <div>or <b>adopt nearest OSM way</b> (nearest to the last vertex, or the centre)</div>
            </div>
            <div class="space-y-1 text-zinc-300">
              <div class="text-zinc-400 font-semibold">Reading the result</div>
              <div><span class="text-teal-300">teal surface</span> = production .ter ground (toggle “.ter ground surface”)</div>
              <div><span class="text-orange-400">orange</span> = production profile · <span class="text-cyan-300">cyan</span> = candidate + ribbon</div>
              <div>grey dots = tile heights across the road (taps) · <span class="text-fuchsia-400">magenta</span> = aggregate the fits see</div>
              <div>hover the chart → marker on the mesh · click the chart → fly there</div>
            </div>
          </div>
          <div v-if="hover" class="absolute bottom-2 left-2 px-2 py-1 rounded bg-black/70 text-[10px] font-mono text-zinc-200 pointer-events-none">
            s {{ hover.s.toFixed(1) }} m · obs {{ fmtM(hover.obs) }} · dem {{ fmtM(hover.dem) }} · prod {{ fmtM(hover.prod) }} · cand {{ fmtM(hover.cand) }}
          </div>
        </div>
        <canvas ref="chart" class="w-full h-56 rounded-lg border border-white/10 bg-[#0f0f12]" @mousemove="onChartMove" @mouseleave="hover = null" @click="onChartClick" />
      </div>

      <aside class="w-80 shrink-0 space-y-3 text-[11px]">
        <section class="rounded-lg bg-zinc-900/90 border border-white/10 p-3 space-y-2">
          <div class="font-semibold text-zinc-200">Corridor sampling</div>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>step (m)</span><span class="font-mono">{{ sampling.stepM }}</span></span>
            <input v-model.number="sampling.stepM" type="range" min="0.5" max="5" step="0.5" class="w-full accent-fuchsia-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>taps across</span><span class="font-mono">{{ sampling.taps }}</span></span>
            <input v-model.number="sampling.taps" type="range" min="1" max="15" step="2" class="w-full accent-fuchsia-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>tap span (× half width)</span><span class="font-mono">{{ sampling.tapSpan }}</span></span>
            <input v-model.number="sampling.tapSpan" type="range" min="0.2" max="1.5" step="0.1" class="w-full accent-fuchsia-500" /></label>
          <label class="block"><span class="text-zinc-400">aggregate per sample</span>
            <select v-model="sampling.aggregate" class="mt-0.5 w-full bg-zinc-800 rounded px-1.5 py-1">
              <option value="median">median of taps</option>
              <option value="min">min of taps</option>
              <option value="centre">centre tap</option>
            </select></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>line lift (m)</span><span class="font-mono">{{ liftM }}</span></span>
            <input v-model.number="liftM" type="range" min="0" max="2" step="0.1" class="w-full accent-zinc-400" /></label>
          <div class="flex flex-wrap gap-x-3 gap-y-1">
            <label class="flex items-center gap-1"><input v-model="show.taps" type="checkbox" /> taps</label>
            <label class="flex items-center gap-1"><input v-model="show.obs" type="checkbox" /> aggregate</label>
            <label class="flex items-center gap-1"><input v-model="show.dem" type="checkbox" /> DEM</label>
            <label class="flex items-center gap-1"><input v-model="show.prod" type="checkbox" /> production</label>
            <label class="flex items-center gap-1"><input v-model="show.cand" type="checkbox" /> candidate</label>
            <label class="flex items-center gap-1"><input v-model="show.ribbon" type="checkbox" /> ribbon</label>
          </div>
        </section>

        <section class="rounded-lg bg-zinc-900/90 border border-orange-500/30 p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="font-semibold text-orange-300">Production (buildRoadProfiles)</span>
            <label class="flex items-center gap-1"><input v-model="prodOn" type="checkbox" /> run</label>
          </div>
          <p v-if="prodOn && !S.ground" class="text-zinc-500">needs the production ground extraction — bake to compute it.</p>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>stepM</span><span class="font-mono">{{ prod.stepM }}</span></span>
            <input v-model.number="prod.stepM" type="range" min="1" max="10" step="1" class="w-full accent-orange-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>smoothM</span><span class="font-mono">{{ prod.smoothM }}</span></span>
            <input v-model.number="prod.smoothM" type="range" min="0" max="60" step="5" class="w-full accent-orange-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>outlierM</span><span class="font-mono">{{ prod.outlierM }}</span></span>
            <input v-model.number="prod.outlierM" type="range" min="0.5" max="6" step="0.25" class="w-full accent-orange-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>maxGradePct</span><span class="font-mono">{{ prod.maxGradePct }}</span></span>
            <input v-model.number="prod.maxGradePct" type="range" min="5" max="60" step="1" class="w-full accent-orange-500" /></label>
        </section>

        <section class="rounded-lg bg-zinc-900/90 border border-cyan-500/30 p-3 space-y-2">
          <div class="font-semibold text-cyan-300">Candidate (asymmetric Whittaker)</div>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>cutoff wavelength (m)</span><span class="font-mono">{{ cand.cutoffM }}</span></span>
            <input v-model.number="cand.cutoffM" type="range" min="10" max="200" step="5" class="w-full accent-cyan-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>noise core ± (m)</span><span class="font-mono">{{ cand.coreM }}</span></span>
            <input v-model.number="cand.coreM" type="range" min="0.05" max="2" step="0.05" class="w-full accent-cyan-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>object above (m)</span><span class="font-mono">{{ cand.objectM }}</span></span>
            <input v-model.number="cand.objectM" type="range" min="0.3" max="4" step="0.1" class="w-full accent-cyan-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>object weight</span><span class="font-mono">{{ cand.aboveWeight }}</span></span>
            <input v-model.number="cand.aboveWeight" type="range" min="0" max="1" step="0.01" class="w-full accent-cyan-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>DEM prior weight (gaps)</span><span class="font-mono">{{ cand.priorWeight }}</span></span>
            <input v-model.number="cand.priorWeight" type="range" min="0" max="0.2" step="0.005" class="w-full accent-cyan-500" /></label>
          <label class="block"><span class="flex justify-between text-zinc-400"><span>iterations</span><span class="font-mono">{{ cand.iterations }}</span></span>
            <input v-model.number="cand.iterations" type="range" min="1" max="50" step="1" class="w-full accent-cyan-500" /></label>
        </section>

        <section v-if="metrics" class="rounded-lg bg-zinc-900/90 border border-white/10 p-3 text-[10px] font-mono">
          <div class="grid grid-cols-3 gap-x-2 gap-y-0.5">
            <div class="text-zinc-500" />
            <div class="text-orange-300">prod</div>
            <div class="text-cyan-300">cand</div>
            <template v-for="row in metricRows" :key="row.label">
              <div class="text-zinc-500">{{ row.label }}</div>
              <div>{{ row.prod }}</div>
              <div>{{ row.cand }}</div>
            </template>
          </div>
          <div class="mt-2 text-zinc-400">
            prod vs cand: max {{ metrics.diff.maxAbsM.toFixed(2) }} m · rms {{ metrics.diff.rmsM.toFixed(2) }} m ·
            samples {{ metrics.n }} ({{ metrics.covered }} covered) · length {{ metrics.lengthM.toFixed(0) }} m
          </div>
        </section>
      </aside>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, computed, markRaw, onMounted, onBeforeUnmount, watch } from 'vue';
import * as THREE from 'three';
import { getTilesApiKey } from '@mapng/pipelines/credentials';
import { PRESETS, TILE_SIZES, disposeGroup, bakeTerrainScene } from '../terrain-sandbox/terrainSandbox.js';
import { buildMeshFromHeights } from '@mapng/bake/ground/heightField';
import { extractTileGround, getGroundStrategy } from '@mapng/bake/ground/extractTileGround';
import {
  sampleCorridor, buildDrawnFeature, runProductionProfile, runCandidateProfile, resampleProductionOnto,
  profileMetrics, residualStats, compareProfiles, drivableOsmRoads, osmRoadToSceneLine, nearestOsmRoad,
  halfWidthForHighway, HIGHWAY_CLASSES,
} from './roadProfileBench.js';

const apiKey = getTilesApiKey();

const presetId = ref(PRESETS[0].id);
const lat = ref(PRESETS[0].lat);
const lng = ref(PRESETS[0].lng);
const sizeM = ref(512);
const forceRebake = ref(false);

const showTiles = ref(true);
const tilesWire = ref(false);
const showGround = ref(true);
const groundWire = ref(false);
const groundTexture = ref('solid');
const groundOpacity = ref(0.85);
const showHelp = ref(true);
const flySpeedM = ref(40); // metres per second
const showOsm = ref(true);
const linesThroughMesh = ref(false);
const drawMode = ref(false);
const highway = ref('residential');
const liftM = ref(0.3);
const prodOn = ref(true);

const sampling = reactive({ stepM: 1, taps: 5, tapSpan: 0.8, aggregate: 'median' });
const prod = reactive({ stepM: 5, smoothM: 15, outlierM: 2.5, maxGradePct: 25 });
const cand = reactive({ cutoffM: 40, coreM: 0.4, objectM: 1.0, aboveWeight: 0.02, priorWeight: 0.05, iterations: 20 });
const show = reactive({ taps: true, obs: true, dem: true, prod: true, cand: true, ribbon: true });

const status = ref('idle');
const progress = ref('');
const error = ref('');
const line = ref([]); // drawn centreline, scene units [{x,z}]
const hover = ref(null);
const metrics = ref(null);

const aoi = computed(() => ({ lat: lat.value, lng: lng.value, sizeM: sizeM.value }));
const storageKey = computed(() => `mapng_road_bench_line_${lat.value}_${lng.value}_${sizeM.value}`);
const fmtM = (v) => (Number.isFinite(v) ? `${v.toFixed(2)} m` : '—');

const metricRows = computed(() => {
  const m = metrics.value;
  if (!m) return [];
  const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  return [
    { label: 'bump rms (m)', prod: f(m.prod?.roughnessRmsM, 3), cand: f(m.cand.roughnessRmsM, 3) },
    { label: 'worst bump (m)', prod: f(m.prod?.worstBumpM, 3), cand: f(m.cand.worstBumpM, 3) },
    { label: 'max grade %', prod: f(m.prod?.maxGradePct, 1), cand: f(m.cand.maxGradePct, 1) },
    { label: 'resid p10', prod: f(m.prodRes?.p10), cand: f(m.candRes.p10) },
    { label: 'resid p50', prod: f(m.prodRes?.p50), cand: f(m.candRes.p50) },
    { label: 'resid p90', prod: f(m.prodRes?.p90), cand: f(m.candRes.p90) },
    { label: 'obs above core', prod: m.prodRes?.above ?? '—', cand: m.candRes.above },
    { label: 'obs below core', prod: m.prodRes?.below ?? '—', cand: m.candRes.below },
  ];
});

function selectPreset(id) {
  presetId.value = id;
  const p = PRESETS.find((x) => x.id === id);
  if (p) { lat.value = p.lat; lng.value = p.lng; }
}

// --- non-reactive scene state -------------------------------------------
const host = ref(null);
const chart = ref(null);
let renderer, scene, camera, raf, resizeObs;
let abortCtrl = null;
// Free-look fly camera: right mouse held = look, WASD/QE = move, wheel = speed.
// No pointer lock, so the left button stays free for picking vertices.
const F = { yaw: 0, pitch: 0, keys: new Set(), looking: false, lastX: 0, lastY: 0, lastT: 0 };
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const S = reactive({ terrain: null, ground: null }); // reactive flags only
const N = { field: null, texture: null, tilesGroup: null, groundGroup: null, osmGroup: null, overlay: null, marker: null, upm: 1 };
const R = { corridor: null, prodH: null, candH: null, prodRoad: null };
const DEFAULT_POSE = { px: 70, py: 55, pz: 70, tx: 0, ty: 5, tz: 0 };
const raycaster = new THREE.Raycaster();
let pointerDown = null;

const toSceneY = (absM) => (absM - (S.terrain?.minHeight ?? 0)) * N.upm;

// --- bake ----------------------------------------------------------------
async function bake() {
  if (status.value === 'baking') return;
  abortCtrl?.abort();
  abortCtrl = new AbortController();
  const ctrl = abortCtrl;
  status.value = 'baking'; error.value = ''; progress.value = '';
  try {
    const res = await bakeTerrainScene(aoi.value, {
      onProgress: (m) => { if (ctrl === abortCtrl) progress.value = m; },
      forceRebake: forceRebake.value,
      signal: ctrl.signal,
      terrainTexture: 'satellite',
      maxSeg: 4096, // full .ter resolution — the corridor taps read 1 m cells
    });
    if (ctrl.signal.aborted) { disposeGroup(res.tilesGroup); return; }
    clearSceneGroups();
    N.tilesGroup = res.tilesGroup;
    N.tilesGroup.visible = showTiles.value;
    scene.add(N.tilesGroup);
    applyTilesWireframe();
    N.field = res.field;
    N.texture = res.texture;
    N.upm = res.unitsPerMeter ?? (res.field.unitsPerMeter || 1);
    S.terrain = markRaw(res.terrain);
    S.ground = null;

    progress.value = 'extracting production ground (.ter strategy)…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      S.ground = markRaw(extractTileGround(N.tilesGroup, res.terrain, getGroundStrategy()));
      buildGroundGroup();
    } catch (e) {
      console.warn('[road-bench] production ground extraction failed:', e);
    }
    buildOsmGroup();
    loadLine();
    status.value = 'done';
    recompute();
  } catch (err) {
    if (ctrl.signal.aborted || err?.name === 'AbortError') return;
    status.value = 'error';
    error.value = err?.message ?? String(err);
    console.error('[road-bench] bake failed:', err);
  }
}

function clearSceneGroups() {
  for (const k of ['tilesGroup', 'groundGroup', 'osmGroup', 'overlay']) {
    if (N[k]) { scene.remove(N[k]); disposeGroup(N[k]); N[k] = null; }
  }
}

function buildGroundGroup() {
  if (N.groundGroup) { scene.remove(N.groundGroup); disposeGroup(N.groundGroup); N.groundGroup = null; }
  const g = S.ground, t = S.terrain;
  if (!g) return;
  const fieldLike = { nx: g.width, nz: g.height, segX: g.width - 1, segZ: g.height - 1 };
  const heights = new Float32Array(g.heightMap.length);
  for (let i = 0; i < heights.length; i++) heights[i] = (g.heightMap[i] - t.minHeight) * N.upm;
  const mesh = buildMeshFromHeights(fieldLike, heights, {
    texture: groundTexture.value === 'satellite' ? N.texture : null, color: 0x4fd1c5,
  });
  mesh.material.transparent = true;
  mesh.material.opacity = groundOpacity.value;
  mesh.material.wireframe = groundWire.value;
  mesh.material.polygonOffset = true; // sits under coplanar tile road without flicker
  mesh.material.polygonOffsetFactor = 1;
  mesh.material.polygonOffsetUnits = 1;
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.mesh = mesh;
  group.visible = showGround.value;
  N.groundGroup = group;
  scene.add(group);
}

function buildOsmGroup() {
  if (N.osmGroup) { scene.remove(N.osmGroup); disposeGroup(N.osmGroup); N.osmGroup = null; }
  const t = S.terrain;
  if (!t) return;
  const group = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x8b5cf6, transparent: true, opacity: 0.7, depthTest: false });
  for (const f of drivableOsmRoads(t)) {
    const pts = osmRoadToSceneLine(f, t).map((p) => {
      const h = sampleAt(N.field, p.x, p.z);
      return new THREE.Vector3(p.x, h + 0.2 * N.upm, p.z);
    });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  group.visible = showOsm.value;
  N.osmGroup = group;
  scene.add(group);
}

// Tile min surface (scene units) at a scene point, DEM where uncovered.
function sampleAt(field, x, z) {
  const { nx, nz, minH, covered, demH } = field;
  const gx = Math.round(((x + 50) / 100) * (nx - 1)), gz = Math.round(((z + 50) / 100) * (nz - 1));
  const i = Math.max(0, Math.min(nz - 1, gz)) * nx + Math.max(0, Math.min(nx - 1, gx));
  return covered[i] ? minH[i] : demH[i];
}

// --- drawing + fly camera input ------------------------------------------
function onPointerDown(e) {
  if (e.button === 2) {
    F.looking = true; F.lastX = e.clientX; F.lastY = e.clientY;
    renderer.domElement.setPointerCapture?.(e.pointerId);
    return;
  }
  if (e.button === 0) pointerDown = { x: e.clientX, y: e.clientY };
}
function onPointerMove(e) {
  if (!F.looking) return;
  const dx = e.clientX - F.lastX, dy = e.clientY - F.lastY;
  F.lastX = e.clientX; F.lastY = e.clientY;
  F.yaw -= dx * 0.0035;
  F.pitch = Math.max(-1.55, Math.min(1.55, F.pitch - dy * 0.0035));
  applyCameraPose();
}
function onPointerUp(e) {
  if (e.button === 2) { F.looking = false; renderer.domElement.releasePointerCapture?.(e.pointerId); return; }
  if (!pointerDown) return;
  const moved = Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y);
  pointerDown = null;
  if (moved > 4 || !drawMode.value || !N.tilesGroup) return;
  const hit = pickMesh(e);
  if (!hit) return;
  line.value = [...line.value, { x: hit.x, z: hit.z }];
  saveLine();
  recompute();
}
function pickMesh(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [N.tilesGroup, N.groundGroup?.visible ? N.groundGroup : null].filter(Boolean);
  const hits = raycaster.intersectObjects(targets, true);
  return hits.length ? hits[0].point : null;
}
function undoVertex() { line.value = line.value.slice(0, -1); saveLine(); recompute(); }
function clearLine() { line.value = []; saveLine(); recompute(); }
function adoptNearestOsm() {
  if (!S.terrain) return;
  const anchor = line.value.length ? line.value[line.value.length - 1] : { x: 0, z: 0 };
  const best = nearestOsmRoad(drivableOsmRoads(S.terrain), S.terrain, anchor.x, anchor.z);
  if (!best) return;
  line.value = best.line.filter((p) => Math.abs(p.x) <= 50 && Math.abs(p.z) <= 50);
  if (best.feature.tags?.highway && HIGHWAY_CLASSES.includes(best.feature.tags.highway)) highway.value = best.feature.tags.highway;
  saveLine();
  recompute();
}
function saveLine() {
  try { localStorage.setItem(storageKey.value, JSON.stringify({ line: line.value, highway: highway.value })); } catch { /* ignore */ }
}
function loadLine() {
  try {
    const raw = localStorage.getItem(storageKey.value);
    if (!raw) { line.value = []; return; }
    const parsed = JSON.parse(raw);
    line.value = Array.isArray(parsed?.line) ? parsed.line : [];
    if (parsed?.highway) highway.value = parsed.highway;
  } catch { line.value = []; }
}

// --- profiles ----------------------------------------------------------------
function recompute() {
  if (!N.field || !S.terrain) return;
  if (N.overlay) { scene.remove(N.overlay); disposeGroup(N.overlay); N.overlay = null; }
  metrics.value = null;
  R.corridor = null; R.prodH = null; R.candH = null; R.prodRoad = null;
  if (line.value.length < 2) { drawChart(); return; }

  const halfWidthM = halfWidthForHighway(highway.value);
  const corridor = sampleCorridor(N.field, S.terrain, line.value, {
    stepM: sampling.stepM, halfWidthM, taps: sampling.taps, tapSpan: sampling.tapSpan,
  });
  if (corridor.samples.length < 3) { drawChart(); return; }
  R.corridor = corridor;

  const candidate = runCandidateProfile(corridor, { aggregate: sampling.aggregate, ...cand });
  R.candH = candidate.h;

  if (prodOn.value && S.ground) {
    const feature = buildDrawnFeature(S.terrain, line.value, highway.value);
    R.prodRoad = runProductionProfile(feature, S.terrain, S.ground, { ...prod });
    R.prodH = resampleProductionOnto(R.prodRoad, corridor);
  }

  const n = corridor.samples.length;
  const covered = corridor.samples.filter((s) => Number.isFinite(s.median)).length;
  metrics.value = {
    n, covered, lengthM: corridor.samples[n - 1].s,
    cand: profileMetrics(R.candH, corridor.stepM),
    candRes: residualStats(R.candH, candidate.obs, cand.coreM),
    prod: R.prodH ? profileMetrics(R.prodH, corridor.stepM) : null,
    prodRes: R.prodH ? residualStats(R.prodH, candidate.obs, cand.coreM) : null,
    diff: R.prodH ? compareProfiles(R.prodH, R.candH) : { maxAbsM: NaN, rmsM: NaN },
  };
  buildOverlay(corridor, candidate.obs, halfWidthM);
  drawChart();
}

function lineObject(points, color, opacity = 1) {
  const mat = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: !linesThroughMesh.value });
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), mat);
}

function buildOverlay(corridor, obs, halfWidthM) {
  const group = new THREE.Group();
  const lift = liftM.value * N.upm;
  const S_ = corridor.samples;
  const pt = (s, hAbs) => new THREE.Vector3(s.x, toSceneY(hAbs) + lift, s.z);

  // drawn centreline vertices
  const vtxMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, depthTest: false });
  const vtxGeo = new THREE.SphereGeometry(0.25, 8, 8);
  for (const v of line.value) {
    const m = new THREE.Mesh(vtxGeo, vtxMat);
    m.position.set(v.x, sampleAt(N.field, v.x, v.z) + lift, v.z);
    group.add(m);
  }

  // cross-section taps
  if (show.taps) {
    const pos = [], col = [];
    for (let i = 0; i < S_.length; i++) {
      const s = S_[i];
      const q = S_[Math.min(i + 1, S_.length - 1)], o = S_[Math.max(i - 1, 0)];
      const dl = Math.hypot(q.x - o.x, q.z - o.z) || 1;
      const nx = -(q.z - o.z) / dl, nz = (q.x - o.x) / dl;
      const reach = halfWidthM * sampling.tapSpan * N.upm;
      for (let k = 0; k < s.taps.length; k++) {
        const v = s.taps[k];
        if (!Number.isFinite(v)) continue;
        const f = s.taps.length === 1 ? 0 : (k / (s.taps.length - 1)) * 2 - 1;
        pos.push(s.x + nx * reach * f, toSceneY(v) + lift, s.z + nz * reach * f);
        col.push(0.75, 0.75, 0.75);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    group.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.18, vertexColors: true, depthTest: !linesThroughMesh.value })));
  }

  const seq = (arr) => {
    const out = [];
    for (let i = 0; i < S_.length; i++) if (Number.isFinite(arr[i])) out.push(pt(S_[i], arr[i]));
    return out;
  };
  if (show.obs) group.add(lineObject(seq(obs), 0xd946ef, 0.9));
  if (show.dem) group.add(lineObject(seq(S_.map((s) => s.dem)), 0x9ca3af, 0.8));
  if (show.prod && R.prodH) group.add(lineObject(seq(R.prodH), 0xf97316));
  if (show.cand) group.add(lineObject(seq(R.candH), 0x22d3ee));

  if (show.ribbon) {
    const pos = [], idx = [];
    const w = halfWidthM * N.upm;
    for (let i = 0; i < S_.length; i++) {
      const s = S_[i], q = S_[Math.min(i + 1, S_.length - 1)], o = S_[Math.max(i - 1, 0)];
      const dl = Math.hypot(q.x - o.x, q.z - o.z) || 1;
      const nx = -(q.z - o.z) / dl, nz = (q.x - o.x) / dl;
      const y = toSceneY(R.candH[i]) + 0.05 * N.upm;
      pos.push(s.x + nx * w, y, s.z + nz * w, s.x - nx * w, y, s.z - nz * w);
      if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false })));
  }

  N.overlay = group;
  scene.add(group);
}

// --- chart -----------------------------------------------------------------
let chartMap = null; // { x0, x1, y0, y1, sMin, sMax, hMin, hMax }
function drawChart() {
  const c = chart.value;
  if (!c) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = c.clientWidth, H = c.clientHeight;
  c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  chartMap = null;
  const cor = R.corridor;
  if (!cor) {
    ctx.fillStyle = '#52525b'; ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('profile chart — draw at least two vertices', 12, 20);
    return;
  }
  const S_ = cor.samples;
  const obs = S_.map((s) => (sampling.aggregate === 'min' ? s.min : sampling.aggregate === 'centre' ? s.centre : s.median));
  let hMin = Infinity, hMax = -Infinity;
  const consider = (v) => { if (Number.isFinite(v)) { hMin = Math.min(hMin, v); hMax = Math.max(hMax, v); } };
  for (let i = 0; i < S_.length; i++) {
    consider(S_[i].dem); consider(R.candH[i]); if (R.prodH) consider(R.prodH[i]);
    for (const t of S_[i].taps) if (Number.isFinite(t) && t < hMin + 12) consider(t); // keep tall canopies from flattening the chart
  }
  if (!Number.isFinite(hMin)) { hMin = 0; hMax = 1; }
  const pad = Math.max(0.5, (hMax - hMin) * 0.08);
  hMin -= pad; hMax += pad;
  const x0 = 44, x1 = W - 10, y0 = 8, y1 = H - 18;
  const sMax = S_[S_.length - 1].s || 1;
  const X = (s) => x0 + (s / sMax) * (x1 - x0);
  const Y = (h) => y1 - ((h - hMin) / (hMax - hMin)) * (y1 - y0);
  chartMap = { x0, x1, y0, y1, sMin: 0, sMax, hMin, hMax };

  // axes + grid
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  ctx.fillStyle = '#71717a'; ctx.font = '10px ui-monospace, monospace';
  const hStep = niceStep((hMax - hMin) / 5);
  for (let h = Math.ceil(hMin / hStep) * hStep; h <= hMax; h += hStep) {
    ctx.beginPath(); ctx.moveTo(x0, Y(h)); ctx.lineTo(x1, Y(h)); ctx.stroke();
    ctx.fillText(h.toFixed(hStep < 1 ? 1 : 0), 4, Y(h) + 3);
  }
  const sStep = niceStep(sMax / 8);
  for (let s = 0; s <= sMax; s += sStep) {
    ctx.beginPath(); ctx.moveTo(X(s), y0); ctx.lineTo(X(s), y1); ctx.stroke();
    ctx.fillText(`${s.toFixed(0)}`, X(s) - 6, H - 5);
  }

  // taps
  if (show.taps) {
    ctx.fillStyle = 'rgba(200,200,200,0.45)';
    for (const s of S_) for (const t of s.taps) if (Number.isFinite(t)) ctx.fillRect(X(s.s) - 1, Y(t) - 1, 2, 2);
  }
  const plot = (arr, color, width = 1.5, dash = null) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < S_.length; i++) {
      const v = arr[i];
      if (!Number.isFinite(v)) { pen = false; continue; }
      if (!pen) { ctx.moveTo(X(S_[i].s), Y(v)); pen = true; } else ctx.lineTo(X(S_[i].s), Y(v));
    }
    ctx.stroke(); ctx.setLineDash([]);
  };
  if (show.obs) plot(obs, '#d946ef', 1);
  if (show.dem) plot(S_.map((s) => s.dem), '#9ca3af', 1, [4, 3]);
  if (show.prod && R.prodH) plot(R.prodH, '#f97316', 2);
  if (show.cand) plot(R.candH, '#22d3ee', 2);

  // trust marks from the production profile (red = untrusted)
  if (R.prodRoad?.pts) {
    ctx.fillStyle = 'rgba(248,113,113,0.8)';
    for (const p of R.prodRoad.pts) if (!p.trusted) ctx.fillRect(X(p.s) - 1, y0, 2, 4);
  }
  if (hover.value) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(hover.value.s), y0); ctx.lineTo(X(hover.value.s), y1); ctx.stroke();
  }
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
function chartIndexAt(e) {
  if (!chartMap || !R.corridor) return -1;
  const rect = chart.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const s = ((x - chartMap.x0) / (chartMap.x1 - chartMap.x0)) * chartMap.sMax;
  const S_ = R.corridor.samples;
  let best = 0, bd = Infinity;
  for (let i = 0; i < S_.length; i++) { const d = Math.abs(S_[i].s - s); if (d < bd) { bd = d; best = i; } }
  return best;
}
function onChartMove(e) {
  const i = chartIndexAt(e);
  if (i < 0) { hover.value = null; return; }
  const s = R.corridor.samples[i];
  const obs = sampling.aggregate === 'min' ? s.min : sampling.aggregate === 'centre' ? s.centre : s.median;
  hover.value = { i, s: s.s, obs, dem: s.dem, prod: R.prodH ? R.prodH[i] : NaN, cand: R.candH[i] };
  N.marker.visible = true;
  N.marker.position.set(s.x, toSceneY(Number.isFinite(R.candH[i]) ? R.candH[i] : s.dem) + liftM.value * N.upm, s.z);
  drawChart();
}
function onChartClick(e) {
  const i = chartIndexAt(e);
  if (i < 0) return;
  const s = R.corridor.samples[i];
  const target = new THREE.Vector3(s.x, toSceneY(Number.isFinite(R.candH[i]) ? R.candH[i] : s.dem), s.z);
  // Stand 25 m back along the road direction and 8 m up, looking at the sample.
  const S_ = R.corridor.samples;
  const q = S_[Math.min(i + 1, S_.length - 1)], o = S_[Math.max(i - 1, 0)];
  const dir = new THREE.Vector3(q.x - o.x, 0, q.z - o.z).normalize();
  if (dir.lengthSq() === 0) dir.set(1, 0, 0);
  camera.position.copy(target).addScaledVector(dir, -25 * N.upm).add(new THREE.Vector3(0, 8 * N.upm, 0));
  lookAtPoint(target);
}

// --- view helpers ------------------------------------------------------------
function applyCameraPose() {
  camera.rotation.set(F.pitch, F.yaw, 0, 'YXZ');
}
function lookAtPoint(p) {
  const d = p.clone().sub(camera.position).normalize();
  F.yaw = Math.atan2(-d.x, -d.z);
  F.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
  applyCameraPose();
}
function resetView() {
  camera.position.set(DEFAULT_POSE.px, DEFAULT_POSE.py, DEFAULT_POSE.pz);
  lookAtPoint(new THREE.Vector3(DEFAULT_POSE.tx, DEFAULT_POSE.ty, DEFAULT_POSE.tz));
}
const isTypingTarget = (e) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName);
function onKeyDown(e) {
  if (isTypingTarget(e)) return;
  F.keys.add(e.code); // D is also "move right": a short TAP toggles draw mode (see onKeyUp), holding flies

  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'Escape') drawMode.value = false;
  if (e.code === 'Backspace' && drawMode.value) { e.preventDefault(); undoVertex(); }
  if (e.code === 'F2') drawMode.value = !drawMode.value;
}
let dTapStart = 0;
function onKeyUp(e) {
  F.keys.delete(e.code);
  // A short tap on D (no movement intended) toggles draw mode; holding D flies right.
  if (e.code === 'KeyD' && !isTypingTarget(e)) {
    if (performance.now() - dTapStart < 220) drawMode.value = !drawMode.value;
  }
}
function onKeyDownTap(e) { if (e.code === 'KeyD' && !e.repeat) dTapStart = performance.now(); }
function onWheel(e) {
  e.preventDefault();
  flySpeedM.value = Math.round(Math.max(2, Math.min(400, flySpeedM.value * (e.deltaY > 0 ? 0.85 : 1.18))));
}
function updateFly() {
  const now = performance.now();
  const dt = Math.min((now - F.lastT) / 1000, 0.1);
  F.lastT = now;
  if (!F.keys.size) return;
  const boost = F.keys.has('ShiftLeft') || F.keys.has('ShiftRight') ? 4 : 1;
  const step = flySpeedM.value * N.upm * boost * dt;
  camera.getWorldDirection(_fwd);
  _right.crossVectors(_fwd, camera.up).normalize();
  if (F.keys.has('KeyW')) camera.position.addScaledVector(_fwd, step);
  if (F.keys.has('KeyS')) camera.position.addScaledVector(_fwd, -step);
  if (F.keys.has('KeyD')) camera.position.addScaledVector(_right, step);
  if (F.keys.has('KeyA')) camera.position.addScaledVector(_right, -step);
  if (F.keys.has('KeyE') || F.keys.has('Space')) camera.position.y += step;
  if (F.keys.has('KeyQ')) camera.position.y -= step;
}
function applyTilesWireframe() {
  N.tilesGroup?.traverse((nd) => {
    if (!nd.isMesh) return;
    const mats = Array.isArray(nd.material) ? nd.material : [nd.material];
    for (const m of mats) if (m) m.wireframe = tilesWire.value;
  });
}
function resize() {
  if (!host.value || !renderer) return;
  const w = host.value.clientWidth || 2, h = host.value.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  drawChart();
}

onMounted(() => {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f12);
  scene.add(new THREE.GridHelper(100, 10, 0x2a2a30, 0x1c1c22));
  const ambient = new THREE.AmbientLight(0xffffff, 1.1);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(60, 120, 40);
  scene.add(ambient, sun);

  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 5000);
  camera.position.set(DEFAULT_POSE.px, DEFAULT_POSE.py, DEFAULT_POSE.pz);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.value.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, { width: '100%', height: '100%', display: 'block' });
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKeyDownTap);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  F.lastT = performance.now();
  resetView();

  N.marker = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
  N.marker.visible = false;
  N.marker.renderOrder = 10;
  scene.add(N.marker);

  resize();
  resizeObs = new ResizeObserver(resize);
  resizeObs.observe(host.value);
  const loop = () => { raf = requestAnimationFrame(loop); updateFly(); renderer.render(scene, camera); };
  loop();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  abortCtrl?.abort();
  resizeObs?.disconnect();
  window.removeEventListener('keydown', onKeyDownTap);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  clearSceneGroups();
  renderer?.dispose();
  renderer?.domElement?.remove();
});

watch(showTiles, (v) => { if (N.tilesGroup) N.tilesGroup.visible = v; });
watch(tilesWire, applyTilesWireframe);
watch(showGround, (v) => { if (N.groundGroup) N.groundGroup.visible = v; });
watch(groundOpacity, (v) => { const m = N.groundGroup?.userData.mesh; if (m) { m.material.opacity = v; m.material.needsUpdate = true; } });
watch(groundWire, (v) => { const m = N.groundGroup?.userData.mesh; if (m) { m.material.wireframe = v; m.material.needsUpdate = true; } });
watch(groundTexture, buildGroundGroup);
watch(showOsm, (v) => { if (N.osmGroup) N.osmGroup.visible = v; });
watch([sampling, prod, cand, show, highway, liftM, prodOn, linesThroughMesh], recompute, { deep: true });
</script>
