<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  faPlus, faPenToSquare, faTrash, faUpRightAndDownLeftFromCenter, faHardDrive, faCompactDisc, faNetworkWired,
  faShieldHalved, faDice, faDog, faRotateRight,
} from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import { gateway, errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { can } from '@/stores/access'
import { openDialog, run } from '@/services/dialogs'
import { condition } from '@/util/kubevirt'
import DropdownMenu, { type MenuItem } from '@/components/ui/DropdownMenu.vue'
import Notice from '@/components/ui/Notice.vue'
import AddDiskDialog from './AddDiskDialog.vue'
import {
  editCpu, editDisk, editDisplay, editFirmware, editMachine, editMemory, editNic, editWatchdog, hardwareRows, removeDisk,
  removeListDevice, removeNic, resizeDisk, setRng, setTpm, type HardwareRow,
} from './hardware'
import { volumeInfo, volumesOf } from './spec'
import { vmApi } from '@/api/k8s'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()

const vm = computed(() => props.ctx.object)
const vmi = computed(() => props.ctx.related.vmi)
const usesInstancetype = computed(() => !!vm.value?.spec?.instancetype || !!vm.value?.spec?.preference)

// With an instance type or preference, the effective values only exist in the expanded spec.
const expanded = ref<any>(null)
const expandError = ref<string | null>(null)
watch(
  () => [usesInstancetype.value, vm.value?.metadata.resourceVersion] as const,
  async ([uses]) => {
    if (!uses || !vm.value) {
      expanded.value = null
      return
    }
    try {
      expanded.value = await gateway.call('vm.expandSpec', { namespace: props.ctx.namespace, name: props.ctx.name })
      expandError.value = null
    } catch (e) {
      expandError.value = errorMessage(e)
    }
  },
  { immediate: true },
)

const spec = computed(() => (vm.value ? (expanded.value?.spec?.template?.spec ?? vm.value.spec?.template?.spec) : vmi.value?.spec) ?? {})
const pvcByName = computed(() => new Map(inv.pvcs.filter((p) => p.metadata.namespace === props.ctx.namespace).map((p) => [p.metadata.name, p])))
const rows = computed(() => hardwareRows(spec.value, vmi.value, { pvc: (name) => pvcByName.value.get(name) ?? null }, !!vm.value?.spec?.instancetype))

const selectedId = ref<string | null>(null)
const selected = computed(() => rows.value.find((r) => r.id === selectedId.value) ?? null)

const restartRequired = computed(() => condition(vm.value, 'RestartRequired'))
const mayEdit = computed(() => !!vm.value && can({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: props.ctx.namespace, name: props.ctx.name }) === true)
const devices = computed(() => vm.value?.spec?.template?.spec?.domain?.devices ?? {})

const addItems = computed<MenuItem[]>(() => [
  { id: 'disk', title: 'Hard Disk', icon: faHardDrive, run: () => openDialog(AddDiskDialog, { ctx: props.ctx }) },
  { id: 'cdrom', title: 'CD/DVD Drive', icon: faCompactDisc, run: () => openDialog(AddDiskDialog, { ctx: props.ctx, cdrom: true }) },
  { id: 'nic', title: 'Network Device', icon: faNetworkWired, run: () => editNic(props.ctx) },
  { id: 'tpm', title: 'TPM State', icon: faShieldHalved, divider: true, disabled: !!devices.value.tpm, run: () => setTpm(props.ctx, true) },
  { id: 'rng', title: 'VirtIO RNG', icon: faDice, disabled: !!devices.value.rng, run: () => setRng(props.ctx, true) },
  { id: 'watchdog', title: 'Watchdog', icon: faDog, disabled: !!devices.value.watchdog, run: () => editWatchdog(props.ctx) },
])

function edit(row: HardwareRow | null) {
  if (!row || !row.editable || !mayEdit.value) return
  switch (row.kind) {
    case 'memory':
      return editMemory(props.ctx)
    case 'cpu':
      return editCpu(props.ctx)
    case 'firmware':
      return editFirmware(props.ctx)
    case 'machine':
      return editMachine(props.ctx)
    case 'display':
      return editDisplay(props.ctx)
    case 'disk':
      return editDisk(props.ctx, row.name!)
    case 'nic':
      return editNic(props.ctx, row.name)
    case 'tpm':
      return setTpm(props.ctx, true)
    case 'watchdog':
      return editWatchdog(props.ctx)
  }
}

function remove(row: HardwareRow | null) {
  if (!row || !row.removable || !mayEdit.value) return
  switch (row.kind) {
    case 'disk':
      return removeDisk(props.ctx, row.name!, !!row.hotplugged)
    case 'nic':
      return removeNic(props.ctx, row.name!)
    case 'tpm':
      return setTpm(props.ctx, false)
    case 'rng':
      return setRng(props.ctx, false)
    case 'watchdog':
      return editWatchdog(props.ctx, true)
    case 'gpu':
      return removeListDevice(props.ctx, 'gpus', row.name!, 'GPU')
    case 'hostDevice':
      return removeListDevice(props.ctx, 'hostDevices', row.name!, 'host device')
    case 'input':
      return removeListDevice(props.ctx, 'inputs', row.name!, 'input device')
  }
}

function resize(row: HardwareRow | null) {
  if (!row?.resizable) return
  const claim = volumeInfo(volumesOf(vm.value?.spec?.template?.spec).find((v) => v.name === row.name)).claim
  return resizeDisk(props.ctx, row.name!, claim ? (pvcByName.value.get(claim) ?? null) : null)
}

async function restart() {
  await run(`Restart ${props.ctx.name}`, () => vmApi.action('restart', props.ctx.namespace!, props.ctx.name), { openLog: true })
}
</script>

<template>
  <div class="space-y-3 p-3">
    <Notice v-if="restartRequired?.status === 'True'" kind="warning" title="Pending changes">
      <div class="flex items-center gap-3">
        <span class="flex-1">{{ restartRequired.message ?? 'The VM definition changed; restart the VM to apply it.' }}</span>
        <button class="btn btn-sm" @click="restart"><Fa :icon="faRotateRight" /> Restart now</button>
      </div>
    </Notice>
    <Notice v-if="usesInstancetype" kind="info">
      This VM takes {{ vm?.spec?.instancetype ? `its CPU and memory from instance type ${vm.spec.instancetype.name}` : '' }}{{ vm?.spec?.instancetype && vm?.spec?.preference ? ' and ' : '' }}{{ vm?.spec?.preference ? `device defaults from preference ${vm.spec.preference.name}` : '' }}. Values shown are the expanded result{{ vm?.spec?.instancetype ? '; change the instance type to resize it' : '' }}.
      <span v-if="expandError" class="text-bad"> ({{ expandError }})</span>
    </Notice>
    <Notice v-if="!vm && vmi" kind="info">This is a standalone VirtualMachineInstance; its hardware cannot be changed.</Notice>

    <div class="flex items-center gap-1.5">
      <DropdownMenu :items="addItems" :icon="faPlus" title="Add" :disabled="!mayEdit" />
      <button class="btn" :disabled="!mayEdit || !selected?.editable" @click="edit(selected)"><Fa :icon="faPenToSquare" /> Edit</button>
      <button class="btn" :disabled="!mayEdit || !selected?.removable" @click="remove(selected)"><Fa :icon="faTrash" /> Remove</button>
      <button class="btn" :disabled="!mayEdit || !selected?.resizable" @click="resize(selected)"><Fa :icon="faUpRightAndDownLeftFromCenter" /> Resize disk</button>
      <span v-if="vm && !mayEdit" class="ml-2 text-xs text-fg-subtle">Read-only: you may not change this VM.</span>
    </div>

    <div class="overflow-auto rounded-md border border-line bg-surface-1">
      <table class="table-dense">
        <tbody>
          <tr
            v-for="row in rows"
            :key="row.id"
            class="cursor-pointer"
            :class="{ selected: row.id === selectedId }"
            @click="selectedId = row.id"
            @dblclick="edit(row)"
          >
            <td class="w-72">
              <span class="flex items-center gap-2.5">
                <Fa :icon="row.icon" class="w-4 text-fg-muted" />
                <span class="font-medium">{{ row.label }}</span>
              </span>
            </td>
            <td class="max-w-0 truncate" :class="row.pending ? 'text-warn' : ''" :title="row.value">
              {{ row.value }}
              <span v-if="row.pending" class="chip ml-2 bg-warn/15 text-warn">after restart</span>
              <span v-if="row.hotplugged" class="chip ml-2 bg-info/15 text-info">hot-plugged</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-xs text-fg-subtle">Double-click a row to edit it. Most changes apply the next time the VM starts; disks can be hot-plugged into a running VM.</p>
  </div>
</template>
