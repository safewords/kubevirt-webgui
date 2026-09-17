<script setup lang="ts">
/** Events about a node, and about the pods and VMs running on it. */
import { computed, ref } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useInventory } from '@/plugins/core/inventory'
import { useMultiWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age, dateTime } from '@/util/format'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()

const scope = computed(() => {
  const allowed = can({ verb: 'list', group: '', resource: 'events' })
  if (allowed === undefined) return undefined
  return allowed ? null : inv.reachableNamespaces
})
const events = useMultiWatch(
  () => (scope.value === undefined ? null : { apiVersion: 'v1', resource: 'events' }),
  () => (scope.value === undefined ? [] : scope.value),
)
const includeGuests = ref(true)

const guests = computed(() => new Set(inv.vmis.filter((v) => v.status?.nodeName === props.ctx.name).map((v) => `${v.metadata.namespace}/${v.metadata.name}`)))

const rows = computed(() =>
  events.items.value.filter((e: KObject) => {
    const io = e.involvedObject ?? {}
    if (io.kind === 'Node' && io.name === props.ctx.name) return true
    if (e.source?.host === props.ctx.name || e.reportingInstance === props.ctx.name) return true
    if (!includeGuests.value) return false
    if ((io.kind === 'VirtualMachineInstance' || io.kind === 'VirtualMachine') && guests.value.has(`${io.namespace}/${io.name}`)) return true
    return false
  }),
)

const timestamp = (e: KObject) => Date.parse(e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') || 0

const columns: Column<KObject>[] = [
  { key: 'time', label: 'Last seen', value: timestamp },
  { key: 'type', label: 'Type', value: (e) => e.type },
  { key: 'object', label: 'Object', value: (e) => `${e.involvedObject?.kind}/${e.involvedObject?.namespace ? `${e.involvedObject.namespace}/` : ''}${e.involvedObject?.name}` },
  { key: 'reason', label: 'Reason', value: (e) => e.reason },
  { key: 'message', label: 'Message', value: (e) => e.message },
  { key: 'count', label: 'Count', align: 'right', value: (e) => e.count ?? e.series?.count ?? 1 },
]
</script>

<template>
  <div class="space-y-2 p-3">
    <Notice v-if="events.error.value" kind="warning">{{ events.error.value.message }}</Notice>
    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(e) => e.metadata.uid"
      filterable
      :loading="!events.synced.value"
      :default-sort="{ key: 'time', dir: 'desc' }"
      empty-text="No recent events for this node (Kubernetes keeps them for about an hour)"
    >
      <template #toolbar>
        <label class="flex items-center gap-1.5"><input v-model="includeGuests" type="checkbox" class="accent-[var(--accent)]" /> Include guests on this node</label>
      </template>
      <template #cell-time="{ value }"><span class="tabular-nums" :title="dateTime(value as number)">{{ age(value as number) }} ago</span></template>
      <template #cell-type="{ value }"><span :class="value === 'Warning' ? 'text-warn' : 'text-fg-muted'">{{ value }}</span></template>
      <template #cell-object="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
      <template #cell-message="{ value }"><span class="block max-w-[640px] truncate" :title="value as string">{{ value }}</span></template>
    </DataTable>
  </div>
</template>
