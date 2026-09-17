<script setup lang="ts">
/** Grant a role in a namespace — Proxmox's "Add permission". */
import { computed, ref } from 'vue'
import { faUserPlus } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { toast } from '@/services/dialogs'
import { randomSuffix, toDnsLabel } from '@/util/format'

const props = defineProps<{ namespaces: string[]; namespace: string; clusterRoles: string[]; subject?: { kind: string; name: string; namespace?: string } }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

const namespace = ref(props.namespace)
const roleKind = ref<'ClusterRole' | 'Role'>('ClusterRole')
const role = ref('kubevirt.io:edit')
const subjectKind = ref(props.subject?.kind ?? 'User')
const subjectName = ref(props.subject?.name ?? '')
const subjectNamespace = ref(props.subject?.namespace ?? props.namespace)
const name = ref('')
const error = ref<string | null>(null)
const busy = ref(false)

const SUGGESTED = [
  { name: 'kubevirt.io:view', hint: 'See VMs and their status' },
  { name: 'kubevirt.io:edit', hint: 'Manage and operate VMs' },
  { name: 'kubevirt.io:admin', hint: 'Everything, including migrations and snapshots' },
  { name: 'view', hint: 'Read everything in the namespace' },
  { name: 'edit', hint: 'Change most objects' },
  { name: 'admin', hint: 'Full control, including RBAC' },
]
const otherRoles = computed(() => props.clusterRoles.filter((r) => !SUGGESTED.some((s) => s.name === r)).sort())

const generatedName = computed(() => toDnsLabel(`${role.value.replace(/[^a-z0-9]+/gi, '-')}-${subjectName.value.split(':').pop() ?? ''}`).slice(0, 52) || 'binding')
const finalName = computed(() => name.value.trim() || `${generatedName.value}-${suffix}`)
const suffix = randomSuffix(4)
const valid = computed(() => namespace.value && role.value.trim() && subjectName.value.trim() && (subjectKind.value !== 'ServiceAccount' || subjectNamespace.value) && (!name.value.trim() || /^[a-z0-9.:-]+$/.test(name.value.trim())))

async function submit() {
  if (!valid.value) return
  error.value = null
  busy.value = true
  try {
    const subject: Record<string, string> = { kind: subjectKind.value, name: subjectName.value.trim() }
    if (subjectKind.value === 'ServiceAccount') subject.namespace = subjectNamespace.value
    else subject.apiGroup = 'rbac.authorization.k8s.io'
    await k8s.create(
      { apiVersion: 'rbac.authorization.k8s.io/v1', resource: 'rolebindings', namespace: namespace.value },
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: { name: finalName.value, namespace: namespace.value, labels: { 'app.kubernetes.io/managed-by': 'kubevirt-webgui' } },
        roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: roleKind.value, name: role.value.trim() },
        subjects: [subject],
      },
    )
    toast('success', 'Permission added', `${subjectName.value} → ${role.value} in ${namespace.value}`)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Add permission" :icon="faUserPlus" width="560px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="label">Namespace</label>
          <select v-model="namespace" class="input">
            <option v-for="ns in namespaces" :key="ns" :value="ns">{{ ns }}</option>
          </select>
        </div>
        <div>
          <label class="label">Role kind</label>
          <select v-model="roleKind" class="input">
            <option value="ClusterRole">ClusterRole (shared definition)</option>
            <option value="Role">Role (defined in the namespace)</option>
          </select>
        </div>
      </div>
      <div>
        <label class="label">Role</label>
        <input v-model="role" class="input mono" list="kve-role-options" placeholder="kubevirt.io:edit" />
        <datalist id="kve-role-options">
          <option v-for="r in SUGGESTED" :key="r.name" :value="r.name">{{ r.hint }}</option>
          <option v-for="r in otherRoles" :key="r" :value="r" />
        </datalist>
        <p class="mt-1 text-xs text-fg-muted">{{ SUGGESTED.find((s) => s.name === role)?.hint ?? 'A custom role' }}</p>
      </div>
      <div class="grid grid-cols-[150px_1fr] gap-3">
        <div>
          <label class="label">Subject kind</label>
          <select v-model="subjectKind" class="input">
            <option>User</option>
            <option>Group</option>
            <option>ServiceAccount</option>
          </select>
        </div>
        <div>
          <label class="label">{{ subjectKind === 'ServiceAccount' ? 'ServiceAccount name' : subjectKind === 'Group' ? 'Group' : 'User name (as the cluster knows it, e.g. OIDC email)' }}</label>
          <input v-model="subjectName" class="input mono" :placeholder="subjectKind === 'Group' ? 'vm-operators' : subjectKind === 'User' ? 'alice@example.com' : 'ci-bot'" />
        </div>
      </div>
      <div v-if="subjectKind === 'ServiceAccount'">
        <label class="label">ServiceAccount namespace</label>
        <select v-model="subjectNamespace" class="input">
          <option v-for="ns in namespaces" :key="ns" :value="ns">{{ ns }}</option>
        </select>
      </div>
      <div>
        <label class="label">Binding name</label>
        <input v-model="name" class="input mono" :placeholder="finalName" />
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!valid || busy" @click="submit"><Fa :icon="faUserPlus" /> Add</button>
    </template>
  </Modal>
</template>
