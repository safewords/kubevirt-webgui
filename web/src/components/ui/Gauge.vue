<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  /** 0..1, or null when unknown. */
  value: number | null
  detail?: string
}>()

const pct = computed(() => (props.value === null ? 0 : Math.max(0, Math.min(1, props.value))))
const color = computed(() => (pct.value > 0.9 ? 'bg-bad' : pct.value > 0.75 ? 'bg-warn' : 'bg-accent'))
</script>

<template>
  <div>
    <div class="mb-1 flex items-baseline justify-between gap-2">
      <span class="text-fg-muted">{{ label }}</span>
      <span class="tabular-nums">
        <span class="font-semibold">{{ value === null ? '—' : `${(pct * 100).toFixed(1)}%` }}</span>
        <span v-if="detail" class="ml-1.5 text-fg-muted">{{ detail }}</span>
      </span>
    </div>
    <div class="h-1.5 overflow-hidden rounded-full bg-surface-3">
      <div class="h-full rounded-full transition-[width] duration-500" :class="color" :style="{ width: `${pct * 100}%` }" />
    </div>
  </div>
</template>
