<script setup lang="ts">
import { computed } from 'vue'
import { faPlus, faTrash, faFileCode, faLock } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { k8s } from '@/api/k8s'
import { useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { confirm, openDialog, run } from '@/services/dialogs'
import DataTable, { type Column } from '@/components/ui/DataTable.vue'
import Notice from '@/components/ui/Notice.vue'
import FirewallRuleDialog from './FirewallRuleDialog.vue'
import PolicyYamlDialog from './PolicyYamlDialog.vue'

const props = defineProps<{ ctx: ObjectContext; vm?: string }>()
const namespace = computed(() => props.ctx.namespace ?? props.ctx.name)
const policies = useWatch(() => ({ apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: namespace.value }))

function selectorText(selector: any): string {
  const labels = selector?.matchLabels ?? {}
  const keys = Object.keys(labels)
  const exprs = (selector?.matchExpressions ?? []).map((e: any) => `${e.key} ${e.operator} ${(e.values ?? []).join('|')}`)
  if (!keys.length && !exprs.length) return 'all pods'
  if (labels['vm.kubevirt.io/name']) return `VM ${labels['vm.kubevirt.io/name']}`
  if (labels['kubevirt.io/vm']) return `VM ${labels['kubevirt.io/vm']}`
  if (labels['kubevirt.io'] === 'virt-launcher' && keys.length === 1) return 'all VMs'
  return [...keys.map((k) => `${k}=${labels[k]}`), ...exprs].join(', ')
}

function peerText(peer: any): string {
  if (peer.ipBlock) return `${peer.ipBlock.cidr}${peer.ipBlock.except?.length ? ` except ${peer.ipBlock.except.join(', ')}` : ''}`
  const parts: string[] = []
  if (peer.namespaceSelector) {
    const ns = peer.namespaceSelector.matchLabels?.['kubernetes.io/metadata.name']
    parts.push(ns ? `ns ${ns}` : `ns ${selectorText(peer.namespaceSelector)}`)
  }
  if (peer.podSelector) parts.push(selectorText(peer.podSelector))
  return parts.join(' / ')
}

function portsText(ports: any[] | undefined): string {
  if (!ports?.length) return 'all ports'
  return ports.map((p) => `${p.protocol ?? 'TCP'}${p.port !== undefined ? `/${p.port}${p.endPort ? `-${p.endPort}` : ''}` : ''}`).join(', ')
}

interface Row {
  key: string
  policy: KObject
  direction: 'IN' | 'OUT'
  target: string
  peers: string
  ports: string
}

// Each rule of each policy as a row, the way a Proxmox firewall lists rules.
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  for (const policy of policies.items.value) {
    const target = selectorText(policy.spec?.podSelector)
    if (props.vm) {
      const labels = policy.spec?.podSelector?.matchLabels ?? {}
      const applies = !Object.keys(labels).length || labels['kubevirt.io'] === 'virt-launcher' || labels['vm.kubevirt.io/name'] === props.vm || labels['kubevirt.io/vm'] === props.vm
      if (!applies) continue
    }
    const types: string[] = policy.spec?.policyTypes ?? (policy.spec?.egress ? ['Ingress', 'Egress'] : ['Ingress'])
    for (const type of types) {
      const dir = type === 'Ingress' ? 'IN' : 'OUT'
      const rules: any[] = (type === 'Ingress' ? policy.spec?.ingress : policy.spec?.egress) ?? []
      if (!rules.length) {
        out.push({ key: `${policy.metadata.uid}/${type}/deny`, policy, direction: dir, target, peers: 'DROP all (no allow rules)', ports: '' })
      }
      rules.forEach((rule, i) => {
        const peers = (type === 'Ingress' ? rule.from : rule.to) as any[] | undefined
        out.push({ key: `${policy.metadata.uid}/${type}/${i}`, policy, direction: dir, target, peers: peers?.length ? peers.map(peerText).join('; ') : 'any', ports: portsText(rule.ports) })
      })
    }
  }
  return out
})

const columns: Column<Row>[] = [
  { key: 'direction', label: 'Direction', width: '90px' },
  { key: 'target', label: 'Applies to' },
  { key: 'peers', label: 'Source / destination' },
  { key: 'ports', label: 'Ports' },
  { key: 'policy', label: 'Policy', value: (r) => r.policy.metadata.name },
  { key: 'comment', label: 'Comment', value: (r) => r.policy.metadata.annotations?.['kubevirt-webgui/comment'] ?? '' },
]

const canCreate = computed(() => can({ verb: 'create', group: 'networking.k8s.io', resource: 'networkpolicies', namespace: namespace.value }) === true)
const canDelete = computed(() => can({ verb: 'delete', group: 'networking.k8s.io', resource: 'networkpolicies', namespace: namespace.value }) === true)

async function remove(policy: KObject) {
  const ok = await confirm({ title: 'Remove firewall policy', message: `Delete the NetworkPolicy ${policy.metadata.name}? All of its rules go with it.`, confirmText: 'Delete', danger: true })
  if (ok) await run('Remove firewall policy', () => k8s.delete({ apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: namespace.value, name: policy.metadata.name }))
}

async function isolate() {
  const target = props.vm ? `VM ${props.vm}` : `every VM in ${namespace.value}`
  const ok = await confirm({
    title: 'Drop incoming traffic',
    message: `Create a policy that selects ${target} for ingress with no allow rules? Incoming traffic is dropped except what other rules allow.`,
    confirmText: 'Create',
    danger: true,
  })
  if (!ok) return
  const name = props.vm ? `fw-${props.vm}-default-drop-in`.slice(0, 63) : 'fw-vms-default-drop-in'
  await run('Drop incoming traffic', () =>
    k8s.create({ apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: namespace.value }, {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name, namespace: namespace.value, labels: { 'app.kubernetes.io/managed-by': 'kubevirt-webgui' }, annotations: { 'kubevirt-webgui/comment': 'default policy: DROP in' } },
      spec: { podSelector: { matchLabels: props.vm ? { 'vm.kubevirt.io/name': props.vm } : { 'kubevirt.io': 'virt-launcher' } }, policyTypes: ['Ingress'] },
    }),
  )
}
</script>

<template>
  <div class="space-y-3 p-3">
    <div class="flex items-center gap-2">
      <h3 class="panel-title">Firewall rules <span class="font-normal text-fg-muted">(NetworkPolicies{{ vm ? ` that apply to ${vm}` : '' }})</span></h3>
      <button class="btn btn-sm ml-auto" :disabled="!canCreate" @click="isolate"><Fa :icon="faLock" /> Default DROP in</button>
      <button class="btn btn-sm btn-primary" :disabled="!canCreate" @click="openDialog(FirewallRuleDialog, { namespace, vm })"><Fa :icon="faPlus" /> Add rule</button>
    </div>
    <Notice v-if="policies.error.value" kind="warning">{{ policies.error.value.message }}</Notice>
    <DataTable v-else :columns="columns" :rows="rows" :row-key="(r) => r.key" filterable :loading="!policies.synced.value" :empty-text="`No policies: all traffic is allowed (policy ACCEPT)`">
      <template #cell-direction="{ value }">
        <span class="chip" :class="value === 'IN' ? 'bg-info/15 text-info' : 'bg-accent-soft text-accent'">{{ value }}</span>
      </template>
      <template #cell-peers="{ value }">
        <span class="max-w-[360px] truncate" :class="String(value).startsWith('DROP') ? 'text-bad' : ''" :title="String(value)">{{ value }}</span>
      </template>
      <template #cell-comment="{ row, value }">
        <span class="flex items-center gap-1.5">
          <span class="truncate text-fg-muted">{{ value }}</span>
          <button class="btn btn-sm btn-ghost ml-auto" title="View or edit YAML" @click.stop="openDialog(PolicyYamlDialog, { policy: row.policy })"><Fa :icon="faFileCode" /></button>
          <button class="btn btn-sm btn-ghost text-bad" :disabled="!canDelete" title="Delete policy" @click.stop="remove(row.policy)"><Fa :icon="faTrash" /></button>
        </span>
      </template>
    </DataTable>
    <p class="text-xs text-fg-muted">Enforcement depends on the cluster's CNI. VMs are matched by their launcher pods' labels (<span class="mono">vm.kubevirt.io/name</span>); with masquerade networking the guest's traffic is the pod's traffic.</p>
  </div>
</template>
