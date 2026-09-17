<script setup lang="ts">
/** CSI VolumeSnapshots of one disk: take, restore into a new disk, delete. */
import { computed, ref } from 'vue'
import { faCamera, faTrash, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { useCluster } from '@/stores/cluster'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { confirm, openTaskLog, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age, bytes, dateTime, isDnsLabel, quantity, randomSuffix, toDnsLabel } from '@/util/format'
import { sizeOf, toQuantity } from './helpers'

const props = defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const apiVersion = computed(() => cluster.versionFor('snapshot.storage.k8s.io', 'volumesnapshots'))
const snapshots = useWatch(() => (apiVersion.value ? { apiVersion: apiVersion.value, resource: 'volumesnapshots', namespace: props.ctx.namespace } : null))
const classes = useWatch(() => {
  const v = cluster.versionFor('snapshot.storage.k8s.io', 'volumesnapshotclasses')
  return v ? { apiVersion: v, resource: 'volumesnapshotclasses' } : null
})

const mine = computed(() => snapshots.items.value.filter((s) => s.spec?.source?.persistentVolumeClaimName === props.ctx.name))

const name = ref(toDnsLabel(`${props.ctx.name}-snap-${randomSuffix(4)}`))
const snapshotClass = ref('')

const canCreate = computed(() => can({ verb: 'create', group: 'snapshot.storage.k8s.io', resource: 'volumesnapshots', namespace: props.ctx.namespace }) === true)
const canDelete = computed(() => can({ verb: 'delete', group: 'snapshot.storage.k8s.io', resource: 'volumesnapshots', namespace: props.ctx.namespace }) === true)

const columns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (s) => s.metadata.name },
  { key: 'ready', label: 'Ready', value: (s) => (s.status?.readyToUse ? 'yes' : s.status?.error ? 'error' : 'no') },
  { key: 'size', label: 'Restore size', align: 'right', value: (s) => quantity(s.status?.restoreSize) },
  { key: 'class', label: 'Class', value: (s) => s.spec?.volumeSnapshotClassName ?? 'default' },
  { key: 'created', label: 'Taken', value: (s) => s.status?.creationTime ?? s.metadata.creationTimestamp },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

async function take() {
  const ok = await confirm({
    title: 'Take snapshot',
    message: `Snapshot ${props.ctx.name} as ${name.value}? For a consistent copy of a running guest, freeze its filesystems first or use a VM snapshot, which does that through the guest agent.`,
    confirmText: 'Take snapshot',
  })
  if (!ok || !apiVersion.value) return
  await run('Take snapshot', () =>
    k8s.create({ apiVersion: apiVersion.value!, resource: 'volumesnapshots', namespace: props.ctx.namespace }, {
      apiVersion: apiVersion.value,
      kind: 'VolumeSnapshot',
      metadata: { name: name.value, namespace: props.ctx.namespace },
      spec: {
        source: { persistentVolumeClaimName: props.ctx.name },
        ...(snapshotClass.value ? { volumeSnapshotClassName: snapshotClass.value } : {}),
      },
    }),
  )
  name.value = toDnsLabel(`${props.ctx.name}-snap-${randomSuffix(4)}`)
}

async function restore(snapshot: KObject) {
  const target = toDnsLabel(`${props.ctx.name}-from-${snapshot.metadata.name}`).slice(0, 63).replace(/-+$/, '')
  const ok = await confirm({
    title: 'Restore to a new disk',
    message: `Create the disk ${target} from snapshot ${snapshot.metadata.name}? The original disk is left untouched.`,
    confirmText: 'Restore',
  })
  if (!ok) return
  const size = Math.max(quantity(snapshot.status?.restoreSize), sizeOf(props.ctx.object))
  const result = await run('Restore snapshot', () =>
    gateway.call<{ task: string }>('datavolume.create', {
      body: {
        apiVersion: 'cdi.kubevirt.io/v1beta1',
        kind: 'DataVolume',
        metadata: { name: target, namespace: props.ctx.namespace },
        spec: {
          source: { snapshot: { namespace: props.ctx.namespace, name: snapshot.metadata.name } },
          storage: {
            resources: { requests: { storage: toQuantity(size) } },
            ...(props.ctx.object?.spec?.storageClassName ? { storageClassName: props.ctx.object.spec.storageClassName } : {}),
            ...(props.ctx.object?.spec?.volumeMode ? { volumeMode: props.ctx.object.spec.volumeMode } : {}),
          },
        },
      },
    }),
    { quiet: true },
  )
  if (result?.task) openTaskLog(result.task)
}

async function remove(snapshot: KObject) {
  const ok = await confirm({ title: 'Delete snapshot', message: `Delete snapshot ${snapshot.metadata.name}?`, confirmText: 'Delete', danger: true })
  if (ok && apiVersion.value) await run('Delete snapshot', () => k8s.delete({ apiVersion: apiVersion.value!, resource: 'volumesnapshots', namespace: props.ctx.namespace, name: snapshot.metadata.name }))
}
</script>

<template>
  <div class="space-y-3 p-3">
    <div class="card p-3">
      <div class="grid items-end gap-2 sm:grid-cols-[1fr_220px_auto]">
        <div>
          <label class="label">Snapshot name</label>
          <input v-model="name" class="input mono" />
        </div>
        <div>
          <label class="label">Snapshot class</label>
          <select v-model="snapshotClass" class="input">
            <option value="">default</option>
            <option v-for="c in classes.items.value" :key="c.metadata.uid" :value="c.metadata.name">{{ c.metadata.name }} ({{ c.driver }})</option>
          </select>
        </div>
        <button class="btn btn-primary" :disabled="!canCreate || !isDnsLabel(name)" @click="take"><Fa :icon="faCamera" /> Take snapshot</button>
      </div>
    </div>
    <Notice v-if="snapshots.error.value" kind="warning">{{ snapshots.error.value.message }}</Notice>
    <DataTable v-else :columns="columns" :rows="mine" :row-key="(s) => s.metadata.uid" :loading="!snapshots.synced.value" empty-text="No snapshots of this disk">
      <template #cell-ready="{ row, value }">
        <span :class="value === 'yes' ? 'text-ok' : value === 'error' ? 'text-bad' : 'text-warn'" :title="row.status?.error?.message">{{ value }}</span>
      </template>
      <template #cell-size="{ value }">{{ (value as number) ? bytes(value as number) : '—' }}</template>
      <template #cell-created="{ value }"><span :title="dateTime(value as string)">{{ age(value as string) }} ago</span></template>
      <template #cell-actions="{ row }">
        <span class="flex justify-end gap-1.5">
          <button class="btn btn-sm" :disabled="!row.status?.readyToUse" @click.stop="restore(row)"><Fa :icon="faClockRotateLeft" /> Restore to new disk</button>
          <button class="btn btn-sm btn-danger" :disabled="!canDelete" @click.stop="remove(row)"><Fa :icon="faTrash" /></button>
        </span>
      </template>
    </DataTable>
  </div>
</template>
