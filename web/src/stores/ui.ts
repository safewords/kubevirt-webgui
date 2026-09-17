import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

const KEY = 'kve.ui'

interface Persisted {
  theme: 'dark' | 'light' | 'system'
  treeView: string
  treeWidth: number
  taskPanelHeight: number
  taskPanelOpen: boolean
  expanded: string[]
  collapsed: string[]
  namespaceFilter: string
  extraNamespaces: string[]
}

const defaults: Persisted = {
  theme: 'dark',
  treeView: 'server',
  treeWidth: 280,
  taskPanelHeight: 200,
  taskPanelOpen: true,
  expanded: [],
  collapsed: [],
  namespaceFilter: '',
  extraNamespaces: [],
}

function load(): Persisted {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
  } catch {
    return { ...defaults }
  }
}

/** Per-browser layout preferences. */
export const useUi = defineStore('ui', () => {
  const saved = load()
  const theme = ref(saved.theme)
  const treeView = ref(saved.treeView)
  const treeWidth = ref(saved.treeWidth)
  const taskPanelHeight = ref(saved.taskPanelHeight)
  const taskPanelOpen = ref(saved.taskPanelOpen)
  const expanded = ref(new Set(saved.expanded))
  const collapsed = ref(new Set(saved.collapsed))
  const namespaceFilter = ref(saved.namespaceFilter)
  const extraNamespaces = ref<string[]>(saved.extraNamespaces)
  const search = ref('')

  function applyTheme() {
    const dark = theme.value === 'dark' || (theme.value === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
  }
  applyTheme()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)

  watch(
    [theme, treeView, treeWidth, taskPanelHeight, taskPanelOpen, expanded, collapsed, namespaceFilter, extraNamespaces],
    () => {
      applyTheme()
      try {
        localStorage.setItem(
          KEY,
          JSON.stringify({
            theme: theme.value,
            treeView: treeView.value,
            treeWidth: treeWidth.value,
            taskPanelHeight: taskPanelHeight.value,
            taskPanelOpen: taskPanelOpen.value,
            expanded: [...expanded.value],
            collapsed: [...collapsed.value],
            namespaceFilter: namespaceFilter.value,
            extraNamespaces: extraNamespaces.value,
          } satisfies Persisted),
        )
      } catch {
        /* preferences are a convenience */
      }
    },
    { deep: true },
  )

  /** The top two tree levels start open, as in Proxmox; deeper ones closed. */
  function isOpen(key: string, depth: number): boolean {
    return depth < 2 ? !collapsed.value.has(key) : expanded.value.has(key)
  }

  function toggle(key: string, depth: number, open?: boolean) {
    const shouldOpen = open ?? !isOpen(key, depth)
    if (depth < 2) {
      const next = new Set(collapsed.value)
      if (shouldOpen) next.delete(key)
      else next.add(key)
      collapsed.value = next
    } else {
      const next = new Set(expanded.value)
      if (shouldOpen) next.add(key)
      else next.delete(key)
      expanded.value = next
    }
  }

  return { theme, treeView, treeWidth, taskPanelHeight, taskPanelOpen, expanded, collapsed, namespaceFilter, extraNamespaces, search, isOpen, toggle }
})
