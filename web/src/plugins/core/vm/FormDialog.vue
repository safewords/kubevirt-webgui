<script setup lang="ts">
/**
 * A small form in a dialog — most VM settings are a handful of fields, and a
 * dialog per setting would repeat this frame dozens of times.
 *
 * When `submit` is given it runs inside the dialog, so a refusal from the API
 * server is shown next to the fields that caused it rather than in a toast.
 */
import { computed, reactive, ref } from 'vue'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { errorMessage } from '@/api/gateway'

export interface FormField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'checkbox' | 'textarea'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  hint?: string
  min?: number
  max?: number
  mono?: boolean
  /** A datalist of suggestions for a text field. */
  suggestions?: string[]
  unit?: string
  validate?: (value: any, values: Record<string, any>) => string | null
  visible?: (values: Record<string, any>) => boolean
  disabled?: (values: Record<string, any>) => boolean
}

const props = withDefaults(
  defineProps<{
    title: string
    icon?: IconDefinition
    fields: FormField[]
    initial?: Record<string, any>
    description?: string
    warning?: string
    submitText?: string
    width?: string
    submit?: (values: Record<string, any>) => Promise<unknown>
  }>(),
  { submitText: 'OK', width: '520px' },
)
const emit = defineEmits<{ close: [values?: Record<string, any>] }>()

const values = reactive<Record<string, any>>({ ...(props.initial ?? {}) })
for (const field of props.fields) {
  if (values[field.key] === undefined) values[field.key] = field.type === 'checkbox' ? false : ''
}
const busy = ref(false)
const error = ref<string | null>(null)
const touched = ref(false)

const shown = computed(() => props.fields.filter((f) => !f.visible || f.visible(values)))
const problems = computed(() => {
  const out: Record<string, string> = {}
  for (const field of shown.value) {
    const problem = field.validate?.(values[field.key], values)
    if (problem) out[field.key] = problem
  }
  return out
})
const valid = computed(() => Object.keys(problems.value).length === 0)

async function ok() {
  touched.value = true
  if (!valid.value) return
  error.value = null
  if (!props.submit) {
    emit('close', { ...values })
    return
  }
  busy.value = true
  try {
    await props.submit({ ...values })
    emit('close', { ...values })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="title" :icon="icon" :width="width" @close="emit('close')">
    <form class="space-y-3" @submit.prevent="ok">
      <p v-if="description" class="whitespace-pre-line text-fg-muted">{{ description }}</p>
      <Notice v-if="warning" kind="warning">{{ warning }}</Notice>
      <template v-for="field in shown" :key="field.key">
        <label v-if="field.type === 'checkbox'" class="flex items-start gap-2">
          <input v-model="values[field.key]" type="checkbox" class="mt-0.5 accent-[var(--accent)]" :disabled="field.disabled?.(values)" />
          <span>
            <span class="block">{{ field.label }}</span>
            <span v-if="field.hint" class="block text-xs text-fg-muted">{{ field.hint }}</span>
          </span>
        </label>
        <div v-else>
          <label class="label">{{ field.label }}</label>
          <div class="flex items-center gap-2">
            <select v-if="field.type === 'select'" v-model="values[field.key]" class="input" :disabled="field.disabled?.(values)">
              <option v-for="option in field.options" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <textarea
              v-else-if="field.type === 'textarea'"
              v-model="values[field.key]"
              class="input h-28"
              :class="field.mono ? 'mono' : ''"
              :placeholder="field.placeholder"
              :disabled="field.disabled?.(values)"
              spellcheck="false"
            />
            <input
              v-else-if="field.type === 'number'"
              v-model.number="values[field.key]"
              type="number"
              class="input"
              :min="field.min"
              :max="field.max"
              :placeholder="field.placeholder"
              :disabled="field.disabled?.(values)"
            />
            <template v-else>
              <input
                v-model="values[field.key]"
                class="input"
                :class="field.mono ? 'mono' : ''"
                :placeholder="field.placeholder"
                :list="field.suggestions ? `suggest-${field.key}` : undefined"
                :disabled="field.disabled?.(values)"
                spellcheck="false"
              />
              <datalist v-if="field.suggestions" :id="`suggest-${field.key}`">
                <option v-for="s in field.suggestions" :key="s" :value="s" />
              </datalist>
            </template>
            <span v-if="field.unit" class="shrink-0 text-fg-muted">{{ field.unit }}</span>
          </div>
          <p v-if="touched && problems[field.key]" class="mt-1 text-xs text-bad">{{ problems[field.key] }}</p>
          <p v-else-if="field.hint" class="mt-1 text-xs text-fg-muted">{{ field.hint }}</p>
        </div>
      </template>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <button type="submit" class="hidden" />
    </form>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="ok">{{ busy ? 'Saving…' : submitText }}</button>
    </template>
  </Modal>
</template>
