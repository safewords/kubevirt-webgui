<script setup lang="ts">
/** Grant a role in a namespace — Proxmox's "Add permission" on a pool. */
import { computed, ref } from 'vue'
import { faUserShield } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { toDnsLabel } from '@/util/format'
import { toast } from '@/services/dialogs'

const props = defineProps<{ namespace: string }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

const ROLES = [
  { name: 'kubevirt.io:admin', hint: 'Full control of VMs, including consoles, migration and snapshots' },
  { name: 'kubevirt.io:edit', hint: 'Create, change and operate VMs' },
  { name: 'kubevirt.io:view', hint: 'See VMs; no changes, no consoles' },
  { name: 'admin', hint: 'Kubernetes namespace admin (includes RBAC in the namespace)' },
  { name: 'edit', hint: 'Kubernetes: change most objects' },
  { name: 'view', hint: 'Kubernetes: read most objects' },
]

const role = ref(ROLES[0].name)
const customRole = ref('')
const subjectKind = ref<'User' | 'Group' | 'ServiceAccount'>('User')
const subjectName = ref('')
const saNamespace = ref(props.namespace)
const busy = ref(false)
const error = ref<string | null>(null)

const roleName = computed(() => (role.value === '__custom' ? customRole.value.trim() : role.value))
const bindingName = computed(() => toDnsLabel(`kve-${roleName.value.replace(/[:.]/g, '-')}-${subjectKind.value === 'ServiceAccount' ? `${saNamespace.value}-` : ''}${subjectName.value}`).slice(0, 63).replace(/-+$/, ''))
const ready = computed(() => !!roleName.value && !!subjectName.value.trim() && !!bindingName.value)

async function save() {
  error.value = null
  busy.value = true
  try {
    const subject =
      subjectKind.value === 'ServiceAccount'
        ? { kind: 'ServiceAccount', name: subjectName.value.trim(), namespace: saNamespace.value.trim() }
        : { kind: subjectKind.value, name: subjectName.value.trim(), apiGroup: 'rbac.authorization.k8s.io' }
    await k8s.create(
      { apiVersion: 'rbac.authorization.k8s.io/v1', resource: 'rolebindings', namespace: props.namespace },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: bindingName.value, namespace: props.namespace, labels: { 'app.kubernetes.io/managed-by': 'kubevirt-webgui' } },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: roleName.value },
        subjects: [subject],
      },
    )
    toast('success', 'Permission added', `${subject.kind} ${subject.name} → ${roleName.value}`)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="`Add permission in ${namespace}`" :icon="faUserShield" width="560px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div>
        <label class="label">Role (ClusterRole)</label>
        <select v-model="role" class="input">
          <option v-for="r in ROLES" :key="r.name" :value="r.name">{{ r.name }} — {{ r.hint }}</option>
          <option value="__custom">Other ClusterRole…</option>
        </select>
        <input v-if="role === '__custom'" v-model="customRole" class="input mono mt-2" placeholder="cluster role name" />
      </div>
      <div class="grid gap-3 sm:grid-cols-[160px_1fr]">
        <div>
          <label class="label">Subject</label>
          <select v-model="subjectKind" class="input">
            <option value="User">User</option>
            <option value="Group">Group</option>
            <option value="ServiceAccount">ServiceAccount</option>
          </select>
        </div>
        <div>
          <label class="label">{{ subjectKind === 'ServiceAccount' ? 'ServiceAccount name' : subjectKind === 'Group' ? 'Group name' : 'User name (as the API server sees it, e.g. an OIDC email)' }}</label>
          <input v-model="subjectName" class="input mono" />
        </div>
      </div>
      <div v-if="subjectKind === 'ServiceAccount'">
        <label class="label">ServiceAccount namespace</label>
        <input v-model="saNamespace" class="input mono" />
      </div>
      <p class="text-xs text-fg-muted">Creates the RoleBinding <span class="mono">{{ bindingName || '…' }}</span>. You can only grant permissions you hold yourself.</p>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !ready" @click="save">Add</button>
    </template>
  </Modal>
</template>
