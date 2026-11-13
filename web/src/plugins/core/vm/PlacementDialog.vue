<script setup lang="ts">
/** Where the VM may run: anywhere, one node, or nodes with given labels — and, on Ceph, whether a pin is strict. */
import { computed, ref } from 'vue'
import { faLocationDot, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { useWatch } from '@/stores/watch'
import { liveInstance, nodeReady } from '@/util/kubevirt'
import { updateVm } from './update'
import { HOST, cephOnly, hasHostPin, isSoft, placementPatch, strictPlacement } from './placement'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()
const storageClasses = useWatch({ apiVersion: 'storage.k8s.io/v1', resource: 'storageclasses' })

// Edit the strict placement; soft placement is applied on top when saving.
const strict = strictPlacement(props.ctx.object)
const current: Record<string, string> = { ...(strict.nodeSelector ?? {}) }
const keys = Object.keys(current)
const mode = ref<'any' | 'node' | 'labels'>(keys.length === 0 ? 'any' : keys.length === 1 && keys[0] === HOST ? 'node' : 'labels')
const node = ref(current[HOST] ?? '')
const pairs = ref<Array<{ key: string; value: string }>>(mode.value === 'labels' ? Object.entries(current).map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }])
const soft = ref(isSoft(props.ctx.object))
const busy = ref(false)
const error = ref<string | null>(null)

const virtNodes = computed(() => inv.nodes.filter((n) => n.metadata.labels?.['kubevirt.io/schedulable'] === 'true'))
const matching = computed(() => {
  const selector = Object.fromEntries(pairs.value.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value.trim()]))
  return inv.nodes.filter((n) => Object.entries(selector).every(([k, v]) => n.metadata.labels?.[k] === v)).map((n) => n.metadata.name)
})
/** Hostnames the required node affinity pins to, which this dialog does not edit but soft placement covers. */
const affinityPins = computed(() => {
  const terms: any[] = strict.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []
  return [...new Set(terms.flatMap((t) => (t.matchExpressions ?? []).filter((e: any) => e.key === HOST && e.operator === 'In').flatMap((e: any) => e.values ?? [])))] as string[]
})
const known = computed(() => new Set(inv.nodes.map((n) => n.metadata.name)))
const ceph = computed(() => cephOnly(props.ctx.object, inv.pvcs, storageClasses.items.value))
const selector = computed<Record<string, string> | null>(() => {
  if (mode.value === 'node') return node.value ? { [HOST]: node.value } : null
  if (mode.value === 'labels') {
    const s = Object.fromEntries(pairs.value.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value.trim()]))
    return Object.keys(s).length ? s : null
  }
  return null
})
const pinned = computed(() => hasHostPin({ nodeSelector: selector.value, nodeAffinity: strict.nodeAffinity }))
// A pending instance was made from the old rules; it has to be recreated to use the new ones.
const pendingInstance = computed(() => {
  const vmi = props.ctx.related.vmi
  return liveInstance(vmi) && vmi?.status?.phase !== 'Running'
})

async function save() {
  busy.value = true
  error.value = null
  try {
    if (mode.value === 'node' && !node.value) throw new Error('Choose a node')
    if (soft.value && !ceph.value.ok) throw new Error(`Soft placement needs every disk on Ceph: ${ceph.value.reason}`)
    // Built from the VM as it is now, so an affinity edited elsewhere is kept.
    await updateVm(props.ctx, (vm) => {
      const fresh = strictPlacement(vm)
      return placementPatch(vm, { nodeSelector: selector.value, nodeAffinity: fresh.nodeAffinity }, soft.value && pinned.value)
    })
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Node placement" :icon="faLocationDot" width="540px" @close="emit('close')">
    <div class="space-y-3">
      <label class="flex items-center gap-2"><input v-model="mode" type="radio" value="any" class="accent-[var(--accent)]" /> Any node the scheduler picks</label>
      <label class="flex items-center gap-2"><input v-model="mode" type="radio" value="node" class="accent-[var(--accent)]" /> Pin to one node</label>
      <div v-if="mode === 'node'" class="pl-6">
        <select v-model="node" class="input">
          <option value="" disabled>Choose a node…</option>
          <option v-for="n in virtNodes" :key="n.metadata.uid" :value="n.metadata.name">{{ n.metadata.name }}{{ nodeReady(n) ? '' : ' (offline)' }}</option>
        </select>
        <p class="mt-1 text-xs text-fg-muted">A pinned VM cannot live-migrate and stays down if its node does.</p>
      </div>
      <label class="flex items-center gap-2"><input v-model="mode" type="radio" value="labels" class="accent-[var(--accent)]" /> Nodes with these labels</label>
      <div v-if="mode === 'labels'" class="space-y-1.5 pl-6">
        <div v-for="(pair, i) in pairs" :key="i" class="flex items-center gap-1.5">
          <input v-model="pair.key" class="input mono" placeholder="topology.kubernetes.io/zone" />
          <span class="text-fg-subtle">=</span>
          <input v-model="pair.value" class="input mono" placeholder="value" />
          <button class="btn btn-ghost btn-sm" aria-label="Remove" @click="pairs.splice(i, 1)"><Fa :icon="faXmark" /></button>
        </div>
        <button class="btn btn-sm" @click="pairs.push({ key: '', value: '' })"><Fa :icon="faPlus" /> Label</button>
        <p class="text-xs text-fg-muted">Matches now: {{ matching.length ? matching.join(', ') : 'no node' }}</p>
      </div>
      <p v-if="affinityPins.length" class="text-xs text-fg-muted">
        Its affinity also limits it to {{ affinityPins.map((h) => (known.has(h) ? h : `${h} (not in the cluster)`)).join(', ') }} — edit that under Options → Affinity.
      </p>

      <div class="border-t border-line pt-3">
        <label class="flex items-start gap-2" :class="ceph.ok ? '' : 'opacity-60'">
          <input v-model="soft" type="checkbox" class="mt-1 accent-[var(--accent)]" :disabled="!ceph.ok && !soft" />
          <span>
            When its pinned node cannot take it, start it on any other node its rules allow
            <span class="block text-xs text-fg-muted">
              The pin becomes a preference: it still runs on {{ [node, ...affinityPins].filter(Boolean).join(' / ') || 'its pinned node' }} when that node is up and has room. Other rules — labels, exclusions — still apply.
              <template v-if="ceph.ok"> Every disk is on Ceph, so any node can open them.</template>
              <template v-else> Unavailable: {{ ceph.reason }}.</template>
            </span>
          </span>
        </label>
        <p v-if="soft && !pinned" class="mt-1 pl-6 text-xs text-fg-muted">There is no node pin to soften, so this has no effect until one is set.</p>
      </div>

      <Notice v-if="pendingInstance" kind="info">This VM has a start pending under the old rules. Stop it and start it again for the new placement to apply.</Notice>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'OK' }}</button>
    </template>
  </Modal>
</template>
