<script setup lang="ts">
import { computed, ref } from 'vue'
import { faPlug, faLinkSlash, faToggleOn } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { can } from '@/stores/access'
import { confirm, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { useUsb, deviceLabel } from './store'

const props = defineProps<{ ctx: ObjectContext }>()
const usb = useUsb()

const mine = computed(() => usb.claims.filter((c) => c.metadata.namespace === props.ctx.namespace && c.spec?.vmName === props.ctx.name))
const selected = ref<string | null>(null)

// atomic-usb plugs devices into the usbredir sockets KubeVirt only creates
// for VMs that ask for them.
const passthrough = computed(() => !!props.ctx.object?.spec?.template?.spec?.domain?.devices?.clientPassthrough)
const runningWith = computed(() => props.ctx.related.vmi?.spec?.domain?.devices?.clientPassthrough !== undefined)
const needsRestart = computed(() => passthrough.value && !!props.ctx.related.vmi && !runningWith.value)
const canPatch = computed(() => can({ verb: 'patch', group: 'kubevirt.io', resource: 'virtualmachines', namespace: props.ctx.namespace, name: props.ctx.name }) === true)

const claimColumns: Column<KObject>[] = [
  { key: 'name', label: 'Claim', value: (c) => c.metadata.name },
  { key: 'phase', label: 'Phase', value: (c) => c.status?.phase },
  { key: 'device', label: 'Device', value: (c) => c.status?.deviceName },
  { key: 'from', label: 'Plugged into', value: (c) => c.status?.sourceNode },
  { key: 'connection', label: 'Connection', value: (c) => c.status?.connection?.state },
  { key: 'message', label: 'Message', value: (c) => c.status?.message },
]
const deviceColumns: Column<KObject>[] = [
  { key: 'product', label: 'Device', value: (d) => deviceLabel(d) },
  { key: 'serial', label: 'Serial', value: (d) => d.spec?.serial ?? '' },
  { key: 'node', label: 'Node', value: (d) => d.status?.node },
  { key: 'port', label: 'Port', value: (d) => d.status?.portPath },
  { key: 'phase', label: 'Phase', value: (d) => d.status?.phase },
  { key: 'claim', label: 'Claimed by', value: (d) => (d.status?.attachedTo ? `${d.status.attachedTo.namespace}/${d.status.attachedTo.vmName}` : '') },
]

async function enablePassthrough() {
  const running = !!props.ctx.related.vmi
  const ok = await confirm({
    title: 'Enable USB redirection',
    message: `Add devices.clientPassthrough to ${props.ctx.name}? KubeVirt then creates the usbredir sockets atomic-usb attaches devices through.${running ? '\n\nThe VM is running: it takes effect after the next restart.' : ''}`,
    confirmText: 'Enable',
  })
  if (!ok) return
  await run(`Enable USB redirection on ${props.ctx.name}`, () =>
    k8s.patch(
      { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace: props.ctx.namespace, name: props.ctx.name },
      { spec: { template: { spec: { domain: { devices: { clientPassthrough: {} } } } } } },
    ),
  )
}

async function attach(device: KObject) {
  if (device.status?.attachedTo) return
  const ok = await confirm({
    title: 'Attach USB device',
    message: `Attach ${deviceLabel(device)} (plugged into ${device.status?.node}) to ${props.ctx.name}? It is hot-plugged into the running guest and follows the device if it is moved to another node.`,
    confirmText: 'Attach',
  })
  if (ok) await run('Attach USB device', () => gateway.call('usb.attach', { namespace: props.ctx.namespace, vm: props.ctx.name, device: device.metadata.name }), { openLog: true })
}

async function detach(claim: KObject) {
  const ok = await confirm({ title: 'Detach USB device', message: `Detach ${claim.status?.deviceName ?? claim.metadata.name} from ${props.ctx.name}?`, confirmText: 'Detach', danger: true })
  if (ok) await run('Detach USB device', () => gateway.call('usb.detach', { namespace: props.ctx.namespace, claim: claim.metadata.name }))
}
</script>

<template>
  <div class="space-y-4 p-3">
    <Notice v-if="ctx.object && !passthrough" kind="warning" title="USB redirection is not enabled on this VM">
      <div class="flex flex-wrap items-center gap-3">
        <span>atomic-usb needs <code class="mono">spec.template.spec.domain.devices.clientPassthrough</code>; claims for this VM wait in <code class="mono">VMNotConfigured</code> until it is set.</span>
        <button class="btn btn-sm btn-primary" :disabled="!canPatch" @click="enablePassthrough"><Fa :icon="faToggleOn" /> Enable</button>
      </div>
    </Notice>
    <Notice v-else-if="needsRestart" kind="info">USB redirection is enabled in the definition but the running instance predates it. Restart the VM to attach devices.</Notice>

    <section>
      <h3 class="panel-title mb-2">Attached to this VM</h3>
      <DataTable :columns="claimColumns" :rows="mine" :row-key="(c) => c.metadata.uid" empty-text="No USB devices are claimed for this VM">
        <template #cell-phase="{ value }"><span :class="value === 'Attached' ? 'text-ok' : 'text-warn'">{{ value ?? 'Pending' }}</span></template>
        <template #cell-message="{ row, value }">
          <span class="flex items-center gap-2">
            <span class="truncate text-fg-muted">{{ value }}</span>
            <button class="btn btn-sm btn-danger ml-auto" @click.stop="detach(row)"><Fa :icon="faLinkSlash" /> Detach</button>
          </span>
        </template>
      </DataTable>
    </section>
    <section>
      <h3 class="panel-title mb-2">Devices in the cluster</h3>
      <Notice v-if="usb.devicesError" kind="warning">{{ usb.devicesError.message }}</Notice>
      <DataTable
        v-else
        :columns="deviceColumns"
        :rows="usb.devices"
        :row-key="(d) => d.metadata.uid"
        :selected="selected"
        :loading="!usb.devicesSynced"
        filterable
        empty-text="No USB devices discovered"
        @select="(d) => (selected = d.metadata.uid)"
        @activate="attach"
      >
        <template #cell-phase="{ value }"><span :class="value === 'Available' ? 'text-ok' : 'text-warn'">{{ value }}</span></template>
        <template #cell-claim="{ row, value }">
          <span class="flex items-center gap-2">
            <span class="text-fg-muted">{{ value }}</span>
            <button v-if="!row.status?.attachedTo && row.status?.phase === 'Available'" class="btn btn-sm ml-auto" :disabled="!passthrough" @click.stop="attach(row)"><Fa :icon="faPlug" /> Attach</button>
          </span>
        </template>
      </DataTable>
    </section>
  </div>
</template>
