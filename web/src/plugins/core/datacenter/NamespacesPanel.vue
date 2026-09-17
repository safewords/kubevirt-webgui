<script setup lang="ts">
/** Namespaces — Proxmox's resource pools. */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { faFolderPlus, faTrash, faRotate } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject, NamespaceSummary } from '@/api/types'
import { k8s } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useInventory } from '@/plugins/core/inventory'
import { confirm, openDialog, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age, bytes, quantity } from '@/util/format'
import { vmState } from '@/util/kubevirt'
import { routeTo } from '@/util/nav'
import CreateNamespaceDialog from './CreateNamespaceDialog.vue'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const inv = useInventory()
const router = useRouter()

const canCreate = computed(() => can({ verb: 'create', group: '', resource: 'namespaces' }))

interface Row {
  name: string
  phase: string
  created?: string
  description: string
  vms: number
  running: number
  disks: number
  storage: number
  system: boolean
}

const SYSTEM = /^(kube-|kubevirt$|cdi$|default$|cattle-|calico-|cilium|metallb|traefik$|longhorn|rook-)/

const rows = computed<Row[]>(() =>
  cluster.namespaces.map((ns: NamespaceSummary) => {
    const vms = inv.vms.filter((v) => v.metadata.namespace === ns.name)
    const disks = inv.pvcs.filter((p) => p.metadata.namespace === ns.name)
    return {
      name: ns.name,
      phase: ns.phase ?? 'Active',
      created: ns.created,
      description: ns.annotations?.['kubevirt-webgui/description'] ?? ns.annotations?.['openshift.io/description'] ?? '',
      vms: vms.length,
      running: vms.filter((v: KObject) => ['running', 'paused', 'migrating'].includes(vmState(v, inv.vmiFor(v)))).length,
      disks: disks.length,
      storage: disks.reduce((sum, p) => sum + quantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage), 0),
      system: SYSTEM.test(ns.name),
    }
  }),
)

const columns: Column<Row>[] = [
  { key: 'name', label: 'Namespace' },
  { key: 'phase', label: 'Status' },
  { key: 'vms', label: 'VMs', align: 'right' },
  { key: 'running', label: 'Running', align: 'right' },
  { key: 'disks', label: 'Claims', align: 'right' },
  { key: 'storage', label: 'Storage', align: 'right' },
  { key: 'description', label: 'Description' },
  { key: 'created', label: 'Age', value: (r) => (r.created ? Date.parse(r.created) : 0) },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

async function create() {
  const name = await openDialog<string>(CreateNamespaceDialog)
  if (name) {
    await cluster.reloadNamespaces()
    router.push(routeTo({ kind: 'namespace', name }))
  }
}

async function remove(row: Row) {
  const result = await confirm({
    title: `Delete namespace ${row.name}`,
    message: `Deleting ${row.name} destroys everything in it${row.vms ? ` — including ${row.vms} virtual machine(s)` : ''}${row.disks ? ` and ${row.disks} disk(s)` : ''}. This cannot be undone.`,
    confirmText: 'Delete namespace',
    danger: true,
    typeToConfirm: row.name,
  })
  if (!result) return
  await run(`Delete namespace ${row.name}`, async () => {
    await k8s.delete({ apiVersion: 'v1', resource: 'namespaces', name: row.name })
    await cluster.reloadNamespaces()
  })
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="!cluster.canListNamespaces" kind="info" title="Limited view">
      You cannot list namespaces, so only the ones known to this browser are shown. Add more under <RouterLink class="text-accent hover:underline" :to="{ name: 'datacenter', params: { panel: 'my-settings' } }">My settings</RouterLink>.
    </Notice>
    <DataTable
      :columns="columns"
      :rows="rows"
      :row-key="(r) => r.name"
      filterable
      filter-placeholder="Filter namespaces"
      :default-sort="{ key: 'name', dir: 'asc' }"
      empty-text="No namespaces"
      @activate="(r) => router.push(routeTo({ kind: 'namespace', name: r.name }))"
    >
      <template #toolbar>
        <button class="btn btn-primary" :disabled="canCreate !== true" :title="canCreate === false ? 'You may not create namespaces' : ''" @click="create"><Fa :icon="faFolderPlus" /> Create</button>
        <button class="btn" :disabled="cluster.loading" @click="cluster.reloadNamespaces()"><Fa :icon="faRotate" /> Refresh</button>
      </template>
      <template #cell-name="{ row }">
        <RouterLink class="font-medium hover:text-accent" :to="routeTo({ kind: 'namespace', name: row.name })">{{ row.name }}</RouterLink>
        <span v-if="row.system" class="chip ml-2">system</span>
      </template>
      <template #cell-phase="{ value }"><span :class="value === 'Active' ? 'text-ok' : 'text-warn'">{{ value }}</span></template>
      <template #cell-running="{ value }"><span :class="(value as number) ? 'text-ok' : 'text-fg-subtle'">{{ value }}</span></template>
      <template #cell-storage="{ value }">{{ (value as number) ? bytes(value as number) : '—' }}</template>
      <template #cell-description="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
      <template #cell-created="{ value }">{{ (value as number) ? age(value as number) : '—' }}</template>
      <template #cell-actions="{ row }">
        <button
          class="btn btn-sm btn-danger"
          :disabled="row.phase === 'Terminating' || can({ verb: 'delete', group: '', resource: 'namespaces', name: row.name }) !== true"
          @click.stop="remove(row)"
        >
          <Fa :icon="faTrash" />
        </button>
      </template>
    </DataTable>
  </div>
</template>
