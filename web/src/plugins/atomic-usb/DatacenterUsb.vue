<script setup lang="ts">
import { computed } from 'vue'
import { faPlus, faLinkSlash } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { openDialog } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age } from '@/util/format'
import { routeTo } from '@/util/nav'
import AttachUsbDialog from './AttachUsbDialog.vue'
import UsbDevicesTable from './UsbDevicesTable.vue'
import { detachClaim, useUsb } from './store'

defineProps<{ ctx: ObjectContext }>()
const usb = useUsb()

const summary = computed(() => {
  const nodes = new Set(usb.devices.map((d) => d.status?.node).filter(Boolean))
  return {
    total: usb.devices.length,
    available: usb.devices.filter((d) => d.status?.phase === 'Available').length,
    attached: usb.devices.filter((d) => d.status?.attachedTo).length,
    nodes: nodes.size,
    pending: usb.claims.filter((c) => c.status?.phase !== 'Attached').length,
  }
})

const claimColumns: Column<KObject>[] = [
  { key: 'name', label: 'Claim', value: (c) => `${c.metadata.namespace}/${c.metadata.name}` },
  { key: 'vm', label: 'VM', value: (c) => c.spec?.vmName },
  { key: 'phase', label: 'Phase', value: (c) => c.status?.phase ?? 'Pending' },
  { key: 'device', label: 'Device', value: (c) => c.status?.deviceName ?? '' },
  { key: 'selector', label: 'Selector', value: (c) => Object.entries(c.spec?.selector ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') },
  { key: 'route', label: 'Path', value: (c) => (c.status?.sourceNode ? `${c.status.sourceNode} → ${c.status.connection?.node ?? '?'}` : '') },
  { key: 'connection', label: 'Connection', value: (c) => c.status?.connection?.state ?? '' },
  { key: 'age', label: 'Age', value: (c) => age(c.metadata.creationTimestamp) },
]
</script>

<template>
  <div class="space-y-4 p-3">
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <div class="card p-3"><div class="text-fg-muted">Devices</div><div class="text-xl font-semibold tabular-nums">{{ summary.total }}</div></div>
      <div class="card p-3"><div class="text-fg-muted">Available</div><div class="text-xl font-semibold tabular-nums text-ok">{{ summary.available }}</div></div>
      <div class="card p-3"><div class="text-fg-muted">Attached</div><div class="text-xl font-semibold tabular-nums">{{ summary.attached }}</div></div>
      <div class="card p-3"><div class="text-fg-muted">Nodes with devices</div><div class="text-xl font-semibold tabular-nums">{{ summary.nodes }}</div></div>
      <div class="card p-3"><div class="text-fg-muted">Claims waiting</div><div class="text-xl font-semibold tabular-nums" :class="summary.pending ? 'text-warn' : ''">{{ summary.pending }}</div></div>
    </div>

    <section>
      <div class="mb-2 flex items-center gap-2">
        <h3 class="panel-title">USB devices</h3>
        <button class="btn btn-sm btn-primary ml-auto" @click="openDialog(AttachUsbDialog, {})"><Fa :icon="faPlus" /> Attach device to VM</button>
      </div>
      <Notice v-if="usb.devicesError" kind="warning">{{ usb.devicesError.message }}</Notice>
      <UsbDevicesTable v-else :devices="usb.devices" :loading="!usb.devicesSynced" />
    </section>

    <section>
      <h3 class="panel-title mb-2">Claims</h3>
      <Notice v-if="usb.claimsError" kind="warning">{{ usb.claimsError.message }}</Notice>
      <DataTable v-else :columns="claimColumns" :rows="usb.claims" :row-key="(c) => c.metadata.uid" filterable :loading="!usb.claimsSynced" empty-text="No UsbDeviceClaims">
        <template #cell-vm="{ row, value }">
          <RouterLink class="text-accent hover:underline" :to="routeTo({ kind: 'vm', name: value as string, namespace: row.metadata.namespace }, 'usb')" @click.stop>{{ value }}</RouterLink>
        </template>
        <template #cell-phase="{ row, value }">
          <span :class="value === 'Attached' ? 'text-ok' : 'text-warn'" :title="row.status?.message">{{ value }}</span>
        </template>
        <template #cell-age="{ row, value }">
          <span class="flex items-center gap-2">
            <span class="text-fg-muted">{{ value }}</span>
            <button class="btn btn-sm btn-ghost ml-auto text-bad" @click.stop="detachClaim(row)"><Fa :icon="faLinkSlash" /> Detach</button>
          </span>
        </template>
      </DataTable>
    </section>
    <p class="text-xs text-fg-muted">atomic-usb forwards USB over the pod network without encryption, and anyone who may create a UsbDeviceClaim can take any device on any node. Grant <span class="mono">usbdeviceclaims</span> carefully.</p>
  </div>
</template>
