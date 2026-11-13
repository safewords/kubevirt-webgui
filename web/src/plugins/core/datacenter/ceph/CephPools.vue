<script setup lang="ts">
/** Where the space goes: capacity by disk type, and each pool's data against what it can still take. */
import { computed } from 'vue'
import { useClusterWatch } from '../helpers'
import { useCluster } from '@/stores/cluster'
import { isCephProvisioner } from '@/plugins/core/vm/placement'
import { bytes } from '@/util/format'
import StackedBar, { type Part } from './StackedBar.vue'
import { ceph, count } from './useCeph'

const cluster = useCluster()
const classes = useClusterWatch(() => (cluster.has('storage.k8s.io/v1/storageclasses') ? 'storage.k8s.io/v1' : null), 'storage.k8s.io', 'storageclasses')
const classesByPool = computed(() => {
  const map = new Map<string, string[]>()
  for (const c of classes.items.value.filter((c) => isCephProvisioner((c as any).provisioner))) {
    const pool = (c as any).parameters?.pool
    if (pool) map.set(pool, [...(map.get(pool) ?? []), c.metadata.name])
  }
  return map
})

/** Raw capacity by device class, from the OSDs (dashboard). Two classes, two category colors. */
const byClass = computed(() => {
  const m = new Map<string, { used: number; total: number; osds: number }>()
  for (const o of ceph.osds?.osds ?? []) {
    if (!o.totalBytes) continue
    const e = m.get(o.deviceClass || 'other') ?? { used: 0, total: 0, osds: 0 }
    e.used += o.usedBytes
    e.total += o.totalBytes
    e.osds++
    m.set(o.deviceClass || 'other', e)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})
const classColor = (c: string) => (c === 'hdd' ? 'var(--chart-1)' : 'var(--chart-2)')

const pools = computed(() => [...(ceph.status?.pools ?? [])].sort((a, b) => (b.storedBytes ?? 0) - (a.storedBytes ?? 0)))
const poolParts = (p: NonNullable<typeof ceph.status>['pools'] extends (infer T)[] | undefined ? T : never): Part[] => [
  { key: 'stored', label: 'Stored', value: p.storedBytes ?? 0, color: 'var(--chart-2)' },
  { key: 'free', label: 'Can still take', value: p.maxAvailBytes ?? 0, color: 'var(--surface-3)' },
]
</script>

<template>
  <div class="space-y-4">
    <section v-if="byClass.length" class="card p-3">
      <h4 class="mb-2 font-medium">Raw capacity by disk type</h4>
      <div class="space-y-3">
        <div v-for="[cls, e] in byClass" :key="cls">
          <div class="mb-1 flex items-baseline justify-between text-sm">
            <span><span class="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm" :style="{ background: classColor(cls) }" />{{ cls.toUpperCase() }} · {{ e.osds }} OSD{{ e.osds > 1 ? 's' : '' }}</span>
            <span class="text-fg-muted">{{ bytes(e.used) }} of {{ bytes(e.total) }} ({{ ((e.used / e.total) * 100).toFixed(1) }}%)</span>
          </div>
          <div class="h-2.5 w-full rounded bg-surface-2"><div class="h-full rounded" :style="{ width: `${(e.used / e.total) * 100}%`, background: classColor(cls) }" /></div>
        </div>
      </div>
      <p class="mt-2 text-xs text-fg-subtle">Raw space counts every copy: a pool keeping three copies uses three bytes of raw space per byte stored.</p>
    </section>

    <section class="card">
      <div class="card-header">Pools</div>
      <div class="divide-y divide-line">
        <div v-for="p in pools" :key="p.id" class="p-3">
          <div class="mb-1.5 flex flex-wrap items-baseline gap-x-3">
            <span class="mono font-medium">{{ p.name }}</span>
            <span class="text-xs text-fg-subtle">{{ p.type }} · {{ p.pgs ?? '?' }} PGs · {{ count(p.objects) }} objects</span>
            <span v-for="c in classesByPool.get(p.name) ?? []" :key="c" class="chip text-xs" title="Kubernetes storage class on this pool">{{ c }}</span>
            <span class="ml-auto text-sm" :class="(p.percentUsed ?? 0) > 85 ? 'text-bad' : (p.percentUsed ?? 0) > 70 ? 'text-warn' : 'text-fg-muted'">{{ (p.percentUsed ?? 0).toFixed(1) }}% used</span>
          </div>
          <StackedBar :parts="poolParts(p)" :format="(v) => bytes(v)" :height="10" />
        </div>
      </div>
      <p class="px-3 pb-3 text-xs text-fg-subtle">"Can still take" is what the pool can store before its fullest OSD fills, after copies — pools on the same disks share it.</p>
    </section>
  </div>
</template>
