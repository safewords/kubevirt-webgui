<script setup lang="ts">
/** A CodeMirror YAML editor that follows the app theme. */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'

const props = withDefaults(defineProps<{ modelValue: string; readonly?: boolean }>(), { readonly: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null
const theme = new Compartment()
const editable = new Compartment()

function isDark() {
  return document.documentElement.classList.contains('dark')
}

const baseTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: 'var(--surface-0)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)' },
  '.cm-gutters': { backgroundColor: 'var(--surface-1)', borderRight: '1px solid var(--line)' },
})

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        yaml(),
        baseTheme,
        theme.of(isDark() ? oneDark : []),
        editable.of(EditorState.readOnly.of(props.readonly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
        }),
      ],
    }),
  })
  const observer = new MutationObserver(() => view?.dispatch({ effects: theme.reconfigure(isDark() ? oneDark : []) }))
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  onBeforeUnmount(() => observer.disconnect())
})

watch(
  () => props.modelValue,
  (value) => {
    if (view && value !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  },
)
watch(
  () => props.readonly,
  (readonly) => view?.dispatch({ effects: editable.reconfigure(EditorState.readOnly.of(readonly)) }),
)

onBeforeUnmount(() => view?.destroy())
</script>

<template>
  <div ref="host" class="h-full min-h-0 overflow-hidden rounded-md border border-line" />
</template>
