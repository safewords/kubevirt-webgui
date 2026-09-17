<script setup lang="ts">
/** Take a snapshot of a VM. */
import { computed, ref } from 'vue'
import { faCamera } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'
import { vmApi } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { condition } from '@/util/kubevirt'
import { openTaskLog } from '@/services/dialogs'
import { validName } from './spec'
import { SNAPSHOT_GATE_OFF, explainGateError, useFeatureGate } from './featureGates'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const cluster = useCluster()

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
const name = ref(`${props.ctx.name}-${stamp}`.slice(0, 63))
const description = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

const running = computed(() => props.ctx.related.vmi?.status?.phase === 'Running')
const agent = computed(() => condition(props.ctx.related.vmi, 'AgentConnected')?.status === 'True')
const unsupported = computed(() => (props.ctx.object?.status?.volumeSnapshotStatuses ?? []).filter((s: any) => !s.enabled))
const included = computed(() => (props.ctx.object?.status?.volumeSnapshotStatuses ?? []).filter((s: any) => s.enabled))
const csiSnapshots = computed(() => cluster.has('snapshot.storage.k8s.io'))
const gate = useFeatureGate('Snapshot')
const problem = computed(() => validName(name.value))

async function take() {
  if (problem.value || gate.value === false) return
  busy.value = true
  error.value = null
  try {
    const apiVersion = cluster.versionFor('snapshot.kubevirt.io', 'virtualmachinesnapshots') ?? undefined
    const result = await vmApi.snapshot(props.ctx.namespace!, props.ctx.name, name.value, description.value.trim() || undefined, apiVersion)
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
  <Modal title="Take snapshot" :icon="faCamera" width="520px" @close="emit('close')">
    <div class="space-y-3">
      <div>
        <label class="label">Name</label>
        <input v-model="name" class="input mono" />
        <p v-if="problem" class="mt-1 text-xs text-bad">{{ problem }}</p>
      </div>
      <div>
        <label class="label">Description</label>
        <textarea v-model="description" class="input h-20" placeholder="Before the kernel upgrade…" />
      </div>
      <Notice v-if="gate === false" kind="error" title="Snapshots are switched off">{{ SNAPSHOT_GATE_OFF }}</Notice>
      <Notice v-if="!csiSnapshots" kind="warning" title="No CSI snapshot support">
        The cluster does not serve snapshot.storage.k8s.io, so persistent disks cannot be captured: they are left out, and the snapshot holds the VM definition and any disks that can be.
      </Notice>
      <Notice v-if="included.length" kind="info" title="Disks captured">
        <span class="mono">{{ included.map((s: any) => s.name).join(', ') }}</span> — copy-on-write storage snapshots, restored on rollback.
      </Notice>
      <Notice v-if="unsupported.length" kind="info" title="Not included">
        <div v-for="s in unsupported" :key="s.name"><span class="mono">{{ s.name }}</span> — {{ s.reason }}</div>
      </Notice>
      <Notice v-if="running" :kind="agent ? 'info' : 'warning'">
        {{ agent ? 'The guest agent will freeze filesystems for a consistent snapshot.' : 'The VM is running without a guest agent: the snapshot is crash-consistent, like pulling the plug.' }}
      </Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !!problem || gate === false" @click="take">{{ busy ? 'Starting…' : 'Take snapshot' }}</button>
    </template>
  </Modal>
</template>
