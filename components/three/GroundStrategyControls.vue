<template>
  <!-- Drivable ground (.ter) strategy — the bare-earth filter + post-process used
       by the BeamNG export. Bound to googleTilesStore.ground, the single source of
       truth shared by the single-tile preview AND the route export (getGroundStrategy).
       Same controls, usable from the route preview so the strategy can be steered
       there without bouncing to single-tile mode. -->
  <div class="space-y-2">
    <label class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1 font-medium mb-1">
      <Mountain :size="12" /> Drivable ground (.ter)
    </label>

    <!-- source: tiles vs DEM -->
    <div class="flex bg-gray-100 dark:bg-gray-800 rounded-md p-0.5 border border-gray-200 dark:border-gray-700">
      <button
        @click="store.setGroundSource('tiles')"
        :class="['flex-1 text-[10px] py-1 rounded transition-colors', store.ground.source === 'tiles' ? 'bg-[#FF6600] text-white shadow-sm font-medium' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white']"
      >From Google tiles</button>
      <button
        @click="store.setGroundSource('dem')"
        :class="['flex-1 text-[10px] py-1 rounded transition-colors', store.ground.source === 'dem' ? 'bg-[#FF6600] text-white shadow-sm font-medium' : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white']"
      >DEM (legacy)</button>
    </div>

    <template v-if="store.ground.source === 'tiles'">
      <!-- bare-earth filter -->
      <div class="flex items-center gap-2">
        <label class="text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap w-12">filter</label>
        <select
          :value="store.ground.filterId"
          @change="store.setGroundFilter($event.target.value)"
          class="flex-1 text-[10px] px-1 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
        >
          <option v-for="f in store.groundFilters" :key="f.meta.id" :value="f.meta.id">{{ f.meta.label }}</option>
        </select>
      </div>
      <div v-for="d in filterMeta.params" :key="d.key" class="flex items-center gap-2">
        <label class="text-[10px] text-gray-500 dark:text-gray-400 truncate w-16" :title="d.label">{{ d.short || d.label }}</label>
        <input
          type="range" :min="d.min" :max="d.max" :step="d.step"
          :value="store.ground.filterParams[d.key]"
          @input="store.setGroundFilterParam(d.key, $event.target.valueAsNumber)"
          class="flex-1 accent-[#FF6600]"
        />
        <span class="text-[10px] text-gray-400 dark:text-gray-500 w-8 text-right tabular-nums">{{ store.ground.filterParams[d.key] }}</span>
      </div>

      <!-- rasteriser steep-triangle gate: facade skirts / LOD-seam walls must not
           seed the per-cell min with below-street heights. 0 = off (legacy). -->
      <div class="flex items-center gap-2">
        <label class="text-[10px] text-gray-500 dark:text-gray-400 truncate w-16" title="Skip triangles steeper than this |normal.y| (0 = off)">steep cut</label>
        <input
          type="range" min="0" max="0.95" step="0.05"
          :value="store.ground.minNormalY"
          @input="store.setGroundMinNormalY($event.target.valueAsNumber)"
          class="flex-1 accent-[#FF6600]"
        />
        <span class="text-[10px] text-gray-400 dark:text-gray-500 w-8 text-right tabular-nums">{{ store.ground.minNormalY }}</span>
      </div>

      <!-- worker-side road snap: flatten the tile road mesh onto the extracted
           .ter ground (route bakes only — changes baked geometry, re-bakes). -->
      <label class="flex items-center gap-2 cursor-pointer pt-1">
        <div class="relative">
          <input type="checkbox" :checked="store.ground.snapRoads" @change="store.setGroundSnapRoads($event.target.checked)" class="peer sr-only" />
          <div class="w-7 h-4 bg-gray-200 rounded-full peer peer-checked:bg-[#FF6600] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-full"></div>
        </div>
        <span class="text-[10px] text-gray-700 dark:text-gray-300" title="Snap the tile mesh's road vertices onto the extracted .ter ground during the route bake — removes the photogrammetry wobble on the road surface. Changing this re-bakes the tiles.">flatten roads onto .ter (bake)</span>
      </label>

      <!-- worker-side profile carve: the .ter follows OSM road profiles into
           underpasses / onto embankments (route bakes only — re-bakes). -->
      <label class="flex items-center gap-2 cursor-pointer pt-1">
        <div class="relative">
          <input type="checkbox" :checked="store.ground.carveRoads" @change="store.setGroundCarveRoads($event.target.checked)" class="peer sr-only" />
          <div class="w-7 h-4 bg-gray-200 rounded-full peer peer-checked:bg-[#FF6600] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-full"></div>
        </div>
        <span class="text-[10px] text-gray-700 dark:text-gray-300" title="Carve 1D road elevation profiles into the .ter during the route bake: the driving surface follows roads down into underpasses and up onto embankments. Bridges never carve — the lower road wins. Changing this re-bakes the tiles.">carve road profiles into .ter (bake)</span>
      </label>

      <!-- post-process smoothing -->
      <label class="flex items-center gap-2 cursor-pointer pt-1">
        <div class="relative">
          <input type="checkbox" :checked="store.ground.postOn" @change="store.setGroundPostOn($event.target.checked)" class="peer sr-only" />
          <div class="w-7 h-4 bg-gray-200 rounded-full peer peer-checked:bg-[#FF6600] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-full"></div>
        </div>
        <span class="text-[10px] text-gray-700 dark:text-gray-300">smooth (post-process)</span>
      </label>
      <template v-if="store.ground.postOn">
        <div class="flex items-center gap-2">
          <label class="text-[10px] text-gray-500 dark:text-gray-400 whitespace-nowrap w-12">effect</label>
          <select
            :value="store.ground.postId"
            @change="store.setGroundPostEffect($event.target.value)"
            class="flex-1 text-[10px] px-1 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            <option v-for="p in store.groundPost" :key="p.meta.id" :value="p.meta.id">{{ p.meta.label }}</option>
          </select>
        </div>
        <div v-for="d in postMeta.params" :key="d.key" class="flex items-center gap-2">
          <label class="text-[10px] text-gray-500 dark:text-gray-400 truncate w-16" :title="d.label">{{ d.short || d.label }}</label>
          <input
            type="range" :min="d.min" :max="d.max" :step="d.step"
            :value="store.ground.postParams[d.key]"
            @input="store.setGroundPostParam(d.key, $event.target.valueAsNumber)"
            class="flex-1 accent-[#FF6600]"
          />
          <span class="text-[10px] text-gray-400 dark:text-gray-500 w-8 text-right tabular-nums">{{ store.ground.postParams[d.key] }}</span>
        </div>
      </template>
      <slot name="footer" />
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { Mountain } from 'lucide-vue-next';
import { useGoogleTilesStore } from '../../stores/googleTilesStore.js';

const store = useGoogleTilesStore();

const filterMeta = computed(() =>
  (store.groundFilters.find((f) => f.meta.id === store.ground.filterId) || store.groundFilters[0]).meta);
const postMeta = computed(() =>
  (store.groundPost.find((p) => p.meta.id === store.ground.postId) || store.groundPost[0]).meta);
</script>
