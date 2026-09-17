<script setup lang="ts">
/** Copy a disk into a new DataVolume (CDI smart/CSI clone when the storage allows). */
import { computed, ref } from 'vue'
import { faClone } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import type { KObject } from '@/api/types'
import { gateway, errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { useWatch } from '@/stores/watch'
import { bytes, isDnsLabel, toDnsLabel, randomSuffix } from '@/util/format'
import { openTaskLog } from '@/services/dialogs'
import { sizeOf, toQuantity, UNITS, vmsUsing } from './helpers'

const props = defineProps<{ pvc: KObject }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()
const classes = useWatch(() => ({ apiVersion: 'storage.k8s.io/v1', resource: 'storageclasses' }))

const source = computed(() => sizeOf(props.pvc))
const name = ref(toDnsLabel(`${props.pvc.metadata.name}-clone-${randomSuffix(4)}`))
const namespace = ref(props.pvc.metadata.namespace!)
const storageClass = ref<string>(props.pvc.spec?.storageClassName ?? '')
const sizeValue = ref(Math.ceil(source.value / 1024 ** 3) || 1)
const unit = ref(1024 ** 3)
const busy = ref(false)
const error = ref<string | null>(null)

const size = computed(() => sizeValue.value * unit.value)
const runningUsers = computed(() => vmsUsing(props.pvc.metadata.namespace, props.pvc.metadata.name).filter((vm) => inv.vmiFor(vm)?.status?.phase === 'Running'))

async function save() {
  error.value = null
  busy.value = true
  try {
    const body = {
      apiVersion: 'cdi.kubevirt.io/v1beta1',
      kind: 'DataVolume',
      metadata: { name: name.value, namespace: namespace.value, annotations: { 'kubevirt-webgui/cloned-from': `${props.pvc.metadata.namespace}/${props.pvc.metadata.name}` } },
      spec: {
        source: { pvc: { namespace: props.pvc.metadata.namespace, name: props.pvc.metadata.name } },
        storage: {
          resources: { requests: { storage: toQuantity(size.value) } },
          ...(storageClass.value ? { storageClassName: storageClass.value } : {}),
          ...(storageClass.value === props.pvc.spec?.storageClassName && props.pvc.spec?.volumeMode ? { volumeMode: props.pvc.spec.volumeMode } : {}),
        },
      },
    }
    const result = await gateway.call<{ task: string }>('datavolume.create', { body })
    openTaskLog(result.task)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="`Clone disk ${pvc.metadata.name}`" :icon="faClone" width="520px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <label class="label">New disk name</label>
          <input v-model="name" class="input mono" />
        </div>
        <div>
          <label class="label">Namespace</label>
          <select v-model="namespace" class="input">
            <option v-for="ns in inv.reachableNamespaces" :key="ns" :value="ns">{{ ns }}</option>
          </select>
        </div>
        <div>
          <label class="label">Storage class</label>
          <select v-model="storageClass" class="input">
            <option value="">cluster default</option>
            <option v-for="sc in classes.items.value" :key="sc.metadata.uid" :value="sc.metadata.name">{{ sc.metadata.name }}</option>
          </select>
        </div>
        <div>
          <label class="label">Size (source {{ bytes(source) }})</label>
          <div class="grid grid-cols-[1fr_80px] gap-2">
            <input v-model.number="sizeValue" type="number" min="1" class="input tabular-nums" />
            <select v-model.number="unit" class="input">
              <option v-for="u in UNITS" :key="u.label" :value="u.factor">{{ u.label }}</option>
            </select>
          </div>
        </div>
      </div>
      <Notice v-if="size < source" kind="warning">The clone must be at least as large as the source ({{ bytes(source) }}).</Notice>
      <Notice v-if="runningUsers.length" kind="warning">
        {{ runningUsers.map((v) => v.metadata.name).join(', ') }} is running and writing to this disk. The copy is crash-consistent at best; stop the VM or snapshot it first for a clean copy.
      </Notice>
      <p class="text-xs text-fg-muted">CDI copies with a CSI clone when source and target share a storage class that supports it (fast, copy-on-write on Ceph RBD), otherwise with a host-assisted copy. Progress is shown in the task log.</p>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !isDnsLabel(name) || size < source" @click="save">Clone</button>
    </template>
  </Modal>
</template>
