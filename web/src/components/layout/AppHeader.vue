<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  faPlus, faRightFromBracket, faUser, faMoon, faSun, faCircleHalfStroke, faBook, faCircle, faGear, faPuzzlePiece,
} from '@fortawesome/free-solid-svg-icons'
import { gateway } from '@/api/gateway'
import { useSession } from '@/stores/session'
import { useCluster } from '@/stores/cluster'
import { useUi } from '@/stores/ui'
import { registry, byOrder } from '@/plugins/registry'
import DropdownMenu, { type MenuItem } from '@/components/ui/DropdownMenu.vue'
import GlobalSearch from './GlobalSearch.vue'
import { resetWatches } from '@/stores/watch'
import { resetAccess } from '@/stores/access'
import { useTasks } from '@/stores/tasks'

const session = useSession()
const cluster = useCluster()
const ui = useUi()
const router = useRouter()
const tasks = useTasks()

// One Create menu: the primary items (Create VM) first, the rest after a divider.
const createItems = computed(() => registry.createItems.filter((c) => !c.requires || c.requires.every((r) => cluster.has(r))).sort(byOrder))
const createMenu = computed<MenuItem[]>(() => {
  const primary = createItems.value.filter((c) => c.primary)
  const rest = createItems.value.filter((c) => !c.primary)
  return [...primary, ...rest].map((c, index) => ({ id: c.id, title: c.title, icon: c.icon, divider: index === primary.length && primary.length > 0, run: () => c.run() }))
})

const userMenu = computed<MenuItem[]>(() => [
  { id: 'theme-dark', title: 'Dark theme', icon: faMoon, hint: ui.theme === 'dark' ? '✓' : '', run: () => (ui.theme = 'dark') },
  { id: 'theme-light', title: 'Light theme', icon: faSun, hint: ui.theme === 'light' ? '✓' : '', run: () => (ui.theme = 'light') },
  { id: 'theme-system', title: 'System theme', icon: faCircleHalfStroke, hint: ui.theme === 'system' ? '✓' : '', run: () => (ui.theme = 'system') },
  { id: 'settings', title: 'My settings', icon: faGear, divider: true, run: () => router.push({ name: 'datacenter', params: { panel: 'my-settings' } }) },
  { id: 'extensions', title: 'Extensions', icon: faPuzzlePiece, run: () => router.push({ name: 'datacenter', params: { panel: 'extensions' } }) },
  {
    id: 'logout',
    title: 'Sign out',
    icon: faRightFromBracket,
    divider: true,
    run: async () => {
      await session.logout()
      tasks.stop()
      resetWatches()
      resetAccess()
      // A full reload leaves nothing of this user's state behind.
      window.location.assign('/login')
    },
  },
])

const connection = computed(() => {
  switch (gateway.state.value) {
    case 'open':
      return { class: 'text-ok', label: gateway.latency.value !== null ? `Connected · ${gateway.latency.value} ms` : 'Connected' }
    case 'connecting':
      return { class: 'text-warn animate-pulse', label: 'Connecting…' }
    default:
      return { class: 'text-bad', label: 'Disconnected — reconnecting' }
  }
})
</script>

<template>
  <header class="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-3">
    <RouterLink :to="{ name: 'datacenter' }" class="flex items-center gap-2 pr-2">
      <img src="/favicon.svg" class="size-6" alt="" />
      <span class="text-[14px] font-semibold tracking-tight whitespace-nowrap">{{ session.hello?.server.product ?? 'kubevirt-webgui' }}</span>
      <span class="hidden text-xs whitespace-nowrap text-fg-subtle 2xl:inline">
        {{ cluster.kubevirtVersion ? `KubeVirt ${cluster.kubevirtVersion}` : '' }}
        {{ cluster.kubernetesVersion ? `· Kubernetes ${cluster.kubernetesVersion}` : '' }}
      </span>
    </RouterLink>

    <GlobalSearch class="mx-auto w-full max-w-md" />

    <div class="flex items-center gap-2">
      <span class="hidden items-center gap-1.5 text-xs text-fg-muted lg:flex" :title="connection.label">
        <Fa :icon="faCircle" class="text-[7px]" :class="connection.class" />
        <span class="hidden xl:inline">{{ connection.label }}</span>
      </span>
      <a class="btn btn-ghost" href="https://kubevirt.io/user-guide/" target="_blank" rel="noopener" title="KubeVirt documentation">
        <Fa :icon="faBook" /><span class="hidden lg:inline">Documentation</span>
      </a>
      <DropdownMenu v-if="createMenu.length" :items="createMenu" :icon="faPlus" title="Create" align="right" button-class="btn-primary" />
      <DropdownMenu :items="userMenu" align="right" button-class="btn-ghost">
        <template #button>
          <Fa :icon="faUser" />
          <span class="max-w-[220px] truncate">{{ session.displayName }}</span>
        </template>
      </DropdownMenu>
    </div>
  </header>
</template>
