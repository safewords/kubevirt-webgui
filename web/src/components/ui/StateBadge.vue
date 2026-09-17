<script setup lang="ts">
import { computed } from 'vue'
import { stateStyle, type VmState } from '@/util/kubevirt'

const props = defineProps<{ state: VmState | string; label?: string }>()
const style = computed(() => stateStyle[props.state as VmState] ?? stateStyle.unknown)
</script>

<template>
  <span class="inline-flex items-center gap-1.5 whitespace-nowrap" :class="style.text">
    <span class="size-2 rounded-full" :class="[style.dot, state === 'starting' || state === 'migrating' || state === 'stopping' ? 'animate-pulse' : '']" />
    <span class="font-medium">{{ label ?? style.label }}</span>
  </span>
</template>
