<script setup lang="ts">
/** API tokens: ServiceAccounts, their permissions, and minting tokens. */
import { computed, ref } from 'vue'
import { faKey, faPlus, faTrash, faUserShield, faRobot } from '@fortawesome/free-solid-svg-icons'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useWatch } from '@/stores/watch'
import { confirm, openDialog, run, toast } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age, isDnsLabel } from '@/util/format'
import { useClusterWatch, useScopedWatch } from '../helpers'
import TokenDialog from './TokenDialog.vue'
import RoleBindingDialog from './RoleBindingDialog.vue'

const props = defineProps<{ namespaces: string[]; initial: string }>()
const cluster = useCluster()
const RBAC = 'rbac.authorization.k8s.io'

const namespace = ref(props.initial)
const accounts = useWatch(() => ({ apiVersion: 'v1', resource: 'serviceaccounts', namespace: namespace.value }))
const bindings = useScopedWatch(() => (cluster.has(`${RBAC}/v1/rolebindings`) ? `${RBAC}/v1` : null), RBAC, 'rolebindings')
const clusterBindings = useClusterWatch(() => (cluster.has(`${RBAC}/v1/clusterrolebindings`) ? `${RBAC}/v1` : null), RBAC, 'clusterrolebindings')
const clusterRoles = useClusterWatch(() => (cluster.has(`${RBAC}/v1/clusterroles`) ? `${RBAC}/v1` : null), RBAC, 'clusterroles')

function rolesOf(sa: KObject): string[] {
  const matches = (b: KObject) => (b.subjects ?? []).some((s: any) => s.kind === 'ServiceAccount' && s.name === sa.metadata.name && s.namespace === sa.metadata.namespace)
  return [
    ...bindings.items.value.filter(matches).map((b) => `${b.roleRef?.name} (${b.metadata.namespace})`),
    ...clusterBindings.items.value.filter(matches).map((b) => `${b.roleRef?.name} (cluster)`),
  ]
}

const columns: Column<KObject>[] = [
  { key: 'name', label: 'ServiceAccount', value: (s) => s.metadata.name },
  { key: 'roles', label: 'Roles', value: (s) => rolesOf(s).join(', ') },
  { key: 'description', label: 'Description', value: (s) => s.metadata.annotations?.['kubevirt-webgui/description'] ?? '' },
  { key: 'age', label: 'Age', value: (s) => Date.parse(s.metadata.creationTimestamp ?? '') || 0 },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

const canCreateSa = computed(() => can({ verb: 'create', group: '', resource: 'serviceaccounts', namespace: namespace.value }))
const canToken = computed(() => can({ verb: 'create', group: '', resource: 'serviceaccounts', subresource: 'token', namespace: namespace.value }))

const newName = ref('')
const newDescription = ref('')
const creating = ref(false)

async function createAccount() {
  if (!isDnsLabel(newName.value)) return
  creating.value = true
  try {
    await k8s.create(
      { apiVersion: 'v1', resource: 'serviceaccounts', namespace: namespace.value },
      {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
          name: newName.value,
          namespace: namespace.value,
          labels: { 'app.kubernetes.io/managed-by': 'kubevirt-webgui' },
          annotations: newDescription.value.trim() ? { 'kubevirt-webgui/description': newDescription.value.trim() } : undefined,
        },
      },
    )
    toast('success', 'ServiceAccount created', `${namespace.value}/${newName.value} — grant it a role, then create a token.`)
    newName.value = ''
    newDescription.value = ''
  } catch (e) {
    toast('error', 'Could not create the ServiceAccount', errorMessage(e))
  } finally {
    creating.value = false
  }
}

function token(sa: KObject) {
  openDialog(TokenDialog, { namespace: sa.metadata.namespace, name: sa.metadata.name })
}

function grant(sa: KObject) {
  openDialog(RoleBindingDialog, {
    namespaces: props.namespaces,
    namespace: sa.metadata.namespace,
    clusterRoles: clusterRoles.items.value.map((r) => r.metadata.name),
    subject: { kind: 'ServiceAccount', name: sa.metadata.name, namespace: sa.metadata.namespace },
  })
}

async function remove(sa: KObject) {
  const ok = await confirm({
    title: 'Delete ServiceAccount',
    message: `Delete ${sa.metadata.namespace}/${sa.metadata.name}? Every token issued for it stops working immediately.`,
    confirmText: 'Delete',
    danger: true,
    typeToConfirm: sa.metadata.name,
  })
  if (ok) await run(`Delete ${sa.metadata.name}`, () => k8s.delete({ apiVersion: 'v1', resource: 'serviceaccounts', namespace: sa.metadata.namespace, name: sa.metadata.name }))
}
</script>

<template>
  <div class="space-y-3">
    <p class="text-fg-muted">
      Automation and people without single sign-on authenticate with ServiceAccount tokens. Create an account, grant it a role, then issue a token with an expiry — it works with <code class="mono">kubectl</code>, the API, and this GUI.
    </p>
    <div class="flex flex-wrap items-end gap-2">
      <div>
        <label class="label">Namespace</label>
        <select v-model="namespace" class="input w-56">
          <option v-for="ns in namespaces" :key="ns" :value="ns">{{ ns }}</option>
        </select>
      </div>
      <div class="ml-auto">
        <label class="label">New ServiceAccount</label>
        <input v-model="newName" class="input mono w-48" placeholder="ci-deployer" @keydown.enter="createAccount" />
      </div>
      <div>
        <label class="label">Description</label>
        <input v-model="newDescription" class="input w-56" placeholder="Optional" />
      </div>
      <button class="btn btn-primary" :disabled="!isDnsLabel(newName) || creating || canCreateSa !== true" @click="createAccount"><Fa :icon="faPlus" /> Create</button>
    </div>
    <Notice v-if="accounts.error.value" kind="warning">{{ accounts.error.value.message }}</Notice>
    <DataTable :columns="columns" :rows="accounts.items.value" :row-key="(s) => s.metadata.uid" filterable :default-sort="{ key: 'name', dir: 'asc' }" empty-text="No ServiceAccounts in this namespace">
      <template #cell-name="{ row }">
        <span class="flex items-center gap-2"><Fa :icon="faRobot" class="text-fg-muted" /><span class="mono font-medium">{{ row.metadata.name }}</span></span>
      </template>
      <template #cell-roles="{ row }">
        <span class="flex flex-wrap gap-1 whitespace-normal">
          <span v-for="r in rolesOf(row)" :key="r" class="chip mono">{{ r }}</span>
          <span v-if="!rolesOf(row).length" class="text-fg-subtle">no roles you can see</span>
        </span>
      </template>
      <template #cell-description="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
      <template #cell-age="{ value }">{{ (value as number) ? age(value as number) : '—' }}</template>
      <template #cell-actions="{ row }">
        <span class="flex justify-end gap-1">
          <button class="btn btn-sm" @click.stop="grant(row)"><Fa :icon="faUserShield" /> Grant role</button>
          <button class="btn btn-sm" :disabled="canToken !== true" @click.stop="token(row)"><Fa :icon="faKey" /> Create token</button>
          <button class="btn btn-sm btn-danger" :disabled="row.metadata.name === 'default'" @click.stop="remove(row)"><Fa :icon="faTrash" /></button>
        </span>
      </template>
    </DataTable>
  </div>
</template>
