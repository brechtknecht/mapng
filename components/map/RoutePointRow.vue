<template>
  <div
    :class="[
      'flex items-center gap-2 rounded-md border px-2 py-1.5 transition-all',
      active
        ? 'border-[#0f766e] bg-[#0f766e]/5'
        : 'border-gray-200 dark:border-gray-700',
    ]"
  >
    <span :class="['w-2.5 h-2.5 rounded-full flex-shrink-0', dotClass]" />
    <div class="min-w-0 flex-1">
      <div class="text-[10px] uppercase tracking-wide text-gray-400 dark:text-gray-500">{{ label }}</div>
      <div class="text-[12px] text-gray-800 dark:text-gray-100 truncate font-mono">
        <template v-if="point">{{ point.lat.toFixed(5) }}, {{ point.lng.toFixed(5) }}</template>
        <span v-else-if="active" class="text-[#0f766e] not-italic font-sans">{{ activeLabel }}</span>
        <span v-else class="text-gray-400 italic font-sans">{{ pickLabel }}</span>
      </div>
    </div>
    <button
      type="button"
      :class="[
        'text-[11px] px-2 py-1 rounded inline-flex items-center gap-1 flex-shrink-0',
        active
          ? 'bg-[#0f766e] text-white'
          : 'text-gray-500 hover:text-[#0f766e] hover:bg-gray-100 dark:hover:bg-gray-700',
      ]"
      @click="$emit('pick')"
    >
      <MapPin :size="12" />
    </button>
    <button
      v-if="point"
      type="button"
      class="text-gray-300 hover:text-red-500 flex-shrink-0"
      @click="$emit('clear')"
    >
      <X :size="13" />
    </button>
  </div>
</template>

<script setup>
import { MapPin, X } from 'lucide-vue-next';

defineProps({
  label: { type: String, default: '' },
  dotClass: { type: String, default: 'bg-gray-400' },
  point: { type: Object, default: null },
  active: { type: Boolean, default: false },
  pickLabel: { type: String, default: '' },
  activeLabel: { type: String, default: '' },
});

defineEmits(['pick', 'clear']);
</script>
