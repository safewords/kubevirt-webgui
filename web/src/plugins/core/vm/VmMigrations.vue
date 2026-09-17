<script setup lang="ts">
import { computed, ref } from 'vue'
import { faArrowRightArrowLeft, faBan } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { confirm, openDialog, run } from '@/services/dialogs'
import { dateTime, duration } from '@/util/format'
import { isTrue } from '@/util/kubevirt'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import MigrateDialog from './MigrateDialog.vue'

const props = defineProps<{ ctx: ObjectContext }>()

const migrations = useWatch(() => ({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstancemigrations', namespace: props.ctx.namespace }))
const mine = computed(() => migrations.items.value.filter((m) => m.spec?.vmiName === props.ctx.name))
const selected = ref<string | null>(null)
const current = computed(() => mine.value.find((m) => m.metadata.uid === selected.value) ?? null)

const FINAL = new Set(['Succeeded', 'Failed'])
const vmi = computed(() => props.ctx.related.vmi)
const state = computed(() => vmi.value?.status?.migrationState)
const mayMigrate = computed(() => can({ verb: 'create', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations', namespace: props.ctx.namespace }) === true)
const mayCancel = computed(() => can({ verb: 'delete', group: 'kubevirt.io', resource: 'virtualmachineinstancemigrations', namespace: props.ctx.namespace }) === true)

function started(m: KObject): number {
  return Date.parse(m.status?.migrationState?.startTimestamp ?? m.metadata.creationTimestamp ?? '') || 0
}
function ended(m: KObject): number | null {
  const end = m.status?.migrationState?.endTimestamp
  return end ? Date.parse(end) : null
}

const columns: Column<KObject>[] = [
  { key: 'started', label: 'Started', value: started },
  { key: 'phase', label: 'Phase', value: (m) => m.status?.phase ?? 'Pending' },
  { key: 'route', label: 'Source → target', value: (m) => `${m.status?.migrationState?.sourceNode ?? '?'} → ${m.status?.migrationState?.targetNode ?? '?'}` },
  { key: 'duration', label: 'Duration', align: 'right', value: (m) => (ended(m) ?? Date.now()) - started(m) },
  { key: 'mode', label: 'Mode', value: (m) => m.status?.migrationState?.mode ?? '' },
  { key: 'result', label: 'Result', value: (m) => m.status?.migrationState?.failureReason ?? (m.status?.phase === 'Succeeded' ? 'OK' : '') },
  { key: 'name', label: 'Migration', value: (m) => m.metadata.name },
]

async function cancel(m: KObject | null) {
  if (!m || FINAL.has(m.status?.phase)) return
  const ok = await confirm({ title: 'Cancel migration', message: `Cancel migration ${m.metadata.name}? The VM stays on ${m.status?.migrationState?.sourceNode ?? 'its current node'}.`, confirmText: 'Cancel migration', danger: true })
  if (ok) await run('Cancel migration', () => gateway.call('vm.migrate.cancel', { namespace: props.ctx.namespace, migration: m.metadata.name }))
}
</script>

<template>
  <div class="space-y-4 p-3">
    <Notice v-if="state && !state.completed" kind="info" title="Migration in progress">
      {{ state.sourceNode }} → {{ state.targetNode ?? 'choosing a node' }}{{ state.mode ? ` (${state.mode})` : '' }}, started {{ dateTime(state.startTimestamp) }}
    </Notice>
    <Notice v-else-if="state?.failed" kind="warning" title="The last migration failed">{{ state.failureReason ?? 'No reason reported' }}</Notice>

    <DataTable
      :columns="columns"
      :rows="mine"
      :row-key="(m) => m.metadata.uid"
      :selected="selected"
      :loading="!migrations.synced.value"
      :default-sort="{ key: 'started', dir: 'desc' }"
      empty-text="This VM has not been migrated (migration objects are cleaned up after a while)"
      @select="(m) => (selected = m.metadata.uid)"
    >
      <template #toolbar>
        <button class="btn btn-primary" :disabled="!vmi || !mayMigrate" :title="vmi && !isTrue(vmi, 'LiveMigratable') ? 'KubeVirt reports this VM is not live-migratable' : ''" @click="openDialog(MigrateDialog, { ctx })">
          <Fa :icon="faArrowRightArrowLeft" /> Migrate
        </button>
        <button class="btn" :disabled="!current || FINAL.has(current.status?.phase) || !mayCancel" @click="cancel(current)"><Fa :icon="faBan" /> Cancel</button>
      </template>
      <template #cell-started="{ row }">{{ dateTime(started(row)) }}</template>
      <template #cell-phase="{ value }">
        <span :class="value === 'Succeeded' ? 'text-ok' : value === 'Failed' ? 'text-bad' : 'text-info'">{{ value }}</span>
      </template>
      <template #cell-duration="{ value }">{{ duration(value as number) }}</template>
      <template #cell-result="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
      <template #cell-name="{ value }"><span class="mono text-fg-muted">{{ value }}</span></template>
    </DataTable>
  </div>
</template>
