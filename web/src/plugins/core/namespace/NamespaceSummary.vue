<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { faDesktop, faMicrochip, faMemory, faHardDrive } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useInventory } from '@/plugins/core/inventory'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import StateBadge from '@/components/ui/StateBadge.vue'
import { vmState, vcpus, memoryBytes, templateSpec } from '@/util/kubevirt'
import { bytes, quantity, age } from '@/util/format'
import { routeTo } from '@/util/nav'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const router = useRouter()

const vms = computed(() => inv.vms.filter((v) => v.metadata.namespace === props.ctx.name))
const disks = computed(() => inv.pvcs.filter((p) => p.metadata.namespace === props.ctx.name))

const totals = computed(() => {
  let cpu = 0
  let memory = 0
  let runningCpu = 0
  let runningMemory = 0
  let running = 0
  for (const vm of vms.value) {
    const spec = templateSpec(vm)
    const c = vcpus(spec)
    const m = memoryBytes(spec)
    cpu += c
    memory += m
    const s = vmState(vm, inv.vmiFor(vm))
    if (s === 'running' || s === 'paused' || s === 'migrating') {
      running++
      runningCpu += c
      runningMemory += m
    }
  }
  const storage = disks.value.reduce((sum, p) => sum + quantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage), 0)
  return { cpu, memory, runningCpu, runningMemory, running, storage }
})

const vmColumns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (v) => v.metadata.name },
  { key: 'status', label: 'Status', value: (v) => vmState(v, inv.vmiFor(v)) },
  { key: 'node', label: 'Node', value: (v) => inv.vmiFor(v)?.status?.nodeName ?? '' },
  { key: 'cpu', label: 'vCPU', align: 'right', value: (v) => vcpus(templateSpec(v)) },
  { key: 'memory', label: 'Memory', align: 'right', value: (v) => memoryBytes(templateSpec(v)) },
  { key: 'age', label: 'Age', value: (v) => age(v.metadata.creationTimestamp) },
]
const diskColumns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (p) => p.metadata.name },
  { key: 'status', label: 'Status', value: (p) => p.status?.phase },
  { key: 'size', label: 'Size', align: 'right', value: (p) => quantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage) },
  { key: 'class', label: 'Storage class', value: (p) => p.spec?.storageClassName },
  { key: 'mode', label: 'Mode', value: (p) => `${p.spec?.volumeMode ?? 'Filesystem'} · ${(p.spec?.accessModes ?? []).join(', ')}` },
  { key: 'age', label: 'Age', value: (p) => age(p.metadata.creationTimestamp) },
]
</script>

<template>
  <div class="space-y-4 p-3">
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="card p-3">
        <div class="flex items-center gap-2 text-fg-muted"><Fa :icon="faDesktop" /> Virtual machines</div>
        <div class="mt-1 text-xl font-semibold tabular-nums">{{ vms.length }}</div>
        <div class="text-xs text-fg-muted">{{ totals.running }} running · {{ vms.length - totals.running }} not running</div>
      </div>
      <div class="card p-3">
        <div class="flex items-center gap-2 text-fg-muted"><Fa :icon="faMicrochip" /> vCPU</div>
        <div class="mt-1 text-xl font-semibold tabular-nums">{{ totals.cpu }}</div>
        <div class="text-xs text-fg-muted">{{ totals.runningCpu }} allocated to running guests</div>
      </div>
      <div class="card p-3">
        <div class="flex items-center gap-2 text-fg-muted"><Fa :icon="faMemory" /> Memory</div>
        <div class="mt-1 text-xl font-semibold tabular-nums">{{ bytes(totals.memory) }}</div>
        <div class="text-xs text-fg-muted">{{ bytes(totals.runningMemory) }} allocated to running guests</div>
      </div>
      <div class="card p-3">
        <div class="flex items-center gap-2 text-fg-muted"><Fa :icon="faHardDrive" /> Disk capacity</div>
        <div class="mt-1 text-xl font-semibold tabular-nums">{{ bytes(totals.storage) }}</div>
        <div class="text-xs text-fg-muted">{{ disks.length }} persistent volume claim{{ disks.length === 1 ? '' : 's' }}</div>
      </div>
    </div>
    <section>
      <h3 class="panel-title mb-2">Virtual machines</h3>
      <DataTable :columns="vmColumns" :rows="vms" :row-key="(v) => v.metadata.uid" filterable empty-text="No virtual machines in this namespace" @activate="(v) => router.push(routeTo({ kind: 'vm', name: v.metadata.name, namespace: v.metadata.namespace }))">
        <template #cell-status="{ value }"><StateBadge :state="value as string" /></template>
        <template #cell-memory="{ value }">{{ bytes(value as number) }}</template>
      </DataTable>
    </section>
    <section>
      <h3 class="panel-title mb-2">Persistent volume claims</h3>
      <DataTable :columns="diskColumns" :rows="disks" :row-key="(p) => p.metadata.uid" filterable empty-text="No disks in this namespace" @activate="(p) => router.push(routeTo({ kind: 'disk', name: p.metadata.name, namespace: p.metadata.namespace }))">
        <template #cell-size="{ value }">{{ bytes(value as number) }}</template>
      </DataTable>
    </section>
  </div>
</template>
