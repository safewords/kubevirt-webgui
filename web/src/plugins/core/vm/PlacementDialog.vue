<script setup lang="ts">
/** Where the VM may run: anywhere, one node, or nodes with given labels. */
import { computed, ref } from 'vue'
import { faLocationDot, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { nodeReady } from '@/util/kubevirt'
import { updateTemplate } from './update'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()

const HOST = 'kubernetes.io/hostname'
const current: Record<string, string> = { ...(props.ctx.object?.spec?.template?.spec?.nodeSelector ?? {}) }
const keys = Object.keys(current)
const mode = ref<'any' | 'node' | 'labels'>(keys.length === 0 ? 'any' : keys.length === 1 && keys[0] === HOST ? 'node' : 'labels')
const node = ref(current[HOST] ?? '')
const pairs = ref<Array<{ key: string; value: string }>>(mode.value === 'labels' ? Object.entries(current).map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }])
const busy = ref(false)
const error = ref<string | null>(null)

const virtNodes = computed(() => inv.nodes.filter((n) => n.metadata.labels?.['kubevirt.io/schedulable'] === 'true'))
const matching = computed(() => {
  const selector = Object.fromEntries(pairs.value.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value.trim()]))
  return inv.nodes.filter((n) => Object.entries(selector).every(([k, v]) => n.metadata.labels?.[k] === v)).map((n) => n.metadata.name)
})

async function save() {
  busy.value = true
  error.value = null
  try {
    let selector: Record<string, string> | null = null
    if (mode.value === 'node') {
      if (!node.value) throw new Error('Choose a node')
      selector = { [HOST]: node.value }
    } else if (mode.value === 'labels') {
      selector = Object.fromEntries(pairs.value.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value.trim()]))
      if (!Object.keys(selector).length) selector = null
    }
    // A merge patch merges maps, so keys that are no longer wanted are nulled.
    await updateTemplate(props.ctx, (spec) => {
      if (!selector) return { nodeSelector: null }
      const removed = Object.keys(spec.nodeSelector ?? {}).filter((k) => !(k in selector!))
      return { nodeSelector: { ...Object.fromEntries(removed.map((k) => [k, null])), ...selector } }
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
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'OK' }}</button>
    </template>
  </Modal>
</template>
