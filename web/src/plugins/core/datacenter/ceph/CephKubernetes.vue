<script setup lang="ts">
/** What Kubernetes knows about Ceph: the classes on it, the CSI driver on each node, and every RBD image a disk lives on. */
import { computed } from 'vue'
import { faServer, faDatabase, faPlug } from '@fortawesome/free-solid-svg-icons'
import type { KObject } from '@/api/types'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useMultiWatch, useWatch } from '@/stores/watch'
import { useInventory } from '@/plugins/core/inventory'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age } from '@/util/format'
import { nodeReady } from '@/util/kubevirt'
import { isCephProvisioner } from '@/plugins/core/vm/placement'
import { useClusterWatch } from '../helpers'

const cluster = useCluster()
const inv = useInventory()

// --- what Kubernetes knows ---------------------------------------------------

const classes = useClusterWatch(() => (cluster.has('storage.k8s.io/v1/storageclasses') ? 'storage.k8s.io/v1' : null), 'storage.k8s.io', 'storageclasses')
const cephClasses = computed(() => classes.items.value.filter((c) => isCephProvisioner((c as any).provisioner)))
const classesByPool = computed(() => {
  const map = new Map<string, string[]>()
  for (const c of cephClasses.value) {
    const pool = (c as any).parameters?.pool
    if (pool) map.set(pool, [...(map.get(pool) ?? []), c.metadata.name])
  }
  return map
})

// ceph-csi keeps the monitors in a ConfigMap next to its secrets.
const csiNamespace = computed(() => {
  const params = (cephClasses.value[0] as any)?.parameters ?? {}
  return params['csi.storage.k8s.io/provisioner-secret-namespace'] ?? params['csi.storage.k8s.io/node-stage-secret-namespace'] ?? null
})
const csiConfig = useWatch(() => (csiNamespace.value ? { apiVersion: 'v1', resource: 'configmaps', namespace: csiNamespace.value, name: 'ceph-csi-config' } : null))
const monitorsByCluster = computed(() => {
  const map = new Map<string, string[]>()
  for (const cm of csiConfig.items.value) {
    try {
      for (const entry of JSON.parse(cm.data?.['config.json'] ?? '[]')) map.set(entry.clusterID, entry.monitors ?? [])
    } catch {
      /* not ours to fix */
    }
  }
  return map
})

const classColumns: Column<KObject>[] = [
  { key: 'name', label: 'Storage class', value: (c) => c.metadata.name },
  { key: 'driver', label: 'Driver', value: (c) => (c as any).provisioner },
  { key: 'pool', label: 'Pool', value: (c) => (c as any).parameters?.pool ?? (c as any).parameters?.fsName ?? '' },
  { key: 'cluster', label: 'Ceph cluster', value: (c) => (c as any).parameters?.clusterID ?? '' },
  { key: 'mons', label: 'Monitors', value: (c) => monitorsByCluster.value.get((c as any).parameters?.clusterID)?.join(', ') ?? '' },
]

// The CSI driver's pods: a node without a running node plugin cannot attach a Ceph disk.
const podScope = computed(() => {
  const allowed = can({ verb: 'list', group: '', resource: 'pods' })
  if (allowed === undefined) return undefined
  return allowed ? null : inv.reachableNamespaces
})
const csiPods = useMultiWatch(
  () => (podScope.value !== undefined ? { apiVersion: 'v1', resource: 'pods', labelSelector: 'app in (ceph-csi-rbd,ceph-csi-cephfs)' } : null),
  () => (podScope.value === undefined ? [] : podScope.value),
)
const restarts = (p: KObject) => ((p.status?.containerStatuses ?? []) as any[]).reduce((n, c) => n + (c.restartCount ?? 0), 0)
const lastRestart = (p: KObject) =>
  ((p.status?.containerStatuses ?? []) as any[]).map((c) => c.lastState?.terminated?.finishedAt).filter(Boolean).sort().pop() as string | undefined
const ready = (p: KObject) => {
  const cs = (p.status?.containerStatuses ?? []) as any[]
  return `${cs.filter((c) => c.ready).length}/${cs.length}`
}
const podColumns: Column<KObject>[] = [
  { key: 'node', label: 'Node', value: (p) => p.spec?.nodeName ?? '' },
  { key: 'component', label: 'Component', value: (p) => `${p.metadata.labels?.app ?? ''} ${p.metadata.labels?.component ?? ''}`.trim() },
  { key: 'ready', label: 'Ready', value: ready },
  { key: 'phase', label: 'Phase', value: (p) => p.status?.phase ?? '' },
  { key: 'restarts', label: 'Restarts', align: 'right', value: restarts },
  { key: 'last', label: 'Last restart', value: (p) => lastRestart(p) ?? '' },
  { key: 'age', label: 'Age', value: (p) => age(p.metadata.creationTimestamp) },
]
/** Ready nodes that run VMs but have no Ceph node plugin. */
const nodesWithoutPlugin = computed(() => {
  if (!csiPods.items.value.length) return []
  const covered = new Set(csiPods.items.value.filter((p) => p.metadata.labels?.component === 'nodeplugin' && p.status?.phase === 'Running').map((p) => p.spec?.nodeName))
  return inv.nodes.filter((n) => nodeReady(n) && n.metadata.labels?.['kubevirt.io/schedulable'] === 'true' && !covered.has(n.metadata.name)).map((n) => n.metadata.name)
})
// A lifetime count only grows; what matters is a pod that is restarting now.
const RECENT_MS = 24 * 3600 * 1000
const restartedRecently = (p: KObject) => {
  const last = lastRestart(p)
  return !!last && Date.now() - new Date(last).getTime() < RECENT_MS
}
const flappingPlugins = computed(() => csiPods.items.value.filter((p) => restartedRecently(p) && restarts(p) >= 5))

// Every disk on Ceph: its RBD image, the VM that uses it, and where it is attached.
const pvs = useClusterWatch(() => 'v1', '', 'persistentvolumes')
const attachments = useClusterWatch(() => (cluster.has('storage.k8s.io/v1/volumeattachments') ? 'storage.k8s.io/v1' : null), 'storage.k8s.io', 'volumeattachments')
const cephPvs = computed(() => pvs.items.value.filter((pv) => isCephProvisioner(pv.spec?.csi?.driver)))
const attachedTo = computed(() => {
  const map = new Map<string, string[]>()
  for (const a of attachments.items.value) {
    const pv = a.spec?.source?.persistentVolumeName
    if (pv && a.status?.attached) map.set(pv, [...(map.get(pv) ?? []), a.spec?.nodeName])
  }
  return map
})
const vmByClaim = computed(() => {
  const map = new Map<string, string>()
  for (const vm of inv.vms) {
    for (const v of vm.spec?.template?.spec?.volumes ?? []) {
      const claim = v.persistentVolumeClaim?.claimName ?? v.dataVolume?.name
      if (claim) map.set(`${vm.metadata.namespace}/${claim}`, vm.metadata.name)
    }
  }
  // Persistent TPM/EFI state belongs to its VM too.
  for (const pvc of inv.pvcs) {
    const owner = pvc.metadata.labels?.['persistent-state-for']
    if (owner) map.set(`${pvc.metadata.namespace}/${pvc.metadata.name}`, `${owner} (TPM/EFI state)`)
  }
  return map
})
const claimOf = (pv: KObject) => (pv.spec?.claimRef ? `${pv.spec.claimRef.namespace}/${pv.spec.claimRef.name}` : '')
const volumeColumns: Column<KObject>[] = [
  { key: 'claim', label: 'Disk (claim)', value: claimOf },
  { key: 'vm', label: 'VM', value: (pv) => vmByClaim.value.get(claimOf(pv)) ?? '' },
  { key: 'image', label: 'RBD image', value: (pv) => `${pv.spec?.csi?.volumeAttributes?.pool ?? '?'}/${pv.spec?.csi?.volumeAttributes?.imageName ?? pv.spec?.csi?.volumeHandle}` },
  { key: 'size', label: 'Size', align: 'right', value: (pv) => pv.spec?.capacity?.storage ?? '' },
  { key: 'modes', label: 'Access', value: (pv) => (pv.spec?.accessModes ?? []).join(', ') },
  { key: 'attached', label: 'Attached to', value: (pv) => attachedTo.value.get(pv.metadata.name)?.join(', ') ?? '' },
  { key: 'phase', label: 'Phase', value: (pv) => pv.status?.phase ?? '' },
]

</script>

<template>
  <div class="space-y-4">

    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faDatabase" class="text-fg-muted" /> Storage classes on Ceph</h3>
      <DataTable :columns="classColumns" :rows="cephClasses" :row-key="(c) => c.metadata.uid" :default-sort="{ key: 'name', dir: 'asc' }" empty-text="No storage class uses a Ceph CSI driver">
        <template #cell-driver="{ value }"><span class="mono">{{ value }}</span></template>
        <template #cell-cluster="{ value }"><span class="mono text-xs">{{ value }}</span></template>
        <template #cell-mons="{ value }"><span class="mono text-xs">{{ value || '—' }}</span></template>
      </DataTable>
      <p class="mt-1.5 text-xs text-fg-subtle">VMs whose every disk is on these classes can use soft node placement (VM → Options → Node placement).</p>
    </section>

    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faPlug" class="text-fg-muted" /> CSI driver</h3>
      <Notice v-if="nodesWithoutPlugin.length" kind="warning" class="mb-2">
        No running Ceph node plugin on {{ nodesWithoutPlugin.join(', ') }}: VMs with Ceph disks cannot start there until it runs.
      </Notice>
      <Notice v-if="flappingPlugins.length" kind="warning" class="mb-2">
        Restarted in the last 24 hours:
        <ul class="mt-1 list-disc space-y-1 pl-5">
          <li v-for="p in flappingPlugins" :key="p.metadata.uid">
            {{ p.metadata.name }} on {{ p.spec?.nodeName }} — {{ restarts(p) }} restarts, the last {{ age(lastRestart(p)!) }} ago. Its logs say why:
            <code class="mono">kubectl logs -n {{ p.metadata.namespace }} {{ p.metadata.name }} --all-containers --previous</code>
          </li>
        </ul>
        <p class="mt-1">While a node plugin is down, Ceph disks on that node cannot be mapped or unmapped.</p>
      </Notice>
      <DataTable :columns="podColumns" :rows="csiPods.items.value" :row-key="(p) => p.metadata.uid" filterable :default-sort="{ key: 'node', dir: 'asc' }" empty-text="No ceph-csi pods visible (looked for app=ceph-csi-rbd / ceph-csi-cephfs)">
        <template #cell-ready="{ row, value }"><span :class="row.status?.phase === 'Running' && String(value).split('/')[0] === String(value).split('/')[1] ? 'text-ok' : 'text-bad'">{{ value }}</span></template>
        <template #cell-restarts="{ row, value }"><span :class="restartedRecently(row) && (value as number) >= 5 ? 'text-warn' : ''">{{ value }}</span></template>
        <template #cell-last="{ value }">{{ value ? `${age(value as string)} ago` : '—' }}</template>
      </DataTable>
    </section>

    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faServer" class="text-fg-muted" /> Disks on Ceph</h3>
      <DataTable :columns="volumeColumns" :rows="cephPvs" :row-key="(pv) => pv.metadata.uid" filterable :default-sort="{ key: 'claim', dir: 'asc' }" empty-text="No persistent volumes on a Ceph driver">
        <template #cell-image="{ value }"><span class="mono text-xs">{{ value }}</span></template>
        <template #cell-attached="{ value }">{{ value || '—' }}</template>
      </DataTable>
      <p class="mt-1.5 text-xs text-fg-subtle">"Attached to" is the node the CSI driver has mapped the image on, from VolumeAttachments.</p>
    </section>
  </div>
</template>
