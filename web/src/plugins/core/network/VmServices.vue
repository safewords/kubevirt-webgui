<script setup lang="ts">
import { computed } from 'vue'
import { faPlus, faTrash, faCopy } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { useWatch } from '@/stores/watch'
import { useInventory } from '@/plugins/core/inventory'
import { can } from '@/stores/access'
import { confirm, openDialog, run, toast } from '@/services/dialogs'
import { copyText } from '@/util/clipboard'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import { age } from '@/util/format'
import ExposeDialog from './ExposeDialog.vue'
import { exposedVm, externalAddresses, servicePorts } from './services'

const props = defineProps<{ ctx: ObjectContext }>()
const inv = useInventory()
const services = useWatch(() => ({ apiVersion: 'v1', resource: 'services', namespace: props.ctx.namespace }))
const mine = computed(() => services.items.value.filter((s) => exposedVm(s) === props.ctx.name))

const nodeAddresses = computed(() => {
  const out: string[] = []
  for (const node of inv.nodes) {
    const addr = (node.status?.addresses ?? []).find((a: any) => a.type === 'ExternalIP') ?? (node.status?.addresses ?? []).find((a: any) => a.type === 'InternalIP')
    if (addr) out.push(addr.address)
  }
  return out
})

const columns: Column<KObject>[] = [
  { key: 'name', label: 'Service', value: (s) => s.metadata.name },
  { key: 'type', label: 'Type', value: (s) => s.spec?.type },
  { key: 'clusterIP', label: 'Cluster IP', value: (s) => s.spec?.clusterIP },
  { key: 'ports', label: 'Ports', value: servicePorts },
  { key: 'external', label: 'External address', value: (s) => externalAddresses(s).join(', ') },
  { key: 'age', label: 'Age', value: (s) => age(s.metadata.creationTimestamp) },
]

const canCreate = computed(() => can({ verb: 'create', resource: 'services', namespace: props.ctx.namespace }) === true)
const canDelete = computed(() => can({ verb: 'delete', resource: 'services', namespace: props.ctx.namespace }) === true)

function endpoints(s: KObject): string[] {
  const out: string[] = []
  const ports = (s.spec?.ports ?? []) as any[]
  for (const p of ports) {
    for (const addr of externalAddresses(s)) out.push(`${addr}:${p.port}`)
    if (s.spec?.type === 'NodePort' || s.spec?.type === 'LoadBalancer') for (const node of nodeAddresses.value.slice(0, 1)) if (p.nodePort) out.push(`${node}:${p.nodePort}`)
    out.push(`${s.metadata.name}.${s.metadata.namespace}.svc:${p.port}`)
  }
  return out
}

async function copy(text: string) {
  if (await copyText(text)) toast('success', 'Copied', text)
  else toast('error', 'Could not copy', 'The browser blocked clipboard access')
}

async function remove(s: KObject) {
  const ok = await confirm({ title: 'Delete service', message: `Delete the service ${s.metadata.name}? ${props.ctx.name} stops being reachable through it.`, confirmText: 'Delete', danger: true })
  if (ok) await run('Delete service', () => k8s.delete({ apiVersion: 'v1', resource: 'services', namespace: props.ctx.namespace, name: s.metadata.name }))
}
</script>

<template>
  <div class="space-y-3 p-3">
    <div class="flex items-center gap-2">
      <h3 class="panel-title">Services exposing {{ ctx.name }}</h3>
      <button class="btn btn-sm btn-primary ml-auto" :disabled="!canCreate" @click="openDialog(ExposeDialog, { namespace: ctx.namespace, vm: ctx.name })"><Fa :icon="faPlus" /> Expose</button>
    </div>
    <Notice v-if="services.error.value" kind="warning">{{ services.error.value.message }}</Notice>
    <DataTable v-else :columns="columns" :rows="mine" :row-key="(s) => s.metadata.uid" :loading="!services.synced.value" empty-text="Not exposed: reachable only from inside the cluster through its pod address">
      <template #cell-type="{ value }"><span class="chip">{{ value }}</span></template>
      <template #cell-external="{ row, value }">
        <span class="flex items-center gap-2">
          <span class="mono">{{ value || (row.spec?.type === 'LoadBalancer' ? 'pending…' : '—') }}</span>
          <button class="btn btn-sm btn-ghost ml-auto text-bad" :disabled="!canDelete" title="Delete" @click.stop="remove(row)"><Fa :icon="faTrash" /></button>
        </span>
      </template>
    </DataTable>
    <div v-if="mine.length" class="card">
      <div class="card-header">Connect</div>
      <div class="space-y-1 p-3">
        <div v-for="s in mine" :key="s.metadata.uid">
          <div v-for="e in endpoints(s)" :key="e" class="flex items-center gap-2">
            <span class="mono">{{ e }}</span>
            <button class="btn btn-sm btn-ghost" @click="copy(e)"><Fa :icon="faCopy" /></button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
