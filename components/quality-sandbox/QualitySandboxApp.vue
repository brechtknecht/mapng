<template>
  <div class="min-h-screen bg-[#0a0a0c] text-zinc-200">
    <!-- Toolbar -->
    <header class="sticky top-0 z-30 bg-[#0a0a0c]/95 backdrop-blur border-b border-white/10">
      <div class="px-4 py-3 flex flex-wrap items-end gap-x-6 gap-y-3">
        <div class="mr-2">
          <div class="text-sm font-semibold text-white">Quality Sandbox</div>
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

        <!-- Render controls (apply live to all cells, no re-bake) -->
        <div class="flex items-center gap-3 text-[11px]">
          <label class="flex items-center gap-1.5"><input v-model="toneMapping" type="checkbox" /> <span>tone map</span></label>
          <label v-if="toneMapping" class="flex items-center gap-1.5">
            <span class="text-zinc-400">exp</span>
            <input v-model.number="exposure" type="range" min="0.2" max="2" step="0.05" class="w-20 accent-teal-500" />
            <span class="font-mono w-8">{{ exposure.toFixed(2) }}</span>
          </label>
          <label class="flex items-center gap-1.5"><input v-model="wireframe" type="checkbox" /> <span>wireframe</span></label>
          <label class="flex items-center gap-1.5"><input v-model="syncEnabled" type="checkbox" /> <span>sync cam</span></label>
          <button class="px-2 py-1 rounded bg-white/10 hover:bg-white/20" @click="resetView">reset view</button>
        </div>

        <!-- Actions -->
        <div class="flex items-center gap-2 ml-auto text-xs">
          <label class="flex items-center gap-1.5 text-[11px]"><input v-model="forceRebake" type="checkbox" /> <span>force rebake</span></label>
          <button class="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20" @click="addVariant">+ variant</button>
          <button class="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40" :disabled="!apiKey" @click="bakeAll">Bake all</button>
        </div>
      </div>
      <p class="px-4 pb-2 text-[11px] text-zinc-500">
        Same AOI baked with different settings, side by side. Cameras are synced — orbit one, all follow.
        Defaults isolate one lever each: <span class="font-mono text-zinc-400">errorTarget</span> &amp;
        <span class="font-mono text-zinc-400">sensorSize</span> pull finer DATA; the
        <span class="font-mono text-zinc-400">quality</span> tier moves cameras closer; <span class="font-mono text-zinc-400">tone map</span> is render-side only.
      </p>
    </header>

    <!-- Missing key banner -->
    <div v-if="!apiKey" class="m-4 p-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-200">
      <code>VITE_GOOGLE_MAPS_API_KEY</code> is not set — set it in <code>.env.local</code> and reload to bake tiles.
    </div>

    <!-- Comparison grid -->
    <main class="p-3">
      <div class="grid gap-3" :style="{ gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))' }">
        <div v-for="v in variants" :key="v.id" class="h-[460px]">
          <SandboxCell
            :variant="v"
            :aoi="aoi"
            :pose="pose"
            :sync-enabled="syncEnabled"
            :tone-mapping="toneMapping"
            :exposure="exposure"
            :wireframe="wireframe"
            :force-rebake="forceRebake"
            @remove="removeVariant(v.id)"
          />
        </div>
      </div>
      <p v-if="!variants.length" class="text-center text-zinc-500 text-sm py-12">No variants — click “+ variant”.</p>
    </main>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import SandboxCell from './SandboxCell.vue';
import { PRESETS, TILE_SIZES, defaultVariants, mkVariant } from './sandbox.js';
import { getTilesApiKey } from '@mapng/pipelines/credentials';

const apiKey = getTilesApiKey();

const presetId = ref(PRESETS[0].id);
const lat = ref(PRESETS[0].lat);
const lng = ref(PRESETS[0].lng);
const sizeM = ref(512);

const variants = reactive(defaultVariants());

const toneMapping = ref(false);
const exposure = ref(0.8); // matches the real preview's ACES exposure
const wireframe = ref(false);
const syncEnabled = ref(true);
const forceRebake = ref(false);

const DEFAULT_POSE = { px: 55, py: 42, pz: 55, tx: 0, ty: 5, tz: 0 };
const pose = reactive({ ...DEFAULT_POSE, version: 1, source: '' });

const aoi = computed(() => ({ lat: lat.value, lng: lng.value, sizeM: sizeM.value }));

function selectPreset(id) {
  presetId.value = id;
  const p = PRESETS.find((x) => x.id === id);
  if (p) { lat.value = p.lat; lng.value = p.lng; }
}

// Stagger starts so 4 multi-GB sidecar bakes don't all fire at once.
function bakeAll() {
  variants.forEach((v, i) => setTimeout(() => { v.bakeNonce++; }, i * 500));
}

function addVariant() {
  const last = variants[variants.length - 1];
  variants.push(mkVariant('new variant', { ...(last ? last.options : {}) }));
}

function removeVariant(id) {
  const i = variants.findIndex((v) => v.id === id);
  if (i >= 0) variants.splice(i, 1);
}

function resetView() {
  Object.assign(pose, DEFAULT_POSE);
  pose.source = '';
  pose.version++;
}
</script>
