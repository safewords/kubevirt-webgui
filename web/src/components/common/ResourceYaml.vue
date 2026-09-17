<script setup lang="ts">
/** View and edit any object as YAML, with a server-side dry run before saving. */
import { computed, ref, watch } from 'vue'
import { dump, load } from 'js-yaml'
import { faFloppyDisk, faRotateLeft, faPenToSquare, faCheck, faCopy } from '@fortawesome/free-solid-svg-icons'
import YamlEditor from './YamlEditor.vue'
import Notice from '@/components/ui/Notice.vue'
import { k8s, refFor, type Ref } from '@/api/k8s'
import type { KObject } from '@/api/types'
import { errorMessage } from '@/api/gateway'
import { toast } from '@/services/dialogs'
import { copyText } from '@/util/clipboard'

const props = defineProps<{ object: KObject | null; resourceRef?: Ref | null; readonly?: boolean }>()

const editing = ref(false)
const text = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const validated = ref(false)

function render(object: KObject | null) {
  if (!object) return ''
  const copy = JSON.parse(JSON.stringify(object))
  delete copy.metadata?.managedFields
  return dump(copy, { lineWidth: 140, noRefs: true, sortKeys: false })
}

watch(
  () => props.object,
  (object) => {
    if (!editing.value) text.value = render(object)
  },
  { immediate: true },
)

const target = computed(() => props.resourceRef ?? (props.object ? refFor(props.object) : null))
const stale = computed(() => {
  if (!editing.value || !props.object || render(props.object) === text.value) return false
  // Half-typed YAML does not parse; that is not a conflict, and a computed must not throw.
  try {
    return (load(text.value) as any)?.metadata?.resourceVersion !== props.object.metadata.resourceVersion
  } catch {
    return false
  }
})

function parse(): KObject {
  const parsed = load(text.value) as KObject
  if (!parsed || typeof parsed !== 'object' || !parsed.metadata?.name) throw new Error('the document needs metadata.name')
  return parsed
}

async function validate() {
  error.value = null
  validated.value = false
  busy.value = true
  try {
    const body = parse()
    await k8s.replace({ ...target.value!, name: body.metadata.name }, body, { dryRun: true })
    validated.value = true
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function save() {
  error.value = null
  busy.value = true
  try {
    const body = parse()
    await k8s.replace({ ...target.value!, name: body.metadata.name }, body)
    toast('success', 'Saved', `${body.kind ?? 'Object'} ${body.metadata.name} updated`)
    editing.value = false
    validated.value = false
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

function reset() {
  editing.value = false
  error.value = null
  validated.value = false
  text.value = render(props.object)
}

async function copy() {
  if (await copyText(text.value)) toast('success', 'Copied to clipboard')
  else toast('error', 'Could not copy', 'The browser blocked clipboard access')
}
</script>

<template>
  <div class="flex h-full min-h-[420px] flex-col gap-2">
    <div class="flex items-center gap-2">
      <template v-if="!editing">
        <button v-if="!readonly && target" class="btn" @click="editing = true"><Fa :icon="faPenToSquare" /> Edit</button>
      </template>
      <template v-else>
        <button class="btn" :disabled="busy" @click="validate"><Fa :icon="faCheck" /> Validate (dry run)</button>
        <button class="btn btn-primary" :disabled="busy" @click="save"><Fa :icon="faFloppyDisk" /> Save</button>
        <button class="btn" :disabled="busy" @click="reset"><Fa :icon="faRotateLeft" /> Discard</button>
        <span v-if="validated" class="text-ok"><Fa :icon="faCheck" /> The API server accepts this</span>
      </template>
      <button class="btn btn-ghost ml-auto" @click="copy"><Fa :icon="faCopy" /> Copy</button>
    </div>
    <Notice v-if="stale" kind="warning">The object changed on the server while you were editing. Saving will fail with a conflict; discard to reload it.</Notice>
    <Notice v-if="error" kind="error">{{ error }}</Notice>
    <div class="min-h-0 flex-1">
      <YamlEditor v-model="text" :readonly="!editing" />
    </div>
  </div>
</template>
