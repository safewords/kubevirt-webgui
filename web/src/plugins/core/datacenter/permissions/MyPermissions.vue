<script setup lang="ts">
/** What the signed-in user may do: a KubeVirt matrix, then the raw rules. */
import { computed, ref, watch } from 'vue'
import { faCircleCheck, faCircleXmark, faCircleQuestion, faRotate, faUser } from '@fortawesome/free-solid-svg-icons'
import { gateway, errorMessage } from '@/api/gateway'
import { useSession } from '@/stores/session'
import { can } from '@/stores/access'
import Notice from '@/components/ui/Notice.vue'

const props = defineProps<{ namespaces: string[]; initial: string }>()
const session = useSession()
const namespace = ref(props.initial)

interface Rule {
  verbs: string[]
  apiGroups?: string[]
  resources?: string[]
  resourceNames?: string[]
}
interface NonResourceRule {
  verbs: string[]
  nonResourceURLs: string[]
}

const rules = ref<Rule[]>([])
const nonResource = ref<NonResourceRule[]>([])
const incomplete = ref(false)
const evaluationError = ref<string | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
const filter = ref('')

async function load() {
  if (!namespace.value) return
  loading.value = true
  error.value = null
  try {
    const status = await gateway.call<any>('access.rules', { namespace: namespace.value })
    rules.value = status?.resourceRules ?? []
    nonResource.value = status?.nonResourceRules ?? []
    incomplete.value = !!status?.incomplete
    evaluationError.value = status?.evaluationError ?? null
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
watch(namespace, load, { immediate: true })

const shownRules = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return rules.value
  return rules.value.filter((r) => [...(r.apiGroups ?? []), ...(r.resources ?? []), ...(r.verbs ?? []), ...(r.resourceNames ?? [])].some((x) => x.toLowerCase().includes(q)))
})

interface MatrixRow {
  label: string
  group: string
  resource: string
  subresource?: string
  verbs: string[]
}

const MATRIX: MatrixRow[] = [
  { label: 'Virtual machines', group: 'kubevirt.io', resource: 'virtualmachines', verbs: ['list', 'get', 'create', 'update', 'patch', 'delete'] },
  { label: 'VM instances', group: 'kubevirt.io', resource: 'virtualmachineinstances', verbs: ['list', 'get', 'delete'] },
  { label: 'Start', group: 'subresources.kubevirt.io', resource: 'virtualmachines', subresource: 'start', verbs: ['update'] },
  { label: 'Stop', group: 'subresources.kubevirt.io', resource: 'virtualmachines', subresource: 'stop', verbs: ['update'] },
  { label: 'Restart', group: 'subresources.kubevirt.io', resource: 'virtualmachines', subresource: 'restart', verbs: ['update'] },
  { label: 'Pause', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'pause', verbs: ['update'] },
  { label: 'VNC console', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'vnc', verbs: ['get'] },
  { label: 'Serial console', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'console', verbs: ['get'] },
  { label: 'Guest agent info', group: 'subresources.kubevirt.io', resource: 'virtualmachineinstances', subresource: 'guestosinfo', verbs: ['get'] },
  { label: 'Migrations', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations', verbs: ['list', 'create', 'delete'] },
  { label: 'Snapshots', group: 'snapshot.kubevirt.io', resource: 'virtualmachinesnapshots', verbs: ['list', 'create', 'delete'] },
  { label: 'Restores', group: 'snapshot.kubevirt.io', resource: 'virtualmachinerestores', verbs: ['create'] },
  { label: 'Clones', group: 'clone.kubevirt.io', resource: 'virtualmachineclones', verbs: ['create'] },
  { label: 'DataVolumes', group: 'cdi.kubevirt.io', resource: 'datavolumes', verbs: ['list', 'create', 'delete'] },
  { label: 'Disk uploads', group: 'upload.cdi.kubevirt.io', resource: 'uploadtokenrequests', verbs: ['create'] },
  { label: 'Persistent volume claims', group: '', resource: 'persistentvolumeclaims', verbs: ['list', 'create', 'patch', 'delete'] },
  { label: 'Services', group: '', resource: 'services', verbs: ['list', 'create', 'delete'] },
  { label: 'Secrets', group: '', resource: 'secrets', verbs: ['list', 'create'] },
  { label: 'Role bindings', group: 'rbac.authorization.k8s.io', resource: 'rolebindings', verbs: ['list', 'create', 'delete'] },
  { label: 'ServiceAccount tokens', group: '', resource: 'serviceaccounts', subresource: 'token', verbs: ['create'] },
]
const ALL_VERBS = ['list', 'get', 'create', 'update', 'patch', 'delete']

function answer(row: MatrixRow, verb: string) {
  if (!row.verbs.includes(verb)) return null
  return can({ verb, group: row.group, resource: row.resource, subresource: row.subresource, namespace: namespace.value })
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <span class="flex items-center gap-2 text-fg-muted"><Fa :icon="faUser" /> <span class="mono text-fg">{{ session.user?.username }}</span></span>
      <span v-for="g in session.user?.groups ?? []" :key="g" class="chip mono">{{ g }}</span>
      <label class="ml-auto flex items-center gap-2 text-fg-muted">
        Namespace
        <select v-model="namespace" class="input w-56">
          <option v-for="ns in namespaces" :key="ns" :value="ns">{{ ns }}</option>
        </select>
      </label>
      <button class="btn" :disabled="loading" @click="load"><Fa :icon="faRotate" :spin="loading" /> Refresh</button>
    </div>

    <section>
      <h4 class="panel-title mb-2">Virtualization permissions in {{ namespace }}</h4>
      <div class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead>
            <tr>
              <th>Resource</th>
              <th v-for="verb in ALL_VERBS" :key="verb" class="w-20 text-center">{{ verb }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in MATRIX" :key="row.label">
              <td>
                {{ row.label }}
                <span class="mono ml-1 text-xs text-fg-subtle">{{ row.group ? `${row.group}/` : '' }}{{ row.resource }}{{ row.subresource ? `/${row.subresource}` : '' }}</span>
              </td>
              <td v-for="verb in ALL_VERBS" :key="verb" class="text-center">
                <template v-if="answer(row, verb) !== null">
                  <Fa v-if="answer(row, verb) === true" :icon="faCircleCheck" class="text-ok" :title="`${verb}: allowed`" />
                  <Fa v-else-if="answer(row, verb) === false" :icon="faCircleXmark" class="text-fg-subtle" :title="`${verb}: denied`" />
                  <Fa v-else :icon="faCircleQuestion" class="animate-pulse text-fg-subtle" />
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <div class="mb-2 flex items-center gap-2">
        <h4 class="panel-title">Effective rules in {{ namespace }}</h4>
        <span class="chip">{{ rules.length }}</span>
        <input v-model="filter" class="input ml-auto w-56" placeholder="Filter rules" />
      </div>
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <Notice v-if="incomplete" kind="warning">The API server reports this list as incomplete{{ evaluationError ? `: ${evaluationError}` : '' }} — some authorizers (e.g. webhooks) cannot enumerate their rules.</Notice>
      <div class="mt-2 overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead>
            <tr><th class="w-64">API groups</th><th>Resources</th><th class="w-56">Names</th><th class="w-72">Verbs</th></tr>
          </thead>
          <tbody>
            <tr v-for="(rule, i) in shownRules" :key="i">
              <td class="mono whitespace-normal">{{ (rule.apiGroups ?? []).map((g) => g || 'core').join(', ') }}</td>
              <td class="mono whitespace-normal">{{ (rule.resources ?? []).join(', ') }}</td>
              <td class="mono whitespace-normal text-fg-muted">{{ (rule.resourceNames ?? []).join(', ') || 'any' }}</td>
              <td class="whitespace-normal">
                <span v-for="verb in rule.verbs" :key="verb" class="chip mr-1" :class="verb === '*' ? 'bg-accent-soft text-accent' : ''">{{ verb }}</span>
              </td>
            </tr>
            <tr v-if="!shownRules.length">
              <td colspan="4" class="h-12 text-center text-fg-subtle">{{ loading ? 'Loading…' : 'No rules' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <details v-if="nonResource.length" class="mt-2">
        <summary class="cursor-pointer text-fg-muted">{{ nonResource.length }} non-resource URL rules</summary>
        <div class="mt-1 space-y-1">
          <div v-for="(r, i) in nonResource" :key="i" class="mono text-xs">{{ r.verbs.join(',') }} {{ r.nonResourceURLs.join(' ') }}</div>
        </div>
      </details>
    </section>
  </div>
</template>
