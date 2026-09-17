<script setup lang="ts">
/** Who holds which role — RoleBindings and ClusterRoleBindings. */
import { computed, ref } from 'vue'
import { faUserPlus, faTrash, faUser, faUsers, faRobot, faFileCode } from '@fortawesome/free-solid-svg-icons'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { confirm, openDialog, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age } from '@/util/format'
import { useClusterWatch, useScopedWatch } from '../helpers'
import RoleBindingDialog from './RoleBindingDialog.vue'
import YamlDialog from '../YamlDialog.vue'

const props = defineProps<{ namespaces: string[]; initial: string }>()
const cluster = useCluster()
const RBAC = 'rbac.authorization.k8s.io'

const bindings = useScopedWatch(() => (cluster.has(`${RBAC}/v1/rolebindings`) ? `${RBAC}/v1` : null), RBAC, 'rolebindings')
const clusterBindings = useClusterWatch(() => (cluster.has(`${RBAC}/v1/clusterrolebindings`) ? `${RBAC}/v1` : null), RBAC, 'clusterrolebindings')
const clusterRoles = useClusterWatch(() => (cluster.has(`${RBAC}/v1/clusterroles`) ? `${RBAC}/v1` : null), RBAC, 'clusterroles')

const scope = ref<'virt' | 'all'>('virt')
const includeCluster = ref(true)
const hideSystem = ref(true)

interface Row {
  uid: string
  object: KObject
  scope: string
  role: string
  roleKind: string
  subjects: Array<{ kind: string; name: string; namespace?: string }>
  name: string
  created?: string
}

const VIRT_ROLE = /^(kubevirt\.io:|cdi\.kubevirt\.io:|instancetype\.kubevirt\.io:|admin$|edit$|view$|cluster-admin$)/
const SYSTEM = /^(system:|kubeadm:|k3s)/

const rows = computed<Row[]>(() => {
  const all = [...bindings.items.value, ...(includeCluster.value ? clusterBindings.items.value : [])]
  return all
    .map((b) => ({
      uid: b.metadata.uid,
      object: b,
      scope: b.metadata.namespace ?? 'cluster-wide',
      role: b.roleRef?.name ?? '',
      roleKind: b.roleRef?.kind ?? '',
      subjects: b.subjects ?? [],
      name: b.metadata.name,
      created: b.metadata.creationTimestamp,
    }))
    .filter((r) => scope.value === 'all' || VIRT_ROLE.test(r.role))
    .filter((r) => !hideSystem.value || !(SYSTEM.test(r.name) || SYSTEM.test(r.role)))
})

const columns: Column<Row>[] = [
  { key: 'scope', label: 'Scope' },
  { key: 'subjects', label: 'Subjects', value: (r) => r.subjects.map((s) => `${s.kind} ${s.namespace ? `${s.namespace}:` : ''}${s.name}`).join(', ') },
  { key: 'role', label: 'Role', value: (r) => r.role },
  { key: 'name', label: 'Binding' },
  { key: 'created', label: 'Age', value: (r) => (r.created ? Date.parse(r.created) : 0) },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

const subjectIcon = (kind: string) => (kind === 'Group' ? faUsers : kind === 'ServiceAccount' ? faRobot : faUser)
const canCreate = computed(() => can({ verb: 'create', group: RBAC, resource: 'rolebindings', namespace: props.initial }))

async function add() {
  await openDialog(RoleBindingDialog, { namespaces: props.namespaces, namespace: props.initial, clusterRoles: clusterRoles.items.value.map((r) => r.metadata.name) })
}

function canDelete(row: Row) {
  return row.object.metadata.namespace
    ? can({ verb: 'delete', group: RBAC, resource: 'rolebindings', namespace: row.object.metadata.namespace, name: row.name })
    : can({ verb: 'delete', group: RBAC, resource: 'clusterrolebindings', name: row.name })
}

async function remove(row: Row) {
  const who = row.subjects.map((s) => s.name).join(', ')
  const ok = await confirm({
    title: 'Remove permission',
    message: `Remove ${row.role} from ${who} ${row.object.metadata.namespace ? `in ${row.object.metadata.namespace}` : 'cluster-wide'}? The binding ${row.name} is deleted.`,
    confirmText: 'Remove',
    danger: true,
  })
  if (!ok) return
  await run(`Remove ${row.name}`, () =>
    k8s.delete({
      apiVersion: `${RBAC}/v1`,
      resource: row.object.metadata.namespace ? 'rolebindings' : 'clusterrolebindings',
      namespace: row.object.metadata.namespace,
      name: row.name,
    }),
  )
}

function show(row: Row) {
  openDialog(YamlDialog, { title: `${row.object.metadata.namespace ? 'RoleBinding' : 'ClusterRoleBinding'} ${row.name}`, mode: 'view', object: row.object })
}
</script>

<template>
  <div class="space-y-2">
    <Notice v-if="bindings.error.value" kind="warning">{{ bindings.error.value.message }}</Notice>
    <DataTable :columns="columns" :rows="rows" :row-key="(r) => r.uid" filterable filter-placeholder="Filter by subject, role…" :default-sort="{ key: 'scope', dir: 'asc' }" empty-text="No matching bindings you can see" @activate="show">
      <template #toolbar>
        <button class="btn btn-primary" :disabled="canCreate === false" @click="add"><Fa :icon="faUserPlus" /> Add permission</button>
        <select v-model="scope" class="input w-52">
          <option value="virt">Virtualization-related roles</option>
          <option value="all">All roles</option>
        </select>
        <label class="flex items-center gap-1.5"><input v-model="includeCluster" type="checkbox" class="accent-[var(--accent)]" /> Cluster-wide</label>
        <label class="flex items-center gap-1.5"><input v-model="hideSystem" type="checkbox" class="accent-[var(--accent)]" /> Hide system</label>
      </template>
      <template #cell-scope="{ row }">
        <span :class="row.object.metadata.namespace ? '' : 'text-accent'">{{ row.scope }}</span>
      </template>
      <template #cell-subjects="{ row }">
        <span class="flex flex-wrap gap-1 whitespace-normal">
          <span v-for="(s, i) in row.subjects" :key="i" class="chip" :title="s.kind">
            <Fa :icon="subjectIcon(s.kind)" />{{ s.namespace ? `${s.namespace}:` : '' }}{{ s.name }}
          </span>
        </span>
      </template>
      <template #cell-role="{ row }">
        <span class="mono">{{ row.role }}</span>
        <span v-if="row.roleKind === 'Role'" class="chip ml-1">Role</span>
      </template>
      <template #cell-name="{ value }"><span class="mono text-fg-muted">{{ value }}</span></template>
      <template #cell-created="{ value }">{{ (value as number) ? age(value as number) : '—' }}</template>
      <template #cell-actions="{ row }">
        <span class="flex justify-end gap-1">
          <button class="btn btn-sm btn-ghost" title="YAML" @click.stop="show(row)"><Fa :icon="faFileCode" /></button>
          <button class="btn btn-sm btn-danger" :disabled="canDelete(row) !== true" @click.stop="remove(row)"><Fa :icon="faTrash" /></button>
        </span>
      </template>
    </DataTable>
  </div>
</template>
