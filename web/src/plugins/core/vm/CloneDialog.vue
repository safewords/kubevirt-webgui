<script setup lang="ts">
/** Clone a VM, disks and all, into a new VM in the same namespace. */
import { computed, ref } from 'vue'
import { faClone } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { gateway, errorMessage } from '@/api/gateway'
import { useCluster } from '@/stores/cluster'
import { useInventory } from '@/plugins/core/inventory'
import { openTaskLog } from '@/services/dialogs'
import { vmState } from '@/util/kubevirt'
import { validName } from './spec'
import { SNAPSHOT_GATE_OFF, explainGateError, useFeatureGate } from './featureGates'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const cluster = useCluster()
const inv = useInventory()
const gate = useFeatureGate('Snapshot')

const target = ref(`${props.ctx.name}-clone`.slice(0, 63))
const copyLabels = ref(true)
const copyAnnotations = ref(true)
const busy = ref(false)
const error = ref<string | null>(null)

const running = computed(() => vmState(props.ctx.object, props.ctx.related.vmi) !== 'stopped')
const problem = computed(() => validName(target.value) ?? (inv.vms.some((v) => v.metadata.namespace === props.ctx.namespace && v.metadata.name === target.value) ? 'A VM with that name already exists' : null))

async function clone() {
  if (problem.value || gate.value === false) return
  busy.value = true
  error.value = null
  try {
    const result = await gateway.call<{ task: string }>('vm.clone', {
      namespace: props.ctx.namespace,
      name: props.ctx.name,
      target: target.value,
      apiVersion: cluster.versionFor('clone.kubevirt.io', 'virtualmachineclones') ?? undefined,
      labelFilters: copyLabels.value ? ['*'] : ['!*'],
      annotationFilters: copyAnnotations.value ? ['*'] : ['!*'],
    })
    openTaskLog(result.task)
    emit('close', true)
  } catch (e) {
    error.value = explainGateError(errorMessage(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Clone VM" :icon="faClone" width="500px" @close="emit('close')">
    <div class="space-y-3">
      <dl class="kv">
        <dt>Source</dt>
        <dd>{{ ctx.namespace }}/{{ ctx.name }}</dd>
        <dt>Namespace</dt>
        <dd>{{ ctx.namespace }}</dd>
      </dl>
      <div>
        <label class="label">Name of the new VM</label>
        <input v-model="target" class="input mono" autofocus @keydown.enter="clone" />
        <p v-if="problem" class="mt-1 text-xs text-bad">{{ problem }}</p>
      </div>
      <label class="flex items-center gap-2"><input v-model="copyLabels" type="checkbox" class="accent-[var(--accent)]" /> Copy labels and tags</label>
      <label class="flex items-center gap-2"><input v-model="copyAnnotations" type="checkbox" class="accent-[var(--accent)]" /> Copy annotations and notes</label>
      <p class="text-xs text-fg-muted">A full clone: every disk is copied (a CSI clone where the storage supports it). MAC addresses and the SMBIOS serial are regenerated.</p>
      <Notice v-if="gate === false" kind="error" title="Cloning is switched off">{{ SNAPSHOT_GATE_OFF }}</Notice>
      <Notice v-if="running" kind="warning">The VM is running. Cloning a running VM needs snapshot-capable storage; stop it first for a reliable copy.</Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !!problem || gate === false" @click="clone">{{ busy ? 'Starting…' : 'Clone' }}</button>
    </template>
  </Modal>
</template>
