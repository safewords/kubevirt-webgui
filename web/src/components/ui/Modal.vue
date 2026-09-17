<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faXmark } from '@fortawesome/free-solid-svg-icons'

const props = withDefaults(
  defineProps<{
    title: string
    icon?: IconDefinition
    width?: string
    /** Fill most of the viewport — for editors and consoles. */
    large?: boolean
    closable?: boolean
  }>(),
  { width: '560px', closable: true },
)
const emit = defineEmits<{ close: [] }>()

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.closable) {
    event.stopPropagation()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" @mousedown.self="closable && emit('close')">
    <div
      class="card flex max-h-[92vh] flex-col shadow-2xl shadow-black/40"
      :style="large ? { width: 'min(1200px, 96vw)', height: '86vh' } : { width: `min(${width}, 96vw)` }"
      role="dialog"
      aria-modal="true"
    >
      <header class="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Fa v-if="icon" :icon="icon" class="text-accent" />
        <h2 class="flex-1 truncate text-[13px] font-semibold">{{ title }}</h2>
        <slot name="header-extra" />
        <button v-if="closable" class="btn btn-ghost btn-sm" aria-label="Close" @click="emit('close')">
          <Fa :icon="faXmark" />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-auto" :class="large ? '' : 'p-4'">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-surface-2 px-3 py-2 rounded-b-lg">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>
