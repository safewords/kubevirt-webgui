<script setup lang="ts">
/** Add or edit a network device: the interface and the network it joins. */
import { computed, reactive, ref } from 'vue'
import { faNetworkWired } from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { useCluster } from '@/stores/cluster'
import { useWatch } from '@/stores/watch'
import { errorMessage } from '@/api/gateway'
import { copy, interfacesOf, MAC, networksOf, nextName, validName } from './spec'
import { updateTemplate } from './update'

const props = defineProps<{ ctx: ObjectContext; name?: string }>()
const emit = defineEmits<{ close: [result?: boolean] }>()
const cluster = useCluster()

const spec = computed(() => props.ctx.object?.spec?.template?.spec ?? {})
const existing = props.name ? interfacesOf(spec.value).find((i) => i.name === props.name) : null
const existingNetwork = props.name ? networksOf(spec.value).find((n) => n.name === props.name) : null
const hasPod = networksOf(spec.value).some((n) => n.pod && n.name !== props.name)

const form = reactive({
  name: props.name ?? nextName('net', interfacesOf(spec.value).map((i) => i.name)),
  network: existingNetwork?.multus ? 'multus' : hasPod ? 'multus' : 'pod',
  nad: existingNetwork?.multus?.networkName ?? '',
  binding: existing ? (['masquerade', 'bridge', 'passt', 'sriov'].find((b) => existing[b]) ?? 'bridge') : hasPod ? 'bridge' : 'masquerade',
  model: existing?.model ?? 'virtio',
  mac: existing?.macAddress ?? '',
  down: existing?.state === 'down',
})

const multusAvailable = computed(() => cluster.has('k8s.cni.cncf.io'))
const nads = useWatch(() =>
  multusAvailable.value ? { apiVersion: 'k8s.cni.cncf.io/v1', resource: 'network-attachment-definitions', namespace: props.ctx.namespace } : null,
)

const busy = ref(false)
const error = ref<string | null>(null)
const touched = ref(false)

const problems = computed(() => {
  const out: string[] = []
  if (!props.name) {
    const nameProblem = validName(form.name)
    if (nameProblem) out.push(`Name: ${nameProblem}`)
    if (interfacesOf(spec.value).some((i) => i.name === form.name)) out.push('Name: already used')
  }
  if (form.network === 'pod' && hasPod) out.push('Only one interface can use the pod network')
  if (form.network === 'multus' && !form.nad.trim()) out.push('Choose a network attachment')
  if (form.network === 'multus' && form.binding === 'masquerade') out.push('Masquerade only works on the pod network')
  if (form.mac && !MAC.test(form.mac)) out.push('MAC address: use aa:bb:cc:dd:ee:ff')
  return out
})

async function save() {
  touched.value = true
  if (problems.value.length) return
  busy.value = true
  error.value = null
  try {
    await updateTemplate(props.ctx, (current) => {
      const interfaces = copy(interfacesOf(current))
      const networks = copy(networksOf(current))
      const iface: Record<string, any> = { ...(interfaces.find((i: any) => i.name === form.name) ?? {}), name: form.name }
      for (const b of ['masquerade', 'bridge', 'passt', 'sriov', 'slirp', 'macvtap']) delete iface[b]
      delete iface.binding
      iface[form.binding] = {}
      iface.model = form.model
      if (form.mac.trim()) iface.macAddress = form.mac.trim().toLowerCase().replace(/-/g, ':')
      else delete iface.macAddress
      if (form.down) iface.state = 'down'
      else delete iface.state
      const network = form.network === 'pod' ? { name: form.name, pod: {} } : { name: form.name, multus: { networkName: form.nad.trim() } }

      const i = interfaces.findIndex((x: any) => x.name === form.name)
      if (i === -1) interfaces.push(iface)
      else interfaces[i] = iface
      const n = networks.findIndex((x: any) => x.name === form.name)
      if (n === -1) networks.push(network)
      else networks[n] = network
      return { domain: { devices: { interfaces } }, networks }
    })
    emit('close', true)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="name ? `Edit network device ${name}` : 'Add network device'" :icon="faNetworkWired" width="540px" @close="emit('close')">
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="label">Name</label>
        <input v-model="form.name" class="input mono" :disabled="!!name" />
      </div>
      <div>
        <label class="label">Model</label>
        <select v-model="form.model" class="input">
          <option value="virtio">VirtIO (paravirtualized)</option>
          <option value="e1000e">Intel E1000E</option>
          <option value="e1000">Intel E1000</option>
          <option value="rtl8139">Realtek RTL8139</option>
        </select>
      </div>
      <div>
        <label class="label">Network</label>
        <select v-model="form.network" class="input">
          <option value="pod" :disabled="hasPod">Pod network{{ hasPod ? ' (in use)' : '' }}</option>
          <option value="multus" :disabled="!multusAvailable">Multus attachment{{ multusAvailable ? '' : ' (Multus not installed)' }}</option>
        </select>
      </div>
      <div>
        <label class="label">Binding</label>
        <select v-model="form.binding" class="input">
          <option value="masquerade" :disabled="form.network !== 'pod'">Masquerade (NAT)</option>
          <option value="bridge">Bridge</option>
          <option value="passt">passt</option>
          <option value="sriov" :disabled="form.network === 'pod'">SR-IOV</option>
        </select>
      </div>
      <div v-if="form.network === 'multus'" class="col-span-2">
        <label class="label">Network attachment definition</label>
        <input v-model="form.nad" class="input mono" list="nad-list" placeholder="namespace/name or name" />
        <datalist id="nad-list">
          <option v-for="nad in nads.items.value" :key="nad.metadata.uid" :value="nad.metadata.name" />
        </datalist>
      </div>
      <div>
        <label class="label">MAC address</label>
        <input v-model="form.mac" class="input mono" placeholder="auto" />
      </div>
      <label class="flex items-end gap-2 pb-1.5">
        <input v-model="form.down" type="checkbox" class="accent-[var(--accent)]" />
        <span>Disconnect (link down)</span>
      </label>
    </div>
    <p class="mt-3 text-xs text-fg-muted">Masquerade gives the guest a private address behind the pod's IP. Bridge hands the pod's IP to the guest, which prevents live migration on the pod network.</p>
    <Notice v-if="touched && problems.length" kind="warning" class="mt-3">
      <div v-for="p in problems" :key="p">{{ p }}</div>
    </Notice>
    <Notice v-if="error" kind="error" class="mt-3">{{ error }}</Notice>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">{{ busy ? 'Saving…' : name ? 'OK' : 'Add' }}</button>
    </template>
  </Modal>
</template>
