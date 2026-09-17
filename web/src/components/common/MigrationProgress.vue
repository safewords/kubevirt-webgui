<script setup lang="ts">
/**
 * A live migration's transfer, as it happens: memory sent and left, the
 * transfer rate, and how fast the guest dirties memory again. Figures come
 * from the source node's virt-handler every few seconds.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { gateway, type Subscription } from '@/api/gateway'
import ProgressBar from '@/components/ui/ProgressBar.vue'
import { bytes } from '@/util/format'

interface Transfer {
  total?: number
  processed?: number
  remaining?: number
  transferRate?: number
  dirtyRate?: number
  sampledAt?: number
}
interface ProgressEvent {
  migrating: boolean
  sourceNode?: string
  targetNode?: string | null
  mode?: string | null
  transfer?: Transfer
  unavailable?: string
}

const props = withDefaults(defineProps<{ namespace: string; name: string; compact?: boolean }>(), { compact: false })
const state = ref<ProgressEvent | null>(null)
let sub: Subscription | null = null

watch(
  () => `${props.namespace}/${props.name}`,
  () => {
    sub?.close()
    state.value = null
    sub = gateway.subscribe('migration.progress', { namespace: props.namespace, name: props.name }, (event: ProgressEvent) => (state.value = event))
  },
  { immediate: true },
)
onBeforeUnmount(() => sub?.close())

const transfer = computed(() => state.value?.transfer)
const fraction = computed(() => {
  const t = transfer.value
  if (!t?.total || t.remaining === undefined) return null
  return Math.max(0, Math.min(1, (t.total - t.remaining) / t.total))
})
/** Pre-copy cannot finish while the guest dirties memory faster than it is sent. */
const outpaced = computed(() => {
  const t = transfer.value
  return !!(t?.dirtyRate && t.transferRate && t.dirtyRate >= t.transferRate)
})
const summary = computed(() => {
  const t = transfer.value
  if (!t) return ''
  const parts: string[] = []
  if (t.total !== undefined && t.remaining !== undefined) parts.push(`${bytes(t.total - t.remaining)} of ${bytes(t.total)}`)
  if (t.transferRate) parts.push(`${bytes(t.transferRate)}/s`)
  return parts.join(' · ')
})
</script>

<template>
  <template v-if="state?.migrating">
    <div v-if="compact" class="flex min-w-0 items-center gap-2" :title="summary">
      <ProgressBar :value="fraction" size="sm" class="w-20 shrink-0" />
      <span class="tabular-nums">{{ fraction === null ? '…' : `${Math.floor(fraction * 100)}%` }}</span>
      <span v-if="transfer?.transferRate" class="truncate text-fg-muted">{{ bytes(transfer.transferRate) }}/s</span>
    </div>
    <div v-else class="space-y-1.5" data-migration-progress>
      <div class="flex items-baseline justify-between gap-3 text-[12px]">
        <span class="text-fg-muted">
          {{ state.sourceNode }} → {{ state.targetNode ?? 'choosing a node' }}{{ state.mode ? ` · ${state.mode}` : '' }}
        </span>
        <span class="tabular-nums">
          <span v-if="fraction !== null" class="mr-1.5 font-semibold">{{ Math.floor(fraction * 100) }}%</span>
          <span class="text-fg-muted">{{ summary || (state.unavailable ? '' : 'waiting for the first sample…') }}</span>
        </span>
      </div>
      <ProgressBar :value="fraction" />
      <div v-if="transfer" class="flex flex-wrap gap-x-4 text-[12px] text-fg-muted tabular-nums">
        <span v-if="transfer.remaining !== undefined">Remaining {{ bytes(transfer.remaining) }}</span>
        <span v-if="transfer.processed !== undefined">Sent {{ bytes(transfer.processed) }}</span>
        <span v-if="transfer.dirtyRate !== undefined" :class="outpaced ? 'text-warn' : ''">
          Guest dirtying {{ bytes(transfer.dirtyRate) }}/s{{ outpaced ? ' — faster than the transfer; consider auto-converge or post-copy' : '' }}
        </span>
      </div>
      <div v-if="state.unavailable" class="text-[12px] text-fg-subtle">Transfer figures unavailable: {{ state.unavailable }}</div>
    </div>
  </template>
</template>
