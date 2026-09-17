<script setup lang="ts">
/** A table of USB devices with attach/detach, used on the datacenter and node screens. */
import { computed, ref } from 'vue'
import { faPlug, faLinkSlash } from '@fortawesome/free-solid-svg-icons'
import type { KObject } from '@/api/types'
import { can } from '@/stores/access'
import { openDialog } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import { age } from '@/util/format'
import { routeTo } from '@/util/nav'
import AttachUsbDialog from './AttachUsbDialog.vue'
import { deviceLabel, detachClaim, useUsb } from './store'

const props = withDefaults(defineProps<{ devices: KObject[]; showNode?: boolean; loading?: boolean }>(), { showNode: true })
const usb = useUsb()
const selected = ref<string | null>(null)

const columns = computed<Column<KObject>[]>(() => [
  { key: 'product', label: 'Device', value: (d) => deviceLabel(d) },
  { key: 'serial', label: 'Serial', value: (d) => d.spec?.serial ?? '' },
  { key: 'class', label: 'Class', value: (d) => d.status?.deviceClass ?? (d.status?.interfaceClasses ?? []).join(', ') },
  ...(props.showNode ? [{ key: 'node', label: 'Node', value: (d: KObject) => d.status?.node ?? '' }] : []),
  { key: 'port', label: 'Port', value: (d) => d.status?.portPath ?? '' },
  { key: 'identity', label: 'Identity', value: (d) => d.spec?.identity },
  { key: 'phase', label: 'Phase', value: (d) => d.status?.phase ?? '' },
  { key: 'seen', label: 'Last seen', value: (d) => d.status?.lastSeen ?? '' },
  { key: 'claim', label: 'Attached to', value: (d) => (d.status?.attachedTo ? `${d.status.attachedTo.namespace}/${d.status.attachedTo.vmName}` : '') },
])

const canAttach = (namespace?: string) => can({ verb: 'create', group: 'atomicusb.safewords.io', resource: 'usbdeviceclaims', namespace }) !== false

function claimFor(device: KObject): KObject | undefined {
  const a = device.status?.attachedTo
  if (!a) return undefined
  return usb.claims.find((c) => c.metadata.namespace === a.namespace && c.metadata.name === a.claim)
}

function attach(device: KObject) {
  openDialog(AttachUsbDialog, { device })
}

function detach(device: KObject) {
  const claim = claimFor(device)
  const a = device.status?.attachedTo
  if (claim) detachClaim(claim)
  else if (a) detachClaim({ metadata: { name: a.claim, namespace: a.namespace, uid: a.claimUid }, spec: { vmName: a.vmName }, status: { deviceName: device.metadata.name } })
}
</script>

<template>
  <DataTable
    :columns="columns"
    :rows="devices"
    :row-key="(d) => d.metadata.uid"
    :selected="selected"
    :loading="loading"
    filterable
    empty-text="No USB devices discovered"
    @select="(d) => (selected = d.metadata.uid)"
  >
    <template #cell-phase="{ value }">
      <span :class="value === 'Available' ? 'text-ok' : value === 'Lost' ? 'text-bad' : 'text-warn'">{{ value || '—' }}</span>
    </template>
    <template #cell-seen="{ value }">{{ value ? `${age(value as string)} ago` : '—' }}</template>
    <template #cell-claim="{ row, value }">
      <span class="flex items-center gap-2">
        <RouterLink
          v-if="row.status?.attachedTo"
          class="text-accent hover:underline"
          :to="routeTo({ kind: 'vm', name: row.status.attachedTo.vmName, namespace: row.status.attachedTo.namespace }, 'usb')"
          @click.stop
        >{{ value }}</RouterLink>
        <span v-else class="text-fg-subtle">—</span>
        <button v-if="row.status?.attachedTo" class="btn btn-sm btn-ghost ml-auto text-bad" :disabled="!canAttach(row.status.attachedTo.namespace)" @click.stop="detach(row)"><Fa :icon="faLinkSlash" /> Detach</button>
        <button v-else-if="row.status?.phase === 'Available'" class="btn btn-sm ml-auto" @click.stop="attach(row)"><Fa :icon="faPlug" /> Attach</button>
      </span>
    </template>
  </DataTable>
</template>
