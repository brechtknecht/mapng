<!--
  /tiles-wall — LOD-wall probe.

  Bakes ONE tiny AOI up an escalating errorTarget/sensor(/quality) ladder,
  sequentially (dispose between runs so memory is comparable), and tabulates:

    • fidelity delivered  — selected tiles, triangles, texture megapixels
    • cost                — bake seconds, worker RSS (sidecar) / JS heap
    • wall signals        — cacheFull, timedOut, missingScenes

  Two questions it answers with numbers instead of guesses:
    1. Where does fidelity PLATEAU? (finer settings stop adding tiles/tris =
       Google's LOD ceiling for this spot — pushing further is wasted.)
    2. Where does the bake WALL? (cacheFull / timeout / missing scenes = the
       memory/budget limit that produces silent partial coverage.)

  Reuses the quality-sandbox bake harness verbatim; adds no pipeline coupling.
-->
<template>
  <div class="min-h-screen bg-zinc-950 text-zinc-100 p-6 font-sans">
    <header class="mb-5">
      <h1 class="text-xl font-semibold">Google 3D Tiles — LOD wall probe</h1>
      <p class="text-sm text-zinc-400 mt-1 max-w-3xl">
        One small AOI, baked up an escalating fidelity ladder. Watch two things:
        the <span class="text-teal-300">fidelity columns</span> stop rising = Google's LOD
        <b>ceiling</b> (finer settings fetch nothing new); a
        <span class="text-amber-300">wall flag</span> turns on = the bake hit its memory/time
        limit and shipped partial coverage.
      </p>
    </header>

    <div v-if="!apiKey" class="mb-4 p-3 rounded-lg bg-red-900/30 border border-red-700/50 text-sm text-red-200">
      <code>VITE_GOOGLE_MAPS_API_KEY</code> is not set — set it in <code>.env.local</code> and reload.
    </div>

    <section class="flex flex-wrap items-end gap-4 mb-5 text-sm">
      <label class="flex flex-col gap-1">
        <span class="text-zinc-400">Location</span>
        <select v-model="presetId" @change="selectPreset" class="bg-zinc-800 rounded px-2 py-1.5 min-w-56">
          <option v-for="p in PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-zinc-400">AOI size (m) — keep small</span>
        <input v-model.number="sizeM" type="number" min="96" max="512" step="32" class="bg-zinc-800 rounded px-2 py-1.5 w-28" />
      </label>
      <label class="flex items-center gap-2 pb-1.5">
        <input v-model="includeCameraTiers" type="checkbox" />
        <span class="text-zinc-400">include high/max (camera-distance) rows — slower</span>
      </label>
      <button
        class="px-4 py-2 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium disabled:opacity-40"
        :disabled="!apiKey || running"
        @click="runLadder"
      >{{ running ? 'Baking…' : 'Run the ladder' }}</button>
      <button
        v-if="running"
        class="px-3 py-2 rounded bg-zinc-700 hover:bg-zinc-600 text-white"
        @click="abort"
      >Stop</button>
      <span v-if="progress" class="text-zinc-400 pb-1">{{ progress }}</span>
    </section>

    <div v-if="verdict" class="mb-5 p-4 rounded-lg bg-zinc-900 border border-zinc-800 text-sm leading-relaxed">
      <div class="font-semibold text-zinc-200 mb-1">Verdict</div>
      <div v-html="verdict"></div>
    </div>

    <div class="overflow-x-auto">
      <table class="text-sm border-collapse min-w-full">
        <thead>
          <tr class="text-left text-zinc-400 border-b border-zinc-700">
            <th class="py-2 pr-4">#</th>
            <th class="py-2 pr-4">settings</th>
            <th class="py-2 pr-4 text-right">stations</th>
            <th class="py-2 pr-4 text-right text-teal-300">selected</th>
            <th class="py-2 pr-4 text-right text-teal-300">tris</th>
            <th class="py-2 pr-4 text-right text-teal-300">tex MP</th>
            <th class="py-2 pr-4 text-right">max tex px</th>
            <th class="py-2 pr-4 text-right">bake s</th>
            <th class="py-2 pr-4 text-right">RSS MB</th>
            <th class="py-2 pr-4 text-right">heap Δ MB</th>
            <th class="py-2 pr-4 text-center text-amber-300">wall</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(r, i) in rows"
            :key="r.label"
            class="border-b border-zinc-800/70"
            :class="{ 'bg-teal-950/30': r.isCeiling, 'bg-amber-950/30': r.hasWall }"
          >
            <td class="py-1.5 pr-4 text-zinc-500">{{ i + 1 }}</td>
            <td class="py-1.5 pr-4 font-mono text-xs">
              {{ r.label }}
              <span v-if="r.isCeiling" class="ml-1 text-teal-300">◀ ceiling</span>
            </td>
            <td class="py-1.5 pr-4 text-right">{{ cell(r, 'stations') }}</td>
            <td class="py-1.5 pr-4 text-right">{{ cell(r, 'selected') }}</td>
            <td class="py-1.5 pr-4 text-right">{{ r.stats ? fmt(r.stats.triangles) : dash(r) }}</td>
            <td class="py-1.5 pr-4 text-right">{{ r.stats ? r.stats.texMegapixels : dash(r) }}</td>
            <td class="py-1.5 pr-4 text-right">{{ cell(r, 'maxTexDim') }}</td>
            <td class="py-1.5 pr-4 text-right">{{ r.bakeMs != null ? (r.bakeMs / 1000).toFixed(1) : dash(r) }}</td>
            <td class="py-1.5 pr-4 text-right">{{ r.wall?.rssMB ?? '—' }}</td>
            <td class="py-1.5 pr-4 text-right">{{ r.heapDeltaMB != null ? r.heapDeltaMB : '—' }}</td>
            <td class="py-1.5 pr-4 text-center">
              <span v-if="r.error" class="text-red-400" :title="r.error">err</span>
              <template v-else-if="r.wall">
                <span v-if="r.wall.cacheFull" class="text-amber-300" title="LRU byte/count budget saturated">cacheFull </span>
                <span v-if="r.wall.timedOut" class="text-amber-300" title="bake budget exhausted — stations skipped">timeout </span>
                <span v-if="r.wall.missingScenes" class="text-amber-300" :title="`${r.wall.missingScenes} selected tiles lost their scene`">holes:{{ r.wall.missingScenes }} </span>
                <span v-if="!r.hasWall" class="text-zinc-600">—</span>
              </template>
              <span v-else class="text-zinc-600">{{ r.status === 'baking' ? '…' : '' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue';
import { PRESETS, bakeVariant, computeGroupStats, disposeGroup, fmt } from '../quality-sandbox/sandbox.js';
import { getTilesApiKey } from '@mapng/pipelines/credentials';

const apiKey = getTilesApiKey();

const presetId = ref(PRESETS[0].id);
const lat = ref(PRESETS[0].lat);
const lng = ref(PRESETS[0].lng);
const sizeM = ref(192); // small test object — fast bakes, isolates the LOD knobs
const includeCameraTiers = ref(false);

const running = ref(false);
const progress = ref('');
const verdict = ref('');
const rows = reactive([]);
let abortCtl = null;

function selectPreset() {
  const p = PRESETS.find((x) => x.id === presetId.value);
  if (p) { lat.value = p.lat; lng.value = p.lng; }
}

// Standard-tier ladder isolates the pure-DATA levers (errorTarget ↓, sensor ↑)
// at a fixed camera distance, so a plateau is unambiguously Google's LOD
// ceiling and not a camera artefact. The optional camera tiers move the
// cameras closer (a different lever) — kept separate so the two don't blur.
function ladder() {
  const base = [
    { label: 'err12 · s1024 (coarse control)', o: { errorTarget: 12, sensorSize: 1024 } },
    { label: 'err5 · s1024 (prod default)', o: { errorTarget: 5, sensorSize: 1024 } },
    { label: 'err3 · s1536', o: { errorTarget: 3, sensorSize: 1536 } },
    { label: 'err2 · s2048', o: { errorTarget: 2, sensorSize: 2048 } },
    { label: 'err1 · s2048 (finest data)', o: { errorTarget: 1, sensorSize: 2048 } },
  ];
  if (includeCameraTiers.value) {
    base.push(
      { label: 'high · err2 · s2048 (closer cams)', o: { quality: 'high', errorTarget: 2, sensorSize: 2048 } },
      { label: 'max · err2 · s2048 (closest cams)', o: { quality: 'max', errorTarget: 2, sensorSize: 2048 } },
    );
  }
  return base;
}

const heapMB = () =>
  (typeof performance !== 'undefined' && performance.memory)
    ? performance.memory.usedJSHeapSize / 1024 ** 2
    : null;

async function runLadder() {
  running.value = true;
  verdict.value = '';
  rows.splice(0, rows.length, ...ladder().map((r) => ({
    label: r.label, options: r.o, status: 'pending',
    stats: null, wall: null, bakeMs: null, heapDeltaMB: null,
    error: '', isCeiling: false, hasWall: false,
  })));
  abortCtl = new AbortController();
  const aoi = { lat: lat.value, lng: lng.value, sizeM: sizeM.value };

  for (let i = 0; i < rows.length; i++) {
    if (abortCtl.signal.aborted) break;
    const r = rows[i];
    r.status = 'baking';
    progress.value = `row ${i + 1}/${rows.length}: ${r.label}`;
    const heap0 = heapMB();
    let group = null;
    try {
      // forceRebake so every rung is a REAL bake at its settings (never a cache
      // hit from a coarser sibling), memoryCache off so groups don't evict.
      const res = await bakeVariant(aoi, r.options, {
        forceRebake: true,
        signal: abortCtl.signal,
        onProgress: (m) => { progress.value = `row ${i + 1}/${rows.length}: ${m}`; },
      });
      group = res.group;
      const stats = computeGroupStats(group);
      const bs = group.userData?.bakeStats ?? {};
      r.stats = stats;
      r.bakeMs = bs.elapsedMs ?? null;
      r.wall = {
        cacheFull: bs.cacheFull === true,
        timedOut: bs.timedOut === true,
        missingScenes: bs.missingScenes ?? 0,
        rssMB: bs.rssMB ?? bs.cacheBytesMB ?? null,
      };
      r.hasWall = r.wall.cacheFull || r.wall.timedOut || r.wall.missingScenes > 0;
      const heap1 = heapMB();
      r.heapDeltaMB = (heap0 != null && heap1 != null) ? Math.round(heap1 - heap0) : null;
      r.status = 'done';
    } catch (err) {
      if (abortCtl.signal.aborted) { r.status = 'aborted'; break; }
      r.error = String(err?.message ?? err);
      r.status = 'error';
      console.error(`[tiles-wall] ${r.label} failed:`, err);
    } finally {
      if (group) disposeGroup(group);
    }
  }

  markCeiling();
  writeVerdict();
  progress.value = '';
  running.value = false;
}

function abort() { abortCtl?.abort(); }

// Ceiling = first rung whose `selected` grew < 3% over the best of the rungs
// BEFORE it (i.e. finer settings stopped fetching new tiles). Only meaningful
// among same-camera (standard-tier) rows.
function markCeiling() {
  let best = 0;
  for (const r of rows) {
    if (!r.stats || r.stats.selected == null) continue;
    const sel = r.stats.selected;
    if (best > 0 && sel <= best * 1.03) { r.isCeiling = true; break; }
    best = Math.max(best, sel);
  }
}

function writeVerdict() {
  const done = rows.filter((r) => r.stats);
  if (!done.length) { verdict.value = 'No successful bakes.'; return; }
  const ceil = rows.find((r) => r.isCeiling);
  const firstWall = rows.find((r) => r.hasWall);
  const top = done[done.length - 1].stats;
  const parts = [];

  if (ceil) {
    const ci = rows.indexOf(ceil);
    parts.push(
      `<b>Ceiling reached at row ${ci + 1}</b> (<span class="font-mono">${ceil.label}</span>): ` +
      `finer settings added &lt;3% tiles — you're at Google's LOD limit for this spot. ` +
      `Rows below it spend time/memory for nothing.`,
    );
  } else {
    parts.push(
      `<b>No ceiling hit</b> — fidelity was still climbing at the finest rung ` +
      `(${fmt(top.selected)} tiles / ${fmt(top.triangles)} tris). ` +
      `Google has more to give here; the binding limit is the wall, not the data.`,
    );
  }

  if (firstWall) {
    const wi = rows.indexOf(firstWall);
    const flags = [
      firstWall.wall.cacheFull && 'cacheFull (LRU budget saturated → later stations starved to coarse LOD)',
      firstWall.wall.timedOut && 'timeout (budget exhausted → stations skipped)',
      firstWall.wall.missingScenes > 0 && `${firstWall.wall.missingScenes} missing scenes (holes)`,
    ].filter(Boolean).join('; ');
    parts.push(`<b class="text-amber-300">Wall at row ${wi + 1}</b>: ${flags}. This is where partial coverage begins.`);
  } else {
    parts.push(`<b>No wall hit</b> — no cacheFull / timeout / missing scenes on any rung at this AOI size. Try a larger AOI or the camera tiers to find it.`);
  }
  verdict.value = parts.join('<br>');
}

// small template helpers
function cell(r, k) { return r.stats && r.stats[k] != null ? fmt(r.stats[k]) : dash(r); }
function dash(r) { return r.status === 'baking' ? '…' : r.status === 'error' ? '×' : '—'; }
</script>
