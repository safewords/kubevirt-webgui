<script setup lang="ts">
/** Live migrations cluster-wide, and the policies that tune them. */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { faArrowRightArrowLeft, faBan, faPlus, faPenToSquare, faTrash, faScaleBalanced, faBroom } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useInventory } from '@/plugins/core/inventory'
import { confirm, openDialog, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { dateTime, duration } from '@/util/format'
import { routeTo } from '@/util/nav'
import { useClusterWatch } from './helpers'
import YamlDialog from './YamlDialog.vue'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const inv = useInventory()
const router = useRouter()

// Durations of running migrations tick.
const now = ref(Date.now())
const timer = setInterval(() => (now.value = Date.now()), 1000)
onBeforeUnmount(() => clearInterval(timer))

const RUNNING = ['Pending', 'Scheduling', 'Scheduled', 'PreparingTarget', 'TargetReady', 'Running', 'WaitingForSync', 'Synchronizing']
const phaseOf = (m: KObject) => m.status?.phase ?? 'Pending'
const isRunning = (m: KObject) => RUNNING.includes(phaseOf(m))
const started = (m: KObject) => Date.parse(m.status?.migrationState?.startTimestamp ?? m.metadata.creationTimestamp ?? '') || 0
const ended = (m: KObject) => Date.parse(m.status?.migrationState?.endTimestamp ?? '') || 0

const migrations = computed(() => [...inv.migrations].sort((a, b) => started(b) - started(a)))
const activeCount = computed(() => migrations.value.filter(isRunning).length)
const finished = computed(() => migrations.value.filter((m) => !isRunning(m)))

const columns: Column<KObject>[] = [
  { key: 'vm', label: 'VM', value: (m) => `${m.metadata.namespace}/${m.spec?.vmiName}` },
  { key: 'phase', label: 'Phase', value: phaseOf },
  { key: 'source', label: 'Source', value: (m) => m.status?.migrationState?.sourceNode ?? '' },
  { key: 'target', label: 'Target', value: (m) => m.status?.migrationState?.targetNode ?? m.spec?.addedNodeSelector?.['kubernetes.io/hostname'] ?? '' },
  { key: 'mode', label: 'Mode', value: (m) => m.status?.migrationState?.mode ?? '' },
  { key: 'started', label: 'Started', value: started },
  { key: 'duration', label: 'Duration', align: 'right', value: (m) => (ended(m) || now.value) - started(m) },
  { key: 'policy', label: 'Policy', value: (m) => m.status?.migrationState?.migrationPolicyName ?? '' },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

function phaseClass(phase: string) {
  if (phase === 'Succeeded') return 'text-ok'
  if (phase === 'Failed') return 'text-bad'
  return 'text-info'
}

async function cancel(m: KObject) {
  const ok = await confirm({ title: 'Cancel migration', message: `Cancel the migration of ${m.metadata.namespace}/${m.spec?.vmiName}? The VM keeps running on its source node.`, confirmText: 'Cancel migration', danger: true })
  if (ok) await run('Cancel migration', () => gateway.call('vm.migrate.cancel', { namespace: m.metadata.namespace, migration: m.metadata.name }))
}

async function cleanUp() {
  const list = finished.value
  const ok = await confirm({ title: 'Remove finished migrations', message: `Delete ${list.length} finished migration record(s)? This only removes history; VMs are not affected.`, confirmText: 'Remove', danger: true })
  if (!ok) return
  await run('Remove finished migrations', async () => {
    for (const m of list) await k8s.delete({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstancemigrations', namespace: m.metadata.namespace, name: m.metadata.name })
  })
}

// --- policies ----------------------------------------------------------------
const policyVersion = computed(() => cluster.versionFor('migrations.kubevirt.io', 'migrationpolicies'))
const policies = useClusterWatch(() => policyVersion.value, 'migrations.kubevirt.io', 'migrationpolicies')
const canCreatePolicy = computed(() => can({ verb: 'create', group: 'migrations.kubevirt.io', resource: 'migrationpolicies' }))

function selectors(p: KObject): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(p.spec?.selectors?.namespaceSelector ?? {})) parts.push(`ns ${k}=${v}`)
  for (const [k, v] of Object.entries(p.spec?.selectors?.virtualMachineInstanceSelector ?? {})) parts.push(`vm ${k}=${v}`)
  return parts.join(', ')
}

const policyColumns: Column<KObject>[] = [
  { key: 'name', label: 'Policy', value: (p) => p.metadata.name },
  { key: 'selectors', label: 'Applies to', value: selectors },
  { key: 'bandwidth', label: 'Bandwidth', value: (p) => p.spec?.bandwidthPerMigration ?? '' },
  { key: 'timeout', label: 'Timeout / GiB', align: 'right', value: (p) => p.spec?.completionTimeoutPerGiB ?? '' },
  { key: 'postcopy', label: 'Post-copy', value: (p) => (p.spec?.allowPostCopy === undefined ? '' : p.spec.allowPostCopy ? 'yes' : 'no') },
  { key: 'converge', label: 'Auto-converge', value: (p) => (p.spec?.allowAutoConverge === undefined ? '' : p.spec.allowAutoConverge ? 'yes' : 'no') },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

function createPolicy() {
  openDialog(YamlDialog, {
    title: 'Create migration policy',
    mode: 'create',
    resourceRef: { apiVersion: policyVersion.value!, resource: 'migrationpolicies' },
    object: {
      apiVersion: policyVersion.value,
      kind: 'MigrationPolicy',
      metadata: { name: 'large-memory-vms' },
      spec: {
        allowAutoConverge: true,
        allowPostCopy: false,
        bandwidthPerMigration: '1Gi',
        completionTimeoutPerGiB: 300,
        selectors: {
          namespaceSelector: { 'kubernetes.io/metadata.name': 'default' },
          virtualMachineInstanceSelector: { workload: 'database' },
        },
      },
    },
  })
}

function editPolicy(p: KObject) {
  openDialog(YamlDialog, { title: `Migration policy ${p.metadata.name}`, mode: 'edit', object: p, resourceRef: { apiVersion: policyVersion.value!, resource: 'migrationpolicies' } })
}

async function deletePolicy(p: KObject) {
  const ok = await confirm({ title: 'Delete migration policy', message: `Delete ${p.metadata.name}? Future migrations of the VMs it selects use the cluster defaults.`, confirmText: 'Delete', danger: true })
  if (ok) await run(`Delete ${p.metadata.name}`, () => k8s.delete({ apiVersion: policyVersion.value!, resource: 'migrationpolicies', name: p.metadata.name }))
}
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title flex items-center gap-2"><Fa :icon="faArrowRightArrowLeft" class="text-fg-muted" /> Migrations</h3>
        <span class="chip" :class="activeCount ? 'bg-info/15 text-info' : ''">{{ activeCount }} in progress</span>
        <button class="btn btn-sm ml-auto" :disabled="!finished.length" @click="cleanUp"><Fa :icon="faBroom" /> Remove finished</button>
      </div>
      <DataTable
        :columns="columns"
        :rows="migrations"
        :row-key="(m) => m.metadata.uid"
        filterable
        empty-text="No migrations recorded. Migrations appear here while their records exist."
        @activate="(m) => router.push(routeTo({ kind: 'vm', name: m.spec?.vmiName, namespace: m.metadata.namespace }))"
      >
        <template #cell-vm="{ row }">
          <RouterLink class="hover:text-accent" :to="routeTo({ kind: 'vm', name: row.spec?.vmiName, namespace: row.metadata.namespace })">
            <span class="text-fg-muted">{{ row.metadata.namespace }}/</span>{{ row.spec?.vmiName }}
          </RouterLink>
        </template>
        <template #cell-phase="{ row, value }">
          <span :class="phaseClass(value as string)" :title="row.status?.migrationState?.failureReason">{{ value }}</span>
          <span v-if="row.status?.migrationState?.failureReason" class="ml-1.5 text-xs text-fg-muted">{{ row.status.migrationState.failureReason }}</span>
        </template>
        <template #cell-started="{ value }">{{ (value as number) ? dateTime(value as number) : '—' }}</template>
        <template #cell-duration="{ value }">{{ duration(Math.max(0, value as number)) }}</template>
        <template #cell-actions="{ row }">
          <button v-if="isRunning(row)" class="btn btn-sm btn-danger" @click.stop="cancel(row)"><Fa :icon="faBan" /> Cancel</button>
        </template>
      </DataTable>
    </section>

    <section v-if="policyVersion">
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title flex items-center gap-2"><Fa :icon="faScaleBalanced" class="text-fg-muted" /> Migration policies</h3>
        <button class="btn btn-sm ml-auto" :disabled="canCreatePolicy !== true" @click="createPolicy"><Fa :icon="faPlus" /> Create</button>
      </div>
      <p class="mb-2 text-fg-muted">Policies override the cluster's live-migration settings for the VMs and namespaces they select.</p>
      <Notice v-if="policies.error.value" kind="warning" class="mb-2">{{ policies.error.value.message }}</Notice>
      <DataTable :columns="policyColumns" :rows="policies.items.value" :row-key="(p) => p.metadata.uid" empty-text="No migration policies" @activate="editPolicy">
        <template #cell-selectors="{ value }"><span class="mono text-fg-muted">{{ value || 'everything' }}</span></template>
        <template #cell-actions="{ row }">
          <span class="flex justify-end gap-1">
            <button class="btn btn-sm" @click.stop="editPolicy(row)"><Fa :icon="faPenToSquare" /> Edit</button>
            <button class="btn btn-sm btn-danger" @click.stop="deletePolicy(row)"><Fa :icon="faTrash" /></button>
          </span>
        </template>
      </DataTable>
    </section>
  </div>
</template>
