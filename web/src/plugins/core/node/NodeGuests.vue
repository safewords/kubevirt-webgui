<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { faArrowRightArrowLeft } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { vmApi } from '@/api/k8s'
import { useInventory } from '@/plugins/core/inventory'
import { can } from '@/stores/access'
import { confirm, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import StateBadge from '@/components/ui/StateBadge.vue'
import { addresses, isTrue, condition, memoryBytes, vcpus, vmState } from '@/util/kubevirt'
import { age, bytes } from '@/util/format'
import { routeTo } from '@/util/nav'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const router = useRouter()

const guests = computed(() => inv.vmis.filter((v) => v.status?.nodeName === props.ctx.name))
const vmFor = (vmi: KObject) => inv.vms.find((vm) => vm.metadata.namespace === vmi.metadata.namespace && vm.metadata.name === vmi.metadata.name) ?? null

const columns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (v) => v.metadata.name },
  { key: 'namespace', label: 'Namespace', value: (v) => v.metadata.namespace },
  { key: 'state', label: 'Status', value: (v) => vmState(vmFor(v), v) },
  { key: 'cpu', label: 'vCPU', align: 'right', value: (v) => vcpus(v.spec) },
  { key: 'memory', label: 'Memory', align: 'right', value: (v) => memoryBytes(v.spec) },
  { key: 'ip', label: 'IP addresses', value: (v) => addresses(v).join(', ') },
  { key: 'migratable', label: 'Live migratable', value: (v) => (isTrue(v, 'LiveMigratable') ? 'yes' : 'no') },
  { key: 'uptime', label: 'Uptime', value: (v) => Date.parse(condition(v, 'Ready')?.lastTransitionTime ?? v.metadata.creationTimestamp ?? '') || 0 },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

const migratable = computed(() => guests.value.filter((v) => isTrue(v, 'LiveMigratable')))

async function migrate(vmi: KObject) {
  const ok = await confirm({ title: 'Migrate', message: `Live-migrate ${vmi.metadata.namespace}/${vmi.metadata.name} off ${props.ctx.name}? The scheduler picks the target node.`, confirmText: 'Migrate' })
  if (ok) await run(`Migrate ${vmi.metadata.name}`, () => vmApi.migrate(vmi.metadata.namespace!, vmi.metadata.name))
}

async function migrateAll() {
  const list = migratable.value
  const ok = await confirm({
    title: 'Migrate all guests',
    message: `Start live migrations for ${list.length} guest(s) on ${props.ctx.name}? The node stays schedulable, so use Drain to keep new VMs off it.`,
    confirmText: 'Migrate all',
  })
  if (!ok) return
  for (const vmi of list) await run(`Migrate ${vmi.metadata.name}`, () => vmApi.migrate(vmi.metadata.namespace!, vmi.metadata.name), { quiet: true })
}
</script>

<template>
  <div class="p-3">
    <DataTable
      :columns="columns"
      :rows="guests"
      :row-key="(v) => v.metadata.uid"
      filterable
      :default-sort="{ key: 'name', dir: 'asc' }"
      empty-text="No guests are running on this node"
      @activate="(v) => router.push(routeTo({ kind: 'vm', name: v.metadata.name, namespace: v.metadata.namespace }))"
    >
      <template #toolbar>
        <span class="text-fg-muted">{{ guests.length }} running · {{ migratable.length }} live-migratable</span>
        <button class="btn" :disabled="!migratable.length" @click="migrateAll"><Fa :icon="faArrowRightArrowLeft" /> Migrate all</button>
      </template>
      <template #cell-name="{ row }">
        <RouterLink class="font-medium hover:text-accent" :to="routeTo({ kind: 'vm', name: row.metadata.name, namespace: row.metadata.namespace })">{{ row.metadata.name }}</RouterLink>
      </template>
      <template #cell-state="{ value }"><StateBadge :state="value as string" /></template>
      <template #cell-memory="{ value }">{{ bytes(value as number) }}</template>
      <template #cell-ip="{ value }"><span class="mono">{{ value }}</span></template>
      <template #cell-migratable="{ row, value }">
        <span :class="value === 'yes' ? 'text-ok' : 'text-warn'" :title="condition(row, 'LiveMigratable')?.message">{{ value === 'yes' ? 'yes' : condition(row, 'LiveMigratable')?.reason ?? 'no' }}</span>
      </template>
      <template #cell-uptime="{ value }">{{ (value as number) ? age(value as number) : '—' }}</template>
      <template #cell-actions="{ row }">
        <button
          class="btn btn-sm"
          :disabled="!isTrue(row, 'LiveMigratable') || can({ verb: 'create', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations', namespace: row.metadata.namespace }) !== true"
          @click.stop="migrate(row)"
        >
          <Fa :icon="faArrowRightArrowLeft" /> Migrate
        </button>
      </template>
    </DataTable>
  </div>
</template>
