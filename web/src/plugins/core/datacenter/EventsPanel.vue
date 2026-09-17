<script setup lang="ts">
/** Every Kubernetes event the user can see, cluster-wide. */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useInventory } from '@/plugins/core/inventory'
import { useMultiWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age, dateTime } from '@/util/format'
import { routeTo, type ObjectRef } from '@/util/nav'

defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const router = useRouter()

const scope = computed(() => {
  const allowed = can({ verb: 'list', group: '', resource: 'events' })
  if (allowed === undefined) return undefined
  return allowed ? null : inv.reachableNamespaces
})
const events = useMultiWatch(
  () => (scope.value === undefined ? null : { apiVersion: 'v1', resource: 'events' }),
  () => (scope.value === undefined ? [] : scope.value),
)

const warningsOnly = ref(false)
const virtOnly = ref(true)
const kind = ref('')

const VIRT_KINDS = new Set([
  'VirtualMachine', 'VirtualMachineInstance', 'VirtualMachineInstanceMigration', 'VirtualMachineSnapshot', 'VirtualMachineRestore', 'VirtualMachineClone',
  'VirtualMachineExport', 'VirtualMachinePool', 'DataVolume', 'DataSource', 'DataImportCron', 'PersistentVolumeClaim', 'Node', 'KubeVirt', 'CDI', 'UsbDeviceClaim', 'UsbDevice',
])

const timestamp = (e: KObject) => Date.parse(e.lastTimestamp ?? e.series?.lastObservedTime ?? e.eventTime ?? e.metadata.creationTimestamp ?? '') || 0
const isVirt = (e: KObject) => VIRT_KINDS.has(e.involvedObject?.kind) || /^(virt-launcher|importer|cdi-upload|hp-volume)-/.test(e.involvedObject?.name ?? '')

const kinds = computed(() => [...new Set(events.items.value.map((e) => e.involvedObject?.kind).filter(Boolean))].sort())
const rows = computed(() =>
  events.items.value.filter((e) => (!warningsOnly.value || e.type === 'Warning') && (!virtOnly.value || isVirt(e)) && (!kind.value || e.involvedObject?.kind === kind.value)),
)
const warnings = computed(() => rows.value.filter((e) => e.type === 'Warning').length)

const columns: Column<KObject>[] = [
  { key: 'time', label: 'Last seen', value: timestamp },
  { key: 'type', label: 'Type', value: (e) => e.type },
  { key: 'object', label: 'Object', value: (e) => `${e.involvedObject?.kind}/${e.involvedObject?.namespace ? `${e.involvedObject.namespace}/` : ''}${e.involvedObject?.name}` },
  { key: 'reason', label: 'Reason', value: (e) => e.reason },
  { key: 'message', label: 'Message', value: (e) => e.message },
  { key: 'source', label: 'Source', value: (e) => e.source?.component ?? e.reportingComponent ?? '' },
  { key: 'count', label: 'Count', align: 'right', value: (e) => e.count ?? e.series?.count ?? 1 },
]

function target(e: KObject): ObjectRef | null {
  const io = e.involvedObject ?? {}
  switch (io.kind) {
    case 'VirtualMachine':
    case 'VirtualMachineInstance':
      return { kind: 'vm', name: io.name, namespace: io.namespace }
    case 'Node':
      return { kind: 'node', name: io.name }
    case 'PersistentVolumeClaim':
    case 'DataVolume':
      return { kind: 'disk', name: io.name, namespace: io.namespace }
    case 'Namespace':
      return { kind: 'namespace', name: io.name }
    default:
      return null
  }
}

function open(e: KObject) {
  const t = target(e)
  if (t) router.push(routeTo(t))
}
</script>

<template>
  <div class="space-y-2 p-3">
    <Notice v-if="events.error.value" kind="warning">{{ events.error.value.message }}</Notice>
    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(e) => e.metadata.uid"
      filterable
      filter-placeholder="Filter events"
      :default-sort="{ key: 'time', dir: 'desc' }"
      :loading="!events.synced.value"
      empty-text="No events. Kubernetes keeps events for about an hour."
      @activate="open"
    >
      <template #toolbar>
        <label class="flex items-center gap-1.5"><input v-model="virtOnly" type="checkbox" class="accent-[var(--accent)]" /> Virtualization only</label>
        <label class="flex items-center gap-1.5"><input v-model="warningsOnly" type="checkbox" class="accent-[var(--accent)]" /> Warnings only</label>
        <select v-model="kind" class="input w-48">
          <option value="">All object kinds</option>
          <option v-for="k in kinds" :key="k" :value="k">{{ k }}</option>
        </select>
        <span class="chip" :class="warnings ? 'bg-warn/15 text-warn' : ''"><Fa :icon="faTriangleExclamation" /> {{ warnings }} warnings</span>
        <span class="text-xs text-fg-subtle">{{ rows.length }} shown</span>
      </template>
      <template #cell-time="{ value }"><span class="tabular-nums" :title="dateTime(value as number)">{{ age(value as number) }} ago</span></template>
      <template #cell-type="{ value }"><span :class="value === 'Warning' ? 'text-warn' : 'text-fg-muted'">{{ value }}</span></template>
      <template #cell-object="{ row }">
        <span :class="target(row) ? 'cursor-pointer hover:text-accent' : ''" @click="open(row)">
          <span class="text-fg-muted">{{ row.involvedObject?.kind }}</span>
          {{ row.involvedObject?.namespace ? `${row.involvedObject.namespace}/` : '' }}{{ row.involvedObject?.name }}
        </span>
      </template>
      <template #cell-message="{ value }"><span class="block max-w-[640px] truncate" :title="value as string">{{ value }}</span></template>
      <template #cell-source="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
    </DataTable>
  </div>
</template>
