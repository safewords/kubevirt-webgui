<script setup lang="ts">
/**
 * Ceph: the cluster's own state (from the manager's Prometheus module, through
 * the server), and what Kubernetes knows about it — the CSI driver on each
 * node, the classes on Ceph, and every RBD image a disk lives on.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { faHeartPulse, faServer, faDatabase, faHardDrive, faPlug, faRotate } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway, errorMessage } from '@/api/gateway'
import { useCluster } from '@/stores/cluster'
import { can } from '@/stores/access'
import { useMultiWatch, useWatch } from '@/stores/watch'
import { useInventory } from '@/plugins/core/inventory'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { bytes, age } from '@/util/format'
import { nodeReady } from '@/util/kubevirt'
import { isCephProvisioner } from '@/plugins/core/vm/placement'
import { useClusterWatch } from './helpers'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const inv = useInventory()

// --- the Ceph cluster ------------------------------------------------------

interface CephStatus {
  configured: boolean
  source?: string
  error?: string
  fetchedAt?: string
  health?: { status: string; checks: Array<{ name: string; severity: string }> }
  mons?: Array<{ name: string; host?: string; address?: string; version?: string; inQuorum: boolean }>
  osds?: Array<{ id: string; host?: string; deviceClass?: string; up: boolean; in: boolean; bytes?: number; usedBytes?: number }>
  capacity?: { totalBytes?: number; usedBytes?: number }
  pools?: Array<{ id: string; name: string; type?: string; storedBytes?: number; maxAvailBytes?: number; percentUsed?: number; objects?: number; pgs?: number }>
  pgs?: { total: number; states: Record<string, number> }
}

const status = ref<CephStatus | null>(null)
const statusError = ref<string | null>(null)
const loading = ref(false)
async function refresh() {
  loading.value = true
  try {
    status.value = await gateway.call<CephStatus>('ceph.status', {})
    statusError.value = null
  } catch (e) {
    statusError.value = errorMessage(e)
  } finally {
    loading.value = false
  }
}
refresh()
const timer = setInterval(refresh, 15000)
onBeforeUnmount(() => clearInterval(timer))

const healthClass = computed(() => ({ HEALTH_OK: 'text-ok', HEALTH_WARN: 'text-warn', HEALTH_ERR: 'text-bad' })[status.value?.health?.status ?? ''] ?? 'text-fg-subtle')
const usedFraction = computed(() => {
  const c = status.value?.capacity
  return c?.totalBytes && c.usedBytes !== undefined ? c.usedBytes / c.totalBytes : null
})
const osdSummary = computed(() => {
  const osds = status.value?.osds ?? []
  return { total: osds.length, up: osds.filter((o) => o.up).length, in: osds.filter((o) => o.in).length }
})
const quorum = computed(() => (status.value?.mons ?? []).filter((m) => m.inQuorum).length)
/** PG states that are not plain active+clean, worst first-ish. */
const pgProblems = computed(() => {
  const states = status.value?.pgs?.states ?? {}
  return Object.entries(states).filter(([s]) => !['active', 'clean'].includes(s)).sort((a, b) => b[1] - a[1])
})

/** What a health check means, for the ones a VM operator meets most. */
const CHECK_HELP: Record<string, string> = {
  OSD_DOWN: 'One or more OSDs are down; data on them is served from other replicas while it lasts.',
  OSD_HOST_DOWN: 'Every OSD on a host is down — usually the host itself is off.',
  PG_DEGRADED: 'Some data has fewer copies than the pool asks for; Ceph re-replicates once OSDs return or are marked out.',
  PG_AVAILABILITY: 'Some data is not readable or writable right now: disks on it will hang.',
  MON_DOWN: 'A monitor is out of quorum; the cluster keeps working while a majority remains.',
  MON_CLOCK_SKEW: 'Monitor clocks disagree; check NTP on the monitor hosts.',
  OSD_NEARFULL: 'An OSD is nearly full; writes stop at the full ratio.',
  POOL_NEARFULL: 'A pool is nearly full.',
  OSDMAP_FLAGS: 'Cluster flags such as noout or norebalance are set — expected during maintenance, not otherwise.',
  RECENT_CRASH: 'A daemon crashed recently; `ceph crash ls` lists it, `ceph crash archive-all` clears the warning.',
  SLOW_OPS: 'Requests are taking a long time — guests on Ceph disks will feel it.',
}

const osdColumns: Column<NonNullable<CephStatus['osds']>[number]>[] = [
  { key: 'id', label: 'OSD', value: (o) => Number(o.id) },
  { key: 'host', label: 'Host', value: (o) => o.host ?? '' },
  { key: 'class', label: 'Class', value: (o) => o.deviceClass ?? '' },
  { key: 'state', label: 'State', value: (o) => `${o.up ? 'up' : 'down'} · ${o.in ? 'in' : 'out'}` },
  { key: 'used', label: 'Used', align: 'right', value: (o) => (o.bytes ? (o.usedBytes ?? 0) / o.bytes : -1) },
  { key: 'size', label: 'Size', align: 'right', value: (o) => o.bytes ?? 0 },
]
const poolColumns: Column<NonNullable<CephStatus['pools']>[number]>[] = [
  { key: 'name', label: 'Pool', value: (p) => p.name },
  { key: 'type', label: 'Type', value: (p) => p.type ?? '' },
  { key: 'stored', label: 'Stored', align: 'right', value: (p) => p.storedBytes ?? 0 },
  { key: 'avail', label: 'Free', align: 'right', value: (p) => p.maxAvailBytes ?? 0 },
  { key: 'pct', label: 'Used', align: 'right', value: (p) => p.percentUsed ?? 0 },
  { key: 'objects', label: 'Objects', align: 'right', value: (p) => p.objects ?? 0 },
  { key: 'pgs', label: 'PGs', align: 'right', value: (p) => p.pgs ?? 0 },
  { key: 'classes', label: 'Storage classes', value: (p) => classesByPool.value.get(p.name)?.join(', ') ?? '' },
]

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
const flappingPlugins = computed(() => csiPods.items.value.filter((p) => restarts(p) >= 20))

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

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2">
        <Fa :icon="faHeartPulse" class="text-fg-muted" /> Ceph cluster
        <button class="btn btn-ghost btn-sm ml-auto" :disabled="loading" @click="refresh"><Fa :icon="faRotate" :spin="loading" /> Refresh</button>
      </h3>
      <Notice v-if="statusError" kind="error">{{ statusError }}</Notice>
      <Notice v-else-if="status && !status.configured" kind="info" title="Cluster health is not connected">
        Kubernetes reaches Ceph only through its CSI driver, which reports nothing about the cluster's health. To show health, OSDs, pools and capacity here:
        <ol class="mt-1.5 list-decimal space-y-1 pl-5">
          <li>On a Ceph admin host: <code class="mono">ceph mgr module enable prometheus</code> (serves read-only metrics on port 9283 of the active manager).</li>
          <li>
            Set <code class="mono">CEPH_METRICS_URLS</code> on the kubevirt-webgui server to each manager host, e.g.
            <code class="mono">{{ ([...monitorsByCluster.values()][0] ?? ['10.0.0.1:6789']).map((m) => `http://${m.split(':')[0]}:9283/metrics`).join(',') }}</code>
            — only the active manager answers, so list them all.
          </li>
        </ol>
      </Notice>
      <Notice v-else-if="status?.error" kind="warning">{{ status.error }}</Notice>
      <template v-else-if="status?.health">
        <div class="grid gap-3 md:grid-cols-4">
          <div class="card p-3">
            <div class="text-xs text-fg-muted">Health</div>
            <div class="text-lg font-semibold" :class="healthClass">{{ status.health.status }}</div>
          </div>
          <div class="card p-3">
            <div class="text-xs text-fg-muted">Monitors in quorum</div>
            <div class="text-lg font-semibold" :class="quorum * 2 > (status.mons?.length ?? 0) ? 'text-ok' : 'text-bad'">{{ quorum }} / {{ status.mons?.length ?? 0 }}</div>
            <div class="text-xs text-fg-subtle">{{ (status.mons ?? []).map((m) => (m.inQuorum ? m.name : `${m.name} (out)`)).join(', ') }}</div>
          </div>
          <div class="card p-3">
            <div class="text-xs text-fg-muted">OSDs up / in</div>
            <div class="text-lg font-semibold" :class="osdSummary.up === osdSummary.total ? 'text-ok' : 'text-warn'">{{ osdSummary.up }} / {{ osdSummary.in }} of {{ osdSummary.total }}</div>
          </div>
          <div class="card p-3">
            <div class="text-xs text-fg-muted">Raw capacity used</div>
            <div class="text-lg font-semibold" :class="(usedFraction ?? 0) > 0.85 ? 'text-bad' : (usedFraction ?? 0) > 0.7 ? 'text-warn' : 'text-ok'">{{ usedFraction === null ? '—' : pct(usedFraction) }}</div>
            <div class="text-xs text-fg-subtle">{{ bytes(status.capacity?.usedBytes ?? 0) }} of {{ bytes(status.capacity?.totalBytes ?? 0) }}</div>
          </div>
        </div>

        <ul v-if="status.health.checks.length" class="mt-3 space-y-1.5">
          <li v-for="c in status.health.checks" :key="c.name" class="flex gap-2">
            <span class="chip mono" :class="c.severity === 'HEALTH_ERR' ? 'text-bad' : 'text-warn'">{{ c.name }}</span>
            <span class="text-fg-muted">{{ CHECK_HELP[c.name] ?? 'See `ceph health detail` on an admin host for the affected daemons and objects.' }}</span>
          </li>
        </ul>
        <p v-if="pgProblems.length" class="mt-2 text-fg-muted">
          Placement groups ({{ status.pgs?.total ?? 0 }}):
          <span v-for="[state, n] in pgProblems" :key="state" class="chip mr-1">{{ state }} {{ n }}</span>
        </p>

        <h4 class="mt-4 mb-1.5 flex items-center gap-2 font-medium"><Fa :icon="faHardDrive" class="text-fg-muted" /> OSDs</h4>
        <DataTable :columns="osdColumns" :rows="status.osds ?? []" :row-key="(o) => o.id" :default-sort="{ key: 'id', dir: 'asc' }" empty-text="No OSDs reported">
          <template #cell-state="{ row }"><span :class="row.up && row.in ? 'text-ok' : row.up ? 'text-warn' : 'text-bad'">{{ row.up ? 'up' : 'down' }} · {{ row.in ? 'in' : 'out' }}</span></template>
          <template #cell-used="{ value }">{{ (value as number) < 0 ? '—' : pct(value as number) }}</template>
          <template #cell-size="{ value }">{{ value ? bytes(value as number) : '—' }}</template>
        </DataTable>

        <h4 class="mt-4 mb-1.5 flex items-center gap-2 font-medium"><Fa :icon="faDatabase" class="text-fg-muted" /> Pools</h4>
        <DataTable :columns="poolColumns" :rows="status.pools ?? []" :row-key="(p) => p.id" :default-sort="{ key: 'name', dir: 'asc' }" empty-text="No pools reported">
          <template #cell-stored="{ value }">{{ bytes(value as number) }}</template>
          <template #cell-avail="{ value }">{{ bytes(value as number) }}</template>
          <template #cell-pct="{ value }"><span :class="(value as number) > 85 ? 'text-bad' : (value as number) > 70 ? 'text-warn' : ''">{{ (value as number).toFixed(1) }}%</span></template>
        </DataTable>
        <p class="mt-1.5 text-xs text-fg-subtle">From <span class="mono">{{ status.source }}</span>, refreshed every 15 s.</p>
      </template>
    </section>

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
        {{ flappingPlugins.map((p) => `${p.metadata.name} on ${p.spec?.nodeName} (${restarts(p)} restarts)`).join('; ') }} — a node plugin that keeps restarting drops disk mappings while it is down; its logs say why (
        <code class="mono">kubectl logs -n {{ flappingPlugins[0].metadata.namespace }} {{ flappingPlugins[0].metadata.name }} --all-containers --previous</code>).
      </Notice>
      <DataTable :columns="podColumns" :rows="csiPods.items.value" :row-key="(p) => p.metadata.uid" filterable :default-sort="{ key: 'node', dir: 'asc' }" empty-text="No ceph-csi pods visible (looked for app=ceph-csi-rbd / ceph-csi-cephfs)">
        <template #cell-ready="{ row, value }"><span :class="row.status?.phase === 'Running' && String(value).split('/')[0] === String(value).split('/')[1] ? 'text-ok' : 'text-bad'">{{ value }}</span></template>
        <template #cell-restarts="{ value }"><span :class="(value as number) >= 20 ? 'text-warn' : ''">{{ value }}</span></template>
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
