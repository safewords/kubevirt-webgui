<script setup lang="ts">
/** The pods on a node — the VMs' launcher pods, and everything else. */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { faDesktop } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useWatch } from '@/stores/watch'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age } from '@/util/format'
import { routeTo } from '@/util/nav'

const props = defineProps<{ ctx: ObjectContext }>()
const router = useRouter()

const pods = useWatch(() => ({ apiVersion: 'v1', resource: 'pods', fieldSelector: `spec.nodeName=${props.ctx.name}` }))
const show = ref<'all' | 'vms' | 'system'>('all')

const vmName = (p: KObject) => p.metadata.labels?.['vm.kubevirt.io/name'] ?? p.metadata.labels?.['kubevirt.io/domain'] ?? null
const isLauncher = (p: KObject) => p.metadata.labels?.['kubevirt.io'] === 'virt-launcher'

const rows = computed(() =>
  pods.items.value.filter((p) => (show.value === 'all' ? true : show.value === 'vms' ? isLauncher(p) : !isLauncher(p))),
)

function ready(p: KObject) {
  const statuses = p.status?.containerStatuses ?? []
  return `${statuses.filter((s: any) => s.ready).length}/${p.spec?.containers?.length ?? statuses.length}`
}

function restarts(p: KObject) {
  return (p.status?.containerStatuses ?? []).reduce((sum: number, s: any) => sum + (s.restartCount ?? 0), 0)
}

function phase(p: KObject) {
  if (p.metadata.deletionTimestamp) return 'Terminating'
  const waiting = (p.status?.containerStatuses ?? []).find((s: any) => s.state?.waiting?.reason)
  return waiting?.state?.waiting?.reason ?? p.status?.phase ?? 'Unknown'
}

const columns: Column<KObject>[] = [
  { key: 'namespace', label: 'Namespace', value: (p) => p.metadata.namespace },
  { key: 'name', label: 'Pod', value: (p) => p.metadata.name },
  { key: 'vm', label: 'VM', value: (p) => vmName(p) ?? '' },
  { key: 'phase', label: 'Status', value: phase },
  { key: 'ready', label: 'Ready', align: 'right', value: ready },
  { key: 'restarts', label: 'Restarts', align: 'right', value: restarts },
  { key: 'ip', label: 'IP', value: (p) => p.status?.podIP ?? '' },
  { key: 'owner', label: 'Owner', value: (p) => p.metadata.ownerReferences?.[0]?.kind ?? '' },
  { key: 'age', label: 'Age', value: (p) => Date.parse(p.metadata.creationTimestamp ?? '') || 0 },
]

function phaseClass(value: string) {
  if (value === 'Running' || value === 'Succeeded') return 'text-ok'
  if (value === 'Pending' || value === 'ContainerCreating' || value === 'Terminating') return 'text-info'
  return 'text-bad'
}
</script>

<template>
  <div class="space-y-2 p-3">
    <Notice v-if="pods.error.value" kind="warning" title="Pods are not visible">{{ pods.error.value.message }}</Notice>
    <DataTable
      v-else
      :columns="columns"
      :rows="rows"
      :row-key="(p) => p.metadata.uid"
      filterable
      :loading="!pods.synced.value"
      :default-sort="{ key: 'namespace', dir: 'asc' }"
      empty-text="No pods"
    >
      <template #toolbar>
        <select v-model="show" class="input w-52">
          <option value="all">All pods ({{ pods.items.value.length }})</option>
          <option value="vms">VM launcher pods ({{ pods.items.value.filter(isLauncher).length }})</option>
          <option value="system">Other pods</option>
        </select>
      </template>
      <template #cell-name="{ value }"><span class="mono">{{ value }}</span></template>
      <template #cell-vm="{ row }">
        <RouterLink
          v-if="vmName(row)"
          class="hover:text-accent"
          :to="routeTo({ kind: 'vm', name: vmName(row)!, namespace: row.metadata.namespace })"
          @click.stop
        >
          <Fa :icon="faDesktop" class="mr-1 text-fg-muted" />{{ vmName(row) }}
        </RouterLink>
      </template>
      <template #cell-phase="{ value }"><span :class="phaseClass(value as string)">{{ value }}</span></template>
      <template #cell-restarts="{ value }"><span :class="(value as number) > 0 ? 'text-warn' : ''">{{ value }}</span></template>
      <template #cell-ip="{ value }"><span class="mono">{{ value }}</span></template>
      <template #cell-age="{ value }">{{ (value as number) ? age(value as number) : '—' }}</template>
    </DataTable>
  </div>
</template>
