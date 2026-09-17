<script setup lang="ts">
/** Kubernetes events about one or more objects, newest first. */
import { computed } from 'vue'
import { useWatch } from '@/stores/watch'
import { age, dateTime } from '@/util/format'
import type { KObject } from '@/api/types'

const props = defineProps<{
  namespace?: string
  /** Match involved objects by name (and optionally kind). */
  objects: Array<{ name: string; kind?: string }>
  /** Also match names starting with these prefixes (e.g. `virt-launcher-<vm>-`). */
  prefixes?: string[]
}>()

const events = useWatch(() => ({ apiVersion: 'v1', resource: 'events', namespace: props.namespace }))

const rows = computed(() =>
  events.items.value
    .filter((e: KObject) => {
      const io = e.involvedObject ?? {}
      return props.objects.some((o) => o.name === io.name && (!o.kind || o.kind === io.kind)) || (props.prefixes ?? []).some((p) => io.name?.startsWith(p))
    })
    .map((e: KObject) => ({ e, ts: Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') || 0 }))
    .sort((a, b) => b.ts - a.ts),
)
</script>

<template>
  <div class="overflow-auto rounded-md border border-line bg-surface-1">
    <table class="table-dense">
      <thead>
        <tr>
          <th class="w-40">Last seen</th>
          <th class="w-20">Type</th>
          <th class="w-48">Reason</th>
          <th class="w-56">Object</th>
          <th>Message</th>
          <th class="w-14 text-right">Count</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="{ e, ts } in rows" :key="e.metadata.uid">
          <td class="tabular-nums" :title="dateTime(ts)">{{ age(ts) }} ago</td>
          <td :class="e.type === 'Warning' ? 'text-warn' : 'text-fg-muted'">{{ e.type }}</td>
          <td>{{ e.reason }}</td>
          <td class="truncate text-fg-muted">{{ e.involvedObject?.kind }}/{{ e.involvedObject?.name }}</td>
          <td class="max-w-0 truncate whitespace-normal" :title="e.message">{{ e.message }}</td>
          <td class="text-right tabular-nums">{{ e.count ?? e.series?.count ?? 1 }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="6" class="h-14 text-center text-fg-subtle">{{ events.synced.value ? (events.error.value ? events.error.value.message : 'No events (Kubernetes keeps them for about an hour)') : 'Loading…' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
