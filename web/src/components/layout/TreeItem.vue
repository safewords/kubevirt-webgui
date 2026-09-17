<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { faChevronRight, faCircle, faPause, faExclamation, faArrowRightArrowLeft, faStop } from '@fortawesome/free-solid-svg-icons'
import type { TreeNode } from '@/plugins/registry'
import { useUi } from '@/stores/ui'
import { routeTo } from '@/util/nav'

const props = defineProps<{ node: TreeNode; depth: number; selected: string }>()
const ui = useUi()
const router = useRouter()

const hasChildren = computed(() => !!props.node.children?.length)
const open = computed(() => ui.isOpen(props.node.key, props.depth))
const key = computed(() => (props.node.to ? (props.node.to.kind === 'datacenter' ? 'datacenter' : [props.node.to.kind, props.node.to.namespace ?? '', props.node.to.name].join('/')) : null))
const isSelected = computed(() => key.value !== null && key.value === props.selected)

const badge = computed(() => {
  switch (props.node.badge) {
    case 'running':
      return { icon: faCircle, class: 'text-ok text-[6px]' }
    case 'paused':
      return { icon: faPause, class: 'text-warn text-[7px]' }
    case 'error':
      return { icon: faExclamation, class: 'text-bad text-[8px]' }
    case 'warning':
      return { icon: faExclamation, class: 'text-warn text-[8px]' }
    case 'migrating':
      return { icon: faArrowRightArrowLeft, class: 'text-info text-[7px]' }
    case 'pending':
      return { icon: faCircle, class: 'text-info text-[6px] animate-pulse' }
    case 'stopped':
      return { icon: faStop, class: 'text-fg-subtle text-[6px]' }
    default:
      return null
  }
})

function activate() {
  if (props.node.to) router.push(routeTo(props.node.to, props.node.to.panel))
  else if (hasChildren.value) ui.toggle(props.node.key, props.depth)
}
</script>

<template>
  <div role="treeitem" :aria-expanded="hasChildren ? open : undefined">
    <div
      class="group flex h-[26px] cursor-pointer items-center gap-1.5 pr-2"
      :class="isSelected ? 'bg-selection text-fg' : 'hover:bg-surface-3'"
      :style="{ paddingLeft: `${6 + depth * 14}px` }"
      @click="activate"
      @dblclick="hasChildren && ui.toggle(node.key, depth)"
    >
      <button
        class="flex size-4 shrink-0 items-center justify-center text-[9px] text-fg-subtle hover:text-fg"
        :class="hasChildren ? '' : 'invisible'"
        tabindex="-1"
        @click.stop="ui.toggle(node.key, depth)"
      >
        <Fa :icon="faChevronRight" class="transition-transform" :class="open ? 'rotate-90' : ''" />
      </button>
      <span class="relative flex size-4 shrink-0 items-center justify-center">
        <Fa :icon="node.icon" :class="node.iconClass ?? 'text-fg-muted'" />
        <span v-if="badge" class="absolute -right-1 -bottom-1 flex size-2.5 items-center justify-center rounded-full bg-surface-1">
          <Fa :icon="badge.icon" :class="badge.class" />
        </span>
      </span>
      <span class="truncate">{{ node.label }}</span>
      <span v-if="node.hint" class="ml-auto truncate pl-2 text-[11px] text-fg-subtle">{{ node.hint }}</span>
    </div>
    <template v-if="hasChildren && open">
      <TreeItem v-for="child in node.children" :key="child.key" :node="child" :depth="depth + 1" :selected="selected" />
    </template>
  </div>
</template>
