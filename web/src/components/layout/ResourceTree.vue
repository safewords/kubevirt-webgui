<script setup lang="ts">
import { computed, effectScope, onScopeDispose, watch } from 'vue'
import { useRoute } from 'vue-router'
import { registry, byOrder } from '@/plugins/registry'
import { useUi } from '@/stores/ui'
import { useCluster } from '@/stores/cluster'
import TreeItem from './TreeItem.vue'

const ui = useUi()
const route = useRoute()

const cluster = useCluster()
const views = computed(() => registry.treeViews.filter((v) => !v.requires || v.requires.every((r) => cluster.has(r))).sort(byOrder))
const view = computed(() => views.value.find((v) => v.id === ui.treeView) ?? views.value[0])

// Each view's live data is set up once and kept, so switching views is instant.
const scopes = new Map<string, ReturnType<typeof effectScope>>()
watch(
  view,
  (v) => {
    if (!v?.setup || scopes.has(v.id)) return
    const scope = effectScope(true)
    scope.run(() => v.setup!())
    scopes.set(v.id, scope)
  },
  { immediate: true },
)
onScopeDispose(() => scopes.forEach((s) => s.stop()))

const nodes = computed(() => view.value?.build() ?? [])

const selectedKey = computed(() => {
  const p = route.params
  if (route.name === 'datacenter') return 'datacenter'
  return [p.kind, p.namespace ?? '', p.name].join('/')
})
</script>

<template>
  <aside class="flex h-full min-h-0 flex-col bg-surface-1">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
      <select v-model="ui.treeView" class="input h-7 flex-1">
        <option v-for="v in views" :key="v.id" :value="v.id">{{ v.title }}</option>
      </select>
    </div>
    <nav class="min-h-0 flex-1 overflow-auto py-1 select-none" role="tree">
      <TreeItem v-for="node in nodes" :key="node.key" :node="node" :depth="0" :selected="selectedKey" />
    </nav>
  </aside>
</template>
