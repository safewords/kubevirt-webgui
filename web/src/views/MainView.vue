<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '@/components/layout/AppHeader.vue'
import ResourceTree from '@/components/layout/ResourceTree.vue'
import ObjectView from '@/components/layout/ObjectView.vue'
import TaskPanel from '@/components/layout/TaskPanel.vue'
import Notice from '@/components/ui/Notice.vue'
import { useUi } from '@/stores/ui'
import { useCluster } from '@/stores/cluster'
import { useTasks } from '@/stores/tasks'
import { useInventory } from '@/plugins/core/inventory'
import { registry } from '@/plugins/registry'

const route = useRoute()
const ui = useUi()
const cluster = useCluster()
const tasks = useTasks()

// The inventory feeds the tree, search and summaries; it lives as long as the
// main view does.
useInventory().start()

onMounted(() => {
  if (!cluster.discovery) cluster.load()
  tasks.start()
})

const target = computed(() => {
  if (route.name === 'datacenter') return { kind: 'datacenter', panel: route.params.panel as string | undefined }
  return {
    kind: route.params.kind as string,
    name: route.params.name as string,
    namespace: route.params.namespace as string | undefined,
    panel: route.params.panel as string | undefined,
  }
})

function startResize(event: MouseEvent) {
  const start = event.clientX
  const width = ui.treeWidth
  const move = (e: MouseEvent) => (ui.treeWidth = Math.max(200, Math.min(520, width + e.clientX - start)))
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <div class="flex h-full flex-col">
    <AppHeader />
    <div v-if="cluster.error" class="border-b border-line p-2">
      <Notice kind="error" title="Could not read the cluster">{{ cluster.error }}</Notice>
    </div>
    <div class="flex min-h-0 flex-1">
      <div class="shrink-0 border-r border-line" :style="{ width: `${ui.treeWidth}px` }">
        <ResourceTree />
      </div>
      <div class="-ml-1 w-1 shrink-0 cursor-col-resize hover:bg-accent/40" @mousedown.prevent="startResize" />
      <div class="min-w-0 flex-1">
        <ObjectView v-if="cluster.discovery && registry.plugins.some((p) => p.id === 'core')" v-bind="target" :key="`${target.kind}/${target.namespace ?? ''}/${target.name ?? ''}`" />
        <div v-else class="p-4"><Notice kind="loading">Reading the cluster…</Notice></div>
      </div>
    </div>
    <TaskPanel />
  </div>
</template>
