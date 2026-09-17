<script setup lang="ts">
import { computed, ref } from 'vue'
import { faDisplay, faTerminal } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import VncConsole from '@/components/console/VncConsole.vue'
import SerialConsole from '@/components/console/SerialConsole.vue'
import Notice from '@/components/ui/Notice.vue'
import { templateSpec } from '@/util/kubevirt'

const props = defineProps<{ ctx: ObjectContext }>()
const running = computed(() => props.ctx.related.vmi?.status?.phase === 'Running')
const hasGraphics = computed(() => templateSpec(props.ctx.related.vmi ?? props.ctx.object)?.domain?.devices?.autoattachGraphicsDevice !== false)
const mode = ref<'vnc' | 'serial'>(hasGraphics.value ? 'vnc' : 'serial')
</script>

<template>
  <div class="flex h-full min-h-[480px] flex-col">
    <div class="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-surface-1 px-2">
      <button class="btn btn-sm" :class="mode === 'vnc' ? 'bg-surface-3' : 'btn-ghost'" :disabled="!hasGraphics" @click="mode = 'vnc'"><Fa :icon="faDisplay" /> noVNC</button>
      <button class="btn btn-sm" :class="mode === 'serial' ? 'bg-surface-3' : 'btn-ghost'" @click="mode = 'serial'"><Fa :icon="faTerminal" /> Serial (xterm.js)</button>
    </div>
    <div v-if="!running" class="p-4">
      <Notice kind="info" title="The VM is not running">Start it to open a console.</Notice>
    </div>
    <div v-else class="min-h-0 flex-1">
      <VncConsole v-if="mode === 'vnc'" :key="`vnc-${ctx.related.vmi?.metadata.uid}`" :namespace="ctx.namespace!" :name="ctx.name" />
      <SerialConsole v-else :key="`serial-${ctx.related.vmi?.metadata.uid}`" :namespace="ctx.namespace!" :name="ctx.name" />
    </div>
  </div>
</template>
