<script setup lang="ts">
import { computed, ref } from 'vue'
import { faFolderPlus, faPlus, faXmark } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { toast } from '@/services/dialogs'
import { isDnsLabel } from '@/util/format'

const emit = defineEmits<{ close: [result?: string] }>()

const name = ref('')
const description = ref('')
const labels = ref<Array<{ key: string; value: string }>>([])
const error = ref<string | null>(null)
const busy = ref(false)
const valid = computed(() => isDnsLabel(name.value) && labels.value.every((l) => l.key.trim()))

async function submit() {
  if (!valid.value) return
  error.value = null
  busy.value = true
  try {
    const body = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: name.value,
        labels: Object.fromEntries(labels.value.filter((l) => l.key.trim()).map((l) => [l.key.trim(), l.value.trim()])),
        annotations: description.value.trim() ? { 'kubevirt-webgui/description': description.value.trim() } : undefined,
      },
    }
    await k8s.create({ apiVersion: 'v1', resource: 'namespaces' }, body)
    toast('success', 'Namespace created', name.value)
    emit('close', name.value)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal title="Create namespace" :icon="faFolderPlus" width="520px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <div>
        <label class="label">Name</label>
        <input v-model="name" class="input mono" placeholder="team-vms" autofocus @keydown.enter="submit" />
        <p v-if="name && !isDnsLabel(name)" class="mt-1 text-xs text-bad">Lowercase letters, digits and dashes; up to 63 characters.</p>
      </div>
      <div>
        <label class="label">Description</label>
        <input v-model="description" class="input" placeholder="Optional" />
      </div>
      <div>
        <div class="mb-1 flex items-center justify-between">
          <span class="label mb-0">Labels</span>
          <button class="btn btn-sm btn-ghost" @click="labels.push({ key: '', value: '' })"><Fa :icon="faPlus" /> Add label</button>
        </div>
        <div v-for="(label, i) in labels" :key="i" class="mb-1.5 flex gap-2">
          <input v-model="label.key" class="input mono" placeholder="key" />
          <input v-model="label.value" class="input mono" placeholder="value" />
          <button class="btn btn-ghost" aria-label="Remove label" @click="labels.splice(i, 1)"><Fa :icon="faXmark" /></button>
        </div>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!valid || busy" @click="submit"><Fa :icon="faFolderPlus" /> Create</button>
    </template>
  </Modal>
</template>
