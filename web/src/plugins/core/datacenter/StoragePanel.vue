<script setup lang="ts">
/** Storage: classes, CDI storage profiles, snapshot classes. */
import { computed } from 'vue'
import { faStar, faDatabase, faLayerGroup, faCamera } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useCluster } from '@/stores/cluster'
import { useInventory } from '@/plugins/core/inventory'
import { openDialog } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { bytes, quantity, age } from '@/util/format'
import { useClusterWatch, DEFAULT_CLASS_ANNOTATION, DEFAULT_VIRT_CLASS_ANNOTATION } from './helpers'
import YamlDialog from './YamlDialog.vue'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const inv = useInventory()

const classes = useClusterWatch(() => (cluster.has('storage.k8s.io/v1/storageclasses') ? 'storage.k8s.io/v1' : null), 'storage.k8s.io', 'storageclasses')
const profiles = useClusterWatch(() => cluster.versionFor('cdi.kubevirt.io', 'storageprofiles'), 'cdi.kubevirt.io', 'storageprofiles')
const snapshotClasses = useClusterWatch(() => cluster.versionFor('snapshot.storage.k8s.io', 'volumesnapshotclasses'), 'snapshot.storage.k8s.io', 'volumesnapshotclasses')

const usage = computed(() => {
  const map = new Map<string, { claims: number; bytes: number }>()
  for (const pvc of inv.pvcs) {
    const name = pvc.spec?.storageClassName ?? ''
    const entry = map.get(name) ?? { claims: 0, bytes: 0 }
    entry.claims++
    entry.bytes += quantity(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage)
    map.set(name, entry)
  }
  return map
})

const isDefault = (c: KObject) => c.metadata.annotations?.[DEFAULT_CLASS_ANNOTATION] === 'true'
const isVirtDefault = (c: KObject) => c.metadata.annotations?.[DEFAULT_VIRT_CLASS_ANNOTATION] === 'true'

const classColumns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (c) => c.metadata.name },
  { key: 'default', label: 'Default', value: (c) => (isVirtDefault(c) ? 'VMs' : isDefault(c) ? 'yes' : '') },
  { key: 'provisioner', label: 'Provisioner', value: (c) => c.provisioner },
  { key: 'binding', label: 'Binding', value: (c) => c.volumeBindingMode ?? 'Immediate' },
  { key: 'reclaim', label: 'Reclaim', value: (c) => c.reclaimPolicy ?? 'Delete' },
  { key: 'expansion', label: 'Expandable', value: (c) => (c.allowVolumeExpansion ? 'yes' : 'no') },
  { key: 'claims', label: 'Claims', align: 'right', value: (c) => usage.value.get(c.metadata.name)?.claims ?? 0 },
  { key: 'used', label: 'Provisioned', align: 'right', value: (c) => usage.value.get(c.metadata.name)?.bytes ?? 0 },
  { key: 'age', label: 'Age', value: (c) => age(c.metadata.creationTimestamp) },
]

function claimSets(p: KObject): string {
  return (p.status?.claimPropertySets ?? []).map((s: any) => `${s.volumeMode ?? 'Filesystem'}/${(s.accessModes ?? []).join('+')}`).join(', ')
}

const profileColumns: Column<KObject>[] = [
  { key: 'name', label: 'Storage profile', value: (p) => p.metadata.name },
  { key: 'provisioner', label: 'Provisioner', value: (p) => p.status?.provisioner },
  { key: 'sets', label: 'Volume modes / access modes', value: claimSets },
  { key: 'clone', label: 'Clone strategy', value: (p) => p.status?.cloneStrategy ?? p.spec?.cloneStrategy ?? 'default' },
  { key: 'source', label: 'Data import cron source', value: (p) => p.status?.dataImportCronSourceFormat ?? '' },
  { key: 'snapshotClass', label: 'Snapshot class', value: (p) => p.status?.snapshotClass ?? '' },
]

const snapshotColumns: Column<KObject>[] = [
  { key: 'name', label: 'Snapshot class', value: (c) => c.metadata.name },
  { key: 'driver', label: 'Driver', value: (c) => c.driver },
  { key: 'deletion', label: 'Deletion policy', value: (c) => c.deletionPolicy },
  { key: 'default', label: 'Default', value: (c) => (c.metadata.annotations?.['snapshot.storage.kubernetes.io/is-default-class'] === 'true' ? 'yes' : '') },
]

function show(object: KObject, kind: string) {
  openDialog(YamlDialog, { title: `${kind} ${object.metadata.name}`, mode: 'view', object })
}
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faDatabase" class="text-fg-muted" /> Storage classes</h3>
      <Notice v-if="classes.error.value" kind="warning" class="mb-2">{{ classes.error.value.message }}</Notice>
      <DataTable :columns="classColumns" :rows="classes.items.value" :row-key="(c) => c.metadata.uid" filterable :default-sort="{ key: 'name', dir: 'asc' }" empty-text="No storage classes visible" @activate="(c) => show(c, 'StorageClass')">
        <template #cell-name="{ row }">
          <span class="font-medium">{{ row.metadata.name }}</span>
          <Fa v-if="isDefault(row) || isVirtDefault(row)" :icon="faStar" class="ml-1.5 text-accent" :title="isVirtDefault(row) ? 'Default for virtual machines' : 'Cluster default'" />
        </template>
        <template #cell-expansion="{ value }"><span :class="value === 'yes' ? 'text-ok' : 'text-fg-subtle'">{{ value }}</span></template>
        <template #cell-provisioner="{ value }"><span class="mono">{{ value }}</span></template>
        <template #cell-used="{ value }">{{ bytes(value as number) }}</template>
      </DataTable>
      <p class="mt-1.5 text-xs text-fg-subtle">Claims and capacity count the disks you can see. Double-click a row for its definition.</p>
    </section>

    <section v-if="cluster.has('cdi.kubevirt.io')">
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faLayerGroup" class="text-fg-muted" /> CDI storage profiles</h3>
      <p class="mb-2 text-fg-muted">How the Containerized Data Importer provisions disks on each class: the volume and access modes it picks, and how it clones.</p>
      <Notice v-if="profiles.error.value" kind="warning" class="mb-2">{{ profiles.error.value.message }}</Notice>
      <DataTable :columns="profileColumns" :rows="profiles.items.value" :row-key="(p) => p.metadata.uid" :default-sort="{ key: 'name', dir: 'asc' }" empty-text="No storage profiles" @activate="(p) => show(p, 'StorageProfile')">
        <template #cell-sets="{ row }">
          <span v-for="(s, i) in row.status?.claimPropertySets ?? []" :key="i" class="chip mr-1">{{ s.volumeMode ?? 'Filesystem' }} · {{ (s.accessModes ?? []).join(', ') }}</span>
          <span v-if="!(row.status?.claimPropertySets ?? []).length" class="text-warn">not configured</span>
        </template>
      </DataTable>
    </section>

    <section v-if="cluster.has('snapshot.storage.k8s.io')">
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faCamera" class="text-fg-muted" /> Volume snapshot classes</h3>
      <DataTable :columns="snapshotColumns" :rows="snapshotClasses.items.value" :row-key="(c) => c.metadata.uid" empty-text="No snapshot classes — VM snapshots need one for their disks' storage" @activate="(c) => show(c, 'VolumeSnapshotClass')" />
    </section>
    <Notice v-else kind="info" title="No CSI snapshot support">
      The cluster does not serve <code class="mono">snapshot.storage.k8s.io</code>, so VM snapshots cannot capture disk contents. Install the external-snapshotter CRDs and a VolumeSnapshotClass for your CSI driver.
    </Notice>
  </div>
</template>
