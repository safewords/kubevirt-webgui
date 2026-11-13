<script setup lang="ts">
/** A one-series trend line with no axes — for a row or a card. Hover shows the value. */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    points: Array<{ ts: number; value: number }>
    format: (v: number) => string
    color?: string
    width?: number
    height?: number
    /** A value above which the line is drawn in the warning color. */
    warnAbove?: number
    label?: string
  }>(),
  { color: 'var(--chart-2)', width: 120, height: 28 },
)

const pad = 2
const sorted = computed(() => [...props.points].sort((a, b) => a.ts - b.ts))
const range = computed(() => {
  const vs = sorted.value.map((p) => p.value)
  const max = Math.max(1e-9, ...vs, props.warnAbove ?? 0)
  const t0 = sorted.value[0]?.ts ?? 0
  const t1 = sorted.value[sorted.value.length - 1]?.ts ?? 1
  return { max, t0, t1: t1 === t0 ? t0 + 1 : t1 }
})
const x = (ts: number) => pad + ((ts - range.value.t0) / (range.value.t1 - range.value.t0)) * (props.width - pad * 2)
const y = (v: number) => props.height - pad - (v / range.value.max) * (props.height - pad * 2)
const path = computed(() => sorted.value.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(''))
const last = computed(() => sorted.value[sorted.value.length - 1])
const stroke = computed(() => (props.warnAbove !== undefined && (last.value?.value ?? 0) > props.warnAbove ? 'var(--warn)' : props.color))

const hover = ref<{ ts: number; value: number } | null>(null)
function move(e: MouseEvent) {
  const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
  const px = ((e.clientX - rect.left) / rect.width) * props.width
  let best: { ts: number; value: number } | null = null
  for (const p of sorted.value) if (!best || Math.abs(x(p.ts) - px) < Math.abs(x(best.ts) - px)) best = p
  hover.value = best
}
</script>

<template>
  <span class="relative inline-flex items-center">
    <svg
      v-if="sorted.length > 1"
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      role="img"
      :aria-label="`${label ?? 'Trend'}: latest ${last ? format(last.value) : 'none'}`"
      class="overflow-visible"
      @mousemove="move"
      @mouseleave="hover = null"
    >
      <line v-if="warnAbove !== undefined && warnAbove < range.max" :x1="pad" :x2="width - pad" :y1="y(warnAbove)" :y2="y(warnAbove)" stroke="var(--warn)" stroke-width="1" stroke-dasharray="2 3" opacity="0.6" />
      <path :d="path" fill="none" :stroke="stroke" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <circle v-if="hover" :cx="x(hover.ts)" :cy="y(hover.value)" r="4" :fill="stroke" stroke="var(--surface-1)" stroke-width="2" />
      <rect :width="width" :height="height" fill="transparent" />
    </svg>
    <span v-else class="text-xs text-fg-subtle" :style="{ width: `${width}px` }">collecting…</span>
    <span v-if="hover" class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded border border-line bg-surface-1 px-1.5 py-0.5 text-xs shadow">
      {{ format(hover.value) }} · {{ new Date(hover.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
    </span>
  </span>
</template>
