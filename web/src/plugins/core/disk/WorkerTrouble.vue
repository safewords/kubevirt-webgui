<script setup lang="ts">
/**
 * Why CDI cannot fill a disk. CDI retries a failing importer or upload pod
 * forever, and the DataVolume shows only a restart count; the reason is in
 * the pod's termination message, which `datavolume.diagnose` reads.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import Notice from '@/components/ui/Notice.vue'

interface Trouble {
  pod: string
  node: string
  restarts: number
  message: string
  hint?: string | null
}

const props = defineProps<{ dataVolume: KObject | null | undefined }>()

const failing = computed(() => {
  const dv = props.dataVolume
  if (!dv || dv.status?.phase === 'Succeeded') return false
  const restarts = dv.status?.restartCount ?? 0
  const running = (dv.status?.conditions ?? []).find((c: any) => c.type === 'Running')
  return restarts > 0 || (running?.status === 'False' && ['Error', 'CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull'].includes(running?.reason))
})

const trouble = ref<Trouble | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  const dv = props.dataVolume
  if (!dv) return
  try {
    const result = await gateway.call<{ trouble: Trouble | null }>('datavolume.diagnose', { namespace: dv.metadata.namespace, name: dv.metadata.name })
    trouble.value = result.trouble
  } catch {
    // Reading pods may be forbidden; the restart count still shows below.
  }
}

watch(
  () => [failing.value, props.dataVolume?.status?.restartCount] as const,
  ([isFailing]) => {
    if (timer) clearInterval(timer)
    timer = null
    if (!isFailing) {
      trouble.value = null
      return
    }
    load()
    timer = setInterval(load, 15_000)
  },
  { immediate: true },
)
onBeforeUnmount(() => timer && clearInterval(timer))
</script>

<template>
  <Notice v-if="failing" kind="error" :title="trouble ? `CDI's pod keeps failing (${trouble.restarts} restart${trouble.restarts === 1 ? '' : 's'})` : 'CDI is retrying this disk'">
    <template v-if="trouble">
      <div class="mono break-words text-fg">{{ trouble.message }}</div>
      <div class="mt-1 text-xs">Pod <span class="mono">{{ trouble.pod }}</span> on node <span class="mono">{{ trouble.node }}</span></div>
      <div v-if="trouble.hint" class="mt-1.5">{{ trouble.hint }}</div>
    </template>
    <template v-else>
      Its worker pod has restarted {{ dataVolume?.status?.restartCount ?? 0 }} time(s). The Import Log shows its output.
    </template>
  </Notice>
</template>
