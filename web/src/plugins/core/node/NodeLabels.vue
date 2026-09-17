<script setup lang="ts">
/** Labels and taints — where a node's scheduling policy lives. */
import { computed, ref } from 'vue'
import { faPlus, faTrash, faTag, faBan, faLock } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { k8s } from '@/api/k8s'
import { can } from '@/stores/access'
import { confirm, run } from '@/services/dialogs'
import Notice from '@/components/ui/Notice.vue'

const props = defineProps<{ ctx: ObjectContext }>()
const node = computed(() => props.ctx.object)
const ref_ = computed(() => ({ apiVersion: 'v1', resource: 'nodes', name: props.ctx.name }))
const allowed = computed(() => can({ verb: 'patch', group: '', resource: 'nodes', name: props.ctx.name }))

// Labels written by the kubelet and KubeVirt's node-labeller are overwritten
// on their next pass; editing them by hand only confuses the scheduler.
const MANAGED = /^(kubernetes\.io\/|beta\.kubernetes\.io\/|node\.kubernetes\.io\/|topology\.kubernetes\.io\/|[a-z-]+\.node\.kubevirt\.io\/|kubevirt\.io\/(schedulable|cpumanager|ksm-enabled)$|cpumanager$|feature\.node\.kubernetes\.io\/|node-role\.kubernetes\.io\/control-plane|node-role\.kubernetes\.io\/etcd)/
const showManaged = ref(false)
const filter = ref('')

const labels = computed(() =>
  Object.entries(node.value?.metadata.labels ?? {})
    .map(([key, value]) => ({ key, value, managed: MANAGED.test(key) }))
    .filter((l) => showManaged.value || !l.managed)
    .filter((l) => !filter.value || `${l.key}=${l.value}`.toLowerCase().includes(filter.value.toLowerCase()))
    .sort((a, b) => a.key.localeCompare(b.key)),
)
const hiddenCount = computed(() => Object.keys(node.value?.metadata.labels ?? {}).filter((k) => MANAGED.test(k)).length)
const taints = computed<Array<{ key: string; value?: string; effect: string; timeAdded?: string }>>(() => node.value?.spec?.taints ?? [])

const newKey = ref('')
const newValue = ref('')
const LABEL_KEY = /^([a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/
const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/
const labelValid = computed(() => LABEL_KEY.test(newKey.value.trim()) && LABEL_VALUE.test(newValue.value.trim()) && newValue.value.trim().length <= 63)

async function addLabel() {
  if (!labelValid.value) return
  const key = newKey.value.trim()
  const value = newValue.value.trim()
  const done = await run(`Label ${props.ctx.name}`, () => k8s.patch(ref_.value, { metadata: { labels: { [key]: value } } }))
  if (done) {
    newKey.value = ''
    newValue.value = ''
  }
}

async function removeLabel(key: string, managed: boolean) {
  const ok = await confirm({
    title: 'Remove label',
    message: `Remove ${key} from ${props.ctx.name}?${managed ? '\n\nThis label is maintained automatically and will likely be restored.' : ' Workloads that select nodes by it may no longer be scheduled here.'}`,
    confirmText: 'Remove',
    danger: true,
  })
  if (ok) await run(`Remove label ${key}`, () => k8s.patch(ref_.value, { metadata: { labels: { [key]: null } } }))
}

const taintKey = ref('')
const taintValue = ref('')
const taintEffect = ref<'NoSchedule' | 'PreferNoSchedule' | 'NoExecute'>('NoSchedule')
const taintValid = computed(() => LABEL_KEY.test(taintKey.value.trim()) && LABEL_VALUE.test(taintValue.value.trim()))

async function addTaint() {
  if (!taintValid.value) return
  const next = [...taints.value.filter((t) => !(t.key === taintKey.value.trim() && t.effect === taintEffect.value)), { key: taintKey.value.trim(), value: taintValue.value.trim() || undefined, effect: taintEffect.value }]
  if (taintEffect.value === 'NoExecute') {
    const ok = await confirm({
      title: 'Add NoExecute taint',
      message: `A NoExecute taint evicts every pod on ${props.ctx.name} that does not tolerate it — including virtual machines, which are shut down unless they are migrated first.`,
      confirmText: 'Add taint',
      danger: true,
    })
    if (!ok) return
  }
  const done = await run(`Taint ${props.ctx.name}`, () => k8s.patch(ref_.value, { spec: { taints: next } }))
  if (done) {
    taintKey.value = ''
    taintValue.value = ''
  }
}

async function removeTaint(index: number) {
  const taint = taints.value[index]
  const ok = await confirm({ title: 'Remove taint', message: `Remove ${taint.key}${taint.value ? `=${taint.value}` : ''}:${taint.effect} from ${props.ctx.name}?`, confirmText: 'Remove', danger: true })
  if (!ok) return
  const next = taints.value.filter((_, i) => i !== index)
  await run(`Remove taint ${taint.key}`, () => k8s.patch(ref_.value, { spec: { taints: next.length ? next : null } }))
}
</script>

<template>
  <div class="space-y-4 p-3">
    <Notice v-if="allowed === false" kind="info">You can view this node's labels and taints but not change them.</Notice>

    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title flex items-center gap-2"><Fa :icon="faTag" class="text-fg-muted" /> Labels</h3>
        <label class="ml-3 flex items-center gap-1.5 text-fg-muted"><input v-model="showManaged" type="checkbox" class="accent-[var(--accent)]" /> Show {{ hiddenCount }} automatic labels</label>
        <input v-model="filter" class="input ml-auto w-56" placeholder="Filter labels" />
      </div>
      <div class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead>
            <tr><th>Key</th><th>Value</th><th class="w-24" /></tr>
          </thead>
          <tbody>
            <tr v-for="l in labels" :key="l.key">
              <td class="mono">
                {{ l.key }}
                <Fa v-if="l.managed" :icon="faLock" class="ml-1 text-[10px] text-fg-subtle" title="Maintained automatically" />
              </td>
              <td class="mono text-fg-muted">{{ l.value }}</td>
              <td class="text-right">
                <button class="btn btn-sm btn-ghost text-bad" :disabled="allowed !== true" :aria-label="`Remove ${l.key}`" @click="removeLabel(l.key, l.managed)"><Fa :icon="faTrash" /></button>
              </td>
            </tr>
            <tr v-if="!labels.length"><td colspan="3" class="h-12 text-center text-fg-subtle">No labels to show</td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="p-2"><input v-model="newKey" class="input mono" placeholder="example.com/rack" :disabled="allowed !== true" @keydown.enter="addLabel" /></td>
              <td class="p-2"><input v-model="newValue" class="input mono" placeholder="r12" :disabled="allowed !== true" @keydown.enter="addLabel" /></td>
              <td class="p-2 text-right"><button class="btn btn-sm" :disabled="allowed !== true || !labelValid" @click="addLabel"><Fa :icon="faPlus" /> Add</button></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>

    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faBan" class="text-fg-muted" /> Taints</h3>
      <p class="mb-2 text-fg-muted">Taints repel workloads that do not tolerate them. <span class="mono">NoSchedule</span> keeps new VMs off; <span class="mono">NoExecute</span> also evicts running ones.</p>
      <div class="overflow-auto rounded-md border border-line bg-surface-1">
        <table class="table-dense">
          <thead>
            <tr><th>Key</th><th>Value</th><th>Effect</th><th class="w-24" /></tr>
          </thead>
          <tbody>
            <tr v-for="(t, i) in taints" :key="`${t.key}:${t.effect}`">
              <td class="mono">{{ t.key }}</td>
              <td class="mono text-fg-muted">{{ t.value ?? '' }}</td>
              <td><span class="chip" :class="t.effect === 'NoExecute' ? 'bg-bad/15 text-bad' : t.effect === 'NoSchedule' ? 'bg-warn/15 text-warn' : ''">{{ t.effect }}</span></td>
              <td class="text-right">
                <button class="btn btn-sm btn-ghost text-bad" :disabled="allowed !== true" :aria-label="`Remove ${t.key}`" @click="removeTaint(i)"><Fa :icon="faTrash" /></button>
              </td>
            </tr>
            <tr v-if="!taints.length"><td colspan="4" class="h-12 text-center text-fg-subtle">No taints</td></tr>
          </tbody>
          <tfoot>
            <tr>
              <td class="p-2"><input v-model="taintKey" class="input mono" placeholder="dedicated" :disabled="allowed !== true" /></td>
              <td class="p-2"><input v-model="taintValue" class="input mono" placeholder="gpu (optional)" :disabled="allowed !== true" /></td>
              <td class="p-2">
                <select v-model="taintEffect" class="input" :disabled="allowed !== true">
                  <option>NoSchedule</option>
                  <option>PreferNoSchedule</option>
                  <option>NoExecute</option>
                </select>
              </td>
              <td class="p-2 text-right"><button class="btn btn-sm" :disabled="allowed !== true || !taintValid" @click="addTaint"><Fa :icon="faPlus" /> Add</button></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  </div>
</template>
