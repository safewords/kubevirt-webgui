<script setup lang="ts">
/** A thin progress bar with a figure — or an indeterminate shimmer when the total is unknown. */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  /** 0..1, or null when unknown. */
  value: number | null
  size?: 'sm' | 'md'
}>(), { size: 'md' })

const pct = computed(() => (props.value === null ? null : Math.max(0, Math.min(1, props.value))))
</script>

<template>
  <div class="overflow-hidden rounded-full bg-surface-3" :class="size === 'sm' ? 'h-1' : 'h-1.5'" role="progressbar" :aria-valuenow="pct === null ? undefined : Math.round(pct * 100)" aria-valuemin="0" aria-valuemax="100">
    <div v-if="pct !== null" class="h-full rounded-full bg-accent transition-[width] duration-500" :style="{ width: `${pct * 100}%` }" />
    <div v-else class="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
  </div>
</template>
