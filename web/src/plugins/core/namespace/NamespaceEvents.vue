<script setup lang="ts">
/** Every event in the namespace, newest first. */
import { computed, ref } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useWatch } from '@/stores/watch'
import { age, dateTime } from '@/util/format'

const props = defineProps<{ ctx: ObjectContext }>()
const events = useWatch(() => ({ apiVersion: 'v1', resource: 'events', namespace: props.ctx.name }))
const warningsOnly = ref(false)
const filter = ref('')

const rows = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return events.items.value
    .filter((e: KObject) => !warningsOnly.value || e.type === 'Warning')
    .filter((e: KObject) => !q || `${e.reason} ${e.message} ${e.involvedObject?.kind} ${e.involvedObject?.name}`.toLowerCase().includes(q))
    .map((e: KObject) => ({ e, ts: Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') || 0 }))
    .sort((a, b) => b.ts - a.ts)
})
</script>

<template>
  <div class="space-y-2 p-3">
    <div class="flex items-center gap-3">
      <h3 class="panel-title">Events in {{ ctx.name }}</h3>
      <label class="ml-auto flex items-center gap-1.5 text-fg-muted"><input v-model="warningsOnly" type="checkbox" class="accent-[var(--accent)]" /> Warnings only</label>
      <input v-model="filter" class="input w-56" placeholder="Filter" />
    </div>
    <div class="overflow-auto rounded-md border border-line bg-surface-1">
      <table class="table-dense">
        <thead>
          <tr>
            <th class="w-32">Last seen</th>
            <th class="w-20">Type</th>
            <th class="w-44">Reason</th>
            <th class="w-72">Object</th>
            <th>Message</th>
            <th class="w-14 text-right">Count</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ e, ts } in rows" :key="e.metadata.uid">
            <td class="tabular-nums" :title="dateTime(ts)">{{ age(ts) }} ago</td>
            <td :class="e.type === 'Warning' ? 'text-warn' : 'text-fg-muted'">{{ e.type }}</td>
            <td class="truncate">{{ e.reason }}</td>
            <td class="truncate text-fg-muted">{{ e.involvedObject?.kind }}/{{ e.involvedObject?.name }}</td>
            <td class="max-w-0 truncate" :title="e.message">{{ e.message }}</td>
            <td class="text-right tabular-nums">{{ e.count ?? e.series?.count ?? 1 }}</td>
          </tr>
          <tr v-if="!rows.length">
            <td colspan="6" class="h-14 text-center text-fg-subtle">{{ events.error.value ? events.error.value.message : events.synced.value ? 'No events' : 'Loading…' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
