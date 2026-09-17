<script setup lang="ts">
import { ref } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import ResourceYaml from '@/components/common/ResourceYaml.vue'

defineProps<{ ctx: ObjectContext }>()
const which = ref<'vm' | 'vmi'>('vm')
</script>

<template>
  <div class="flex h-full flex-col gap-2 p-3">
    <div class="flex gap-1">
      <button class="btn btn-sm" :class="which === 'vm' ? 'bg-surface-3' : 'btn-ghost'" @click="which = 'vm'">VirtualMachine</button>
      <button class="btn btn-sm" :class="which === 'vmi' ? 'bg-surface-3' : 'btn-ghost'" :disabled="!ctx.related.vmi" @click="which = 'vmi'">VirtualMachineInstance</button>
    </div>
    <div class="min-h-0 flex-1">
      <ResourceYaml v-if="which === 'vm'" :object="ctx.object" />
      <ResourceYaml v-else :object="ctx.related.vmi" readonly />
    </div>
  </div>
</template>
