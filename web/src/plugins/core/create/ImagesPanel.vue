<script setup lang="ts">
/**
 * Datacenter → Images: Proxmox's "ISO Images" and templates, stored the
 * Kubernetes way — each image is a DataVolume (a PVC CDI filled), labelled
 * for the library, that new VMs clone from.
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { faCompactDisc, faHardDrive, faCloudArrowDown, faUpload, faTrash, faDesktop, faXmark, faBoxArchive, faFolderPlus, faCircleInfo } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { confirm, openDialog, run } from '@/services/dialogs'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useInventory } from '@/plugins/core/inventory'
import { useMultiWatch } from '@/stores/watch'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age, bytes, duration } from '@/util/format'
import { routeTo } from '@/util/nav'
import { IMAGE_FILE_ANNOTATION, IMAGE_SOURCE_ANNOTATION, IMAGE_TYPE_LABEL, imageGib, imageNamespace, progressOf, useDataSources, useImages, useScoped } from './helpers'
import { cancelUpload, dismissUpload, uploads } from './uploads'
import CreateDiskDialog from './CreateDiskDialog.vue'
import CreateVmWizard from './CreateVmWizard.vue'

defineProps<{ ctx: ObjectContext }>()
const router = useRouter()
const cluster = useCluster()
const inv = useInventory()
const { images, synced, error } = useImages()
const { sources: dataSources } = useDataSources()

const cronScope = useScoped('cdi.kubevirt.io', 'dataimportcrons')
const crons = useMultiWatch(
  () => {
    const version = cluster.versionFor('cdi.kubevirt.io', 'dataimportcrons')
    return version && cronScope.value !== undefined ? { apiVersion: version, resource: 'dataimportcrons' } : null
  },
  () => (cronScope.value === undefined ? [] : cronScope.value),
)

const namespaceExists = computed(() => !cluster.canListNamespaces || cluster.namespaceNames.includes(imageNamespace.value))
const mayCreateNamespace = computed(() => can({ verb: 'create', resource: 'namespaces' }) === true)

function sourceOf(dv: KObject): string {
  const s = dv.spec?.source ?? {}
  if (s.http?.url) return s.http.url
  if (s.registry?.url) return s.registry.url
  if (s.upload) return `upload${dv.metadata.annotations?.[IMAGE_FILE_ANNOTATION] ? `: ${dv.metadata.annotations[IMAGE_FILE_ANNOTATION]}` : ''}`
  if (s.pvc) return `clone of ${s.pvc.namespace}/${s.pvc.name}`
  if (dv.spec?.sourceRef) return `DataSource ${dv.spec.sourceRef.namespace ?? ''}/${dv.spec.sourceRef.name}`
  return dv.metadata.annotations?.[IMAGE_SOURCE_ANNOTATION] ?? '—'
}

const columns: Column<KObject>[] = [
  { key: 'type', label: 'Content', width: '90px', value: (d) => (d.metadata.labels?.[IMAGE_TYPE_LABEL] === 'iso' ? 'ISO' : 'Disk') },
  { key: 'name', label: 'Name', value: (d) => d.metadata.name },
  { key: 'namespace', label: 'Namespace', value: (d) => d.metadata.namespace },
  { key: 'size', label: 'Size', align: 'right', value: (d) => imageGib(d) },
  { key: 'status', label: 'Status', width: '220px', value: (d) => d.status?.phase ?? 'Pending' },
  { key: 'source', label: 'Source', value: sourceOf, class: 'max-w-[320px] truncate' },
  { key: 'class', label: 'Storage', value: (d) => d.spec?.storage?.storageClassName ?? d.spec?.pvc?.storageClassName ?? 'default' },
  { key: 'age', label: 'Age', value: (d) => age(d.metadata.creationTimestamp) },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

const cronColumns: Column<KObject>[] = [
  { key: 'name', label: 'Golden image', value: (c) => `${c.metadata.namespace}/${c.spec?.managedDataSource ?? c.metadata.name}` },
  { key: 'source', label: 'Source', value: (c) => c.spec?.template?.spec?.source?.registry?.url ?? c.spec?.template?.spec?.source?.http?.url ?? '—', class: 'max-w-[360px] truncate' },
  { key: 'schedule', label: 'Schedule', value: (c) => c.spec?.schedule },
  { key: 'keep', label: 'Keep', align: 'right', value: (c) => c.spec?.importsToKeep ?? 3 },
  { key: 'last', label: 'Last import', value: (c) => (c.status?.lastImportTimestamp ? `${age(c.status.lastImportTimestamp)} ago` : '—') },
  { key: 'up', label: 'Up to date', value: (c) => (c.status?.conditions ?? []).find((x: any) => x.type === 'UpToDate')?.status ?? '—' },
]

const sourceColumns: Column<KObject>[] = [
  { key: 'name', label: 'DataSource', value: (d) => `${d.metadata.namespace}/${d.metadata.name}` },
  { key: 'points', label: 'Points to', value: (d) => (d.spec?.source?.pvc ? `PVC ${d.spec.source.pvc.namespace}/${d.spec.source.pvc.name}` : d.spec?.source?.snapshot ? `snapshot ${d.spec.source.snapshot.namespace}/${d.spec.source.snapshot.name}` : '—') },
  { key: 'ready', label: 'Ready', value: (d) => (d.status?.conditions ?? []).find((x: any) => x.type === 'Ready')?.status ?? '—' },
  { key: 'actions', label: '', sortable: false, value: () => '' },
]

function download() {
  openDialog(CreateDiskDialog, { source: 'http', imageType: null, namespace: imageNamespace.value })
}
function upload() {
  openDialog(CreateDiskDialog, { source: 'upload', imageType: null, namespace: imageNamespace.value })
}

async function createNamespace() {
  await run(`Create namespace ${imageNamespace.value}`, () => k8s.create({ apiVersion: 'v1', resource: 'namespaces' }, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: imageNamespace.value, labels: { 'kubevirt-webgui/purpose': 'images' } } }))
  await cluster.reloadNamespaces()
}

function vmFrom(dv: KObject) {
  const iso = dv.metadata.labels?.[IMAGE_TYPE_LABEL] === 'iso'
  const ref = { namespace: dv.metadata.namespace!, name: dv.metadata.name, sizeGib: imageGib(dv) }
  openDialog(CreateVmWizard, { preset: iso ? { source: 'iso', iso: ref } : { source: 'clone', clone: { kind: 'pvc', ...ref } } })
}

function vmFromDataSource(ds: KObject) {
  openDialog(CreateVmWizard, { preset: { source: 'clone', clone: { kind: 'datasource', namespace: ds.metadata.namespace!, name: ds.metadata.name, sizeGib: 10 } } })
}

async function remove(dv: KObject) {
  const users = inv.vms.filter((vm) =>
    (vm.spec?.dataVolumeTemplates ?? []).some((t: any) => t.spec?.source?.pvc?.name === dv.metadata.name && t.spec?.source?.pvc?.namespace === dv.metadata.namespace),
  )
  const ok = await confirm({
    title: `Remove image ${dv.metadata.name}`,
    message: `Delete ${dv.metadata.namespace}/${dv.metadata.name} and its data?${users.length ? `\n\nVMs created from it keep their own copies: ${users.map((u) => u.metadata.name).join(', ')}.` : ''}`,
    confirmText: 'Remove',
    danger: true,
    typeToConfirm: dv.metadata.name,
  })
  if (!ok) return
  await run(`Remove image ${dv.metadata.name}`, async () => {
    await k8s.delete({ apiVersion: dv.apiVersion ?? 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', namespace: dv.metadata.namespace, name: dv.metadata.name })
    try {
      await k8s.delete({ apiVersion: 'v1', resource: 'persistentvolumeclaims', namespace: dv.metadata.namespace, name: dv.metadata.name })
    } catch (e: any) {
      if (e?.status !== 404) throw e
    }
  })
}

function openDisk(dv: KObject) {
  router.push(routeTo({ kind: 'disk', name: dv.metadata.name, namespace: dv.metadata.namespace }))
}

const jobs = computed(() => uploads.jobs)
</script>

<template>
  <div class="space-y-4 p-3">
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn btn-primary" @click="download"><Fa :icon="faCloudArrowDown" /> Download from URL</button>
      <button class="btn" @click="upload"><Fa :icon="faUpload" /> Upload</button>
      <div class="ml-auto flex items-center gap-2">
        <label class="text-fg-muted" for="kve-image-ns">Library namespace</label>
        <input id="kve-image-ns" v-model.trim="imageNamespace" class="input w-48" list="kve-image-ns-list" spellcheck="false" />
        <datalist id="kve-image-ns-list"><option v-for="ns in inv.reachableNamespaces" :key="ns" :value="ns" /></datalist>
        <button v-if="!namespaceExists && mayCreateNamespace" class="btn" @click="createNamespace"><Fa :icon="faFolderPlus" /> Create it</button>
      </div>
    </div>

    <Notice v-if="!namespaceExists" kind="warning">The namespace “{{ imageNamespace }}” does not exist yet.{{ mayCreateNamespace ? ' Create it to start the library.' : ' Ask an administrator to create it, or pick one you can write to.' }}</Notice>

    <section v-if="jobs.length" class="card">
      <div class="card-header"><Fa :icon="faUpload" class="text-fg-muted" /> Uploads from this browser</div>
      <div class="divide-y divide-line">
        <div v-for="job in jobs" :key="job.id" class="flex items-center gap-3 px-3 py-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline gap-2">
              <span class="truncate font-medium">{{ job.fileName }}</span>
              <span class="text-xs text-fg-subtle">→ {{ job.namespace }}/{{ job.name }}</span>
              <span class="ml-auto text-xs tabular-nums text-fg-muted">
                {{ bytes(job.sent) }} / {{ bytes(job.total) }}
                <template v-if="job.status === 'uploading' && job.rate > 0"> · {{ bytes(job.rate) }}/s · {{ duration(((job.total - job.sent) / job.rate) * 1000) }} left</template>
              </span>
            </div>
            <div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div
                class="h-full rounded-full transition-[width] duration-300"
                :class="job.status === 'error' || job.status === 'cancelled' ? 'bg-bad' : job.status === 'done' ? 'bg-ok' : 'bg-accent'"
                :style="{ width: `${job.total ? (job.sent / job.total) * 100 : 0}%` }"
              />
            </div>
            <div class="mt-0.5 text-xs" :class="job.status === 'error' ? 'text-bad' : 'text-fg-subtle'">
              {{ { starting: 'Starting…', preparing: 'Waiting for CDI to prepare the disk…', uploading: 'Uploading', processing: 'Received; CDI is writing the image…', done: 'Done', error: job.error, cancelled: 'Cancelled' }[job.status] }}
            </div>
          </div>
          <button v-if="['starting', 'preparing', 'uploading'].includes(job.status)" class="btn btn-sm btn-danger" @click="cancelUpload(job)"><Fa :icon="faXmark" /> Cancel</button>
          <button v-else-if="job.status !== 'processing'" class="btn btn-sm btn-ghost" title="Dismiss" @click="dismissUpload(job)"><Fa :icon="faXmark" /></button>
        </div>
      </div>
    </section>

    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faCompactDisc" class="text-fg-muted" /> ISO images and disk templates</h3>
      <Notice v-if="error" kind="error" class="mb-2">{{ error.message }}</Notice>
      <DataTable
        :columns="columns"
        :rows="images"
        :row-key="(d) => d.metadata.uid"
        :loading="!synced"
        filterable
        empty-text="No images yet — download one from a URL or upload one."
        :default-sort="{ key: 'name', dir: 'asc' }"
        @activate="openDisk"
      >
        <template #cell-type="{ row }">
          <span class="chip" :class="row.metadata.labels?.[IMAGE_TYPE_LABEL] === 'iso' ? 'bg-info/15 text-info' : 'bg-accent-soft text-accent'">
            <Fa :icon="row.metadata.labels?.[IMAGE_TYPE_LABEL] === 'iso' ? faCompactDisc : faHardDrive" />
            {{ row.metadata.labels?.[IMAGE_TYPE_LABEL] === 'iso' ? 'ISO' : 'Disk' }}
          </span>
        </template>
        <template #cell-size="{ value }">{{ value ? `${value} GiB` : '—' }}</template>
        <template #cell-status="{ row }">
          <div class="flex items-center gap-2">
            <span :class="row.status?.phase === 'Succeeded' ? 'text-ok' : row.status?.phase === 'Failed' ? 'text-bad' : 'text-info'">{{ row.status?.phase ?? 'Pending' }}</span>
            <div v-if="row.status?.phase !== 'Succeeded' && progressOf(row) !== null" class="h-1.5 w-20 overflow-hidden rounded-full bg-surface-3">
              <div class="h-full rounded-full bg-accent" :style="{ width: `${(progressOf(row) ?? 0) * 100}%` }" />
            </div>
            <span v-if="row.status?.phase !== 'Succeeded' && progressOf(row) !== null" class="text-xs tabular-nums text-fg-muted">{{ row.status?.progress }}</span>
          </div>
        </template>
        <template #cell-source="{ value }"><span class="mono" :title="String(value)">{{ value }}</span></template>
        <template #cell-actions="{ row }">
          <span class="flex justify-end gap-1">
            <button class="btn btn-sm" :disabled="row.status?.phase !== 'Succeeded'" title="Create a VM from this image" @click.stop="vmFrom(row)"><Fa :icon="faDesktop" /> Create VM</button>
            <button class="btn btn-sm btn-ghost text-bad" title="Remove" @click.stop="remove(row)"><Fa :icon="faTrash" /></button>
          </span>
        </template>
      </DataTable>
    </section>

    <section v-if="dataSources.length || crons.items.value.length">
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faBoxArchive" class="text-fg-muted" /> Golden images</h3>
      <p class="mb-2 text-fg-muted">CDI DataSources, some kept current by DataImportCrons that re-import on a schedule.</p>
      <DataTable :columns="sourceColumns" :rows="dataSources" :row-key="(d) => d.metadata.uid" empty-text="No DataSources">
        <template #cell-ready="{ value }"><span :class="value === 'True' ? 'text-ok' : 'text-warn'">{{ value }}</span></template>
        <template #cell-actions="{ row }">
          <span class="flex justify-end"><button class="btn btn-sm" @click.stop="vmFromDataSource(row)"><Fa :icon="faDesktop" /> Create VM</button></span>
        </template>
      </DataTable>
      <div v-if="crons.items.value.length" class="mt-3">
        <DataTable :columns="cronColumns" :rows="crons.items.value" :row-key="(c) => c.metadata.uid" />
      </div>
    </section>

    <Notice kind="info" title="How images are stored">
      <Fa :icon="faCircleInfo" class="hidden" />
      Each image is a DataVolume: CDI creates a PersistentVolumeClaim and fills it — downloading inside the cluster, converting qcow2, VMDK and VHD(X) to raw, or
      receiving an upload over this GUI's WebSocket. A VM installed from an ISO gets its own clone of it (cheap copy-on-write on Ceph RBD), so images can be shared
      across namespaces and removed without affecting VMs made from them.
    </Notice>
  </div>
</template>
