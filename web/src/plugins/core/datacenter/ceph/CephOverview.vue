<script setup lang="ts">
/** Ceph at a glance: is data safe, what is wrong and what to do, and how it has been trending. */
import { computed } from 'vue'
import { faCircleCheck, faTriangleExclamation, faCircleXmark, faCircleQuestion, faShieldHalved, faHardDrive, faServer, faGaugeHigh } from '@fortawesome/free-solid-svg-icons'
import TimeChart from '@/components/ui/TimeChart.vue'
import Notice from '@/components/ui/Notice.vue'
import { bytes } from '@/util/format'
import StackedBar, { type Part } from './StackedBar.vue'
import { ceph, headline, checkHelp, URGENCY_LABEL, points, rate, ops, count, SLOW_MS, historyWindowMs, type Urgency } from './useCeph'

const emit = defineEmits<{ go: [tab: string] }>()

const s = computed(() => ceph.status)
const h = computed(() => s.value?.history)
const windowMs = computed(() => historyWindowMs(h.value))

const icon = computed(() => ({ ok: faCircleCheck, warn: faTriangleExclamation, bad: faCircleXmark, unknown: faCircleQuestion })[headline.value.level])
const tone = computed(() => ({ ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', unknown: 'text-fg-subtle' })[headline.value.level])
const border = computed(() => ({ ok: 'border-ok', warn: 'border-warn', bad: 'border-bad', unknown: 'border-line' })[headline.value.level])

// Tiles
const usedFraction = computed(() => {
  const c = s.value?.capacity
  return c?.totalBytes ? (c.usedBytes ?? 0) / c.totalBytes : null
})
const safeFraction = computed(() => {
  const o = s.value?.objects
  return o?.copies ? 1 - (o.degraded ?? 0) / o.copies : null
})
const osdCounts = computed(() => {
  const osds = s.value?.osds ?? []
  return { total: osds.length, up: osds.filter((o) => o.up).length, in: osds.filter((o) => o.in).length, slow: osds.filter((o) => o.up && (o.commitLatencyMs ?? 0) >= SLOW_MS).length }
})
const quorum = computed(() => ({ in: (s.value?.mons ?? []).filter((m) => m.inQuorum).length, total: s.value?.mons?.length ?? 0 }))
const io = computed(() => {
  const hh = h.value
  const i = (hh?.ts.length ?? 0) - 1
  if (!hh || i < 0) return null
  return { read: hh.readBytes[i], write: hh.writeBytes[i], rops: hh.readOps[i], wops: hh.writeOps[i], recovery: hh.recoveryBytes[i] }
})

// Checks, grouped by how much they matter.
const grouped = computed(() => {
  const groups: Record<Urgency, Array<{ name: string; severity: string }>> = { now: [], soon: [], housekeeping: [] }
  for (const c of s.value?.health?.checks ?? []) groups[checkHelp(c.name).urgency].push(c)
  return (Object.keys(groups) as Urgency[]).filter((u) => groups[u].length).map((u) => ({ urgency: u, checks: groups[u] }))
})

// Placement groups: exact states from the dashboard when we have them.
const PG_COLOR = (state: string) =>
  /down|incomplete|inconsistent|stale|unfound|damaged|failed/.test(state)
    ? 'var(--bad)'
    : /degraded/.test(state)
      ? 'var(--warn)'
      : /undersized/.test(state)
        ? 'color-mix(in srgb, var(--warn) 50%, var(--surface-1))'
      : /recover|backfill|peering|activating|remapped|scrub/.test(state)
        ? 'var(--info)'
        : state === 'active+clean'
          ? 'var(--ok)'
          : 'var(--fg-subtle)'
const PG_NOTE: Record<string, string> = {
  'active+clean': 'fully replicated',
  'active+undersized': 'fewer copies than asked, data intact',
  'active+undersized+degraded': 'objects missing a copy',
}
const pgParts = computed<Part[]>(() => {
  const exact = ceph.osds?.pgStatuses
  if (exact && Object.keys(exact).length) {
    return Object.entries(exact)
      .sort((a, b) => (a[0] === 'active+clean' ? -1 : b[0] === 'active+clean' ? 1 : b[1] - a[1]))
      .map(([k, v]) => ({ key: k, label: k, value: v, color: PG_COLOR(k), note: PG_NOTE[k] }))
  }
  const st = s.value?.pgs?.states ?? {}
  const total = s.value?.pgs?.total ?? 0
  const clean = st.clean ?? 0
  return [
    { key: 'clean', label: 'clean', value: clean, color: 'var(--ok)' },
    { key: 'other', label: 'not clean', value: Math.max(0, total - clean), color: 'var(--warn)' },
  ]
})

// Charts
const throughput = computed(() => [
  { label: 'Read', color: 'var(--chart-2)', points: points(h.value, 'readBytes') },
  { label: 'Write', color: 'var(--chart-1)', points: points(h.value, 'writeBytes') },
])
const iops = computed(() => [
  { label: 'Read', color: 'var(--chart-2)', points: points(h.value, 'readOps') },
  { label: 'Write', color: 'var(--chart-1)', points: points(h.value, 'writeOps') },
])
const capacity = computed(() => [{ label: 'Used (raw)', color: 'var(--chart-2)', points: points(h.value, 'usedBytes') }])
const degraded = computed(() => [{ label: 'Missing copies', color: 'var(--warn)', points: points(h.value, 'degradedObjects') }])
const showDegradedChart = computed(() => (h.value?.degradedObjects ?? []).some((v) => v > 0))
</script>

<template>
  <div class="space-y-4">
    <Notice v-if="s?.error" kind="warning">{{ s.error }}</Notice>

    <!-- The headline: is the data safe? -->
    <section class="card border-l-4 p-4" :class="border">
      <div class="flex items-start gap-3">
        <Fa :icon="icon" class="mt-0.5 text-2xl" :class="tone" />
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-semibold">{{ headline.title }}</h3>
          <p class="text-fg-muted">{{ headline.detail }}</p>
          <p class="mt-1 text-xs text-fg-subtle">
            Ceph reports <span class="mono">{{ s?.health?.status ?? '—' }}</span>
            <template v-if="s?.health?.status === 'HEALTH_ERR' && headline.level !== 'bad'"> — raised by a housekeeping check below, not by data loss</template>
            <template v-if="s?.flags?.length"> · flags set: <span class="mono">{{ s.flags.join(', ') }}</span></template>
          </p>
        </div>
      </div>
    </section>

    <!-- Tiles -->
    <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="card p-3">
        <div class="flex items-center gap-1.5 text-xs text-fg-muted"><Fa :icon="faShieldHalved" /> Data redundancy</div>
        <div class="mt-1 text-2xl font-semibold" :class="safeFraction === null ? '' : safeFraction >= 0.9999 ? 'text-ok' : 'text-warn'">{{ safeFraction === null ? '—' : `${(safeFraction * 100).toFixed(1)}%` }}</div>
        <div class="text-xs text-fg-subtle">of object copies in place · {{ count(s?.objects?.degraded) }} missing of {{ count(s?.objects?.copies) }}</div>
      </div>
      <div class="card p-3">
        <div class="flex items-center gap-1.5 text-xs text-fg-muted"><Fa :icon="faHardDrive" /> Capacity used</div>
        <div class="mt-1 text-2xl font-semibold" :class="(usedFraction ?? 0) > 0.85 ? 'text-bad' : (usedFraction ?? 0) > 0.7 ? 'text-warn' : ''">{{ usedFraction === null ? '—' : `${(usedFraction * 100).toFixed(1)}%` }}</div>
        <div class="mt-1 h-1.5 w-full rounded bg-surface-2"><div class="h-full rounded" :class="(usedFraction ?? 0) > 0.85 ? 'bg-bad' : (usedFraction ?? 0) > 0.7 ? 'bg-warn' : 'bg-accent'" :style="{ width: `${(usedFraction ?? 0) * 100}%` }" /></div>
        <div class="mt-1 text-xs text-fg-subtle">{{ bytes(s?.capacity?.usedBytes ?? 0) }} raw of {{ bytes(s?.capacity?.totalBytes ?? 0) }}</div>
      </div>
      <button class="card p-3 text-left hover:border-line-strong" @click="emit('go', 'osds')">
        <div class="flex items-center gap-1.5 text-xs text-fg-muted"><Fa :icon="faServer" /> OSDs up · in</div>
        <div class="mt-1 text-2xl font-semibold" :class="osdCounts.up === osdCounts.total ? 'text-ok' : 'text-warn'">{{ osdCounts.up }} · {{ osdCounts.in }} <span class="text-sm font-normal text-fg-muted">of {{ osdCounts.total }}</span></div>
        <div class="text-xs text-fg-subtle">
          {{ quorum.in }} of {{ quorum.total }} monitors in quorum<template v-if="osdCounts.slow"> · <span class="text-warn">{{ osdCounts.slow }} slow</span></template> · details →
        </div>
      </button>
      <div class="card p-3">
        <div class="flex items-center gap-1.5 text-xs text-fg-muted"><Fa :icon="faGaugeHigh" /> Client I/O now</div>
        <div class="mt-1 text-2xl font-semibold">{{ io ? rate(io.read + io.write) : '—' }}</div>
        <div class="text-xs text-fg-subtle">
          <template v-if="io">read {{ rate(io.read) }} · write {{ rate(io.write) }} · {{ ops(io.rops + io.wops) }} op/s<template v-if="io.recovery"> · recovering {{ rate(io.recovery) }}</template></template>
          <template v-else>collecting — figures appear after a minute</template>
        </div>
      </div>
    </section>

    <!-- What is wrong, and what to do -->
    <section v-if="grouped.length" class="card">
      <div class="card-header">What Ceph is reporting</div>
      <div class="divide-y divide-line">
        <div v-for="g in grouped" :key="g.urgency" class="p-3">
          <div class="mb-2 text-xs font-semibold uppercase tracking-wide" :class="g.urgency === 'now' ? 'text-warn' : 'text-fg-muted'">{{ URGENCY_LABEL[g.urgency] }}</div>
          <ul class="space-y-2.5">
            <li v-for="c in g.checks" :key="c.name" class="flex gap-2.5">
              <Fa :icon="c.severity === 'HEALTH_ERR' ? faCircleXmark : faTriangleExclamation" class="mt-1 shrink-0" :class="c.severity === 'HEALTH_ERR' ? 'text-bad' : 'text-warn'" />
              <div class="min-w-0">
                <div class="font-medium">{{ checkHelp(c.name).title }} <span class="mono ml-1 text-xs font-normal text-fg-subtle">{{ c.name }}</span></div>
                <div class="text-fg-muted">{{ checkHelp(c.name).meaning }}</div>
                <div class="text-sm"><span class="text-fg-subtle">What to do:</span> {{ checkHelp(c.name).fix }}</div>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- Placement groups -->
    <section class="card p-3">
      <div class="mb-2 flex items-baseline justify-between">
        <h4 class="font-medium">Placement groups</h4>
        <span class="text-xs text-fg-subtle">{{ count(s?.pgs?.total) }} in all<template v-if="ceph.osds?.scrubStatus"> · scrubbing {{ ceph.osds.scrubStatus.toLowerCase() }}</template></span>
      </div>
      <StackedBar :parts="pgParts" />
      <p class="mt-2 text-xs text-fg-subtle">Ceph splits every pool into placement groups and keeps each on several OSDs. Green is fully replicated; amber is readable but short of copies; red is unavailable.</p>
    </section>

    <!-- Trends -->
    <section class="grid gap-3 xl:grid-cols-2">
      <TimeChart title="Client throughput" :series="throughput" :format="(v) => rate(v)" :window-ms="windowMs" />
      <TimeChart title="Client operations" :series="iops" :format="(v) => `${ops(v)} op/s`" :window-ms="windowMs" />
      <TimeChart title="Raw capacity used" :series="capacity" :format="(v) => bytes(v)" :max="s?.capacity?.totalBytes ?? null" :window-ms="windowMs" />
      <TimeChart v-if="showDegradedChart" title="Missing object copies" :series="degraded" :format="(v) => count(v)" :window-ms="windowMs" />
    </section>
    <p class="text-xs text-fg-subtle">
      Trends are sampled every {{ h?.intervalSeconds ?? 30 }} s by the server and kept in memory for 24 hours, so they start empty after it restarts.
      From <span class="mono">{{ s?.source }}</span>.
    </p>
  </div>
</template>
