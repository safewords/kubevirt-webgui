<script setup lang="ts">
import { computed, ref } from 'vue'
import { faUserCheck, faUserShield, faKey } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { useSession } from '@/stores/session'
import { useInventory } from '@/plugins/core/inventory'
import MyPermissions from './permissions/MyPermissions.vue'
import RoleBindings from './permissions/RoleBindings.vue'
import ApiTokens from './permissions/ApiTokens.vue'

defineProps<{ ctx: ObjectContext }>()
const session = useSession()
const inv = useInventory()

const tab = ref<'mine' | 'bindings' | 'tokens'>('mine')
const namespaces = computed(() => {
  const list = new Set(inv.reachableNamespaces)
  if (session.user?.homeNamespace) list.add(session.user.homeNamespace)
  if (!list.size) list.add('default')
  return [...list].sort()
})
const initial = computed(() => {
  const home = session.user?.homeNamespace
  if (home && namespaces.value.includes(home)) return home
  return namespaces.value.includes('default') ? 'default' : namespaces.value[0]
})
</script>

<template>
  <div class="space-y-3 p-3">
    <div class="flex gap-1 border-b border-line pb-2">
      <button class="btn btn-sm" :class="tab === 'mine' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'mine'"><Fa :icon="faUserCheck" /> My permissions</button>
      <button class="btn btn-sm" :class="tab === 'bindings' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'bindings'"><Fa :icon="faUserShield" /> Role bindings</button>
      <button class="btn btn-sm" :class="tab === 'tokens' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'tokens'"><Fa :icon="faKey" /> API tokens</button>
    </div>
    <MyPermissions v-if="tab === 'mine'" :namespaces="namespaces" :initial="initial" />
    <RoleBindings v-else-if="tab === 'bindings'" :namespaces="namespaces" :initial="initial" />
    <ApiTokens v-else :namespaces="namespaces" :initial="initial" />
  </div>
</template>
