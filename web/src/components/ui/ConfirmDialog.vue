<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { faTriangleExclamation, faCircleQuestion } from '@fortawesome/free-solid-svg-icons'
import Modal from './Modal.vue'

const props = defineProps<{
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  typeToConfirm?: string
  options?: Array<{ key: string; label: string; default?: boolean; hint?: string }>
}>()
const emit = defineEmits<{ close: [result?: { options: Record<string, boolean> }] }>()

const typed = ref('')
const values = reactive<Record<string, boolean>>(Object.fromEntries((props.options ?? []).map((o) => [o.key, !!o.default])))
const ready = computed(() => !props.typeToConfirm || typed.value === props.typeToConfirm)

function submit() {
  if (ready.value) emit('close', { options: { ...values } })
}
</script>

<template>
  <Modal :title="title" :icon="danger ? faTriangleExclamation : faCircleQuestion" width="480px" @close="emit('close')">
    <p class="whitespace-pre-line text-fg">{{ message }}</p>
    <div v-if="options?.length" class="mt-3 space-y-2">
      <label v-for="option in options" :key="option.key" class="flex items-start gap-2">
        <input v-model="values[option.key]" type="checkbox" class="mt-0.5 accent-[var(--accent)]" />
        <span>
          <span class="block">{{ option.label }}</span>
          <span v-if="option.hint" class="block text-xs text-fg-muted">{{ option.hint }}</span>
        </span>
      </label>
    </div>
    <div v-if="typeToConfirm" class="mt-4">
      <label class="label">Type <span class="mono text-fg">{{ typeToConfirm }}</span> to confirm</label>
      <input v-model="typed" class="input" autofocus @keydown.enter="submit" />
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn" :class="danger ? 'btn-danger' : 'btn-primary'" :disabled="!ready" @click="submit">
        {{ confirmText ?? 'Confirm' }}
      </button>
    </template>
  </Modal>
</template>
