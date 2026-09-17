<script setup lang="ts">
import { computed, ref } from 'vue'
import { faCamera, faClockRotateLeft, faTrash, faCircleCheck, faSpinner, faCircleXmark } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s, vmApi } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { confirm, openDialog, run } from '@/services/dialogs'
import { age, dateTime } from '@/util/format'
import { vmState } from '@/util/kubevirt'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import SnapshotDialog from './SnapshotDialog.vue'
import { SNAPSHOT_GATE_OFF, useFeatureGate } from './featureGates'

const props = defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const gate = useFeatureGate('Snapshot')

const snapshotVersion = computed(() => cluster.versionFor('snapshot.kubevirt.io', 'virtualmachinesnapshots'))
const restoreVersion = computed(() => cluster.versionFor('snapshot.kubevirt.io', 'virtualmachinerestores'))

const snapshots = useWatch(() => (snapshotVersion.value ? { apiVersion: snapshotVersion.value, resource: 'virtualmachinesnapshots', namespace: props.ctx.namespace } : null))
const restores = useWatch(() => (restoreVersion.value ? { apiVersion: restoreVersion.value, resource: 'virtualmachinerestores', namespace: props.ctx.namespace } : null))

const mine = computed(() => snapshots.items.value.filter((s) => s.spec?.source?.name === props.ctx.name && (s.spec?.source?.kind ?? 'VirtualMachine') === 'VirtualMachine'))
const myRestores = computed(() => restores.items.value.filter((r) => r.spec?.target?.name === props.ctx.name))
const selected = ref<string | null>(null)
const current = computed(() => mine.value.find((s) => s.metadata.uid === selected.value) ?? null)

const stopped = computed(() => vmState(props.ctx.object, props.ctx.related.vmi) === 'stopped')
const mayCreate = computed(() => can({ verb: 'create', group: 'snapshot.kubevirt.io', resource: 'virtualmachinesnapshots', namespace: props.ctx.namespace }) === true)
const mayRestore = computed(() => can({ verb: 'create', group: 'snapshot.kubevirt.io', resource: 'virtualmachinerestores', namespace: props.ctx.namespace }) === true)
const mayDelete = computed(() => can({ verb: 'delete', group: 'snapshot.kubevirt.io', resource: 'virtualmachinesnapshots', namespace: props.ctx.namespace }) === true)

function status(s: KObject): 'ready' | 'progress' | 'failed' {
  if (s.status?.readyToUse) return 'ready'
  if (s.status?.phase === 'Failed' || s.status?.error) return 'failed'
  return 'progress'
}

const columns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (s) => s.metadata.name },
  { key: 'created', label: 'Date/Status', value: (s) => Date.parse(s.status?.creationTime ?? s.metadata.creationTimestamp ?? '') || 0 },
  { key: 'state', label: 'State', value: (s) => status(s) },
  { key: 'indications', label: 'Consistency', value: (s) => (s.status?.indications ?? []).join(', ') },
  { key: 'volumes', label: 'Disks', value: (s) => (s.status?.snapshotVolumes?.includedVolumes ?? []).length },
  { key: 'description', label: 'Description', value: (s) => s.metadata.annotations?.['kubevirt-webgui/description'] ?? '' },
]

const restoreColumns: Column<KObject>[] = [
  { key: 'name', label: 'Restore', value: (r) => r.metadata.name },
  { key: 'snapshot', label: 'From snapshot', value: (r) => r.spec?.virtualMachineSnapshotName },
  { key: 'time', label: 'Restored', value: (r) => Date.parse(r.status?.restoreTime ?? r.metadata.creationTimestamp ?? '') || 0 },
  { key: 'complete', label: 'Status', value: (r) => (r.status?.complete ? 'complete' : 'in progress') },
]

async function rollback(snapshot: KObject | null) {
  if (!snapshot) return
  if (!stopped.value) {
    await confirm({ title: 'Rollback', message: 'Stop the VM before rolling back to a snapshot.', confirmText: 'OK' })
    return
  }
  const ok = await confirm({
    title: 'Rollback',
    message: `Roll ${props.ctx.name} back to ${snapshot.metadata.name}?\nEverything written since the snapshot was taken is lost.`,
    confirmText: 'Rollback',
    danger: true,
  })
  if (ok) await run(`Rollback ${props.ctx.name}`, () => vmApi.restore(props.ctx.namespace!, props.ctx.name, snapshot.metadata.name, restoreVersion.value ?? undefined), { openLog: true })
}

async function remove(snapshot: KObject | null) {
  if (!snapshot) return
  const ok = await confirm({ title: 'Remove snapshot', message: `Remove snapshot ${snapshot.metadata.name} and the volume snapshots it holds?`, confirmText: 'Remove', danger: true })
  if (ok) {
    await run(`Remove snapshot ${snapshot.metadata.name}`, () =>
      k8s.delete({ apiVersion: snapshotVersion.value!, resource: 'virtualmachinesnapshots', namespace: props.ctx.namespace, name: snapshot.metadata.name }),
    )
    selected.value = null
  }
}
</script>

<template>
  <div class="space-y-4 p-3">
    <Notice v-if="gate === false" kind="error" title="Snapshots are switched off">{{ SNAPSHOT_GATE_OFF }}</Notice>
    <Notice v-if="!cluster.has('snapshot.storage.k8s.io')" kind="warning" title="Disk snapshots are unavailable">
      The cluster does not serve the CSI snapshot API (snapshot.storage.k8s.io). Install the snapshot controller and a VolumeSnapshotClass for your storage to snapshot disks.
    </Notice>
    <section>
      <DataTable
        :columns="columns"
        :rows="mine"
        :row-key="(s) => s.metadata.uid"
        :selected="selected"
        :loading="!snapshots.synced.value"
        :default-sort="{ key: 'created', dir: 'desc' }"
        empty-text="No snapshots. Take one before risky changes."
        @select="(s) => (selected = s.metadata.uid)"
        @activate="rollback"
      >
        <template #toolbar>
          <button class="btn btn-primary" :disabled="!ctx.object || !mayCreate || gate === false" @click="openDialog(SnapshotDialog, { ctx })"><Fa :icon="faCamera" /> Take snapshot</button>
          <button class="btn" :disabled="!current || status(current) !== 'ready' || !mayRestore || gate === false" :title="stopped ? '' : 'Stop the VM first'" @click="rollback(current)">
            <Fa :icon="faClockRotateLeft" /> Rollback
          </button>
          <button class="btn" :disabled="!current || !mayDelete" @click="remove(current)"><Fa :icon="faTrash" /> Remove</button>
        </template>
        <template #cell-created="{ row }">
          <span :title="dateTime(row.status?.creationTime ?? row.metadata.creationTimestamp)">{{ dateTime(row.status?.creationTime ?? row.metadata.creationTimestamp) }}</span>
          <span class="ml-1 text-fg-subtle">({{ age(row.status?.creationTime ?? row.metadata.creationTimestamp) }} ago)</span>
        </template>
        <template #cell-state="{ row }">
          <span v-if="status(row) === 'ready'" class="text-ok"><Fa :icon="faCircleCheck" /> ready</span>
          <span v-else-if="status(row) === 'failed'" class="text-bad" :title="row.status?.error?.message"><Fa :icon="faCircleXmark" /> {{ row.status?.error?.message ? 'failed' : row.status?.phase }}</span>
          <span v-else class="text-info"><Fa :icon="faSpinner" spin /> {{ row.status?.phase ?? 'pending' }}</span>
        </template>
        <template #cell-description="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
      </DataTable>
    </section>
    <section v-if="myRestores.length">
      <h3 class="panel-title mb-2">Rollback history</h3>
      <DataTable :columns="restoreColumns" :rows="myRestores" :row-key="(r) => r.metadata.uid" :default-sort="{ key: 'time', dir: 'desc' }">
        <template #cell-time="{ row }">{{ dateTime(row.status?.restoreTime ?? row.metadata.creationTimestamp) }}</template>
        <template #cell-complete="{ value }"><span :class="value === 'complete' ? 'text-ok' : 'text-info'">{{ value }}</span></template>
      </DataTable>
    </section>
  </div>
</template>
