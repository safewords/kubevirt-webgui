<script setup lang="ts">
/** `virtctl expose`, as a dialog: a Service in front of a VM's launcher pod. */
import { computed, reactive, ref } from 'vue'
import { dump } from 'js-yaml'
import { faTowerBroadcast, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { k8s } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { isDnsLabel, toDnsLabel } from '@/util/format'
import { toast } from '@/services/dialogs'
import { VM_NAME_LABEL } from './services'

const props = defineProps<{ namespace: string; vm: string }>()
const emit = defineEmits<{ close: [result?: boolean] }>()

interface PortRow {
  name: string
  port: number
  targetPort: number
  protocol: 'TCP' | 'UDP' | 'SCTP'
  nodePort: number | null
}

const PRESETS = [
  { name: 'ssh', port: 22, protocol: 'TCP' as const, label: 'SSH' },
  { name: 'rdp', port: 3389, protocol: 'TCP' as const, label: 'RDP' },
  { name: 'http', port: 80, protocol: 'TCP' as const, label: 'HTTP' },
  { name: 'https', port: 443, protocol: 'TCP' as const, label: 'HTTPS' },
  { name: 'vnc', port: 5900, protocol: 'TCP' as const, label: 'VNC (guest)' },
]

const name = ref(toDnsLabel(`${props.vm}-ssh`))
const type = ref<'ClusterIP' | 'NodePort' | 'LoadBalancer'>('ClusterIP')
const ports = reactive<PortRow[]>([{ name: 'ssh', port: 22, targetPort: 22, protocol: 'TCP', nodePort: null }])
const loadBalancerIP = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

function preset(p: (typeof PRESETS)[number]) {
  if (ports.some((r) => r.port === p.port && r.protocol === p.protocol)) return
  if (ports.length === 1 && ports[0].port === 0) ports.splice(0, 1)
  ports.push({ name: p.name, port: p.port, targetPort: p.port, protocol: p.protocol, nodePort: null })
  if (ports.length === 1) name.value = toDnsLabel(`${props.vm}-${p.name}`)
}

const service = computed(() => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    name: name.value,
    namespace: props.namespace,
    labels: { 'app.kubernetes.io/managed-by': 'kubevirt-webgui', 'kubevirt-webgui/exposes': props.vm },
    ...(type.value === 'LoadBalancer' && loadBalancerIP.value.trim() ? { annotations: { 'metallb.universe.tf/loadBalancerIPs': loadBalancerIP.value.trim() } } : {}),
  },
  spec: {
    type: type.value,
    selector: { [VM_NAME_LABEL]: props.vm },
    ports: ports.map((p, i) => ({
      name: p.name || `port-${i}`,
      port: Number(p.port),
      targetPort: Number(p.targetPort),
      protocol: p.protocol,
      ...(type.value !== 'ClusterIP' && p.nodePort ? { nodePort: Number(p.nodePort) } : {}),
    })),
  },
}))

const problems = computed(() => {
  const list: string[] = []
  if (!isDnsLabel(name.value)) list.push('the name must be a DNS label')
  if (!ports.length) list.push('add at least one port')
  const names = new Set<string>()
  for (const p of ports) {
    if (!(p.port >= 1 && p.port <= 65535) || !(p.targetPort >= 1 && p.targetPort <= 65535)) list.push('ports must be between 1 and 65535')
    if (p.nodePort && !(p.nodePort >= 30000 && p.nodePort <= 32767)) list.push('node ports are usually 30000–32767')
    if (p.name && !isDnsLabel(p.name)) list.push(`port name “${p.name}” must be a DNS label`)
    if (names.has(p.name)) list.push('port names must be unique')
    names.add(p.name)
  }
  return [...new Set(list)]
})

async function save() {
  error.value = null
  busy.value = true
  try {
    await k8s.create({ apiVersion: 'v1', resource: 'services', namespace: props.namespace }, service.value)
    toast('success', 'Service created', `${props.namespace}/${name.value}`)
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="`Expose ${vm}`" :icon="faTowerBroadcast" width="820px" @close="emit('close')">
    <div class="grid gap-4 lg:grid-cols-[1fr_280px]">
      <div class="space-y-3">
        <Notice v-if="error" kind="error">{{ error }}</Notice>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="label">Service name</label>
            <input v-model="name" class="input mono" />
          </div>
          <div>
            <label class="label">Type</label>
            <select v-model="type" class="input">
              <option value="ClusterIP">ClusterIP — inside the cluster</option>
              <option value="NodePort">NodePort — on every node's address</option>
              <option value="LoadBalancer">LoadBalancer — its own external address</option>
            </select>
          </div>
        </div>
        <div v-if="type === 'LoadBalancer'">
          <label class="label">Requested address (optional, MetalLB)</label>
          <input v-model="loadBalancerIP" class="input mono" placeholder="assigned from the pool" />
        </div>
        <div>
          <div class="mb-1 flex flex-wrap items-center gap-1">
            <label class="label mb-0 mr-2">Ports</label>
            <button v-for="p in PRESETS" :key="p.name" class="btn btn-sm btn-ghost" @click="preset(p)">{{ p.label }}</button>
            <button class="btn btn-sm btn-ghost ml-auto" @click="ports.push({ name: `port-${ports.length}`, port: 8080, targetPort: 8080, protocol: 'TCP', nodePort: null })"><Fa :icon="faPlus" /> Add</button>
          </div>
          <div class="grid grid-cols-[1fr_90px_90px_90px_100px_auto] gap-2 text-xs text-fg-muted">
            <span>Name</span><span>Port</span><span>Guest port</span><span>Protocol</span><span>{{ type === 'ClusterIP' ? '' : 'Node port' }}</span><span />
          </div>
          <div v-for="(p, i) in ports" :key="i" class="mt-1 grid grid-cols-[1fr_90px_90px_90px_100px_auto] gap-2">
            <input v-model="p.name" class="input mono" />
            <input v-model.number="p.port" type="number" min="1" max="65535" class="input tabular-nums" />
            <input v-model.number="p.targetPort" type="number" min="1" max="65535" class="input tabular-nums" />
            <select v-model="p.protocol" class="input"><option>TCP</option><option>UDP</option><option>SCTP</option></select>
            <input v-if="type !== 'ClusterIP'" v-model.number="p.nodePort" type="number" class="input tabular-nums" placeholder="auto" />
            <span v-else />
            <button class="btn btn-ghost btn-sm" @click="ports.splice(i, 1)"><Fa :icon="faTrash" /></button>
          </div>
        </div>
        <Notice kind="info">
          Traffic reaches the guest through its launcher pod. With masquerade networking (the default) that just works; with bridge binding the guest's own address is used and the Service may not route to it.
        </Notice>
        <Notice v-if="problems.length" kind="warning">{{ problems.join('; ') }}</Notice>
      </div>
      <div class="flex min-h-0 flex-col">
        <label class="label">Service</label>
        <pre class="mono min-h-[280px] flex-1 overflow-auto rounded-md border border-line bg-surface-0 p-2 text-[11.5px] leading-snug">{{ dump(service, { noRefs: true }) }}</pre>
      </div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy || problems.length > 0" @click="save">Create service</button>
    </template>
  </Modal>
</template>
