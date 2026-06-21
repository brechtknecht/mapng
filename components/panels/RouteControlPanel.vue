<template>
  <div class="space-y-4">
    <!-- Start / End points -->
    <BaseCard>
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-1.5">
          <Route :size="14" class="text-[#0f766e]" />
          {{ t('route.title') }}
        </h3>
        <button
          v-if="routeStart && routeEnd"
          type="button"
          class="text-[11px] text-gray-500 hover:text-[#0f766e] inline-flex items-center gap-1"
          @click="$emit('swap-points')"
        >
          <ArrowUpDown :size="12" /> {{ t('route.swap') }}
        </button>
      </div>

      <div class="space-y-2">
        <PointRow
          :label="t('route.start')"
          dot-class="bg-[#10B981]"
          :point="routeStart"
          :active="activePoint === 'start'"
          :pick-label="t('route.pickOnMap')"
          :active-label="t('route.clickMapHint')"
          @pick="$emit('pick-point', 'start')"
          @clear="$emit('clear-point', 'start')"
        />
        <PointRow
          :label="t('route.end')"
          dot-class="bg-[#EF4444]"
          :point="routeEnd"
          :active="activePoint === 'end'"
          :pick-label="t('route.pickOnMap')"
          :active-label="t('route.clickMapHint')"
          @pick="$emit('pick-point', 'end')"
          @clear="$emit('clear-point', 'end')"
        />
      </div>
    </BaseCard>

    <!-- Corridor quality dial (width + LOD) -->
    <BaseCard>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-1">
        {{ t('route.corridorQuality') }}
      </h3>
      <p class="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
        {{ t('route.corridorHint') }}
      </p>
      <div class="grid grid-cols-2 gap-1.5">
        <button
          v-for="tier in tiers"
          :key="tier.id"
          type="button"
          :class="[
            'px-2 py-2 rounded-md text-xs font-medium border transition-all text-left',
            tier.id === corridorTier
              ? 'border-[#0f766e] bg-[#0f766e]/10 text-[#0f766e] dark:text-teal-300'
              : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600',
          ]"
          @click="$emit('set-corridor-tier', tier.id)"
        >
          <div class="font-semibold capitalize">{{ t(`route.tier.${tier.id}`) }}</div>
          <div class="text-[10px] opacity-70">±{{ tier.halfWidthM }} m</div>
        </button>
      </div>
    </BaseCard>

    <!-- Chunk size — decoupled from the quality tier -->
    <BaseCard>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-1">
        {{ t('route.chunkSize') }}
      </h3>
      <p class="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
        {{ t('route.chunkSizeHint') }}
      </p>
      <div class="grid grid-cols-5 gap-1.5">
        <button
          type="button"
          :class="[
            'px-1 py-1.5 rounded-md text-[11px] font-medium border transition-all',
            chunkSizeM == null
              ? 'border-[#0f766e] bg-[#0f766e]/10 text-[#0f766e] dark:text-teal-300'
              : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600',
          ]"
          @click="$emit('set-chunk-size', null)"
        >
          {{ t('route.chunkSizeAuto') }}
        </button>
        <button
          v-for="size in chunkPresets"
          :key="size"
          type="button"
          :disabled="size < minChunkM"
          :class="[
            'px-1 py-1.5 rounded-md text-[11px] font-medium border transition-all',
            chunkSizeM === size
              ? 'border-[#0f766e] bg-[#0f766e]/10 text-[#0f766e] dark:text-teal-300'
              : size < minChunkM
                ? 'border-gray-100 dark:border-gray-800 text-gray-300 dark:text-gray-600 cursor-not-allowed'
                : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600',
          ]"
          @click="$emit('set-chunk-size', size)"
        >
          {{ size >= 1024 ? (size / 1024) + 'k' : size }}
        </button>
      </div>
      <p v-if="hasRoute" class="text-[10px] text-gray-400 dark:text-gray-500 mt-2">
        {{ t('route.chunkSizeEffective', { size: effectiveChunkM, res: effectiveChunkM, chunks: chunkCount }) }}
      </p>
    </BaseCard>

    <!-- Parallel fetches -->
    <BaseCard>
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-1">
        {{ t('route.concurrency') }}
      </h3>
      <p class="text-[11px] text-gray-500 dark:text-gray-400 mb-2">
        {{ t('route.concurrencyHint') }}
      </p>
      <div class="grid grid-cols-4 gap-1.5">
        <button
          v-for="n in [1, 2, 3, 4]"
          :key="'conc-' + n"
          type="button"
          :class="[
            'px-1 py-1.5 rounded-md text-[11px] font-medium border transition-all',
            concurrency === n
              ? 'border-[#0f766e] bg-[#0f766e]/10 text-[#0f766e] dark:text-teal-300'
              : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600',
          ]"
          @click="$emit('set-concurrency', n)"
        >
          {{ n }}×
        </button>
      </div>
    </BaseCard>

    <!-- Fetch / result -->
    <div class="space-y-2">
      <BaseButton
        block
        variant="primary"
        :disabled="!canFetch"
        class="!bg-[#0f766e] hover:!bg-[#0c5d56] !text-white"
        @click="$emit('fetch-route')"
      >
        <Loader2 v-if="routeFetching" :size="14" class="animate-spin" />
        <Route v-else :size="14" />
        {{ routeFetching ? t('route.fetching') : t('route.fetchRoute') }}
      </BaseButton>

      <div
        v-if="routeError"
        class="text-[12px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-2"
      >
        {{ routeError }}
      </div>

      <div
        v-else-if="hasRoute"
        class="text-[12px] text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md p-2 flex items-center justify-between"
      >
        <span class="inline-flex items-center gap-1.5">
          <Check :size="13" class="text-[#10B981]" />
          {{ t('route.routeReady', { km: distanceKm, chunks: chunkCount }) }}
        </span>
        <button type="button" class="text-gray-400 hover:text-red-500" @click="$emit('clear-route')">
          <X :size="14" />
        </button>
      </div>
    </div>

    <!-- Bake + export the corridor -->
    <BaseCard v-if="hasRoute">
      <h3 class="text-sm font-semibold text-gray-900 dark:text-white mb-2">
        {{ t('route.bakeTitle') }}
      </h3>

      <template v-if="baking">
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="text-[12px] text-gray-700 dark:text-gray-200">
            {{ t('route.bakeProgress', {
              chunk: bakeDone,
              total: chunkCount,
              phase: t(`route.phase.${bakeProgress?.phase || 'terrain'}`),
            }) }}
          </span>
          <span
            v-if="bakeActive > 1"
            class="text-[10px] font-semibold text-amber-600 dark:text-amber-400 whitespace-nowrap"
          >
            {{ t('route.parallelBaking', { n: bakeActive }) }}
          </span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden mb-1">
          <div class="h-full bg-[#0f766e] transition-all" :style="{ width: bakePercent + '%' }" />
        </div>
        <div class="text-[10px] text-gray-400 dark:text-gray-500 truncate mb-2">{{ bakeProgress?.detail }}</div>
        <BaseButton block variant="secondary" @click="$emit('cancel-bake')">
          {{ t('route.cancelBake') }}
        </BaseButton>
      </template>

      <template v-else>
        <BaseButton
          block
          variant="primary"
          class="!bg-[#FF6600] hover:!bg-[#E65C00] !text-white"
          @click="$emit('export-beamng')"
        >
          <Download :size="14" />
          {{ t('route.exportBeamng', { chunks: chunkCount }) }}
        </BaseButton>
        <BaseButton
          block
          variant="secondary"
          class="mt-2"
          @click="$emit('bake-route')"
        >
          <Download :size="14" />
          {{ t('route.bakeExport', { chunks: chunkCount }) }}
        </BaseButton>
        <p class="text-[10px] text-gray-400 dark:text-gray-500 mt-2 leading-snug">
          {{ t('route.exportBeamngNote') }}
        </p>
      </template>
    </BaseCard>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Route, ArrowUpDown, Loader2, Check, X, Download } from 'lucide-vue-next';
import BaseCard from '../base/BaseCard.vue';
import BaseButton from '../base/BaseButton.vue';
import PointRow from '../map/RoutePointRow.vue';
import { CORRIDOR_TIERS, CHUNK_SIZE_PRESETS, resolveChunkSizeM, getCorridorTier } from '../../services/routeCorridor';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps({
  routeStart: { type: Object, default: null },
  routeEnd: { type: Object, default: null },
  routePolyline: { type: Array, default: () => [] },
  routeDistanceM: { type: Number, default: 0 },
  routeFetching: { type: Boolean, default: false },
  routeError: { type: String, default: '' },
  corridorTier: { type: String, default: 'standard' },
  chunkSizeM: { type: Number, default: null }, // null = Auto (follow the tier)
  concurrency: { type: Number, default: 2 }, // parallel chunk bakes (1–4)
  activePoint: { type: String, default: null }, // 'start' | 'end' | null
  chunkCount: { type: Number, default: 0 },
  baking: { type: Boolean, default: false },
  bakeProgress: { type: Object, default: null }, // RouteProgressSnapshot
});

defineEmits([
  'pick-point',
  'clear-point',
  'swap-points',
  'set-corridor-tier',
  'set-chunk-size',
  'set-concurrency',
  'fetch-route',
  'clear-route',
  'bake-route',
  'export-beamng',
  'cancel-bake',
]);

const tiers = CORRIDOR_TIERS;
const chunkPresets = CHUNK_SIZE_PRESETS;
// A box must be able to contain the corridor → floor presets at 2× half-width.
const minChunkM = computed(() => getCorridorTier(props.corridorTier).halfWidthM * 2);
const effectiveChunkM = computed(() => resolveChunkSizeM(props.corridorTier, props.chunkSizeM));
const canFetch = computed(() => !!props.routeStart && !!props.routeEnd && !props.routeFetching);
const hasRoute = computed(() => props.routePolyline.length > 0);
const distanceKm = computed(() => (props.routeDistanceM / 1000).toFixed(1));
// Prefer the snapshot's weighted overall % (smooth under parallelism); fall
// back to completed/total for the legacy progress shape.
const bakePercent = computed(() => {
  const p = props.bakeProgress;
  if (!p) return 0;
  if (Number.isFinite(p.overallPct)) return p.overallPct;
  if (!p.total) return 0;
  return Math.round((p.chunk / p.total) * 100);
});
const bakeDone = computed(() => {
  const p = props.bakeProgress;
  return Math.min(p?.completed ?? p?.chunk ?? 0, props.chunkCount);
});
const bakeActive = computed(() => props.bakeProgress?.activeCount ?? 1);
</script>
