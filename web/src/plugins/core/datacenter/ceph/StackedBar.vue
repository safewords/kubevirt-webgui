<script setup lang="ts">
/**
 * One horizontal bar split into parts, with a legend underneath and a
 * tooltip per part. Parts carry their own color (status or category) and
 * the legend always names them, so color is never the only cue.
 */
import { computed, ref } from 'vue'

export interface Part {
  key: string
  label: string
  value: number
  color: string
  /** Shown in the tooltip after the value. */
  note?: string
}

const props = withDefaults(defineProps<{ parts: Part[]; format?: (v: number) => string; height?: number; total?: number }>(), {
  format: (v: number) => v.toLocaleString(),
  height: 14,
})

const sum = computed(() => props.total ?? props.parts.reduce((n, p) => n + p.value, 0))
const shown = computed(() => props.parts.filter((p) => p.value > 0))
const hover = ref<Part | null>(null)
const pct = (v: number) => (sum.value ? (v / sum.value) * 100 : 0)
</script>

<template>
  <div>
    <div class="relative flex w-full gap-[2px] overflow-visible" :style="{ height: `${height}px` }" role="img" :aria-label="shown.map((p) => `${p.label} ${format(p.value)}`).join(', ')">
      <div
        v-for="(p, i) in shown"
        :key="p.key"
        class="h-full cursor-default transition-opacity"
        :class="[i === 0 ? 'rounded-l' : '', i === shown.length - 1 ? 'rounded-r' : '', hover && hover.key !== p.key ? 'opacity-50' : '']"
        :style="{ width: `${pct(p.value)}%`, minWidth: '3px', background: p.color }"
        @mouseenter="hover = p"
        @mouseleave="hover = null"
      />
      <div v-if="sum && total && pct(parts.reduce((n, p) => n + p.value, 0)) < 100" class="h-full flex-1 rounded-r bg-surface-2" />
      <div v-if="hover" class="pointer-events-none absolute bottom-full left-0 z-10 mb-1 whitespace-nowrap rounded border border-line bg-surface-1 px-2 py-1 text-xs shadow">
        <span class="font-medium">{{ hover.label }}</span> · {{ format(hover.value) }} ({{ pct(hover.value).toFixed(1) }}%)<span v-if="hover.note" class="text-fg-muted"> · {{ hover.note }}</span>
      </div>
    </div>
    <ul class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
      <li v-for="p in shown" :key="p.key" class="flex items-center gap-1.5" @mouseenter="hover = p" @mouseleave="hover = null">
        <span class="inline-block h-2.5 w-2.5 rounded-sm" :style="{ background: p.color }" />
        <span>{{ p.label }}</span>
        <span class="text-fg">{{ format(p.value) }}</span>
      </li>
    </ul>
  </div>
</template>
