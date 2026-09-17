<script setup lang="ts">
/** Cluster networking for VMs: secondary networks (Multus) and exposed services. */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { useCluster } from '@/stores/cluster'
import { useMultiWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { useInventory } from '@/plugins/core/inventory'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age } from '@/util/format'
import { routeTo } from '@/util/nav'
import { exposedVm, externalAddresses, servicePorts } from './services'

defineProps<{ ctx: ObjectContext }>()
const cluster = useCluster()
const inv = useInventory()
const router = useRouter()

function scope(group: string, resource: string) {
  return () => {
    const allowed = can({ verb: 'list', group, resource })
    if (allowed === undefined) return []
    return allowed ? null : inv.reachableNamespaces
  }
}

const nadVersion = computed(() => cluster.versionFor('k8s.cni.cncf.io', 'network-attachment-definitions'))
const nads = useMultiWatch(() => (nadVersion.value ? { apiVersion: nadVersion.value, resource: 'network-attachment-definitions' } : null), scope('k8s.cni.cncf.io', 'network-attachment-definitions'))
const services = useMultiWatch(() => ({ apiVersion: 'v1', resource: 'services' }), scope('', 'services'))

const vmServices = computed(() => services.items.value.filter((s) => exposedVm(s)))

function nadConfig(nad: KObject): { type: string; detail: string } {
  try {
    const config = JSON.parse(nad.spec?.config ?? '{}')
    const plugin = config.type ? config : (config.plugins ?? [])[0] ?? {}
    const detail = plugin.bridge ?? plugin.master ?? plugin.device ?? plugin.ipam?.type ?? ''
    return { type: plugin.type ?? '—', detail: `${detail}${plugin.vlan ? ` · VLAN ${plugin.vlan}` : ''}` }
  } catch {
    return { type: 'invalid JSON', detail: '' }
  }
}

const nadColumns: Column<KObject>[] = [
  { key: 'name', label: 'Network', value: (n) => n.metadata.name },
  { key: 'namespace', label: 'Namespace', value: (n) => n.metadata.namespace },
  { key: 'type', label: 'CNI plugin', value: (n) => nadConfig(n).type },
  { key: 'detail', label: 'Bridge / device', value: (n) => nadConfig(n).detail },
  { key: 'resource', label: 'Resource', value: (n) => n.metadata.annotations?.['k8s.v1.cni.cncf.io/resourceName'] ?? '' },
  { key: 'users', label: 'VMs', align: 'right', value: (n) => inv.vms.filter((vm) => (vm.spec?.template?.spec?.networks ?? []).some((net: any) => [n.metadata.name, `${n.metadata.namespace}/${n.metadata.name}`].includes(net.multus?.networkName))).length },
]

const serviceColumns: Column<KObject>[] = [
  { key: 'vm', label: 'VM', value: (s) => `${s.metadata.namespace}/${exposedVm(s)}` },
  { key: 'name', label: 'Service', value: (s) => s.metadata.name },
  { key: 'type', label: 'Type', value: (s) => s.spec?.type },
  { key: 'ports', label: 'Ports', value: servicePorts },
  { key: 'clusterIP', label: 'Cluster IP', value: (s) => s.spec?.clusterIP },
  { key: 'external', label: 'External address', value: (s) => externalAddresses(s).join(', ') },
  { key: 'age', label: 'Age', value: (s) => age(s.metadata.creationTimestamp) },
]
</script>

<template>
  <div class="space-y-4 p-3">
    <section>
      <h3 class="panel-title mb-2">Secondary networks</h3>
      <Notice v-if="!nadVersion" kind="info" title="Multus is not installed">
        Every VM gets the pod network (masquerade NAT by default). To attach VMs to VLANs or host bridges — Proxmox's <span class="mono">vmbr</span> — install Multus and define NetworkAttachmentDefinitions; they will be listed here and offered when creating VMs.
      </Notice>
      <template v-else>
        <Notice v-if="nads.error.value" kind="warning">{{ nads.error.value.message }}</Notice>
        <DataTable v-else :columns="nadColumns" :rows="nads.items.value" :row-key="(n) => n.metadata.uid" filterable :loading="!nads.synced.value" empty-text="No NetworkAttachmentDefinitions" />
      </template>
    </section>
    <section>
      <h3 class="panel-title mb-2">Services exposing VMs</h3>
      <Notice v-if="services.error.value" kind="warning">{{ services.error.value.message }}</Notice>
      <DataTable
        v-else
        :columns="serviceColumns"
        :rows="vmServices"
        :row-key="(s) => s.metadata.uid"
        filterable
        :loading="!services.synced.value"
        empty-text="No VM is exposed through a Service"
        @activate="(s) => router.push(routeTo({ kind: 'vm', name: exposedVm(s)!, namespace: s.metadata.namespace }, 'services'))"
      >
        <template #cell-type="{ value }"><span class="chip">{{ value }}</span></template>
        <template #cell-external="{ row, value }"><span class="mono">{{ value || (row.spec?.type === 'LoadBalancer' ? 'pending…' : '—') }}</span></template>
      </DataTable>
    </section>
  </div>
</template>
