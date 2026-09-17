<script setup lang="ts">
/** Live-migrate a VM, to a chosen node or wherever the scheduler prefers. */
import { computed, ref } from 'vue'
import { faArrowRightArrowLeft, faCircleCheck, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'
import { vmApi } from '@/api/k8s'
import { useInventory } from '@/plugins/core/inventory'
import { openTaskLog } from '@/services/dialogs'
import { condition, nodeReady } from '@/util/kubevirt'
import { bytes, quantity } from '@/util/format'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()

const vmi = computed(() => props.ctx.related.vmi)
const source = computed(() => vmi.value?.status?.nodeName ?? '')
const migratable = computed(() => condition(vmi.value, 'LiveMigratable'))
const target = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

// The CPU the guest was started with pins where it can go: `host-model` (the
// default) and `host-passthrough` need a node with the source's host CPU; a
// named model needs a node that supports that model.
const cpuModel = computed<string>(() => vmi.value?.spec?.domain?.cpu?.model ?? 'host-model')
const sourceNode = computed(() => inv.nodes.find((n) => n.metadata.name === source.value))
const labelsWith = (n: any, prefix: string) => Object.keys(n?.metadata?.labels ?? {}).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
const sourceHostModel = computed(() => labelsWith(sourceNode.value, 'host-model-cpu.node.kubevirt.io/')[0] ?? null)

function cpuIncompatible(n: any): string | null {
  if (cpuModel.value === 'host-model' || cpuModel.value === 'host-passthrough') {
    const model = labelsWith(n, 'host-model-cpu.node.kubevirt.io/')[0]
    if (sourceHostModel.value && model && model !== sourceHostModel.value) return `different host CPU (${model} ≠ ${sourceHostModel.value})`
    return null
  }
  return labelsWith(n, 'cpu-model.node.kubevirt.io/').includes(cpuModel.value) ? null : `does not support CPU model ${cpuModel.value}`
}

/** CPU models every VM-capable node supports: what to pick for a VM that should migrate anywhere. */
const commonModels = computed(() => {
  const nodes = inv.nodes.filter((n) => nodeReady(n) && n.metadata.labels?.['kubevirt.io/schedulable'] === 'true')
  if (nodes.length < 2) return []
  const sets = nodes.map((n) => new Set(labelsWith(n, 'cpu-model.node.kubevirt.io/')))
  return [...sets[0]].filter((m) => sets.every((s) => s.has(m))).sort()
})

// A node selector on the VM narrows the candidates, as the scheduler would.
const selector = computed<Record<string, string>>(() => props.ctx.object?.spec?.template?.spec?.nodeSelector ?? vmi.value?.spec?.nodeSelector ?? {})

function blockedBy(kind: 'selector' | 'cpu') {
  return candidates.value.some((c) => (kind === 'selector' ? c.reason?.includes('node selector') : c.reason?.includes('CPU')))
}

const noCompatibleNode = computed(() => candidates.value.length > 0 && candidates.value.every((c) => c.reason))

const candidates = computed(() =>
  inv.nodes
    .filter((n) => n.metadata.name !== source.value)
    .map((n) => {
      const guests = inv.vmis.filter((v) => v.status?.nodeName === n.metadata.name).length
      let reason: string | null = null
      if (!nodeReady(n)) reason = 'offline'
      else if (n.spec?.unschedulable) reason = 'in maintenance'
      else if (n.metadata.labels?.['kubevirt.io/schedulable'] !== 'true') reason = 'cannot run VMs'
      else if (Object.entries(selector.value).some(([k, v]) => n.metadata.labels?.[k] !== v)) reason = "excluded by the VM's node selector"
      else reason = cpuIncompatible(n)
      return { name: n.metadata.name, guests, memory: quantity(n.status?.allocatable?.memory), reason }
    }),
)

async function migrate() {
  busy.value = true
  error.value = null
  try {
    const result = await vmApi.migrate(props.ctx.namespace!, props.ctx.name, target.value || undefined)
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
  <Modal title="Migrate" :icon="faArrowRightArrowLeft" width="560px" @close="emit('close')">
    <div class="space-y-3">
      <dl class="kv">
        <dt>Virtual machine</dt>
        <dd>{{ ctx.namespace }}/{{ ctx.name }}</dd>
        <dt>Source node</dt>
        <dd>{{ source || '—' }}</dd>
        <dt>Mode</dt>
        <dd>Online (live) — the guest keeps running</dd>
        <dt>CPU model</dt>
        <dd>{{ cpuModel }}<span v-if="sourceHostModel && (cpuModel === 'host-model' || cpuModel === 'host-passthrough')" class="text-fg-muted"> (host CPU {{ sourceHostModel }})</span></dd>
        <dt>Live migratable</dt>
        <dd>
          <span v-if="migratable?.status === 'True'" class="text-ok"><Fa :icon="faCircleCheck" /> yes</span>
          <span v-else class="text-warn"><Fa :icon="faTriangleExclamation" /> no — {{ migratable?.reason ?? 'unknown' }}</span>
        </dd>
      </dl>
      <Notice v-if="migratable && migratable.status !== 'True'" kind="warning">{{ migratable.message ?? 'KubeVirt reports this VM cannot be live-migrated; the migration will fail.' }}</Notice>
      <Notice v-if="noCompatibleNode" kind="warning" title="No node can take this VM">
        Every other node is ruled out, so the migration would sit unschedulable and fail.
        <template v-if="blockedBy('selector')"> The VM's node selector pins it to specific nodes (Options → Node placement).</template>
        <template v-if="blockedBy('cpu')">
          Some nodes have a different host CPU.
          <template v-if="commonModels.length">Give the VM a CPU model all nodes support (Hardware → Processors), such as <span class="mono text-fg">{{ commonModels.slice(-3).join(', ') }}</span>, and restart it — like choosing a common CPU type in Proxmox.</template>
        </template>
      </Notice>
      <div>
        <label class="label">Target node</label>
        <div class="overflow-hidden rounded-md border border-line">
          <label class="flex h-8 cursor-pointer items-center gap-2.5 border-b border-line/60 px-2.5 hover:bg-surface-2">
            <input v-model="target" type="radio" value="" class="accent-[var(--accent)]" />
            <span class="flex-1">Automatic — let the scheduler choose</span>
          </label>
          <label
            v-for="node in candidates"
            :key="node.name"
            class="flex h-8 items-center gap-2.5 border-b border-line/60 px-2.5 last:border-b-0"
            :class="node.reason ? 'text-fg-subtle' : 'cursor-pointer hover:bg-surface-2'"
          >
            <input v-model="target" type="radio" :value="node.name" :disabled="!!node.reason" class="accent-[var(--accent)]" />
            <span class="flex-1">{{ node.name }}</span>
            <span class="text-xs">{{ node.reason ?? `${node.guests} guest${node.guests === 1 ? '' : 's'} · ${bytes(node.memory, 0)}` }}</span>
          </label>
        </div>
      </div>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || !vmi" @click="migrate">{{ busy ? 'Starting…' : 'Migrate' }}</button>
    </template>
  </Modal>
</template>
