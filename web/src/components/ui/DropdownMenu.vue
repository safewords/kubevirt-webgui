<script setup lang="ts">
import { nextTick, onUnmounted, ref } from 'vue'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { faChevronDown } from '@fortawesome/free-solid-svg-icons'

export interface MenuItem {
  id: string
  title: string
  icon?: IconDefinition
  disabled?: boolean
  danger?: boolean
  divider?: boolean
  hint?: string
  run: () => void
}

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    title?: string
    icon?: IconDefinition
    /** A split button: clicking the label runs the first item. */
    split?: boolean
    align?: 'left' | 'right'
    buttonClass?: string
    disabled?: boolean
  }>(),
  { align: 'left', buttonClass: '' },
)

const open = ref(false)
const root = ref<HTMLElement | null>(null)

function onDocument(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}
function toggle() {
  open.value = !open.value
  if (open.value) nextTick(() => document.addEventListener('mousedown', onDocument))
  else document.removeEventListener('mousedown', onDocument)
}
function choose(item: MenuItem) {
  if (item.disabled) return
  open.value = false
  document.removeEventListener('mousedown', onDocument)
  item.run()
}
onUnmounted(() => document.removeEventListener('mousedown', onDocument))
</script>

<template>
  <div ref="root" class="relative inline-flex">
    <template v-if="split && props.items.length">
      <button class="btn rounded-r-none" :class="buttonClass" :disabled="disabled || props.items[0].disabled" @click="choose(props.items[0])">
        <Fa v-if="icon" :icon="icon" />
        <span>{{ title ?? props.items[0].title }}</span>
      </button>
      <button class="btn rounded-l-none border-l-0 px-1.5" :class="buttonClass" :disabled="disabled" :aria-label="`More ${title ?? props.items[0].title} actions`" aria-haspopup="menu" data-split-toggle @click="toggle">
        <Fa :icon="faChevronDown" class="text-[10px]" />
      </button>
    </template>
    <button v-else class="btn" :class="buttonClass" :disabled="disabled" @click="toggle">
      <Fa v-if="icon" :icon="icon" />
      <span v-if="title">{{ title }}</span>
      <slot name="button" />
      <Fa :icon="faChevronDown" class="text-[10px] opacity-70" />
    </button>
    <div
      v-if="open"
      class="card absolute top-full z-40 mt-1 min-w-[190px] py-1 shadow-xl shadow-black/30"
      :class="align === 'right' ? 'right-0' : 'left-0'"
    >
      <template v-for="item in props.items" :key="item.id">
        <div v-if="item.divider" class="my-1 border-t border-line" />
        <button
          class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-3 disabled:opacity-40 disabled:hover:bg-transparent"
          :class="item.danger ? 'text-bad' : ''"
          :disabled="item.disabled"
          @click="choose(item)"
        >
          <Fa v-if="item.icon" :icon="item.icon" class="w-4 opacity-80" />
          <span class="flex-1">{{ item.title }}</span>
          <span v-if="item.hint" class="text-xs text-fg-subtle">{{ item.hint }}</span>
        </button>
      </template>
      <slot />
    </div>
  </div>
</template>
