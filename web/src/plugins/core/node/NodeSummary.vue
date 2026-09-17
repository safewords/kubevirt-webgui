<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { faServer, faMicrochip } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { MetricSample } from '@/api/types'
import { gateway } from '@/api/gateway'
import Gauge from '@/components/ui/Gauge.vue'
import TimeChart from '@/components/ui/TimeChart.vue'
import { bytes, cores, quantity, age } from '@/util/format'
import { nodeReady, nodeRoles } from '@/util/kubevirt'
import { useInventory } from '@/plugins/core/inventory'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const node = computed(() => props.ctx.object)

const samples = ref<MetricSample[]>([])
const sub = gateway.subscribe('metrics.node', { name: props.ctx.name }, (event) => {
  if (event.type === 'history') samples.value = event.samples
  else if (event.type === 'sample') {
    const last = samples.value[samples.value.length - 1]
    if (!last || last.ts !== event.sample.ts) samples.value = [...samples.value.slice(-719), event.sample]
  }
})
onBeforeUnmount(() => sub.close())

const latest = computed(() => samples.value[samples.value.length - 1] ?? null)
const cpuCap = computed(() => quantity(node.value?.status?.allocatable?.cpu))
const memCap = computed(() => quantity(node.value?.status?.allocatable?.memory))
const info = computed(() => node.value?.status?.nodeInfo ?? {})
const guests = computed(() => inv.vmis.filter((v) => v.status?.nodeName === props.ctx.name))
const cpuModel = computed(() => Object.keys(node.value?.metadata.labels ?? {}).find((k) => k.startsWith('host-model-cpu.node.kubevirt.io/'))?.split('/')[1])
</script>

<template>
  <div class="grid gap-3 p-3 xl:grid-cols-2">
    <div class="card">
      <div class="card-header"><Fa :icon="faServer" class="text-fg-muted" /> {{ ctx.name }}</div>
      <dl class="kv p-3">
        <dt>Status</dt>
        <dd :class="nodeReady(node) ? (node?.spec?.unschedulable ? 'text-warn' : 'text-ok') : 'text-bad'">
          {{ nodeReady(node) ? (node?.spec?.unschedulable ? 'online (maintenance — cordoned)' : 'online') : 'offline' }}
        </dd>
        <dt>Roles</dt>
        <dd>{{ nodeRoles(node).join(', ') || 'worker' }}</dd>
        <dt>Guests</dt>
        <dd>{{ guests.length }} running</dd>
        <dt>Runs VMs</dt>
        <dd>{{ node?.metadata.labels?.['kubevirt.io/schedulable'] === 'true' ? 'yes' : 'no' }}</dd>
        <dt>Host CPU model</dt>
        <dd>{{ cpuModel ?? '—' }}</dd>
        <dt>Addresses</dt>
        <dd><span v-for="a in node?.status?.addresses ?? []" :key="a.type + a.address" class="mono mr-2">{{ a.address }}</span></dd>
        <dt>OS</dt>
        <dd>{{ info.osImage }}</dd>
        <dt>Kernel</dt>
        <dd class="mono">{{ info.kernelVersion }}</dd>
        <dt>Kubelet</dt>
        <dd>{{ info.kubeletVersion }} · {{ info.containerRuntimeVersion }}</dd>
        <dt>Joined</dt>
        <dd>{{ age(node?.metadata.creationTimestamp) }} ago</dd>
      </dl>
    </div>
    <div class="card">
      <div class="card-header"><Fa :icon="faMicrochip" class="text-fg-muted" /> Usage</div>
      <div class="space-y-4 p-3">
        <Gauge label="CPU" :value="latest && cpuCap ? latest.cpu / cpuCap : null" :detail="`${latest ? cores(latest.cpu) : '—'} of ${cores(cpuCap)} cores`" />
        <Gauge label="Memory" :value="latest && memCap ? latest.memory / memCap : null" :detail="`${latest ? bytes(latest.memory) : '—'} of ${bytes(memCap)}`" />
        <dl class="kv">
          <dt>Capacity</dt>
          <dd>{{ node?.status?.capacity?.cpu }} CPU · {{ bytes(quantity(node?.status?.capacity?.memory)) }} · {{ node?.status?.capacity?.pods }} pods</dd>
          <dt>KVM devices</dt>
          <dd>{{ node?.status?.allocatable?.['devices.kubevirt.io/kvm'] ?? '—' }}</dd>
        </dl>
      </div>
    </div>
    <TimeChart title="CPU usage" :series="[{ label: 'CPU', color: 'var(--chart-1)', points: samples.map((s) => ({ ts: s.ts, value: s.cpu })) }]" :format="(v) => cores(v)" :max="cpuCap" />
    <TimeChart title="Memory usage" :series="[{ label: 'Memory', color: 'var(--chart-2)', points: samples.map((s) => ({ ts: s.ts, value: s.memory })) }]" :format="(v) => bytes(v, 0)" :max="memCap" />
  </div>
</template>
