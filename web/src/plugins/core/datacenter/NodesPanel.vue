<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { bytes, cores, quantity, age } from '@/util/format'
import { nodeReady, nodeRoles, schedulableForVms } from '@/util/kubevirt'
import { routeTo } from '@/util/nav'
import { can } from '@/stores/access'

defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const router = useRouter()

const usage = ref<Record<string, { cpu: number; memory: number }>>({})
const metricsError = ref<string | null>(null)
const sub = gateway.subscribe(
  'metrics.nodes',
  {},
  (event) => {
    if (event.type === 'nodes') {
      usage.value = event.nodes
      metricsError.value = null
    } else if (event.type === 'error') metricsError.value = event.error?.message ?? 'metrics unavailable'
  },
  (error) => {
    if (error) metricsError.value = error.message
  },
)
onBeforeUnmount(() => sub.close())

const canList = computed(() => can({ verb: 'list', group: '', resource: 'nodes' }))

function status(n: KObject) {
  if (!nodeReady(n)) return 'offline'
  return n.spec?.unschedulable ? 'maintenance' : 'online'
}

const columns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (n) => n.metadata.name },
  { key: 'status', label: 'Status', value: status },
  { key: 'roles', label: 'Roles', value: (n) => nodeRoles(n).join(', ') || 'worker' },
  { key: 'virt', label: 'Runs VMs', value: (n) => (schedulableForVms(n) ? 'yes' : 'no') },
  { key: 'guests', label: 'Guests', align: 'right', value: (n) => inv.vmis.filter((v) => v.status?.nodeName === n.metadata.name).length },
  { key: 'cpu', label: 'CPU usage', align: 'right', value: (n) => (usage.value[n.metadata.name] ? usage.value[n.metadata.name].cpu / (quantity(n.status?.allocatable?.cpu) || 1) : -1) },
  { key: 'cpuCap', label: 'CPUs', align: 'right', value: (n) => quantity(n.status?.allocatable?.cpu) },
  { key: 'memory', label: 'Memory usage', align: 'right', value: (n) => (usage.value[n.metadata.name] ? usage.value[n.metadata.name].memory / (quantity(n.status?.allocatable?.memory) || 1) : -1) },
  { key: 'memCap', label: 'Memory', align: 'right', value: (n) => quantity(n.status?.allocatable?.memory) },
  { key: 'address', label: 'Address', value: (n) => n.status?.addresses?.find((a: any) => a.type === 'InternalIP')?.address ?? '' },
  { key: 'kubelet', label: 'Kubelet', value: (n) => n.status?.nodeInfo?.kubeletVersion },
  { key: 'kernel', label: 'Kernel', value: (n) => n.status?.nodeInfo?.kernelVersion },
  { key: 'age', label: 'Age', value: (n) => Date.parse(n.metadata.creationTimestamp ?? '') || 0 },
]

function pct(value: number) {
  return value < 0 ? '—' : `${(value * 100).toFixed(1)}%`
}
function barClass(value: number) {
  return value > 0.9 ? 'bg-bad' : value > 0.75 ? 'bg-warn' : 'bg-accent'
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="canList === false" kind="warning" title="Nodes are not visible">Your account may not list nodes. Ask an administrator for the <code class="mono">nodes: list</code> permission.</Notice>
    <Notice v-if="metricsError" kind="warning" title="Usage unavailable">{{ metricsError }}</Notice>
    <DataTable
      :columns="columns"
      :rows="inv.nodes"
      :row-key="(n) => n.metadata.uid"
      filterable
      filter-placeholder="Filter nodes"
      :default-sort="{ key: 'name', dir: 'asc' }"
      empty-text="No nodes"
      @activate="(n) => router.push(routeTo({ kind: 'node', name: n.metadata.name }))"
    >
      <template #cell-name="{ row }">
        <RouterLink class="font-medium hover:text-accent" :to="routeTo({ kind: 'node', name: row.metadata.name })">{{ row.metadata.name }}</RouterLink>
      </template>
      <template #cell-status="{ value }">
        <span :class="value === 'online' ? 'text-ok' : value === 'maintenance' ? 'text-warn' : 'text-bad'">{{ value }}</span>
      </template>
      <template #cell-virt="{ value }">
        <span :class="value === 'yes' ? 'text-ok' : 'text-fg-subtle'">{{ value }}</span>
      </template>
      <template #cell-cpu="{ value }">
        <span class="inline-flex items-center gap-2">
          <span v-if="(value as number) >= 0" class="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3">
            <span class="block h-full rounded-full" :class="barClass(value as number)" :style="{ width: `${Math.min(100, (value as number) * 100)}%` }" />
          </span>
          {{ pct(value as number) }}
        </span>
      </template>
      <template #cell-memory="{ value }">
        <span class="inline-flex items-center gap-2">
          <span v-if="(value as number) >= 0" class="h-1.5 w-14 overflow-hidden rounded-full bg-surface-3">
            <span class="block h-full rounded-full" :class="barClass(value as number)" :style="{ width: `${Math.min(100, (value as number) * 100)}%` }" />
          </span>
          {{ pct(value as number) }}
        </span>
      </template>
      <template #cell-cpuCap="{ value }">{{ cores(value as number) }}</template>
      <template #cell-memCap="{ value }">{{ bytes(value as number) }}</template>
      <template #cell-address="{ value }"><span class="mono">{{ value }}</span></template>
      <template #cell-kernel="{ value }"><span class="mono text-fg-muted">{{ value }}</span></template>
      <template #cell-age="{ value }">{{ age(value as number) }}</template>
    </DataTable>
  </div>
</template>
