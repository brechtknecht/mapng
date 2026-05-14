<template>
  <div class="absolute top-4 right-4 z-20 flex items-center gap-1.5 bg-white/95 dark:bg-gray-800/95 backdrop-blur rounded-2xl p-1.5 shadow-lg border border-gray-200/80 dark:border-gray-700">
    <BaseButton
      size="sm"
      variant="ghost"
      class="view-tab"
      :class="is2D ? 'view-tab--active' : 'view-tab--inactive'"
      @click="$emit('switch-2d')"
    >
      <Globe :size="16" />
      {{ t('view.map2d') }}
    </BaseButton>
    <BaseButton
      size="sm"
      variant="ghost"
      class="view-tab"
      :class="previewMode ? 'view-tab--active' : 'view-tab--inactive'"
      :disabled="!canPreview"
      @click="$emit('switch-3d')"
    >
      <Layers :size="16" />
      {{ t('view.preview3d') }}
    </BaseButton>
    <BaseButton
      size="sm"
      variant="ghost"
      class="view-tab"
      :class="debugMode ? 'view-tab--active view-tab--debug-active' : 'view-tab--inactive'"
      :disabled="!canPreview"
      @click="$emit('switch-debug')"
    >
      <Bug :size="16" />
      {{ t('view.debug') }}
    </BaseButton>
  </div>
</template>

<style scoped>
.view-tab {
  @apply flex items-center gap-2 rounded-lg px-3 py-2 transition-all duration-150;
}

.view-tab--active {
  @apply bg-[#1d2d44] text-white shadow-sm;
}

.view-tab--debug-active {
  @apply bg-[#b91c1c] text-white shadow-sm;
}

.view-tab--inactive {
  @apply text-gray-600 dark:text-gray-300;
}

.view-tab:disabled {
  @apply opacity-50 cursor-not-allowed;
}

.view-tab--active:hover {
  @apply bg-[#1d2d44] text-white;
}

.view-tab--debug-active:hover {
  @apply bg-[#b91c1c] text-white;
}

.view-tab--inactive:hover {
  @apply bg-transparent text-gray-800 dark:text-white;
}
</style>

<script setup>
import { useI18n } from 'vue-i18n';
import { computed } from 'vue';
import BaseButton from '../base/BaseButton.vue';
import { Globe, Layers, Bug } from 'lucide-vue-next';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps({
  previewMode: { type: Boolean, default: false },
  debugMode: { type: Boolean, default: false },
  canPreview: { type: Boolean, default: false },
});

const is2D = computed(() => !props.previewMode && !props.debugMode);

defineEmits(['switch-2d', 'switch-3d', 'switch-debug']);
</script>
