<script setup lang="ts">
/** A running task's progress: bar, figures, rate and time left. */
import { computed } from 'vue'
import type { TaskProgress } from '@/api/types'
import ProgressBar from '@/components/ui/ProgressBar.vue'
import { bytes, duration } from '@/util/format'

const props = withDefaults(defineProps<{ progress: TaskProgress; compact?: boolean }>(), { compact: false })

const fraction = computed(() => (props.progress.total ? props.progress.done / props.progress.total : null))
const amount = (n: number) => (props.progress.unit === 'bytes' ? bytes(n) : n.toLocaleString())
const figures = computed(() => {
  const { done, total, rate } = props.progress
  const parts = [total ? `${amount(done)} of ${amount(total)}` : amount(done)]
  if (rate) parts.push(props.progress.unit === 'bytes' ? `${bytes(rate)}/s` : `${rate.toFixed(1)}/s`)
  if (rate && total && total > done) parts.push(`${duration(((total - done) / rate) * 1000)} left`)
  return parts.join(' · ')
})
</script>

<template>
  <div v-if="compact" class="flex min-w-0 items-center gap-2" :title="[progress.detail, figures].filter(Boolean).join(' — ')">
    <ProgressBar :value="fraction" size="sm" class="w-20 shrink-0" />
    <span class="tabular-nums">{{ fraction === null ? amount(progress.done) : `${Math.floor(fraction * 100)}%` }}</span>
    <span class="truncate text-fg-muted">{{ progress.rate && progress.unit === 'bytes' ? `${bytes(progress.rate)}/s` : progress.detail }}</span>
  </div>
  <div v-else class="space-y-1">
    <div class="flex items-baseline justify-between gap-3 text-[12px]">
      <span class="truncate text-fg-muted">{{ progress.detail }}</span>
      <span class="shrink-0 tabular-nums">
        <span v-if="fraction !== null" class="mr-1.5 font-semibold">{{ Math.floor(fraction * 100) }}%</span>
        <span class="text-fg-muted">{{ figures }}</span>
      </span>
    </div>
    <ProgressBar :value="fraction" />
  </div>
</template>
