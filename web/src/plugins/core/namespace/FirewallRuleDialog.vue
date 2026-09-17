<script setup lang="ts">
/**
 * A Proxmox-firewall-style rule, written as a NetworkPolicy.
 *
 * Kubernetes policies only allow: selecting a pod for a direction makes
 * everything not allowed in that direction denied. The dialog says so.
 */
import { computed, reactive, ref } from 'vue'
import { dump } from 'js-yaml'
import { faShieldHalved, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { useInventory } from '@/plugins/core/inventory'
import { isDnsLabel, toDnsLabel, randomSuffix } from '@/util/format'
import { toast } from '@/services/dialogs'

const props = defineProps<{ namespace: string; vm?: string }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const inv = useInventory()

type PeerKind = 'any' | 'cidr' | 'namespace' | 'pods' | 'vm'
interface Peer {
  kind: PeerKind
  cidr: string
  except: string
  namespace: string
  podLabels: string
  vm: string
}
interface Port {
  protocol: 'TCP' | 'UDP' | 'SCTP'
  port: string
}

const vms = computed(() => inv.vms.filter((v) => v.metadata.namespace === props.namespace).map((v) => v.metadata.name))

const target = ref<string>(props.vm ?? '')
const direction = ref<'in' | 'out'>('in')
const comment = ref('')
const name = ref(toDnsLabel(`fw-${props.vm ?? 'vms'}-in-${randomSuffix(4)}`))
const peers = reactive<Peer[]>([{ kind: 'any', cidr: '', except: '', namespace: '', podLabels: '', vm: '' }])
const ports = reactive<Port[]>([{ protocol: 'TCP', port: '22' }])
const busy = ref(false)
const error = ref<string | null>(null)

const PRESETS: Array<{ label: string; protocol: Port['protocol']; port: string }> = [
  { label: 'SSH', protocol: 'TCP', port: '22' },
  { label: 'RDP', protocol: 'TCP', port: '3389' },
  { label: 'HTTP', protocol: 'TCP', port: '80' },
  { label: 'HTTPS', protocol: 'TCP', port: '443' },
  { label: 'DNS', protocol: 'UDP', port: '53' },
  { label: 'VNC', protocol: 'TCP', port: '5900' },
]

function parseLabels(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.split('=')
    if (!k || v === undefined) return null
    out[k.trim()] = v.trim()
  }
  return out
}

function peerSpec(peer: Peer): object | null {
  switch (peer.kind) {
    case 'any':
      return null
    case 'cidr':
      return { ipBlock: { cidr: peer.cidr.trim(), ...(peer.except.trim() ? { except: peer.except.split(',').map((s) => s.trim()).filter(Boolean) } : {}) } }
    case 'namespace':
      return { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': peer.namespace.trim() } } }
    case 'pods':
      return { podSelector: { matchLabels: parseLabels(peer.podLabels) ?? {} } }
    case 'vm':
      return { podSelector: { matchLabels: { 'vm.kubevirt.io/name': peer.vm } } }
  }
}

const policy = computed(() => {
  const selectedPeers = peers.map(peerSpec)
  const anyPeer = selectedPeers.some((p) => p === null)
  const portSpecs = ports
    .filter((p) => p.port.trim() || p.protocol)
    .map((p) => {
      const value = p.port.trim()
      if (!value) return { protocol: p.protocol }
      const range = value.match(/^(\d+)-(\d+)$/)
      if (range) return { protocol: p.protocol, port: Number(range[1]), endPort: Number(range[2]) }
      return { protocol: p.protocol, port: /^\d+$/.test(value) ? Number(value) : value }
    })
  const rule: Record<string, unknown> = {}
  if (!anyPeer) rule[direction.value === 'in' ? 'from' : 'to'] = selectedPeers
  if (portSpecs.length) rule.ports = portSpecs
  const spec: Record<string, unknown> = {
    podSelector: { matchLabels: target.value ? { 'vm.kubevirt.io/name': target.value } : { 'kubevirt.io': 'virt-launcher' } },
    policyTypes: [direction.value === 'in' ? 'Ingress' : 'Egress'],
    [direction.value === 'in' ? 'ingress' : 'egress']: [rule],
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: name.value,
      namespace: props.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'kubevirt-webgui' },
      ...(comment.value.trim() ? { annotations: { 'kubevirt-webgui/comment': comment.value.trim() } } : {}),
    },
    spec,
  }
})

const yaml = computed(() => dump(policy.value, { noRefs: true, lineWidth: 120 }))

const problems = computed(() => {
  const list: string[] = []
  if (!isDnsLabel(name.value)) list.push('the name must be a DNS label')
  for (const peer of peers) {
    if (peer.kind === 'cidr' && !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(peer.cidr.trim())) list.push(`“${peer.cidr}” is not a CIDR`)
    if (peer.kind === 'namespace' && !peer.namespace.trim()) list.push('choose a namespace')
    if (peer.kind === 'pods' && !parseLabels(peer.podLabels)) list.push('pod labels must be key=value, comma-separated')
    if (peer.kind === 'vm' && !peer.vm) list.push('choose a VM')
  }
  for (const port of ports) {
    const v = port.port.trim()
    if (v && !/^\d+(-\d+)?$/.test(v) && !/^[a-z0-9-]+$/.test(v)) list.push(`“${v}” is not a port, range or port name`)
  }
  return list
})

function preset(p: (typeof PRESETS)[number]) {
  ports.push({ protocol: p.protocol, port: p.port })
}

async function save() {
  error.value = null
  busy.value = true
  try {
    await k8s.create({ apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: props.namespace }, policy.value)
    toast('success', 'Firewall rule created', `${props.namespace}/${name.value}`)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="`Add firewall rule in ${namespace}`" :icon="faShieldHalved" width="880px" @close="emit('close')">
    <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div class="space-y-3">
        <Notice v-if="error" kind="error">{{ error }}</Notice>
        <div class="grid gap-3 sm:grid-cols-3">
          <div>
            <label class="label">Direction</label>
            <select v-model="direction" class="input">
              <option value="in">IN (ingress)</option>
              <option value="out">OUT (egress)</option>
            </select>
          </div>
          <div>
            <label class="label">Action</label>
            <select class="input" disabled><option>ACCEPT</option></select>
          </div>
          <div>
            <label class="label">Applies to</label>
            <select v-model="target" class="input">
              <option value="">All VMs in {{ namespace }}</option>
              <option v-for="v in vms" :key="v" :value="v">VM {{ v }}</option>
            </select>
          </div>
        </div>

        <div>
          <div class="mb-1 flex items-center">
            <label class="label mb-0">{{ direction === 'in' ? 'Source' : 'Destination' }}</label>
            <button class="btn btn-sm btn-ghost ml-auto" @click="peers.push({ kind: 'cidr', cidr: '', except: '', namespace: '', podLabels: '', vm: '' })"><Fa :icon="faPlus" /> Add</button>
          </div>
          <div v-for="(peer, i) in peers" :key="i" class="mb-2 grid grid-cols-[150px_1fr_auto] gap-2">
            <select v-model="peer.kind" class="input">
              <option value="any">Any</option>
              <option value="cidr">IP / CIDR</option>
              <option value="namespace">Namespace</option>
              <option value="pods">Pods with labels</option>
              <option value="vm">VM in {{ namespace }}</option>
            </select>
            <div v-if="peer.kind === 'any'" class="flex items-center text-fg-muted">any address</div>
            <div v-else-if="peer.kind === 'cidr'" class="grid grid-cols-2 gap-2">
              <input v-model="peer.cidr" class="input mono" placeholder="10.0.0.0/8" />
              <input v-model="peer.except" class="input mono" placeholder="except (comma-separated)" />
            </div>
            <input v-else-if="peer.kind === 'namespace'" v-model="peer.namespace" class="input mono" placeholder="namespace name" list="fw-namespaces" />
            <input v-else-if="peer.kind === 'pods'" v-model="peer.podLabels" class="input mono" placeholder="app=web,tier=frontend" />
            <select v-else v-model="peer.vm" class="input">
              <option value="" disabled>choose a VM</option>
              <option v-for="v in vms" :key="v" :value="v">{{ v }}</option>
            </select>
            <button class="btn btn-ghost btn-sm" :disabled="peers.length === 1" @click="peers.splice(i, 1)"><Fa :icon="faTrash" /></button>
          </div>
          <datalist id="fw-namespaces"><option v-for="ns in inv.reachableNamespaces" :key="ns" :value="ns" /></datalist>
        </div>

        <div>
          <div class="mb-1 flex flex-wrap items-center gap-1">
            <label class="label mb-0 mr-2">Ports</label>
            <button v-for="p in PRESETS" :key="p.label" class="btn btn-sm btn-ghost" @click="preset(p)">{{ p.label }}</button>
            <button class="btn btn-sm btn-ghost ml-auto" @click="ports.push({ protocol: 'TCP', port: '' })"><Fa :icon="faPlus" /> Add</button>
          </div>
          <div v-for="(port, i) in ports" :key="i" class="mb-2 grid grid-cols-[110px_1fr_auto] gap-2">
            <select v-model="port.protocol" class="input">
              <option>TCP</option>
              <option>UDP</option>
              <option>SCTP</option>
            </select>
            <input v-model="port.port" class="input mono" placeholder="port, range 8000-8080, or empty for all" />
            <button class="btn btn-ghost btn-sm" @click="ports.splice(i, 1)"><Fa :icon="faTrash" /></button>
          </div>
          <p v-if="!ports.length" class="text-xs text-fg-muted">No ports: every port and protocol is allowed.</p>
          <p class="mt-1 text-xs text-fg-muted">NetworkPolicy has no ICMP rules; ping is governed by the CNI's own defaults (Cilium allows ICMP only with its own policies).</p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Rule name</label>
            <input v-model="name" class="input mono" />
          </div>
          <div>
            <label class="label">Comment</label>
            <input v-model="comment" class="input" />
          </div>
        </div>

        <Notice kind="info">
          Rules only <b>allow</b>. As soon as any policy selects a VM for {{ direction === 'in' ? 'ingress' : 'egress' }}, all other {{ direction === 'in' ? 'incoming' : 'outgoing' }} traffic to it is dropped — like enabling the Proxmox firewall with policy DROP.
          <template v-if="direction === 'out'"> Remember to allow DNS (UDP 53) for egress rules.</template>
        </Notice>
        <Notice v-if="problems.length" kind="warning">{{ problems.join('; ') }}</Notice>
      </div>
      <div class="flex min-h-0 flex-col">
        <label class="label">Generated NetworkPolicy</label>
        <pre class="mono min-h-[320px] flex-1 overflow-auto rounded-md border border-line bg-surface-0 p-2 text-[11.5px] leading-snug">{{ yaml }}</pre>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || problems.length > 0" @click="save">Add rule</button>
    </template>
  </Modal>
</template>
