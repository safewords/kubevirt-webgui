<script setup lang="ts">
/** View, edit or create one object as YAML, validated by a server dry run. */
import { computed, ref } from 'vue'
import { dump, load } from 'js-yaml'
import { faFileCode, faCheck, faFloppyDisk, faCopy } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { k8s, refFor, type Ref } from '@/api/k8s'
import type { KObject } from '@/api/types'
import { errorMessage } from '@/api/gateway'
import { toast } from '@/services/dialogs'
import { copyText } from '@/util/clipboard'

const props = withDefaults(
  defineProps<{
    title: string
    mode: 'view' | 'edit' | 'create'
    object?: KObject | object | null
    /** Where the object lives; derived from the object's kind when omitted. */
    resourceRef?: Ref | null
  }>(),
  { object: null, resourceRef: null },
)
const emit = defineEmits<{ close: [result?: KObject] }>()

function render(value: unknown) {
  if (!value) return ''
  const copy = JSON.parse(JSON.stringify(value))
  delete copy.metadata?.managedFields
  return dump(copy, { lineWidth: 140, noRefs: true })
}

const text = ref(render(props.object))
const error = ref<string | null>(null)
const validated = ref(false)
const busy = ref(false)
const readonly = computed(() => props.mode === 'view')

function parse(): KObject {
  const parsed = load(text.value) as KObject
  if (!parsed || typeof parsed !== 'object' || !parsed.metadata?.name) throw new Error('the document needs metadata.name')
  return parsed
}

function target(body: KObject): Ref {
  const ref = props.resourceRef ?? refFor(body)
  if (!ref) throw new Error(`cannot tell where a ${body.kind ?? 'document'} belongs; set apiVersion and kind`)
  return { ...ref, namespace: body.metadata.namespace ?? ref.namespace }
}

async function submit(dryRun: boolean) {
  error.value = null
  validated.value = false
  busy.value = true
  try {
    const body = parse()
    const ref = target(body)
    const saved =
      props.mode === 'create'
        ? await k8s.create({ ...ref, name: undefined }, body, { dryRun })
        : await k8s.replace({ ...ref, name: body.metadata.name }, body, { dryRun })
    if (dryRun) {
      validated.value = true
    } else {
      toast('success', props.mode === 'create' ? 'Created' : 'Saved', `${body.kind ?? 'Object'} ${body.metadata.name}`)
      emit('close', saved)
    }
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function copy() {
  if (await copyText(text.value)) toast('success', 'Copied to clipboard')
  else toast('error', 'Could not copy', 'The browser blocked clipboard access; select the text and copy it manually.')
}
</script>

<template>
  <Modal :title="title" :icon="faFileCode" width="900px" @close="emit('close')">
    <div class="flex h-[62vh] flex-col gap-2">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <Notice v-if="validated" kind="info"><Fa :icon="faCheck" /> The API server accepts this (dry run).</Notice>
      <div class="min-h-0 flex-1">
        <YamlEditor v-model="text" :readonly="readonly" />
      </div>
    </div>
    <template #footer>
      <button class="btn btn-ghost mr-auto" @click="copy"><Fa :icon="faCopy" /> Copy</button>
      <button class="btn" @click="emit('close')">{{ readonly ? 'Close' : 'Cancel' }}</button>
      <template v-if="!readonly">
        <button class="btn" :disabled="busy" @click="submit(true)"><Fa :icon="faCheck" /> Validate</button>
        <button class="btn btn-primary" :disabled="busy" @click="submit(false)"><Fa :icon="faFloppyDisk" /> {{ mode === 'create' ? 'Create' : 'Save' }}</button>
      </template>
    </template>
  </Modal>
</template>
