<script setup lang="ts">
/** Grow a disk — Proxmox's "Disk Action → Resize". Claims can only grow. */
import { computed, onMounted, ref } from 'vue'
import { faUpRightAndDownLeftFromCenter } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { bytes } from '@/util/format'
import { toast } from '@/services/dialogs'
import { sizeOf, toQuantity, UNITS, vmsUsing } from './helpers'

const props = defineProps<{ pvc: KObject }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

const current = computed(() => sizeOf(props.pvc))
const mode = ref<'add' | 'set'>('add')
const amount = ref(10)
const unit = ref(1024 ** 3)
const expandable = ref<boolean | null>(null)
const classError = ref<string | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

const target = computed(() => {
  const value = Math.max(0, Number(amount.value) || 0) * unit.value
  return mode.value === 'add' ? current.value + value : value
})
const grows = computed(() => target.value > current.value)
const usedBy = computed(() => vmsUsing(props.pvc.metadata.namespace, props.pvc.metadata.name))

onMounted(async () => {
  const className = props.pvc.spec?.storageClassName
  if (!className) {
    expandable.value = null
    return
  }
  try {
    const sc = await k8s.get({ apiVersion: 'storage.k8s.io/v1', resource: 'storageclasses', name: className })
    expandable.value = sc.allowVolumeExpansion === true
  } catch (e) {
    classError.value = errorMessage(e)
  }
})

async function save() {
  error.value = null
  busy.value = true
  try {
    const size = toQuantity(Math.ceil(target.value / (1024 ** 2)) * 1024 ** 2)
    await k8s.patch(
      { apiVersion: 'v1', resource: 'persistentvolumeclaims', namespace: props.pvc.metadata.namespace, name: props.pvc.metadata.name },
      { spec: { resources: { requests: { storage: size } } } },
    )
    toast('success', 'Resize requested', `${props.pvc.metadata.name} → ${size}`)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="`Resize disk ${pvc.metadata.name}`" :icon="faUpRightAndDownLeftFromCenter" width="480px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <Notice v-if="expandable === false" kind="error" title="Cannot be resized">The storage class {{ pvc.spec?.storageClassName }} does not allow volume expansion.</Notice>
      <Notice v-if="classError" kind="warning">Could not read the storage class: {{ classError }}</Notice>
      <dl class="kv">
        <dt>Current size</dt>
        <dd>{{ bytes(current) }}</dd>
        <dt>Storage class</dt>
        <dd>{{ pvc.spec?.storageClassName ?? 'default' }}</dd>
      </dl>
      <div class="grid grid-cols-[130px_1fr_90px] gap-2">
        <select v-model="mode" class="input">
          <option value="add">Size increment</option>
          <option value="set">New size</option>
        </select>
        <input v-model.number="amount" type="number" min="1" class="input tabular-nums" />
        <select v-model.number="unit" class="input">
          <option v-for="u in UNITS" :key="u.label" :value="u.factor">{{ u.label }}</option>
        </select>
      </div>
      <p class="text-fg-muted">New size: <span class="font-semibold text-fg">{{ bytes(target) }}</span></p>
      <Notice v-if="!grows" kind="warning">A disk can only grow.</Notice>
      <Notice v-if="usedBy.length" kind="info">
        Used by {{ usedBy.map((v) => v.metadata.name).join(', ') }}. A running guest sees the new size only if KubeVirt's <span class="mono">ExpandDisks</span> feature gate is on; otherwise after a restart. Grow the partition and filesystem inside the guest afterwards.
      </Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !grows || expandable === false" @click="save">Resize disk</button>
    </template>
  </Modal>
</template>
