<script setup lang="ts">
/** The CDI worker pod's log — importer, upload server or clone — while a disk fills. */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { faRotate, faPause, faPlay } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { useWatch } from '@/stores/watch'
import Notice from '@/components/ui/Notice.vue'

const props = defineProps<{ ctx: ObjectContext }>()
const pods = useWatch(() => ({ apiVersion: 'v1', resource: 'pods', namespace: props.ctx.namespace, labelSelector: 'app=containerized-data-importer' }))

const pvcUid = computed(() => props.ctx.object?.metadata.uid ?? '')
const workers = computed(() =>
  pods.items.value
    .filter((p: KObject) => {
      const n = p.metadata.name
      return (
        n === `importer-${props.ctx.name}` ||
        n === `cdi-upload-${props.ctx.name}` ||
        n.startsWith(`importer-${props.ctx.name}-`) ||
        (!!pvcUid.value && n.includes(pvcUid.value)) ||
        p.metadata.annotations?.['cdi.kubevirt.io/storage.pod.phase'] !== undefined && p.metadata.ownerReferences?.some((o) => o.name === props.ctx.name)
      )
    })
    .sort((a, b) => (b.metadata.creationTimestamp ?? '').localeCompare(a.metadata.creationTimestamp ?? '')),
)

const selected = ref('')
watch(
  workers,
  (list) => {
    if (!list.some((p) => p.metadata.name === selected.value)) selected.value = list[0]?.metadata.name ?? ''
  },
  { immediate: true },
)

const text = ref('')
const error = ref<string | null>(null)
const follow = ref(true)
const scroller = ref<HTMLElement | null>(null)

async function load() {
  if (!selected.value) {
    text.value = ''
    return
  }
  try {
    text.value = await k8s.logs(props.ctx.namespace!, selected.value, { tailLines: 1000 })
    error.value = null
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  } catch (e) {
    error.value = errorMessage(e)
  }
}
watch(selected, load, { immediate: true })

const phase = computed(() => props.ctx.related.dataVolume?.status?.phase as string | undefined)
const active = computed(() => !!phase.value && !['Succeeded', 'Failed', 'Paused', 'WaitForFirstConsumer', 'PendingPopulation'].includes(phase.value))
const timer = setInterval(() => {
  if (follow.value && active.value && selected.value) load()
}, 4000)
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="flex h-full min-h-[420px] flex-col gap-2 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="panel-title">Import log</h3>
      <span v-if="phase" class="chip">{{ phase }}{{ ctx.related.dataVolume?.status?.progress && ctx.related.dataVolume.status.progress !== 'N/A' ? ` · ${ctx.related.dataVolume.status.progress}` : '' }}</span>
      <select v-if="workers.length > 1" v-model="selected" class="input ml-auto w-72">
        <option v-for="p in workers" :key="p.metadata.uid" :value="p.metadata.name">{{ p.metadata.name }} ({{ p.status?.phase }})</option>
      </select>
      <span v-else-if="selected" class="mono ml-auto text-fg-muted">{{ selected }}</span>
      <button class="btn btn-sm" :class="selected ? '' : 'ml-auto'" :disabled="!active" @click="follow = !follow"><Fa :icon="follow ? faPause : faPlay" /> {{ follow ? 'Following' : 'Paused' }}</button>
      <button class="btn btn-sm" :disabled="!selected" @click="load"><Fa :icon="faRotate" /> Refresh</button>
    </div>
    <Notice v-if="!ctx.related.dataVolume" kind="info">This claim was not created by a DataVolume, so there is no import to follow.</Notice>
    <Notice v-else-if="pods.synced.value && !workers.length" kind="empty">
      No importer pod is running{{ phase === 'Succeeded' ? ' — the import finished and CDI removed it' : phase ? ` (phase ${phase})` : '' }}.
    </Notice>
    <Notice v-if="error" kind="warning">{{ error }}</Notice>
    <pre v-if="selected" ref="scroller" class="mono min-h-0 flex-1 overflow-auto rounded-md border border-line bg-surface-0 p-3 text-[12px] leading-relaxed whitespace-pre-wrap">{{ text || 'No output yet.' }}</pre>
  </div>
</template>
