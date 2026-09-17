<script setup lang="ts">
/**
 * A small time-series area chart — the RRD graphs on a Proxmox summary.
 * Plain SVG, so it costs nothing to load and follows the theme's tokens.
 */
import { computed, ref } from 'vue'

export interface Series {
  label: string
  color: string
  points: Array<{ ts: number; value: number }>
}

const props = withDefaults(
  defineProps<{
    title: string
    series: Series[]
    format: (value: number) => string
    /** A fixed maximum (e.g. allocated memory); otherwise scaled to the data. */
    max?: number | null
    height?: number
    windowMs?: number
  }>(),
  { height: 150, windowMs: 60 * 60 * 1000, max: null },
)

const width = 600
const pad = { top: 8, right: 8, bottom: 20, left: 56 }
const hover = ref<number | null>(null)
const svg = ref<SVGSVGElement | null>(null)

const now = computed(() => Math.max(Date.now(), ...props.series.flatMap((s) => s.points.map((p) => p.ts))))
const from = computed(() => now.value - props.windowMs)

const top = computed(() => {
  const dataMax = Math.max(0, ...props.series.flatMap((s) => s.points.filter((p) => p.ts >= from.value).map((p) => p.value)))
  const max = props.max && props.max > 0 ? Math.max(props.max, dataMax) : dataMax
  return max > 0 ? max * 1.1 : 1
})

const plotW = width - pad.left - pad.right
const plotH = computed(() => props.height - pad.top - pad.bottom)
const x = (ts: number) => pad.left + ((ts - from.value) / props.windowMs) * plotW
const y = (v: number) => pad.top + plotH.value - (v / top.value) * plotH.value

const paths = computed(() =>
  props.series.map((s) => {
    const pts = s.points.filter((p) => p.ts >= from.value).sort((a, b) => a.ts - b.ts)
    if (!pts.length) return { ...s, line: '', area: '', last: null as null | { x: number; y: number } }
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
    const area = `${line} L${x(pts[pts.length - 1].ts).toFixed(1)},${pad.top + plotH.value} L${x(pts[0].ts).toFixed(1)},${pad.top + plotH.value} Z`
    const end = pts[pts.length - 1]
    return { ...s, line, area, last: { x: x(end.ts), y: y(end.value) } }
  }),
)

const gridLines = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: pad.top + plotH.value - f * plotH.value, label: props.format(f * top.value) })))
const timeTicks = computed(() => {
  const ticks = []
  const step = props.windowMs / 4
  for (let i = 0; i <= 4; i++) {
    const ts = from.value + step * i
    const d = new Date(ts)
    ticks.push({ x: x(ts), label: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` })
  }
  return ticks
})

const hoverInfo = computed(() => {
  if (hover.value === null) return null
  const ts = from.value + ((hover.value - pad.left) / plotW) * props.windowMs
  const values = props.series.map((s) => {
    let best: { ts: number; value: number } | null = null
    for (const p of s.points) if (!best || Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p
    return { label: s.label, color: s.color, point: best }
  })
  const anchor = values.find((v) => v.point)?.point
  if (!anchor) return null
  return { x: x(anchor.ts), ts: anchor.ts, values }
})

function onMove(event: MouseEvent) {
  const rect = svg.value!.getBoundingClientRect()
  const px = ((event.clientX - rect.left) / rect.width) * width
  hover.value = px >= pad.left && px <= width - pad.right ? px : null
}
</script>

<template>
  <div class="card">
    <div class="card-header justify-between">
      <span>{{ title }}</span>
      <span class="flex items-center gap-3 text-xs font-normal text-fg-muted">
        <span v-for="s in series" :key="s.label" class="flex items-center gap-1.5">
          <span class="h-0.5 w-3 rounded" :style="{ background: s.color }" />{{ s.label }}
        </span>
      </span>
    </div>
    <div class="relative p-2">
      <svg ref="svg" :viewBox="`0 0 ${width} ${height}`" class="w-full" preserveAspectRatio="none" :style="{ height: `${height}px` }" @mousemove="onMove" @mouseleave="hover = null">
        <g>
          <line v-for="g in gridLines" :key="g.y" :x1="pad.left" :x2="width - pad.right" :y1="g.y" :y2="g.y" stroke="var(--chart-grid)" stroke-width="1" />
          <text v-for="g in gridLines" :key="`l${g.y}`" :x="pad.left - 6" :y="g.y + 3" text-anchor="end" class="fill-fg-subtle" font-size="10">{{ g.label }}</text>
          <text v-for="(t, i) in timeTicks" :key="t.x" :x="t.x" :y="height - 5" :text-anchor="i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'" class="fill-fg-subtle" font-size="10">{{ t.label }}</text>
        </g>
        <g v-for="p in paths" :key="p.label">
          <path :d="p.area" :fill="p.color" fill-opacity="0.16" />
          <path :d="p.line" :stroke="p.color" stroke-width="1.6" fill="none" vector-effect="non-scaling-stroke" />
          <circle v-if="p.last" :cx="p.last.x" :cy="p.last.y" r="2.5" :fill="p.color" />
        </g>
        <line v-if="hoverInfo" :x1="hoverInfo.x" :x2="hoverInfo.x" :y1="pad.top" :y2="pad.top + plotH" stroke="var(--line-strong)" stroke-dasharray="3 3" />
      </svg>
      <div v-if="hoverInfo" class="pointer-events-none absolute top-2 right-3 rounded border border-line bg-surface-1/95 px-2 py-1 text-xs shadow">
        <div class="text-fg-muted">{{ new Date(hoverInfo.ts).toLocaleTimeString() }}</div>
        <div v-for="v in hoverInfo.values" :key="v.label" class="flex items-center gap-1.5">
          <span class="size-2 rounded-full" :style="{ background: v.color }" />
          {{ v.label }}: <span class="font-semibold tabular-nums">{{ v.point ? format(v.point.value) : '—' }}</span>
        </div>
      </div>
      <div v-if="!series.some((s) => s.points.length)" class="absolute inset-0 flex items-center justify-center text-fg-subtle">No data yet</div>
    </div>
  </div>
</template>
