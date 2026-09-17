<script setup lang="ts">
/** Edit one structured field (affinity, tolerations, …) as YAML. */
import { ref } from 'vue'
import { dump } from 'js-yaml'
import { loadYaml } from './yaml'
import { faFileCode } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { errorMessage } from '@/api/gateway'

const props = defineProps<{
  title: string
  value: unknown
  description?: string
  /** Receives the parsed value, or `null` for an empty document. */
  submit: (value: unknown) => Promise<unknown>
}>()
const emit = defineEmits<{ close: [result?: boolean] }>()

const text = ref(props.value === undefined || props.value === null ? '' : dump(props.value, { lineWidth: 120, noRefs: true }))
const busy = ref(false)
const error = ref<string | null>(null)

async function save() {
  busy.value = true
  error.value = null
  try {
    const parsed = loadYaml(text.value)
    await props.submit(parsed ?? null)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="title" :icon="faFileCode" width="720px" @close="emit('close')">
    <p v-if="description" class="mb-2 text-fg-muted">{{ description }}</p>
    <div class="h-[46vh]">
      <YamlEditor v-model="text" />
    </div>
    <Notice v-if="error" kind="error" class="mt-3">{{ error }}</Notice>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : 'OK' }}</button>
    </template>
  </Modal>
</template>
