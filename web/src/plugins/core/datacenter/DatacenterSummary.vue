<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { faHeartPulse, faDesktop, faServer, faMicrochip } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { gateway, type Subscription } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { useCluster } from '@/stores/cluster'
import { useObject } from '@/stores/watch'
import Gauge from '@/components/ui/Gauge.vue'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import { bytes, cores, quantity, age } from '@/util/format'
import { nodeReady, nodeRoles, vmState, condition } from '@/util/kubevirt'
import { routeTo } from '@/util/nav'
import type { KObject } from '@/api/types'

defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const cluster = useCluster()
const router = useRouter()

const usage = ref<Record<string, { cpu: number; memory: number }>>({})
let sub: Subscription | null = gateway.subscribe('metrics.nodes', {}, (event) => {
  if (event.type === 'nodes') usage.value = event.nodes
})
onBeforeUnmount(() => sub?.close())

const kubevirt = useObject(() => (cluster.has('kubevirt.io/v1/kubevirts') ? { apiVersion: 'kubevirt.io/v1', resource: 'kubevirts', namespace: 'kubevirt', name: 'kubevirt' } : null))

const states = computed(() => {
  const counts = { running: 0, stopped: 0, other: 0, error: 0 }
  for (const vm of inv.vms) {
    const s = vmState(vm, inv.vmiFor(vm))
    if (s === 'running' || s === 'paused' || s === 'migrating') counts.running++
    else if (s === 'stopped') counts.stopped++
    else if (s === 'error') counts.error++
    else counts.other++
  }
  return counts
})

const nodeStats = computed(() => {
  const ready = inv.nodes.filter(nodeReady).length
  let cpuCap = 0, memCap = 0, cpuUsed = 0, memUsed = 0
  for (const node of inv.nodes) {
    cpuCap += quantity(node.status?.allocatable?.cpu)
    memCap += quantity(node.status?.allocatable?.memory)
    const u = usage.value[node.metadata.name]
    if (u) {
      cpuUsed += u.cpu
      memUsed += u.memory
    }
  }
  const virt = inv.nodes.filter((n) => n.metadata.labels?.['kubevirt.io/schedulable'] === 'true').length
  return { ready, total: inv.nodes.length, cpuCap, memCap, cpuUsed, memUsed, virt }
})

const health = computed(() => {
  const available = condition(kubevirt.object.value, 'Available')
  const degraded = condition(kubevirt.object.value, 'Degraded')
  if (!kubevirt.object.value) return { ok: null as boolean | null, text: cluster.has('kubevirt.io') ? 'KubeVirt status not readable' : 'KubeVirt is not installed' }
  if (degraded?.status === 'True') return { ok: false, text: degraded.message ?? 'Degraded' }
  if (available?.status === 'True') return { ok: true, text: 'KubeVirt: all components ready' }
  return { ok: false, text: available?.message ?? 'Not available' }
})

const columns: Column<KObject>[] = [
  { key: 'name', label: 'Node', value: (n) => n.metadata.name },
  { key: 'status', label: 'Status', value: (n) => (nodeReady(n) ? (n.spec?.unschedulable ? 'maintenance' : 'online') : 'offline') },
  { key: 'roles', label: 'Roles', value: (n) => nodeRoles(n).join(', ') || 'worker' },
  { key: 'virt', label: 'Virtualization', value: (n) => (n.metadata.labels?.['kubevirt.io/schedulable'] === 'true' ? 'yes' : 'no') },
  { key: 'guests', label: 'Guests', align: 'right', value: (n) => inv.vmis.filter((v) => v.status?.nodeName === n.metadata.name).length },
  { key: 'cpu', label: 'CPU usage', align: 'right', value: (n) => (usage.value[n.metadata.name] ? usage.value[n.metadata.name].cpu / quantity(n.status?.allocatable?.cpu) : -1) },
  { key: 'memory', label: 'Memory usage', align: 'right', value: (n) => (usage.value[n.metadata.name] ? usage.value[n.metadata.name].memory / quantity(n.status?.allocatable?.memory) : -1) },
  { key: 'version', label: 'Kubelet', value: (n) => n.status?.nodeInfo?.kubeletVersion },
  { key: 'uptime', label: 'Age', value: (n) => age(n.metadata.creationTimestamp) },
]
</script>

<template>
  <div class="grid gap-3 p-3 lg:grid-cols-2">
    <div class="card">
      <div class="card-header"><Fa :icon="faHeartPulse" class="text-fg-muted" /> Health</div>
      <div class="grid grid-cols-3 gap-3 p-4 text-center">
        <div>
          <div class="text-fg-muted">Status</div>
          <div class="mt-1 text-2xl" :class="health.ok === null ? 'text-fg-subtle' : health.ok ? 'text-ok' : 'text-warn'">
            <Fa :icon="faHeartPulse" />
          </div>
          <div class="mt-1 text-xs text-fg-muted">{{ health.text }}</div>
        </div>
        <div>
          <div class="text-fg-muted">Nodes</div>
          <div class="mt-1 text-2xl"><Fa :icon="faServer" class="text-fg-muted" /></div>
          <div class="mt-1"><span class="text-ok">{{ nodeStats.ready }} online</span> · <span :class="nodeStats.total - nodeStats.ready ? 'text-bad' : 'text-fg-subtle'">{{ nodeStats.total - nodeStats.ready }} offline</span></div>
          <div class="text-xs text-fg-muted">{{ nodeStats.virt }} can run VMs</div>
        </div>
        <div>
          <div class="text-fg-muted">Guests</div>
          <div class="mt-1 text-2xl"><Fa :icon="faDesktop" class="text-fg-muted" /></div>
          <div class="mt-1"><span class="text-ok">{{ states.running }} running</span> · {{ states.stopped }} stopped</div>
          <div class="text-xs" :class="states.error ? 'text-bad' : 'text-fg-muted'">{{ states.error }} in error · {{ states.other }} transitioning</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><Fa :icon="faMicrochip" class="text-fg-muted" /> Resources</div>
      <div class="space-y-4 p-4">
        <Gauge label="CPU" :value="nodeStats.cpuCap ? nodeStats.cpuUsed / nodeStats.cpuCap : null" :detail="`${cores(nodeStats.cpuUsed)} of ${cores(nodeStats.cpuCap)} cores`" />
        <Gauge label="Memory" :value="nodeStats.memCap ? nodeStats.memUsed / nodeStats.memCap : null" :detail="`${bytes(nodeStats.memUsed)} of ${bytes(nodeStats.memCap)}`" />
        <dl class="kv">
          <dt>Kubernetes</dt>
          <dd>{{ cluster.kubernetesVersion ?? '—' }}</dd>
          <dt>KubeVirt</dt>
          <dd>{{ cluster.kubevirtVersion ?? 'not installed' }}</dd>
          <dt>CDI (disk import)</dt>
          <dd>{{ cluster.has('cdi.kubevirt.io') ? 'installed' : 'not installed' }}</dd>
          <dt>API server</dt>
          <dd class="mono truncate">{{ gateway.hello.value?.server.cluster }}</dd>
        </dl>
      </div>
    </div>

    <div class="lg:col-span-2">
      <h3 class="panel-title mb-2">Nodes</h3>
      <DataTable :columns="columns" :rows="inv.nodes" :row-key="(n) => n.metadata.uid" @activate="(n) => router.push(routeTo({ kind: 'node', name: n.metadata.name }))">
        <template #cell-status="{ value }">
          <span :class="value === 'online' ? 'text-ok' : value === 'maintenance' ? 'text-warn' : 'text-bad'">{{ value }}</span>
        </template>
        <template #cell-cpu="{ value }">{{ (value as number) < 0 ? '—' : `${((value as number) * 100).toFixed(1)}%` }}</template>
        <template #cell-memory="{ value }">{{ (value as number) < 0 ? '—' : `${((value as number) * 100).toFixed(1)}%` }}</template>
      </DataTable>
    </div>
  </div>
</template>
