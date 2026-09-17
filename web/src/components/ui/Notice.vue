<script setup lang="ts">
import { computed } from 'vue'
import { faCircleExclamation, faCircleInfo, faTriangleExclamation, faSpinner, faInbox } from '@fortawesome/free-solid-svg-icons'

const props = withDefaults(defineProps<{ kind?: 'error' | 'warning' | 'info' | 'loading' | 'empty'; title?: string }>(), { kind: 'info' })
const icon = computed(() => ({ error: faCircleExclamation, warning: faTriangleExclamation, info: faCircleInfo, loading: faSpinner, empty: faInbox })[props.kind])
const tone = computed(
  () =>
    ({
      error: 'border-bad/40 bg-bad/8 text-bad',
      warning: 'border-warn/40 bg-warn/8 text-warn',
      info: 'border-info/30 bg-info/8 text-info',
      loading: 'border-line bg-surface-2 text-fg-muted',
      empty: 'border-line border-dashed bg-transparent text-fg-subtle',
    })[props.kind],
)
</script>

<template>
  <div class="flex items-start gap-2.5 rounded-md border px-3 py-2.5" :class="tone">
    <Fa :icon="icon" class="mt-0.5" :spin="kind === 'loading'" />
    <div class="min-w-0 flex-1">
      <div v-if="title" class="font-semibold">{{ title }}</div>
      <div class="break-words text-fg-muted"><slot /></div>
    </div>
  </div>
</template>
