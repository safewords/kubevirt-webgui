<script setup lang="ts">
import { computed, ref } from 'vue'
import { faPlus, faTrash, faUserShield, faRotate } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { gateway, errorMessage } from '@/api/gateway'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { confirm, openDialog, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import RoleBindingDialog from './RoleBindingDialog.vue'

const props = defineProps<{ ctx: ObjectContext }>()
const bindings = useWatch(() => ({ apiVersion: 'rbac.authorization.k8s.io/v1', resource: 'rolebindings', namespace: props.ctx.name }))

interface Row {
  key: string
  binding: KObject
  subject: { kind: string; name: string; namespace?: string }
}

const rows = computed<Row[]>(() =>
  bindings.items.value.flatMap((b) =>
    ((b.subjects ?? []) as Row['subject'][]).map((subject, i) => ({ key: `${b.metadata.uid}/${i}`, binding: b, subject })),
  ),
)

const columns: Column<Row>[] = [
  { key: 'subject', label: 'Subject', value: (r) => (r.subject.kind === 'ServiceAccount' ? `${r.subject.name}@${r.subject.namespace ?? props.ctx.name}` : r.subject.name) },
  { key: 'kind', label: 'Type', value: (r) => r.subject.kind },
  { key: 'role', label: 'Role', value: (r) => r.binding.roleRef?.name },
  { key: 'roleKind', label: 'Role kind', value: (r) => r.binding.roleRef?.kind },
  { key: 'binding', label: 'Binding', value: (r) => r.binding.metadata.name },
]

const canCreate = computed(() => can({ verb: 'create', group: 'rbac.authorization.k8s.io', resource: 'rolebindings', namespace: props.ctx.name }) === true)
const canDelete = computed(() => can({ verb: 'delete', group: 'rbac.authorization.k8s.io', resource: 'rolebindings', namespace: props.ctx.name }) === true)

async function remove(row: Row) {
  const b = row.binding
  const others = (b.subjects ?? []).length - 1
  const ok = await confirm({
    title: 'Remove permission',
    message: others > 0
      ? `Remove ${row.subject.kind} ${row.subject.name} from the binding ${b.metadata.name}? ${others} other subject(s) keep the role.`
      : `Delete the binding ${b.metadata.name}, which grants ${b.roleRef?.name} to ${row.subject.kind} ${row.subject.name}?`,
    confirmText: 'Remove',
    danger: true,
  })
  if (!ok) return
  const ref = { apiVersion: 'rbac.authorization.k8s.io/v1', resource: 'rolebindings', namespace: props.ctx.name, name: b.metadata.name }
  if (others > 0) {
    const subjects = (b.subjects ?? []).filter((s: Row['subject']) => !(s.kind === row.subject.kind && s.name === row.subject.name && (s.namespace ?? '') === (row.subject.namespace ?? '')))
    await run('Remove permission', () => k8s.patch(ref, { metadata: { resourceVersion: b.metadata.resourceVersion }, subjects }))
  } else {
    await run('Remove permission', () => k8s.delete(ref))
  }
}

// What the signed-in user may do here.
const rules = ref<any[] | null>(null)
const rulesError = ref<string | null>(null)
async function loadRules() {
  rulesError.value = null
  try {
    const status = await gateway.call<{ resourceRules?: any[]; incomplete?: boolean }>('access.rules', { namespace: props.ctx.name })
    rules.value = (status.resourceRules ?? []).filter((r) => (r.apiGroups ?? []).some((g: string) => g === '*' || g.includes('kubevirt') || g === '' || g.includes('cdi')))
  } catch (e) {
    rulesError.value = errorMessage(e)
  }
}
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title">Role bindings</h3>
        <button class="btn btn-sm ml-auto" :disabled="!canCreate" @click="openDialog(RoleBindingDialog, { namespace: ctx.name })"><Fa :icon="faPlus" /> Add permission</button>
      </div>
      <Notice v-if="bindings.error.value" kind="warning">{{ bindings.error.value.message }}</Notice>
      <DataTable v-else :columns="columns" :rows="rows" :row-key="(r) => r.key" filterable :loading="!bindings.synced.value" empty-text="No role bindings in this namespace">
        <template #cell-role="{ row, value }">
          <span class="flex items-center gap-2">
            <span class="mono" :class="String(value).startsWith('kubevirt.io:') ? 'text-accent' : ''">{{ value }}</span>
            <button class="btn btn-sm btn-ghost ml-auto text-bad" :disabled="!canDelete" title="Remove" @click.stop="remove(row)"><Fa :icon="faTrash" /></button>
          </span>
        </template>
      </DataTable>
      <p class="mt-2 text-xs text-fg-muted">Cluster-wide ClusterRoleBindings also apply here and are managed at the datacenter level.</p>
    </section>

    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title"><Fa :icon="faUserShield" class="mr-1 text-fg-muted" /> Your access in {{ ctx.name }}</h3>
        <button class="btn btn-sm ml-auto" @click="loadRules"><Fa :icon="faRotate" /> {{ rules ? 'Refresh' : 'Show' }}</button>
      </div>
      <Notice v-if="rulesError" kind="error">{{ rulesError }}</Notice>
      <div v-else-if="rules" class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead><tr><th class="w-64">API groups</th><th>Resources</th><th class="w-72">Verbs</th></tr></thead>
          <tbody>
            <tr v-for="(r, i) in rules" :key="i">
              <td class="mono">{{ (r.apiGroups ?? []).map((g: string) => g || 'core').join(', ') }}</td>
              <td class="mono max-w-0 truncate whitespace-normal">{{ (r.resources ?? []).join(', ') }}</td>
              <td class="mono">{{ (r.verbs ?? []).join(', ') }}</td>
            </tr>
            <tr v-if="!rules.length"><td colspan="3" class="h-12 text-center text-fg-subtle">No rules for core, KubeVirt or CDI resources</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
