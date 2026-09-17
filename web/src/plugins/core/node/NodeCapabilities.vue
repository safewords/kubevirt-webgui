<script setup lang="ts">
/** What a node offers virtual machines: resources, devices, CPU models, machine types. */
import { computed, ref } from 'vue'
import { faMicrochip, faPlug, faLayerGroup } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { useInventory } from '@/plugins/core/inventory'
import Notice from '@/components/ui/Notice.vue'
import { bytes, cores, quantity } from '@/util/format'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const node = computed(() => props.ctx.object)
const labels = computed(() => node.value?.metadata.labels ?? {})

// --- resources ----------------------------------------------------------------
interface ResourceRow {
  name: string
  category: string
  capacity: string
  allocatable: string
  requested: number | null
}

function categoryOf(name: string) {
  if (name === 'cpu' || name === 'memory' || name === 'pods' || name === 'ephemeral-storage') return 'Compute'
  if (name.startsWith('hugepages-')) return 'Huge pages'
  if (name.startsWith('devices.kubevirt.io/')) return 'KubeVirt devices'
  if (name.includes('nvidia.com/') || name.includes('amd.com/') || name.includes('intel.com/')) return 'Accelerators'
  return 'Other devices'
}

function formatValue(name: string, value: string | undefined) {
  if (value === undefined) return '—'
  if (name === 'memory' || name === 'ephemeral-storage' || name.startsWith('hugepages-')) return bytes(quantity(value))
  if (name === 'cpu') return `${cores(quantity(value))} cores`
  return String(quantity(value))
}

// Requests of the virt-launcher pods here are not visible; approximate VM
// demand from the guests' own specs so the table shows how full the node is.
const guestDemand = computed(() => {
  let cpu = 0
  let memory = 0
  for (const vmi of inv.vmis.filter((v) => v.status?.nodeName === props.ctx.name)) {
    const requests = vmi.spec?.domain?.resources?.requests ?? {}
    cpu += quantity(requests.cpu ?? 0)
    memory += quantity(requests.memory ?? vmi.spec?.domain?.memory?.guest ?? 0)
  }
  return { cpu, memory }
})

const resources = computed<ResourceRow[]>(() => {
  const capacity = node.value?.status?.capacity ?? {}
  const allocatable = node.value?.status?.allocatable ?? {}
  const names = [...new Set([...Object.keys(capacity), ...Object.keys(allocatable)])]
  const order = ['Compute', 'Huge pages', 'KubeVirt devices', 'Accelerators', 'Other devices']
  return names
    .map((name) => ({
      name,
      category: categoryOf(name),
      capacity: formatValue(name, capacity[name]),
      allocatable: formatValue(name, allocatable[name]),
      requested: name === 'cpu' ? guestDemand.value.cpu : name === 'memory' ? guestDemand.value.memory : null,
    }))
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name))
})

// --- labels ---------------------------------------------------------------------
interface Group {
  id: string
  title: string
  prefix: string
  hint: string
}

const GROUPS: Group[] = [
  { id: 'host-model', title: 'Host-model CPU', prefix: 'host-model-cpu.node.kubevirt.io/', hint: 'The model libvirt reports for host-model VMs on this node' },
  { id: 'models', title: 'Usable CPU models', prefix: 'cpu-model.node.kubevirt.io/', hint: 'Named models a VM may request here' },
  { id: 'migration-models', title: 'Migration-compatible CPU models', prefix: 'cpu-model-migration.node.kubevirt.io/', hint: 'Models a VM can migrate into this node with' },
  { id: 'features', title: 'CPU features', prefix: 'cpu-feature.node.kubevirt.io/', hint: 'Flags that can be required or forbidden per VM' },
  { id: 'required', title: 'Host-model required features', prefix: 'host-model-required-features.node.kubevirt.io/', hint: 'Features a host-model VM from this node needs on its target' },
  { id: 'machines', title: 'Machine types', prefix: 'machine-type.node.kubevirt.io/', hint: 'QEMU machine types available' },
  { id: 'hyperv', title: 'Hyper-V enlightenments', prefix: 'hyperv.node.kubevirt.io/', hint: 'For Windows guests' },
  { id: 'timer', title: 'CPU timer', prefix: 'cpu-timer.node.kubevirt.io/', hint: 'TSC frequency and scaling' },
  { id: 'scheduling', title: 'Scheduling', prefix: 'scheduling.node.kubevirt.io/', hint: 'Constraints KubeVirt schedules by' },
  { id: 'vendor', title: 'CPU vendor', prefix: 'cpu-vendor.node.kubevirt.io/', hint: '' },
]

function members(prefix: string) {
  return Object.entries(labels.value)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => ({ name: k.slice(prefix.length), value: v }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

const groups = computed(() => GROUPS.map((g) => ({ ...g, members: members(g.prefix) })).filter((g) => g.members.length))
const open = ref(new Set(['host-model', 'machines']))
function toggle(id: string) {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

const kubevirtFlags = computed(() =>
  Object.entries(labels.value)
    .filter(([k]) => k.startsWith('kubevirt.io/'))
    .map(([k, v]) => ({ name: k.slice('kubevirt.io/'.length), value: v })),
)
const heartbeat = computed(() => node.value?.metadata.annotations?.['kubevirt.io/heartbeat'])
const tsc = computed(() => labels.value['cpu-timer.node.kubevirt.io/tsc-frequency'])
const sev = computed(() => node.value?.status?.allocatable?.['devices.kubevirt.io/sev'])
</script>

<template>
  <div class="space-y-4 p-3">
    <Notice v-if="labels['kubevirt.io/schedulable'] !== 'true'" kind="warning" title="Not schedulable for VMs">
      KubeVirt's handler does not mark this node as able to run virtual machines{{ labels['kubevirt.io/schedulable'] === 'false' ? ' (virt-handler reports it unschedulable)' : ' (no virt-handler label)' }}.
    </Notice>

    <div class="grid gap-3 xl:grid-cols-3">
      <div class="card xl:col-span-2">
        <div class="card-header"><Fa :icon="faPlug" class="text-fg-muted" /> Resources and devices</div>
        <div class="overflow-auto">
          <table class="table-dense">
            <thead>
              <tr><th>Resource</th><th>Category</th><th class="text-right">Capacity</th><th class="text-right">Allocatable</th><th class="text-right">Running guests request</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in resources" :key="r.name">
                <td class="mono">{{ r.name }}</td>
                <td class="text-fg-muted">{{ r.category }}</td>
                <td class="text-right tabular-nums">{{ r.capacity }}</td>
                <td class="text-right tabular-nums">{{ r.allocatable }}</td>
                <td class="text-right tabular-nums text-fg-muted">
                  <template v-if="r.requested !== null">{{ r.name === 'memory' ? bytes(r.requested) : cores(r.requested) }}</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><Fa :icon="faMicrochip" class="text-fg-muted" /> Virtualization</div>
        <dl class="kv p-3">
          <dt>Runs VMs</dt>
          <dd :class="labels['kubevirt.io/schedulable'] === 'true' ? 'text-ok' : 'text-warn'">{{ labels['kubevirt.io/schedulable'] ?? 'unknown' }}</dd>
          <dt>Handler heartbeat</dt>
          <dd>{{ heartbeat ? new Date(heartbeat).toLocaleString() : '—' }}</dd>
          <dt>KVM</dt>
          <dd>{{ node?.status?.allocatable?.['devices.kubevirt.io/kvm'] ? 'available' : 'not advertised' }}</dd>
          <dt>Host-model CPU</dt>
          <dd>{{ members('host-model-cpu.node.kubevirt.io/').map((m) => m.name).join(', ') || '—' }}</dd>
          <dt>CPU vendor</dt>
          <dd>{{ members('cpu-vendor.node.kubevirt.io/').map((m) => m.name).join(', ') || '—' }}</dd>
          <dt>TSC frequency</dt>
          <dd>{{ tsc ? `${(Number(tsc) / 1e9).toFixed(3)} GHz${labels['cpu-timer.node.kubevirt.io/tsc-scalable'] === 'true' ? ' (scalable)' : ''}` : '—' }}</dd>
          <dt>AMD SEV</dt>
          <dd>{{ sev && Number(sev) > 0 ? `${sev} slots` : 'not available' }}</dd>
          <template v-for="flag in kubevirtFlags" :key="flag.name">
            <dt class="mono text-xs">{{ flag.name }}</dt>
            <dd class="mono">{{ flag.value }}</dd>
          </template>
        </dl>
      </div>
    </div>

    <section>
      <h3 class="panel-title mb-2 flex items-center gap-2"><Fa :icon="faLayerGroup" class="text-fg-muted" /> Discovered capabilities</h3>
      <Notice v-if="!groups.length" kind="empty">No KubeVirt node-labeller labels on this node.</Notice>
      <div class="space-y-2">
        <div v-for="g in groups" :key="g.id" class="card">
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2" @click="toggle(g.id)">
            <span class="font-semibold">{{ g.title }}</span>
            <span class="chip">{{ g.members.length }}</span>
            <span class="truncate text-xs text-fg-muted">{{ g.hint }}</span>
            <span class="ml-auto text-xs text-fg-subtle">{{ open.has(g.id) ? 'hide' : 'show' }}</span>
          </button>
          <div v-if="open.has(g.id)" class="flex flex-wrap gap-1 border-t border-line p-3">
            <span v-for="m in g.members" :key="m.name" class="chip mono" :title="m.value">
              {{ m.name }}<template v-if="m.value !== 'true'">={{ m.value }}</template>
            </span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
