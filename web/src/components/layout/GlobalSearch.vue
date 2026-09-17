<script setup lang="ts">
/** Search every object the tree knows about — Proxmox's header search. */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'
import { registry, type TreeNode } from '@/plugins/registry'
import { routeTo } from '@/util/nav'

const router = useRouter()
const query = ref('')
const focused = ref(false)
const active = ref(0)

const view = computed(() => registry.treeViews.find((v) => v.id === 'type') ?? registry.treeViews[0])

const all = computed(() => {
  const out: TreeNode[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.to?.name) out.push(node)
      if (node.children) walk(node.children)
    }
  }
  if (view.value && focused.value) walk(view.value.build())
  const seen = new Set<string>()
  return out.filter((n) => {
    const key = `${n.to!.kind}/${n.to!.namespace ?? ''}/${n.to!.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
})

const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return []
  return all.value
    .filter((n) => `${n.label} ${n.hint ?? ''} ${n.to?.namespace ?? ''} ${(n.tags ?? []).join(' ')}`.toLowerCase().includes(q))
    .slice(0, 12)
})

function go(node: TreeNode) {
  if (!node.to) return
  router.push(routeTo(node.to, node.to.panel))
  query.value = ''
  ;(document.activeElement as HTMLElement | null)?.blur()
}

function onBlur() {
  setTimeout(() => (focused.value = false), 150)
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') active.value = Math.min(results.value.length - 1, active.value + 1)
  else if (event.key === 'ArrowUp') active.value = Math.max(0, active.value - 1)
  else if (event.key === 'Enter' && results.value[active.value]) go(results.value[active.value])
  else if (event.key === 'Escape') query.value = ''
  else return
  event.preventDefault()
}
</script>

<template>
  <div class="relative">
    <Fa :icon="faMagnifyingGlass" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-xs text-fg-subtle" />
    <input
      v-model="query"
      class="input h-8 pl-8"
      placeholder="Search VMs, nodes, disks, namespaces…"
      @focus="focused = true"
      @blur="onBlur"
      @input="active = 0"
      @keydown="onKey"
    />
    <div v-if="focused && results.length" class="card absolute top-full right-0 left-0 z-40 mt-1 max-h-96 overflow-auto py-1 shadow-xl shadow-black/30">
      <button
        v-for="(node, index) in results"
        :key="`${node.key}`"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        :class="index === active ? 'bg-surface-3' : 'hover:bg-surface-3'"
        @mousedown.prevent="go(node)"
      >
        <Fa :icon="node.icon" class="w-4" :class="node.iconClass ?? 'text-fg-muted'" />
        <span class="truncate">{{ node.label }}</span>
        <span class="ml-auto truncate text-xs text-fg-subtle">{{ node.to?.kind }}{{ node.to?.namespace ? ` · ${node.to.namespace}` : '' }}</span>
      </button>
    </div>
  </div>
</template>
