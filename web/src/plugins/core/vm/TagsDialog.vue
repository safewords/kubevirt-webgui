<script setup lang="ts">
/** Tags: labels under the GUI's own prefix, so they never collide with anyone else's. */
import { computed, ref } from 'vue'
import { faTags, faXmark } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { TAG_PREFIX, tags as tagsOf } from '@/util/kubevirt'
import { updateVm } from './update'

const props = defineProps<{ ctx: ObjectContext }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()

const original = tagsOf(props.ctx.object)
const tags = ref<string[]>([...original])
const input = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

const TAG = /^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const known = computed(() => [...new Set(inv.vms.flatMap((vm) => tagsOf(vm)))].filter((t) => !tags.value.includes(t)).sort())
const problem = computed(() => (input.value && (!TAG.test(input.value) || input.value.length > 63) ? 'Letters, digits, dashes, dots and underscores; at most 63 characters' : null))

function add(tag = input.value.trim()) {
  if (!tag || !TAG.test(tag) || tags.value.includes(tag)) return
  tags.value.push(tag)
  input.value = ''
}

async function save() {
  if (input.value.trim()) add()
  busy.value = true
  error.value = null
  try {
    await updateVm(props.ctx, (vm) => {
      const labels: Record<string, string | null> = {}
      for (const t of Object.keys(vm.metadata.labels ?? {}).filter((k) => k.startsWith(TAG_PREFIX))) labels[t] = null
      for (const t of tags.value) labels[`${TAG_PREFIX}${t}`] = ''
      return { metadata: { labels } }
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
  <Modal title="Tags" :icon="faTags" width="480px" @close="emit('close')">
    <div class="space-y-3">
      <div class="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-0 p-2">
        <span v-if="!tags.length" class="text-fg-subtle">No tags</span>
        <span v-for="t in tags" :key="t" class="chip bg-accent-soft text-accent">
          {{ t }}
          <button class="hover:text-fg" :aria-label="`Remove ${t}`" @click="tags = tags.filter((x) => x !== t)"><Fa :icon="faXmark" /></button>
        </span>
      </div>
      <div>
        <label class="label">Add a tag</label>
        <input v-model="input" class="input" placeholder="production" list="known-tags" @keydown.enter.prevent="add()" />
        <datalist id="known-tags">
          <option v-for="t in known" :key="t" :value="t" />
        </datalist>
        <p v-if="problem" class="mt-1 text-xs text-bad">{{ problem }}</p>
        <p v-else class="mt-1 text-xs text-fg-muted">Press Enter to add. Tags group VMs in the Tag View.</p>
      </div>
      <div v-if="known.length" class="flex flex-wrap gap-1">
        <span class="text-xs text-fg-muted">In use elsewhere:</span>
        <button v-for="t in known.slice(0, 20)" :key="t" class="chip hover:bg-accent-soft hover:text-accent" @click="add(t)">{{ t }}</button>
      </div>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'OK' }}</button>
    </template>
  </Modal>
</template>
