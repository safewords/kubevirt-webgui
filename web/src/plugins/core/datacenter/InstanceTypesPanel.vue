<script setup lang="ts">
/** Instance types and preferences — KubeVirt's answer to VM templates. */
import { computed, ref } from 'vue'
import { faCubes, faSliders } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useCluster } from '@/stores/cluster'
import { openDialog } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { bytes, quantity } from '@/util/format'
import { useClusterWatch, useScopedWatch } from './helpers'
import YamlDialog from './YamlDialog.vue'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const tab = ref<'instancetypes' | 'preferences'>('instancetypes')

const G = 'instancetype.kubevirt.io'
const clusterTypes = useClusterWatch(() => cluster.versionFor(G, 'virtualmachineclusterinstancetypes'), G, 'virtualmachineclusterinstancetypes')
const nsTypes = useScopedWatch(() => cluster.versionFor(G, 'virtualmachineinstancetypes'), G, 'virtualmachineinstancetypes')
const clusterPrefs = useClusterWatch(() => cluster.versionFor(G, 'virtualmachineclusterpreferences'), G, 'virtualmachineclusterpreferences')
const nsPrefs = useScopedWatch(() => cluster.versionFor(G, 'virtualmachinepreferences'), G, 'virtualmachinepreferences')

const types = computed(() => [...clusterTypes.items.value, ...nsTypes.items.value])
const prefs = computed(() => [...clusterPrefs.items.value, ...nsPrefs.items.value])
const vendorFilter = ref('')
const vendors = computed(() => [...new Set([...types.value, ...prefs.value].map((o) => o.metadata.labels?.[`${G}/vendor`] ?? 'custom'))].sort())
const byVendor = (o: KObject) => !vendorFilter.value || (o.metadata.labels?.[`${G}/vendor`] ?? 'custom') === vendorFilter.value

const typeColumns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (t) => t.metadata.name },
  { key: 'scope', label: 'Scope', value: (t) => t.metadata.namespace ?? 'cluster' },
  { key: 'series', label: 'Series', value: (t) => t.metadata.name.split('.')[0] },
  { key: 'class', label: 'Class', value: (t) => t.metadata.labels?.[`${G}/class`] ?? '' },
  { key: 'cpu', label: 'vCPU', align: 'right', value: (t) => Number(t.spec?.cpu?.guest ?? 0) },
  { key: 'memory', label: 'Memory', align: 'right', value: (t) => quantity(t.spec?.memory?.guest) },
  { key: 'features', label: 'Features', value: (t) => features(t).join(' ') },
  { key: 'description', label: 'Description', value: (t) => t.metadata.annotations?.[`${G}/description`] ?? t.metadata.annotations?.[`${G}/displayName`] ?? '' },
]

function features(t: KObject): string[] {
  const out: string[] = []
  if (t.spec?.cpu?.dedicatedCPUPlacement) out.push('dedicated CPUs')
  if (t.spec?.cpu?.isolateEmulatorThread) out.push('isolated emulator')
  if (t.spec?.cpu?.numa) out.push('NUMA')
  if (t.spec?.memory?.hugepages) out.push(`hugepages ${t.spec.memory.hugepages.pageSize}`)
  if (t.spec?.gpus?.length) out.push(`${t.spec.gpus.length} GPU`)
  if (t.spec?.hostDevices?.length) out.push(`${t.spec.hostDevices.length} host device`)
  if (t.spec?.memory?.overcommitPercent) out.push(`overcommit ${t.spec.memory.overcommitPercent}%`)
  return out
}

const prefColumns: Column<KObject>[] = [
  { key: 'name', label: 'Name', value: (p) => p.metadata.name },
  { key: 'display', label: 'Operating system', value: (p) => p.metadata.annotations?.['openshift.io/display-name'] ?? '' },
  { key: 'scope', label: 'Scope', value: (p) => p.metadata.namespace ?? 'cluster' },
  { key: 'os', label: 'OS type', value: (p) => p.metadata.labels?.[`${G}/os-type`] ?? '' },
  { key: 'reqCpu', label: 'Min vCPU', align: 'right', value: (p) => Number(p.spec?.requirements?.cpu?.guest ?? p.metadata.labels?.[`${G}/required-cpu`] ?? 0) },
  { key: 'reqMem', label: 'Min memory', align: 'right', value: (p) => quantity(p.spec?.requirements?.memory?.guest ?? p.metadata.labels?.[`${G}/required-memory`]) },
  { key: 'disk', label: 'Disk bus', value: (p) => p.spec?.devices?.preferredDiskBus ?? '' },
  { key: 'nic', label: 'NIC model', value: (p) => p.spec?.devices?.preferredInterfaceModel ?? '' },
  { key: 'firmware', label: 'Firmware', value: (p) => (p.spec?.firmware?.preferredUseEfi ? `EFI${p.spec.firmware.preferredUseSecureBoot ? ' + Secure Boot' : ''}` : p.spec?.firmware?.preferredUseBios ? 'BIOS' : '') },
  { key: 'topology', label: 'CPU topology', value: (p) => p.spec?.cpu?.preferredCPUTopology ?? '' },
]

function show(object: KObject) {
  openDialog(YamlDialog, { title: `${object.kind ?? 'Object'} ${object.metadata.name}`, mode: 'view', object })
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="!cluster.has(G)" kind="info">This cluster does not serve instance types ({{ G }}).</Notice>
    <template v-else>
      <p class="text-fg-muted">
        An <strong>instance type</strong> fixes a VM's CPU and memory (like a cloud flavor); a <strong>preference</strong> supplies OS-appropriate defaults — disk bus, NIC model, firmware.
        VMs that reference them pick up changes when restarted. Double-click a row for its definition.
      </p>
      <div class="flex items-center gap-2">
        <button class="btn btn-sm" :class="tab === 'instancetypes' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'instancetypes'"><Fa :icon="faCubes" /> Instance types <span class="chip">{{ types.length }}</span></button>
        <button class="btn btn-sm" :class="tab === 'preferences' ? 'bg-surface-3' : 'btn-ghost'" @click="tab = 'preferences'"><Fa :icon="faSliders" /> Preferences <span class="chip">{{ prefs.length }}</span></button>
        <label class="ml-auto flex items-center gap-2 text-fg-muted">
          Vendor
          <select v-model="vendorFilter" class="input w-44">
            <option value="">all</option>
            <option v-for="v in vendors" :key="v" :value="v">{{ v }}</option>
          </select>
        </label>
      </div>
      <Notice v-if="(tab === 'instancetypes' ? clusterTypes : clusterPrefs).error.value" kind="warning">{{ (tab === 'instancetypes' ? clusterTypes : clusterPrefs).error.value?.message }}</Notice>
      <DataTable
        v-if="tab === 'instancetypes'"
        :columns="typeColumns"
        :rows="types.filter(byVendor)"
        :row-key="(t) => t.metadata.uid"
        filterable
        :default-sort="{ key: 'name', dir: 'asc' }"
        empty-text="No instance types"
        @activate="show"
      >
        <template #cell-name="{ value }"><span class="mono font-medium">{{ value }}</span></template>
        <template #cell-memory="{ value }">{{ bytes(value as number) }}</template>
        <template #cell-features="{ row }">
          <span v-for="f in features(row)" :key="f" class="chip mr-1">{{ f }}</span>
        </template>
        <template #cell-description="{ value }"><span class="text-fg-muted">{{ value }}</span></template>
      </DataTable>
      <DataTable v-else :columns="prefColumns" :rows="prefs.filter(byVendor)" :row-key="(p) => p.metadata.uid" filterable :default-sort="{ key: 'name', dir: 'asc' }" empty-text="No preferences" @activate="show">
        <template #cell-name="{ value }"><span class="mono font-medium">{{ value }}</span></template>
        <template #cell-reqCpu="{ value }">{{ value || '—' }}</template>
        <template #cell-reqMem="{ value }">{{ value ? bytes(value as number) : '—' }}</template>
      </DataTable>
    </template>
  </div>
</template>
