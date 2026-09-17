<script setup lang="ts">
/** Per-browser preferences. */
import { computed, ref } from 'vue'
import { faPalette, faFolderTree, faFolderPlus, faXmark, faBroom, faUser } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { registry, byOrder } from '@/plugins/registry'
import { useUi } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { useCluster } from '@/stores/cluster'
import { confirm } from '@/services/dialogs'
import { isDnsLabel, dateTime } from '@/util/format'

defineProps<{ ctx: ObjectContext }>()
const ui = useUi()
const session = useSession()
const cluster = useCluster()

const views = computed(() => [...registry.treeViews].sort(byOrder))
const namespace = ref('')

function addNamespace() {
  const name = namespace.value.trim()
  if (!isDnsLabel(name) || ui.extraNamespaces.includes(name)) return
  ui.extraNamespaces = [...ui.extraNamespaces, name].sort()
  namespace.value = ''
}

function removeNamespace(name: string) {
  ui.extraNamespaces = ui.extraNamespaces.filter((n) => n !== name)
}

async function clearPreferences() {
  const ok = await confirm({ title: 'Reset preferences', message: 'Forget this browser\'s layout, theme, tree state and extra namespaces? You stay signed in.', confirmText: 'Reset', danger: true })
  if (!ok) return
  try {
    localStorage.removeItem('kve.ui')
  } catch {
    /* nothing stored */
  }
  location.reload()
}
</script>

<template>
  <div class="grid gap-3 p-3 xl:grid-cols-2">
    <div class="card">
      <div class="card-header"><Fa :icon="faUser" class="text-fg-muted" /> Account</div>
      <dl class="kv p-3">
        <dt>User</dt>
        <dd class="mono">{{ session.user?.username }}</dd>
        <dt>Groups</dt>
        <dd><span v-for="g in session.user?.groups ?? []" :key="g" class="chip mono mr-1">{{ g }}</span></dd>
        <dt>Home namespace</dt>
        <dd>{{ session.user?.homeNamespace ?? '—' }}</dd>
        <dt>Session expires</dt>
        <dd>{{ session.expires ? dateTime(session.expires * 1000) : '—' }}</dd>
      </dl>
    </div>

    <div class="card">
      <div class="card-header"><Fa :icon="faPalette" class="text-fg-muted" /> Appearance</div>
      <div class="grid grid-cols-2 gap-3 p-3">
        <div>
          <label class="label">Theme</label>
          <select v-model="ui.theme" class="input">
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Follow the system</option>
          </select>
        </div>
        <div>
          <label class="label">Resource tree view</label>
          <select v-model="ui.treeView" class="input">
            <option v-for="v in views" :key="v.id" :value="v.id">{{ v.title }}</option>
          </select>
        </div>
        <div class="col-span-2">
          <label class="flex items-center gap-2"><input v-model="ui.taskPanelOpen" type="checkbox" class="accent-[var(--accent)]" /> Show the task and cluster log panel</label>
        </div>
      </div>
    </div>

    <div class="card xl:col-span-2">
      <div class="card-header"><Fa :icon="faFolderTree" class="text-fg-muted" /> Extra namespaces</div>
      <div class="space-y-3 p-3">
        <p class="text-fg-muted">
          <template v-if="cluster.canListNamespaces">You can list namespaces, so every namespace is already shown. </template>
          <template v-else>Your account cannot list namespaces. </template>
          Add namespaces you have access to so their VMs and disks appear in the tree and pickers.
        </p>
        <div class="flex gap-2">
          <input v-model="namespace" class="input mono w-64" placeholder="namespace" @keydown.enter="addNamespace" />
          <button class="btn" :disabled="!isDnsLabel(namespace.trim()) || ui.extraNamespaces.includes(namespace.trim())" @click="addNamespace"><Fa :icon="faFolderPlus" /> Add</button>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="ns in ui.extraNamespaces" :key="ns" class="chip mono bg-accent-soft text-accent">
            {{ ns }}
            <button class="hover:text-bad" :aria-label="`Remove ${ns}`" @click="removeNamespace(ns)"><Fa :icon="faXmark" /></button>
          </span>
          <span v-if="!ui.extraNamespaces.length" class="text-fg-subtle">None added</span>
        </div>
      </div>
    </div>

    <div class="xl:col-span-2">
      <button class="btn btn-danger" @click="clearPreferences"><Fa :icon="faBroom" /> Reset local preferences</button>
    </div>
  </div>
</template>
