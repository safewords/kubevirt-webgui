<script setup lang="ts">
/** Create or edit a ResourceQuota with the limits that matter for VMs. */
import { computed, reactive, ref } from 'vue'
import { faScaleBalanced } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { isDnsLabel } from '@/util/format'
import { toast } from '@/services/dialogs'

const props = defineProps<{ namespace: string; quota?: KObject | null }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

const FIELDS = [
  { key: 'requests.cpu', label: 'CPU requests', hint: 'cores, e.g. 16 or 500m' },
  { key: 'limits.cpu', label: 'CPU limits', hint: 'cores' },
  { key: 'requests.memory', label: 'Memory requests', hint: 'e.g. 64Gi' },
  { key: 'limits.memory', label: 'Memory limits', hint: 'e.g. 64Gi' },
  { key: 'requests.storage', label: 'Storage requests', hint: 'total PVC size, e.g. 1Ti' },
  { key: 'persistentvolumeclaims', label: 'Disks (PVCs)', hint: 'count' },
  { key: 'count/virtualmachines.kubevirt.io', label: 'Virtual machines', hint: 'count' },
  { key: 'count/virtualmachineinstances.kubevirt.io', label: 'Running VM instances', hint: 'count' },
  { key: 'pods', label: 'Pods', hint: 'count (each running VM uses one)' },
] as const

const editing = computed(() => !!props.quota)
const name = ref(props.quota?.metadata.name ?? 'vm-quota')
const hard = reactive<Record<string, string>>(Object.fromEntries(FIELDS.map((f) => [f.key, String(props.quota?.spec?.hard?.[f.key] ?? '')])))
const busy = ref(false)
const error = ref<string | null>(null)

const quantityPattern = /^[0-9]+(\.[0-9]+)?(m|k|M|G|T|P|E|Ki|Mi|Gi|Ti|Pi|Ei)?$/
const invalid = computed(() => FIELDS.filter((f) => hard[f.key].trim() && !quantityPattern.test(hard[f.key].trim())).map((f) => f.label))

async function save() {
  error.value = null
  busy.value = true
  try {
    const values: Record<string, string | null> = {}
    for (const f of FIELDS) {
      const v = hard[f.key].trim()
      if (v) values[f.key] = v
      else if (props.quota?.spec?.hard?.[f.key] !== undefined) values[f.key] = null
    }
    const ref = { apiVersion: 'v1', resource: 'resourcequotas', namespace: props.namespace }
    if (editing.value) {
      await k8s.patch({ ...ref, name: name.value }, { spec: { hard: values } })
    } else {
      const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null))
      await k8s.create(ref, { apiVersion: 'v1', kind: 'ResourceQuota', metadata: { name: name.value, namespace: props.namespace }, spec: { hard: clean } })
    }
    toast('success', editing.value ? 'Quota updated' : 'Quota created', `${props.namespace}/${name.value}`)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="editing ? `Edit quota ${quota?.metadata.name}` : `Add quota to ${namespace}`" :icon="faScaleBalanced" width="620px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div>
        <label class="label">Name</label>
        <input v-model="name" class="input" :disabled="editing" />
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div v-for="f in FIELDS" :key="f.key">
          <label class="label">{{ f.label }} <span class="mono font-normal text-fg-subtle">{{ f.key }}</span></label>
          <input v-model="hard[f.key]" class="input mono" :placeholder="f.hint" />
        </div>
      </div>
      <p class="text-xs text-fg-muted">Leave a field empty for no limit. A quota on CPU or memory requires every pod in the namespace — each VM's launcher pod included — to declare requests; KubeVirt sets them from the VM's memory and CPU.</p>
      <Notice v-if="invalid.length" kind="warning">Not a valid quantity: {{ invalid.join(', ') }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !isDnsLabel(name) || invalid.length > 0" @click="save">{{ editing ? 'Save' : 'Create' }}</button>
    </template>
  </Modal>
</template>
