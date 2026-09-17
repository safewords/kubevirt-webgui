<script setup lang="ts">
/** A VM's network devices: what is configured, and what the guest reports. */
import { computed } from 'vue'
import type { ObjectContext } from '@/plugins/registry'
import Notice from '@/components/ui/Notice.vue'
import { templateSpec } from '@/util/kubevirt'

const props = defineProps<{ ctx: ObjectContext }>()

const BINDINGS = ['masquerade', 'bridge', 'sriov', 'passt', 'slirp', 'macvtap']

const rows = computed(() => {
  const spec = templateSpec(props.ctx.object ?? props.ctx.related.vmi)
  const interfaces: any[] = spec?.domain?.devices?.interfaces ?? []
  const networks: any[] = spec?.networks ?? []
  const status: any[] = props.ctx.related.vmi?.status?.interfaces ?? []
  const names = new Set([...interfaces.map((i) => i.name), ...status.map((s) => s.name).filter(Boolean)])
  return [...names].map((name) => {
    const iface = interfaces.find((i) => i.name === name) ?? {}
    const network = networks.find((n) => n.name === name) ?? {}
    const live = status.find((s) => s.name === name) ?? {}
    const binding = iface.binding?.name ?? BINDINGS.find((b) => iface[b] !== undefined) ?? (live.name ? '—' : '')
    const source = network.pod ? `pod network${network.pod.vmNetworkCIDR ? ` (${network.pod.vmNetworkCIDR})` : ''}` : network.multus ? `Multus ${network.multus.networkName}${network.multus.default ? ' (default)' : ''}` : '—'
    return {
      name,
      binding,
      source,
      model: iface.model ?? 'virtio',
      mac: live.mac ?? iface.macAddress ?? '',
      configuredMac: iface.macAddress,
      ips: (live.ipAddresses ?? (live.ipAddress ? [live.ipAddress] : [])) as string[],
      guestName: live.interfaceName ?? '',
      infoSource: live.infoSource ?? '',
      linkState: live.linkState ?? iface.state ?? '',
      ports: (iface.ports ?? []) as any[],
      queues: live.queueCount,
      hotplugged: !interfaces.some((i) => i.name === name),
    }
  })
})

const guestOnly = computed(() => (props.ctx.related.vmi?.status?.interfaces ?? []).filter((s: any) => !s.name))
</script>

<template>
  <div class="space-y-3 p-3">
    <h3 class="panel-title">Network devices</h3>
    <div class="overflow-auto rounded-md border border-line bg-surface-1">
      <table class="table-dense">
        <thead>
          <tr>
            <th>Device</th>
            <th>Binding</th>
            <th>Network</th>
            <th>Model</th>
            <th>MAC address</th>
            <th>IP addresses</th>
            <th>In guest</th>
            <th>Link</th>
            <th>Reported by</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name">
            <td class="font-medium">{{ row.name }}</td>
            <td><span class="chip">{{ row.binding || '—' }}</span></td>
            <td>{{ row.source }}</td>
            <td>{{ row.model }}</td>
            <td class="mono" :title="row.configuredMac ? 'fixed in the VM definition' : 'assigned at start'">{{ row.mac || '—' }}{{ row.configuredMac ? ' ★' : '' }}</td>
            <td class="mono whitespace-normal">
              <span v-if="!row.ips.length" class="text-fg-subtle">{{ ctx.related.vmi ? 'none reported' : 'not running' }}</span>
              <span v-for="ip in row.ips" :key="ip" class="mr-2 inline-block">{{ ip }}</span>
            </td>
            <td class="mono">{{ row.guestName || '—' }}</td>
            <td :class="row.linkState === 'down' ? 'text-warn' : row.linkState === 'up' ? 'text-ok' : 'text-fg-subtle'">{{ row.linkState || '—' }}</td>
            <td class="text-fg-muted">{{ row.infoSource || '—' }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="9" class="h-12 text-center text-fg-subtle">No network devices: the VM is isolated</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="rows.some((r) => r.ports.length)" class="card">
      <div class="card-header">Declared ports</div>
      <div class="p-3">
        <div v-for="row in rows.filter((r) => r.ports.length)" :key="row.name">
          <span class="font-medium">{{ row.name }}:</span>
          <span v-for="p in row.ports" :key="`${p.port}${p.protocol}`" class="chip ml-1">{{ p.name ? `${p.name} ` : '' }}{{ p.port }}/{{ p.protocol ?? 'TCP' }}</span>
        </div>
      </div>
    </div>
    <div v-if="guestOnly.length" class="card">
      <div class="card-header">Guest-only interfaces <span class="font-normal text-fg-muted">(reported by the guest agent, not configured on the VM)</span></div>
      <div class="p-3">
        <div v-for="(g, i) in guestOnly" :key="i" class="mono">{{ g.interfaceName }} {{ g.mac }} {{ (g.ipAddresses ?? []).join(' ') }}</div>
      </div>
    </div>
    <Notice v-if="ctx.related.vmi && !rows.some((r) => r.infoSource.includes('guest-agent'))" kind="info">
      Guest interface names and extra addresses appear once the QEMU guest agent is running in the guest.
    </Notice>
  </div>
</template>
