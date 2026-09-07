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
import { buildMeshFromHeights, buildTileHeightField } from '@mapng/bake/ground/heightField';
import { buildRoadProfiles, carveRoadProfiles } from '@mapng/bake/roadProfiles';
import { conformTilesToFloor } from '@mapng/bake/tileGroundConform';
import { buildGroundMask } from '@mapng/bake/groundMask';
import { computeUnitsPerMeter, sampleHeightAtScene, SCENE_SIZE } from '@mapng/bake/googleBakeCore';

// Fire-and-forget structured log to the turbolog dev bridge (viteTurbologPlugin);
// no-op in prod. Lets the gap heatmap be READ, not only looked at.
const devLog = (stream, message, meta) => {
  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stream, message, meta }),
    }).catch(() => { /* dev-only, best effort */ });
  } catch { /* no fetch / prod */ }
};
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

// Rebuild the chunk DEM (absolute metres, N×M, north-origin) from the GLB's
// `center_terrain` grid mesh (terrainMesh.js: Y = (h − minHeight) × upm, X/Z in
// the ±SCENE_SIZE/2 scene frame). Nearest-vertex splat + hole fill from the
// nearest filled cell; returns a flat plane at the datum only when the chunk
// has no terrain mesh at all (logged).
const demFromTerrainNode = (c, N, M) => {
  const out = new Float32Array(N * M).fill(NaN);
  const pos = c.terrainNode?.geometry?.attributes?.position;
  const upm = computeUnitsPerMeter({ bounds: c.bounds, width: N, height: M }) || 1;
  const half = SCENE_SIZE / 2;
  if (pos && pos.count >= 4) {
    const acc = new Float32Array(N * M), cnt = new Uint16Array(N * M);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const col = Math.round(((x + half) / SCENE_SIZE) * (N - 1));
      const row = Math.round(((z + half) / SCENE_SIZE) * (M - 1));
      if (col < 0 || col >= N || row < 0 || row >= M) continue;
      const k = row * N + col;
      acc[k] += y / upm + c.minHeight; cnt[k]++;
    }
    for (let k = 0; k < out.length; k++) if (cnt[k]) out[k] = acc[k] / cnt[k];
    // Fill holes (coarser mesh than the stub grid) by grassfire dilation.
    let holes = 0;
    for (let k = 0; k < out.length; k++) if (Number.isNaN(out[k])) holes++;
    let guard = 0;
    while (holes > 0 && guard++ < Math.max(N, M)) {
      const next = Float32Array.from(out);
      for (let row = 0; row < M; row++) {
        for (let col = 0; col < N; col++) {
          const k = row * N + col;
          if (!Number.isNaN(out[k])) continue;
          let s = 0, n = 0;
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const r2 = row + dr, c2 = col + dc;
            if (r2 < 0 || r2 >= M || c2 < 0 || c2 >= N) continue;
            const v = out[r2 * N + c2];
            if (!Number.isNaN(v)) { s += v; n++; }
          }
          if (n) { next[k] = s / n; holes--; }
        }
      }
      out.set(next);
    }
    if (holes === 0) return out;
  }
  console.warn(`[RoutePreview] chunk ${c.index}: no usable terrain mesh in the GLB — DEM stub is a flat plane at the datum (${c.minHeight} m)`);
  return new Float32Array(N * M).fill(c.minHeight);
};

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

// Debug heatmap: the conform delta-field's per-cell bend |ΔD| over this chunk,
// measured LIVE against the extracted floor (the same surface the route conform
// seats the tiles onto). Only bending cells are drawn (|ΔD| ≥ 0.05 m/cell):
// green → red over 0.05…0.5 m, blended toward blue when the cell had no measured
// ground (inpainted guess — typically a building interior). Where a red/orange
// patch sits under a bent roof, the delta pass is what bent it, by ~|ΔD| × cells
// spanned. The tiles themselves are untouched — conformTilesToFloor runs
// measureOnly, no positions are allocated or applied.
// Gap heatmap: per-cell vertical difference between the RENDERED tile surface
// (per-cell minimum of the tiles, plus the z-offset + render bias they are
// displayed with) and the floor the car drives on (the shipped/extracted
// ground). Diverging scale over ±store.gapRangeM: red = tiles float ABOVE the
// floor (the car drives inside the mesh), blue = the floor pokes THROUGH the
// tiles, green = coincident. Only tile-covered cells are drawn. Display-only.
const GAP_MAXSEG = 256; // 2 m cells on a 512 m chunk — enough to see a road
const applyGapField = (c, g) => {
  if (c.gapField) { c.object.remove(c.gapField); disposeMesh(c.gapField); c.gapField = null; }
  if (!store.gapFieldShow || !g || !c.tilesNode || !c.bounds || !c._stub) return;
  const upm = computeUnitsPerMeter(c._stub) || 1;
  // Tile surface raster in the chunk frame (scene units above the datum). No
  // normal/band gates: we want what is RENDERED, walls and cars included.
  const field = buildTileHeightField(c.tilesNode, c._stub, upm, { maxSeg: GAP_MAXSEG, minNormalY: 0, belowBandM: 1e6, aboveBandM: 1e6 });
  const floor = { bounds: c.bounds, width: g.width, height: g.height, minHeight: c.minHeight, heightMap: g.heightMap };
  const liftM = (props.zOffsetM || 0) + TILE_RENDER_BIAS_M;
  const range = Math.max(0.1, Number(store.gapRangeM) || 1);
  const { nx, nz } = field;
  const cellU = SCENE_SIZE / (nx - 1);
  const half = SCENE_SIZE / 2;
  const liftU = 0.3 * upm;
  // Road mask (OSM, fixed class widths): the gap ON THE ROAD is what the car
  // feels; off-road cells are context. Reported separately below.
  const roadMask = Array.isArray(c.osmRoads) && c.osmRoads.length ? buildGroundMask(c.osmRoads, c._stub) : null;
  const positions = [], colors = [], indices = [];
  const gaps = [], roadGaps = [];
  // Machine-readable report: a 32×32 grid of mean ROAD gap (NaN where no road
  // cell), the worst road cells with positions, and percentiles.
  const RG = 32;
  const gridSum = new Float64Array(RG * RG), gridN = new Uint32Array(RG * RG);
  const worst = [];
  let vi = 0;
  for (let zi = 0; zi < nz - 1; zi++) {
    for (let xi = 0; xi < nx - 1; xi++) {
      const ni = zi * nx + xi;
      if (!field.covered[ni]) continue;
      const x = (xi / (nx - 1)) * SCENE_SIZE - half;
      const z = (zi / (nz - 1)) * SCENE_SIZE - half;
      const tileM = field.minH[ni] / upm + c.minHeight + liftM;
      const floorM = sampleHeightAtScene(floor, x + cellU / 2, z + cellU / 2);
      const gap = tileM - floorM;
      gaps.push(gap);
      const onRoad = roadMask ? roadMask.sample(x + cellU / 2, z + cellU / 2) >= 0.9 : false;
      if (onRoad) {
        roadGaps.push(gap);
        const gx = Math.min(RG - 1, Math.floor(((x + half) / SCENE_SIZE) * RG));
        const gz = Math.min(RG - 1, Math.floor(((z + half) / SCENE_SIZE) * RG));
        gridSum[gz * RG + gx] += gap; gridN[gz * RG + gx]++;
        if (Math.abs(gap) >= 0.3) worst.push({ x: x + cellU / 2, z: z + cellU / 2, gap });
      }
      // diverging ramp: blue (−range) → green (0) → red (+range)
      const t = Math.max(-1, Math.min(1, gap / range));
      let cr, cg, cb;
      if (t >= 0) { cr = 0.13 + (0.94 - 0.13) * t; cg = 0.77 - (0.77 - 0.2) * t; cb = 0.37 - 0.37 * t; }
      else { const s = -t; cr = 0.13 - 0.13 * s; cg = 0.77 - (0.77 - 0.45) * s; cb = 0.37 + (0.95 - 0.37) * s; }
      const y = (floorM - c.minHeight) * upm + liftU;
      positions.push(x, y, z, x + cellU, y, z, x, y, z + cellU, x + cellU, y, z + cellU);
      for (let k = 0; k < 4; k++) colors.push(cr, cg, cb);
      indices.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
      vi += 4;
    }
  }
  if (!positions.length) return;
  const pct = (arr) => {
    const s = Array.from(arr).sort((a, b) => a - b);
    const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN);
    return {
      n: s.length, p05: q(0.05), p50: q(0.5), p95: q(0.95), min: s[0] ?? NaN, max: s[s.length - 1] ?? NaN,
      aboveP: s.length ? s.filter((v) => v > 0.3).length / s.length : 0,
      belowP: s.length ? s.filter((v) => v < -0.3).length / s.length : 0,
    };
  };
  const all = pct(gaps), road = pct(roadGaps);
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  console.info(
    `[RoutePreview] chunk ${c.index}: tile↔floor gap — road cells ${road.n}: p05 ${f2(road.p05)} / p50 ${f2(road.p50)} / p95 ${f2(road.p95)} m, ` +
    `${(road.aboveP * 100).toFixed(1)}% >0.3 m above, ${(road.belowP * 100).toFixed(1)}% >0.3 m below; all covered cells ${all.n}: p50 ${f2(all.p50)} / p95 ${f2(all.p95)} m`,
  );
  // Turbolog `tile-gap`: the same field as numbers. grid = 32×32 mean road gap
  // (rows north→south, cols west→east, null = no road), ascii = the grid as a
  // glyph map (' ' no road, '.' |gap|<0.15, '+'/'#' tiles 0.15–0.5/>0.5 m above
  // the floor, '-'/'=' floor 0.15–0.5/>0.5 m through the tiles), worst = up to
  // 40 road cells with the largest |gap| (scene x/z + lat/lng).
  const grid = [], ascii = [];
  const b = c.bounds;
  for (let gz = 0; gz < RG; gz++) {
    const row = []; let line = '';
    for (let gx = 0; gx < RG; gx++) {
      const k = gz * RG + gx, n = gridN[k];
      const v = n ? gridSum[k] / n : null;
      row.push(v == null ? null : Math.round(v * 100) / 100);
      line += v == null ? ' ' : Math.abs(v) < 0.15 ? '.' : v > 0.5 ? '#' : v > 0 ? '+' : v < -0.5 ? '=' : '-';
    }
    grid.push(row); ascii.push(line);
  }
  worst.sort((p, q2) => Math.abs(q2.gap) - Math.abs(p.gap));
  const toLatLng = (x, z) => ({
    lat: b.north - ((z + half) / SCENE_SIZE) * (b.north - b.south),
    lng: b.west + ((x + half) / SCENE_SIZE) * (b.east - b.west),
  });
  const worstOut = worst.slice(0, 40).map((w) => ({ x: +w.x.toFixed(1), z: +w.z.toFixed(1), ...toLatLng(w.x, w.z), gapM: +w.gap.toFixed(2) }));
  devLog('tile-gap',
    `chunk ${c.index}: road gap p50 ${f2(road.p50)} / p95 ${f2(road.p95)} m, ${(road.aboveP * 100).toFixed(1)}% >0.3 m above, ${(road.belowP * 100).toFixed(1)}% >0.3 m below (${road.n} road cells, floor=${c._groundSource})`,
    {
      chunk: c.index, floorSource: c._groundSource, liftM: +liftM.toFixed(2), cellM: +(SCENE_SIZE / (nx - 1) / upm).toFixed(2),
      road: { ...road, p05: +f2(road.p05), p50: +f2(road.p50), p95: +f2(road.p95), min: +f2(road.min), max: +f2(road.max) },
      all: { ...all, p05: +f2(all.p05), p50: +f2(all.p50), p95: +f2(all.p95), min: +f2(all.min), max: +f2(all.max) },
      gridCellM: +(SCENE_SIZE / RG / upm).toFixed(1), grid, ascii, worst: worstOut,
      legend: "gap = rendered tile surface − drive floor; + tiles above floor (car inside mesh), − floor through tiles. ascii: ' ' no road, '.' |gap|<0.15, '+' 0.15–0.5 above, '#' >0.5 above, '-' 0.15–0.5 below, '=' >0.5 below; rows north→south, cols west→east",
    });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
  mesh.name = '__gap_field';
  mesh.renderOrder = 5;
  c.object.add(mesh);
  c.gapField = mesh;
};
const refreshGapFields = () => {
  for (const c of loaded.value) {
    try { applyGapField(c, c._g); } catch (e) { console.warn(`[RoutePreview] gap field failed for chunk ${c.index}:`, e); }
  }
};

const BEND_MIN_M = 0.05; // draw threshold — below this the field can't visibly bend anything
const BEND_MAX_M = 0.5;  // full-red saturation, metres per 6 m cell
const applyConformField = (c, g) => {
  if (c.conformField) { c.object.remove(c.conformField); disposeMesh(c.conformField); c.conformField = null; }
  if (!store.conformFieldShow || !g || !c.tilesNode || !c.bounds) return;
  // Tile soup in the conform's frame — group-local X/Z in scene units, Y in
  // metres — using the same localisation heightField.js uses (strips the preview
  // wrapper's upm scale + z-lift, correct regardless of parenting).
  c.tilesNode.updateMatrixWorld(true);
  const groupInv = c.tilesNode.matrixWorld.clone().invert();
  const localMat = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const soup = [];
  c.tilesNode.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes?.position) return;
    const pos = node.geometry.attributes.position;
    localMat.multiplyMatrices(groupInv, node.matrixWorld);
    const arr = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(localMat);
      arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
    }
    let index = node.geometry.index?.array;
    if (!index) {
      index = new Uint32Array(pos.count);
      for (let i = 0; i < pos.count; i++) index[i] = i;
    }
    soup.push({ positions: arr, index });
  });
  if (!soup.length) return;
  // The floor the route conform targets IS the extracted tile ground (.ter);
  // datum stays the chunk's (g.heightMap is absolute metres on the stub grid).
  const data = { bounds: c.bounds, width: g.width, height: g.height, minHeight: c.minHeight, heightMap: g.heightMap };
  const r = conformTilesToFloor(soup, data, { measureOnly: true });
  console.info(
    `[RoutePreview] chunk ${c.index}: conform field ${r.fieldN}×${r.fieldN} (${r.cellsFilled} measured cells), ` +
    `bend |ΔD| p50 ${r.fieldGradP50M.toFixed(2)}/p95 ${r.fieldGradP95M.toFixed(2)}/max ${r.fieldGradMaxM.toFixed(2)} m/cell`,
  );
  const upm = computeUnitsPerMeter(c._stub) || 1;
  const n = r.fieldN;
  const cellU = SCENE_SIZE / n;
  const half = SCENE_SIZE / 2;
  const liftU = 0.5 * upm; // float the quads off the ground so they read
  const positions = [], colors = [], indices = [];
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      const ci = cz * n + cx;
      const bend = r.fieldGrad[ci];
      if (bend < BEND_MIN_M) continue;
      const t = Math.min(1, (bend - BEND_MIN_M) / (BEND_MAX_M - BEND_MIN_M));
      // green → yellow → red ramp; inpainted cells pull toward blue so building
      // interiors (no measured ground) are tellable from measured wobble.
      let cr, cg, cb;
      if (t < 0.5) { const s = t * 2; cr = 0.13 + (0.98 - 0.13) * s; cg = 0.77 + (0.83 - 0.77) * s; cb = 0.37 + (0.15 - 0.37) * s; }
      else { const s = (t - 0.5) * 2; cr = 0.98 - (0.98 - 0.94) * s; cg = 0.83 - (0.83 - 0.27) * s; cb = 0.15 + (0.27 - 0.15) * s; }
      if (!r.fieldFilled[ci]) { cr = cr * 0.55 + 0.23 * 0.45; cg = cg * 0.55 + 0.51 * 0.45; cb = cb * 0.55 + 0.96 * 0.45; }
      const x0 = -half + cx * cellU, x1 = x0 + cellU;
      const z0 = -half + cz * cellU, z1 = z0 + cellU;
      const y = (sampleHeightAtScene(data, (x0 + x1) / 2, (z0 + z1) / 2) - c.minHeight) * upm + liftU;
      const base = positions.length / 3;
      positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
      for (let k = 0; k < 4; k++) colors.push(cr, cg, cb);
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  if (!indices.length) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.55, depthTest: false, side: THREE.DoubleSide,
  }));
  mesh.name = '__conform_field_debug';
  mesh.renderOrder = 998; // over the tiles, under the profile lines (999)
  c.object.add(mesh);
  c.conformField = mesh;
};

const extractChunkGround = (c) => {
  if (c.groundMesh) { c.object.remove(c.groundMesh); disposeMesh(c.groundMesh); c.groundMesh = null; }
  if (c.conformField) { c.object.remove(c.conformField); disposeMesh(c.conformField); c.conformField = null; }
  if (c.gapField) { c.object.remove(c.gapField); disposeMesh(c.gapField); c.gapField = null; }
  if (store.ground.source !== 'tiles') { if (c.terrainNode) c.terrainNode.visible = true; return; }
  if (!c.tilesNode || !c.bounds) return;
  // Preferred: the WORKER's floor — extracted + carved on the real DEM at full
  // .ter resolution, i.e. exactly the surface the terSnap seated the road mesh
  // on. Showing anything else here (a live re-extraction on a coarse grid with
  // a flat DEM stub) puts a floor under the tiles that the mesh was never
  // fitted to, and the mismatch reads as "the ground does not map at all".
  const workerGround = c.ground?.heightMap && c.ground.width && c.ground.height ? c.ground : null;
  if (!c._stub || (workerGround && c._stub.width !== workerGround.width)) {
    // Terrain stub for the chunk: bounds (→ unitsPerMeter), datum, and a DEM.
    // With a worker ground the stub takes ITS grid so the profile/area tools
    // line up. Otherwise the DEM is rebuilt from the chunk's own terrain mesh
    // in the GLB — NEVER a flat plane at the datum: the live extraction falls
    // back to the stub wherever tiles do not cover, and a flat stub put those
    // cells at the chunk's minHeight, so neighbouring chunks with different
    // datums (32.7 m vs 51.6 m on one Berlin route) showed a 19 m step that
    // existed nowhere but in this preview.
    const N = workerGround ? workerGround.width : GROUND_MAXSEG + 1;
    const M = workerGround ? workerGround.height : GROUND_MAXSEG + 1;
    c._stub = { bounds: c.bounds, width: N, height: M, minHeight: c.minHeight, heightMap: demFromTerrainNode(c, N, M) };
  }
  const mat = Array.isArray(c.terrainNode?.material) ? c.terrainNode.material[0] : c.terrainNode?.material;
  let g;
  let prof = null;
  if (workerGround) {
    g = {
      heightMap: workerGround.heightMap,
      coveredMask: workerGround.coveredMask ?? null,
      width: workerGround.width,
      height: workerGround.height,
    };
    if (c._groundSource !== 'worker') console.info(`[RoutePreview] chunk ${c.index}: floor = worker ground (${g.width}×${g.height}, carved in the bake)`);
    c._groundSource = 'worker';
    // Debug profile lines only — the carve already happened in the worker.
    if (store.groundProfilesShow && Array.isArray(c.osmRoads) && c.osmRoads.length) {
      prof = buildRoadProfiles(c.osmRoads, c._stub, g);
    }
  } else {
    // Fallback (restored/cached bake without a shipped ground): full live
    // extraction — heightMap + rawMin + coveredMask feed the SAME profile carve
    // the export worker runs, so the preview floor includes carved underpasses.
    g = extractTileGround(c.tilesNode, c._stub, groundStrategyOpts());
    if (c._groundSource !== 'live') console.info(`[RoutePreview] chunk ${c.index}: floor = live re-extraction (no worker ground shipped)`);
    c._groundSource = 'live';
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
  }
  applyProfileLines(c, prof);
  applyConformField(c, g);
  c._g = g; // kept for overlay-only refreshes (gap heatmap range / z-offset)
  applyGapField(c, g);
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
watch(() => store.conformFieldShow, scheduleGround);
watch(() => [store.gapFieldShow, store.gapRangeM, props.zOffsetM], refreshGapFields);

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
        osmRoads: c.osmRoads || [], ground: c.ground || null, groundMesh: null, conformField: null, gapField: null, _stub: null,
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
