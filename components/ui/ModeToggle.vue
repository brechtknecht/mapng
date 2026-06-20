<template>
  <div class="flex p-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 gap-1">
    <BaseButton
      block
      variant="ghost"
      :class="[tabBase, mode === 'single' ? tabSingleActive : tabInactive]"
      @click="$emit('set-mode', 'single')"
    >
      <Map :size="12" />
      {{ t('mode.singleTile') }}
    </BaseButton>
    <BaseButton
      block
      variant="ghost"
      :class="[tabBase, mode === 'batch' ? tabBatchActive : tabInactive]"
      @click="$emit('set-mode', 'batch')"
    >
      <Grid3X3 :size="12" />
      {{ t('mode.batchJob') }}
    </BaseButton>
    <BaseButton
      block
      variant="ghost"
      :class="[tabBase, mode === 'route' ? tabRouteActive : tabInactive]"
      @click="$emit('set-mode', 'route')"
    >
      <Route :size="12" />
      {{ t('mode.route') }}
    </BaseButton>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n';
import BaseButton from '../base/BaseButton.vue';
import { Grid3X3, Map, Route } from 'lucide-vue-next';

const { t } = useI18n({ useScope: 'global' });

const tabBase = 'flex-1 py-1.5 px-2 text-xs font-medium rounded-md flex items-center justify-center gap-1.5 transition-all';
const tabInactive = 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800';
const tabSingleActive = '!bg-gray-900 !text-white shadow-sm';
const tabBatchActive = '!bg-[#FF6600] !text-white shadow-sm';
const tabRouteActive = '!bg-[#0f766e] !text-white shadow-sm';

defineProps({
  mode: { type: String, default: 'single' },
});

defineEmits(['set-mode']);
</script>
