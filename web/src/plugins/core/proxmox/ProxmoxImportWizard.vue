<script setup lang="ts">
/**
 * Import from Proxmox: sign in to a Proxmox VE host, pick a stopped VM, review
 * how its settings map to KubeVirt, and copy it — disks streamed by the
 * server straight from Proxmox storage into CDI, with live progress in the
 * task viewer.
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  faServer, faPlug, faListUl, faSliders, faHardDrive, faNetworkWired, faClipboardCheck, faChevronLeft, faChevronRight,
  faFileImport, faKey, faShieldHalved, faTriangleExclamation, faRotate, faCircleExclamation,
} from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { gateway, errorMessage } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { run } from '@/services/dialogs'
import { useCluster } from '@/stores/cluster'
import { useWatch } from '@/stores/watch'
import { useInventory } from '@/plugins/core/inventory'
import { bytes, isDnsLabel } from '@/util/format'
import { routeTo } from '@/util/nav'
import FormRow from '@/plugins/core/create/FormRow.vue'
import NamespaceSelect from '@/plugins/core/create/NamespaceSelect.vue'
import StorageClassSelect from '@/plugins/core/create/StorageClassSelect.vue'
import { useCpuModels } from '@/plugins/core/create/cpuModels'
import { KUBEVIRT_NIC_MODELS, buildImport, initialModel, problems, toYaml, warnings, type ImportModel, type PveVmDetail } from './mapping'

const emit = defineEmits<{ close: [result?: unknown] }>()
const router = useRouter()
const cluster = useCluster()
const inv = useInventory()
const cpuModels = useCpuModels()

// --- connecting -------------------------------------------------------------------

interface HostKey { host: string; address: string; port: number; algorithm: string; fingerprint: string }
interface PveVm { vmid: number; name?: string; node: string; status: string; template: boolean; cpus?: number; memoryBytes?: number; diskBytes?: number; tags: string[]; lock?: string }

const KEYS_STORAGE = 'kubevirt-webgui.proxmox.hostKeys'
const LAST_STORAGE = 'kubevirt-webgui.proxmox.last'
function readStorage<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T
  } catch {
    return fallback
  }
}
function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: nothing remembered */
  }
}

const last = readStorage<{ host?: string; port?: number; user?: string; method?: 'password' | 'key' }>(LAST_STORAGE, {})
const login = reactive({ host: last.host ?? '', port: last.port ?? 22, user: last.user ?? 'root', method: last.method ?? 'password', password: '', privateKey: '', passphrase: '' })
const serverStatus = ref<{ enabled: boolean; allowedHosts: string[] } | null>(null)
const hostKey = ref<HostKey | null>(null)
const knownKey = computed(() => (hostKey.value ? readStorage<Record<string, string>>(KEYS_STORAGE, {})[`${hostKey.value.host}:${hostKey.value.port}`] : undefined))
const keyChanged = computed(() => !!hostKey.value && !!knownKey.value && knownKey.value !== hostKey.value.fingerprint)
const session = ref<{ session: string; node: string; version: string; host: string } | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

gateway.call<{ enabled: boolean; allowedHosts: string[] }>('proxmox.status').then((s) => (serverStatus.value = s)).catch((e) => (error.value = errorMessage(e)))
const hostSuggestions = computed(() => (serverStatus.value?.allowedHosts ?? []).filter((h) => h !== '*' && !h.includes('/')))

async function checkHost() {
  error.value = null
  hostKey.value = null
  busy.value = true
  try {
    hostKey.value = await gateway.call<HostKey>('proxmox.hostKey', { host: login.host.trim(), port: login.port })
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function connect() {
  if (!hostKey.value) return
  error.value = null
  busy.value = true
  try {
    session.value = await gateway.call('proxmox.connect', {
      host: login.host.trim(),
      port: login.port,
      user: login.user,
      fingerprint: hostKey.value.fingerprint,
      ...(login.method === 'password' ? { password: login.password } : { privateKey: login.privateKey, passphrase: login.passphrase || undefined }),
    }, { timeout: 60_000 })
    const keys = readStorage<Record<string, string>>(KEYS_STORAGE, {})
    keys[`${hostKey.value.host}:${hostKey.value.port}`] = hostKey.value.fingerprint
    writeStorage(KEYS_STORAGE, keys)
    writeStorage(LAST_STORAGE, { host: login.host.trim(), port: login.port, user: login.user, method: login.method })
    login.password = ''
    login.passphrase = ''
    await loadVms()
    step.value = 'vm'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

onBeforeUnmount(() => {
  // An import already started keeps its own copy of the credentials.
  if (session.value) gateway.call('proxmox.disconnect', { session: session.value.session }).catch(() => {})
})

// --- choosing a VM ------------------------------------------------------------------

const vms = ref<PveVm[]>([])
const filter = ref('')
const loadingVms = ref(false)
async function loadVms() {
  if (!session.value) return
  loadingVms.value = true
  try {
    const result = await gateway.call<{ vms: PveVm[] }>('proxmox.vms', { session: session.value.session }, { timeout: 60_000 })
    vms.value = result.vms.sort((a, b) => a.vmid - b.vmid)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    loadingVms.value = false
  }
}
const shownVms = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return vms.value.filter((v) => !q || `${v.vmid} ${v.name ?? ''} ${v.node} ${v.tags.join(' ')}`.toLowerCase().includes(q))
})
const whyNot = (v: PveVm) => (v.status === 'running' ? 'running — shut it down on Proxmox first' : v.status !== 'stopped' ? `node ${v.status}` : v.lock ? `locked (${v.lock})` : null)

const detail = ref<PveVmDetail | null>(null)
const model = ref<ImportModel | null>(null)

const nadVersion = computed(() => cluster.versionFor('k8s.cni.cncf.io', 'network-attachment-definitions'))
const nads = useWatch(() => (nadVersion.value && model.value && isDnsLabel(model.value.namespace) ? { apiVersion: nadVersion.value, resource: 'network-attachment-definitions', namespace: model.value.namespace } : null))
const nadNames = computed(() => nads.items.value.map((n) => n.metadata.name))

const defaultNamespace = () => (inv.reachableNamespaces.includes('default') ? 'default' : (inv.reachableNamespaces[0] ?? 'default'))
const defaultCpuModel = () => (cpuModels.mixed.value && cpuModels.common.value.length ? cpuModels.common.value[0] : 'host-model')

async function choose(v: PveVm) {
  if (!session.value || whyNot(v)) return
  error.value = null
  busy.value = true
  try {
    detail.value = await gateway.call<PveVmDetail>('proxmox.vm', { session: session.value.session, node: v.node, vmid: v.vmid }, { timeout: 60_000 })
    model.value = initialModel(detail.value, { namespace: model.value?.namespace ?? defaultNamespace(), cpuModel: defaultCpuModel(), nads: nadNames.value })
    validation.value = null
    step.value = 'settings'
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

// --- steps -----------------------------------------------------------------------------

const steps = [
  { id: 'connect', title: 'Connect', icon: faPlug },
  { id: 'vm', title: 'Virtual machine', icon: faListUl },
  { id: 'settings', title: 'Settings', icon: faSliders },
  { id: 'disks', title: 'Disks', icon: faHardDrive },
  { id: 'network', title: 'Network', icon: faNetworkWired },
  { id: 'confirm', title: 'Confirm', icon: faClipboardCheck },
] as const
type StepId = (typeof steps)[number]['id']
const step = ref<StepId>('connect')
const stepIndex = computed(() => steps.findIndex((s) => s.id === step.value))
const reachable = (id: StepId) => (id === 'connect' ? true : id === 'vm' ? !!session.value : !!model.value)

const issues = computed(() => (detail.value && model.value ? problems(detail.value, model.value) : { settings: [], disks: [], network: [] }))
const invalid = computed(() => (['settings', 'disks', 'network'] as const).filter((id) => issues.value[id].length))
const notes = computed(() => (detail.value && model.value ? warnings(detail.value, model.value) : []))
const built = computed(() => (detail.value && model.value ? buildImport(detail.value, model.value) : null))
const yaml = computed(() => (built.value ? toYaml(built.value.vm) : ''))
const copyBytes = computed(() => {
  if (!detail.value || !built.value) return 0
  return built.value.disks.reduce((sum, d) => sum + (detail.value!.config.disks.find((x) => x.key === d.key)?.sizeBytes ?? 0), 0)
})

function next() {
  if (step.value === 'connect' && !session.value) return
  if (step.value === 'vm' && !model.value) return
  if (stepIndex.value < steps.length - 1) step.value = steps[stepIndex.value + 1].id
}
function back() {
  if (stepIndex.value > 0) step.value = steps[stepIndex.value - 1].id
}

const pveDisk = (key: string) => detail.value?.config.disks.find((d) => d.key === key)
const pveNic = (key: string) => detail.value?.config.nics.find((n) => n.key === key)

watch(nadNames, (names) => {
  // A second NIC waiting for a Multus network gets the first one that appears.
  model.value?.nics.forEach((n, i) => {
    if (i > 0 && n.attach === 'none' && names.length) n.attach = `multus:${names[0]}`
  })
})

// --- import ------------------------------------------------------------------------------

const validation = ref<{ ok: boolean; message: string } | null>(null)
async function dryRun(): Promise<boolean> {
  if (!built.value || !model.value) return false
  try {
    await k8s.create({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace: model.value.namespace }, built.value.vm, { dryRun: true })
    validation.value = { ok: true, message: 'The API server accepts this virtual machine.' }
    return true
  } catch (e) {
    validation.value = { ok: false, message: errorMessage(e) }
    return false
  }
}

async function submit() {
  if (!session.value || !detail.value || !model.value || !built.value) return
  if (invalid.value.length) {
    step.value = invalid.value[0]
    return
  }
  busy.value = true
  if (!(await dryRun())) {
    busy.value = false
    return
  }
  const m = model.value
  const result = await run(
    `Import ${detail.value.config.name || detail.value.vmid}`,
    () => gateway.call<{ task: string }>('proxmox.import', {
      session: session.value!.session,
      node: detail.value!.node,
      vmid: detail.value!.vmid,
      digest: detail.value!.config.digest,
      vm: built.value!.vm,
      disks: built.value!.disks,
      start: m.start,
    }),
    { openLog: true },
  )
  busy.value = false
  if (result) {
    emit('close', result)
    router.push(routeTo({ kind: 'vm', name: m.name, namespace: m.namespace }))
  }
}
</script>

<template>
  <Modal title="Import: Proxmox VE virtual machine" :icon="faFileImport" large @close="emit('close')">
    <div class="flex h-full min-h-0" data-proxmox-import>
      <nav class="w-44 shrink-0 border-r border-line bg-surface-1 py-2">
        <button
          v-for="s in steps"
          :key="s.id"
          class="flex h-9 w-full items-center gap-2.5 px-3 text-left disabled:opacity-40"
          :class="step === s.id ? 'bg-selection font-medium shadow-[inset_3px_0_0_var(--accent)]' : 'text-fg-muted hover:bg-surface-3 hover:text-fg'"
          :disabled="!reachable(s.id)"
          @click="step = s.id"
        >
          <Fa :icon="s.icon" class="w-4" :class="step === s.id ? 'text-accent' : ''" />
          <span class="flex-1">{{ s.title }}</span>
          <Fa v-if="invalid.includes(s.id as any)" :icon="faCircleExclamation" class="text-bad" />
        </button>
      </nav>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 overflow-auto p-5">
          <Notice v-if="error" kind="error" class="mb-3 max-w-3xl">{{ error }}</Notice>

          <!-- Connect -->
          <div v-if="step === 'connect'" class="max-w-2xl space-y-3">
            <Notice v-if="serverStatus && !serverStatus.enabled" kind="warning" title="Importing from Proxmox is not enabled">
              The server only connects to Proxmox hosts an administrator allows. Set <span class="mono">PROXMOX_ALLOWED_HOSTS</span> on the server — host names, addresses or CIDR ranges, e.g. <span class="mono">10.0.4.0/24</span>.
            </Notice>
            <p class="text-fg-muted">
              The server signs in to a Proxmox VE node over SSH, reads the VM's configuration and streams its disks into the cluster. Credentials stay in the server's memory for this wizard and the import only; nothing on Proxmox is changed.
            </p>
            <template v-if="!session">
              <FormRow label="Host" required :hint="hostSuggestions.length ? `Allowed: ${serverStatus?.allowedHosts.join(', ')}` : serverStatus?.allowedHosts.length ? `Allowed: ${serverStatus.allowedHosts.join(', ')}` : null">
                <input v-model.trim="login.host" class="input mono" list="kve-pve-hosts" placeholder="pve1.example.com or 10.0.0.2" spellcheck="false" @change="hostKey = null" />
                <datalist id="kve-pve-hosts"><option v-for="h in hostSuggestions" :key="h" :value="h" /></datalist>
              </FormRow>
              <FormRow label="SSH port"><input v-model.number="login.port" type="number" min="1" max="65535" class="input w-28" @change="hostKey = null" /></FormRow>
              <FormRow label="User" hint="root, or a user allowed to run pvesh and pvesm."><input v-model.trim="login.user" class="input w-48" spellcheck="false" /></FormRow>
              <FormRow label="Sign in with">
                <div class="flex gap-4 pt-1.5">
                  <label class="flex items-center gap-2"><input v-model="login.method" type="radio" value="password" class="accent-[var(--accent)]" /> Password</label>
                  <label class="flex items-center gap-2"><input v-model="login.method" type="radio" value="key" class="accent-[var(--accent)]" /> SSH private key</label>
                </div>
              </FormRow>
              <FormRow v-if="login.method === 'password'" label="Password" required>
                <input v-model="login.password" type="password" class="input" autocomplete="off" />
              </FormRow>
              <template v-else>
                <FormRow label="Private key" required hint="OpenSSH or PEM format. Sent to the server for this session only.">
                  <textarea v-model="login.privateKey" class="input mono h-32 resize-y text-[11px]" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck="false" autocomplete="off" />
                </FormRow>
                <FormRow label="Passphrase"><input v-model="login.passphrase" type="password" class="input" autocomplete="off" placeholder="if the key has one" /></FormRow>
              </template>

              <div v-if="!hostKey" class="flex gap-2 pt-1">
                <button class="btn btn-primary" :disabled="busy || !login.host || serverStatus?.enabled === false" @click="checkHost"><Fa :icon="faShieldHalved" /> Check host key</button>
              </div>
              <div v-else class="card space-y-2 p-3" data-host-key>
                <div class="flex items-center gap-2 font-medium"><Fa :icon="faKey" class="text-fg-muted" /> {{ hostKey.host }} ({{ hostKey.address }}:{{ hostKey.port }}) presents this host key</div>
                <div class="mono break-all text-[12px]">{{ hostKey.algorithm }} {{ hostKey.fingerprint }}</div>
                <Notice v-if="keyChanged" kind="error" title="The host key has changed">
                  Last time this host presented {{ knownKey }}. If the host was not reinstalled, someone may be intercepting the connection — do not continue.
                </Notice>
                <p v-else-if="knownKey" class="text-xs text-ok">Matches the key you accepted before.</p>
                <p v-else class="text-xs text-fg-muted">Compare it with the host's own: <span class="mono">ssh-keygen -lf /etc/ssh/ssh_host_{{ hostKey.algorithm.includes('ed25519') ? 'ed25519' : hostKey.algorithm.includes('ecdsa') ? 'ecdsa' : 'rsa' }}_key.pub</span></p>
                <div class="flex gap-2">
                  <button class="btn btn-primary" :class="keyChanged ? 'btn-danger' : ''" :disabled="busy || (login.method === 'password' ? !login.password : !login.privateKey.trim())" @click="connect">
                    <Fa :icon="faPlug" /> {{ keyChanged ? 'Trust the new key and connect' : 'Trust and connect' }}
                  </button>
                  <button class="btn" :disabled="busy" @click="hostKey = null">Cancel</button>
                </div>
              </div>
            </template>
            <Notice v-else kind="info" title="Connected">
              {{ session.host }} — node {{ session.node }}, {{ session.version }}
            </Notice>
          </div>

          <!-- Virtual machine -->
          <div v-else-if="step === 'vm'" class="space-y-3">
            <div class="flex items-center gap-2">
              <input v-model="filter" class="input max-w-xs" placeholder="Filter by id, name, node or tag" />
              <button class="btn" :disabled="loadingVms" @click="loadVms"><Fa :icon="faRotate" :spin="loadingVms" /> Refresh</button>
              <span class="ml-auto text-xs text-fg-muted">Only stopped VMs can be imported: a running VM's disks change while they are read.</span>
            </div>
            <div class="overflow-hidden rounded-md border border-line">
              <table class="table-dense">
                <thead>
                  <tr>
                    <th class="w-20">ID</th>
                    <th>Name</th>
                    <th class="w-40">Node</th>
                    <th class="w-44">Status</th>
                    <th class="w-16 text-right">vCPU</th>
                    <th class="w-24 text-right">Memory</th>
                    <th class="w-24 text-right">Disk</th>
                    <th>Tags</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="v in shownVms"
                    :key="`${v.node}/${v.vmid}`"
                    :data-vmid="v.vmid"
                    :class="[whyNot(v) ? 'opacity-50' : 'cursor-pointer', detail?.vmid === v.vmid ? 'bg-selection' : '']"
                    :title="whyNot(v) ?? 'Import this VM'"
                    @click="choose(v)"
                  >
                    <td class="tabular-nums">{{ v.vmid }}</td>
                    <td>{{ v.name ?? '' }} <span v-if="v.template" class="chip ml-1">template</span></td>
                    <td>{{ v.node }}</td>
                    <td :class="v.status === 'running' ? 'text-ok' : 'text-fg-muted'">{{ whyNot(v) ?? v.status }}</td>
                    <td class="text-right tabular-nums">{{ v.cpus ?? '' }}</td>
                    <td class="text-right tabular-nums">{{ v.memoryBytes ? bytes(v.memoryBytes, 0) : '' }}</td>
                    <td class="text-right tabular-nums">{{ v.diskBytes ? bytes(v.diskBytes, 0) : '' }}</td>
                    <td><span v-for="t in v.tags" :key="t" class="chip mr-1">{{ t }}</span></td>
                  </tr>
                  <tr v-if="!shownVms.length">
                    <td colspan="8" class="h-14 text-center text-fg-subtle">{{ loadingVms ? 'Loading…' : 'No virtual machines' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="busy" class="text-fg-muted">Reading the VM's configuration…</p>
          </div>

          <!-- Settings -->
          <div v-else-if="step === 'settings' && model && detail" class="max-w-2xl space-y-3">
            <Notice kind="info">Importing VM {{ detail.vmid }} ({{ detail.config.name }}) from {{ detail.node }} — {{ detail.config.ostype ?? 'unknown OS' }}, {{ detail.config.bios === 'ovmf' ? 'UEFI' : 'BIOS' }}, {{ detail.config.machine }}.</Notice>
            <FormRow label="Namespace" required><NamespaceSelect v-model="model.namespace" /></FormRow>
            <FormRow label="Name" required><input v-model.trim="model.name" class="input" spellcheck="false" /></FormRow>
            <FormRow label="Description"><textarea v-model="model.description" class="input h-16 resize-y" /></FormRow>
            <FormRow label="Sockets"><input v-model.number="model.sockets" type="number" min="1" class="input w-28" /></FormRow>
            <FormRow label="Cores"><input v-model.number="model.cores" type="number" min="1" class="input w-28" /></FormRow>
            <FormRow label="CPU type" :hint="`Proxmox: ${detail.config.cpuType}${detail.config.cpuFlags ? ` (${detail.config.cpuFlags})` : ''}. A model every node supports keeps the VM live-migratable.`">
              <input v-model.trim="model.cpuModel" class="input" list="kve-import-cpu-models" />
              <datalist id="kve-import-cpu-models">
                <option value="host-model" />
                <option value="host-passthrough" />
                <option v-for="c in cpuModels.common.value.slice(0, 12)" :key="c" :value="c" />
              </datalist>
            </FormRow>
            <FormRow label="Memory (MiB)" :hint="bytes(model.memoryMib * 1024 * 1024)"><input v-model.number="model.memoryMib" type="number" min="128" step="256" class="input w-40" /></FormRow>
            <FormRow label="Firmware">
              <select v-model="model.firmware" class="input w-56">
                <option value="bios">SeaBIOS</option>
                <option value="uefi">OVMF (UEFI)</option>
              </select>
            </FormRow>
            <FormRow label="Secure Boot"><label class="flex items-center gap-2 pt-1.5"><input v-model="model.secureBoot" type="checkbox" :disabled="model.firmware !== 'uefi'" class="accent-[var(--accent)]" /> Enable (Proxmox had pre-enrolled keys: {{ detail.config.secureBoot ? 'yes' : 'no' }})</label></FormRow>
            <FormRow label="TPM"><label class="flex items-center gap-2 pt-1.5"><input v-model="model.tpm" type="checkbox" class="accent-[var(--accent)]" /> Emulated TPM 2.0 (starts empty)</label></FormRow>
            <FormRow label="Windows"><label class="flex items-center gap-2 pt-1.5"><input v-model="model.windows" type="checkbox" class="accent-[var(--accent)]" /> Hyper-V enlightenments and a Windows clock</label></FormRow>
            <FormRow label="Identity" :hint="detail.config.smbios.uuid ? `SMBIOS UUID ${detail.config.smbios.uuid}` : 'Proxmox set no SMBIOS UUID'">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.keepUuid" type="checkbox" :disabled="!detail.config.smbios.uuid" class="accent-[var(--accent)]" /> Keep the UUID (licences and cloud-init instance ids follow it)</label>
            </FormRow>
            <FormRow label="Display"><label class="flex items-center gap-2 pt-1.5"><input v-model="model.graphics" type="checkbox" class="accent-[var(--accent)]" /> VGA display (Proxmox: {{ detail.config.vga ?? 'default' }})</label></FormRow>
            <FormRow label="Tablet pointer"><label class="flex items-center gap-2 pt-1.5"><input v-model="model.tablet" type="checkbox" class="accent-[var(--accent)]" /> USB tablet input</label></FormRow>
            <FormRow v-if="detail.config.usb.length" label="USB" :hint="`Proxmox passes through ${detail.config.usb.map((u) => u.host).join(', ')}`">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.clientPassthrough" type="checkbox" class="accent-[var(--accent)]" /> Allow USB passthrough, to attach the device after import</label>
            </FormRow>
          </div>

          <!-- Disks -->
          <div v-else-if="step === 'disks' && model && detail" class="space-y-3">
            <div v-for="d in model.disks" :key="d.key" class="card p-3" :data-disk="d.key">
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <label class="flex items-center gap-2 font-semibold">
                  <input v-model="d.include" type="checkbox" :disabled="!pveDisk(d.key)?.importable" class="accent-[var(--accent)]" />
                  {{ d.key }}
                </label>
                <span class="mono text-xs text-fg-muted">{{ pveDisk(d.key)?.volid ?? '' }}</span>
                <span class="text-xs text-fg-muted">{{ pveDisk(d.key)?.media === 'cdrom' ? 'CD/DVD' : 'disk' }}{{ pveDisk(d.key)?.sizeBytes ? ` · ${bytes(pveDisk(d.key)!.sizeBytes!)}` : '' }}</span>
                <span v-if="detail.config.bootOrder.includes(d.key)" class="chip">boot #{{ detail.config.bootOrder.indexOf(d.key) + 1 }}</span>
                <span v-if="pveDisk(d.key)?.note" class="text-xs text-fg-subtle">{{ pveDisk(d.key)?.note }}</span>
              </div>
              <div v-if="d.include" class="grid gap-3 lg:grid-cols-2">
                <FormRow label="Bus" :hint="`Proxmox: ${pveDisk(d.key)?.bus}`">
                  <select v-model="d.bus" class="input" :disabled="pveDisk(d.key)?.media === 'cdrom'">
                    <option value="virtio">VirtIO Block</option>
                    <option value="scsi">SCSI (virtio-scsi)</option>
                    <option value="sata">SATA</option>
                  </select>
                </FormRow>
                <FormRow label="Storage"><StorageClassSelect v-model="d.storageClass" /></FormRow>
                <FormRow label="Volume mode">
                  <select v-model="d.volumeMode" class="input">
                    <option :value="null">storage profile default</option>
                    <option value="Block">Block</option>
                    <option value="Filesystem">Filesystem</option>
                  </select>
                </FormRow>
                <FormRow label="Access mode" hint="ReadWriteMany enables live migration.">
                  <select v-model="d.accessMode" class="input">
                    <option :value="null">storage profile default</option>
                    <option value="ReadWriteMany">ReadWriteMany</option>
                    <option value="ReadWriteOnce">ReadWriteOnce</option>
                  </select>
                </FormRow>
              </div>
            </div>
            <Notice v-if="!model.disks.length" kind="info">This VM has no disks.</Notice>
            <Notice v-if="detail.config.efiDisk || detail.config.tpm" kind="info">
              {{ [detail.config.efiDisk ? 'The EFI variables disk' : '', detail.config.tpm ? 'the TPM state' : ''].filter(Boolean).join(' and ') }} stay behind: KubeVirt keeps its own.
            </Notice>
          </div>

          <!-- Network -->
          <div v-else-if="step === 'network' && model && detail" class="space-y-3">
            <div v-for="n in model.nics" :key="n.key" class="card p-3" :data-nic="n.key">
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="font-semibold">{{ n.key }}</span>
                <span class="text-xs text-fg-muted">{{ pveNic(n.key)?.model }} · {{ pveNic(n.key)?.mac ?? 'no MAC' }} · {{ pveNic(n.key)?.bridge ?? 'no bridge' }}{{ pveNic(n.key)?.vlan ? ` · VLAN ${pveNic(n.key)?.vlan}` : '' }}</span>
              </div>
              <div class="grid gap-3 lg:grid-cols-2">
                <FormRow label="Connect to">
                  <select v-model="n.attach" class="input">
                    <option value="masquerade">Pod network — masquerade (NAT)</option>
                    <option value="bridge">Pod network — bridge</option>
                    <option v-for="name in nadNames" :key="name" :value="`multus:${name}`">Multus network {{ name }}</option>
                    <option value="none">Leave out</option>
                  </select>
                </FormRow>
                <FormRow label="Model">
                  <select v-model="n.model" class="input" :disabled="n.attach === 'none'">
                    <option v-for="m in KUBEVIRT_NIC_MODELS" :key="m" :value="m">{{ m }}</option>
                  </select>
                </FormRow>
                <FormRow label="MAC address">
                  <label class="flex items-center gap-2 pt-1.5"><input v-model="n.keepMac" type="checkbox" :disabled="!pveNic(n.key)?.mac || n.attach === 'none'" class="accent-[var(--accent)]" /> Keep {{ pveNic(n.key)?.mac ?? '' }}</label>
                </FormRow>
              </div>
            </div>
            <Notice v-if="!model.nics.length" kind="info">This VM has no network devices.</Notice>
            <Notice v-if="!nadNames.length && model.nics.length > 1" kind="info">Only one NIC can use the pod network. Networks on other LANs or VLANs need a Multus NetworkAttachmentDefinition in {{ model.namespace }}.</Notice>
          </div>

          <!-- Confirm -->
          <div v-else-if="step === 'confirm' && model && detail && built" class="grid h-full min-h-[420px] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div class="space-y-3">
              <Notice v-if="invalid.length" kind="error" title="Some steps need attention">
                <div v-for="id in invalid" :key="id">
                  <button class="underline" @click="step = id">{{ steps.find((s) => s.id === id)?.title }}</button>: {{ issues[id].join('; ') }}
                </div>
              </Notice>
              <div class="overflow-hidden rounded-md border border-line">
                <table class="table-dense">
                  <tbody>
                    <tr><td class="w-32 text-fg-muted">Source</td><td>VM {{ detail.vmid }} {{ detail.config.name }} on {{ detail.node }} ({{ session?.host }})</td></tr>
                    <tr><td class="text-fg-muted">Target</td><td>{{ model.namespace }}/{{ model.name }}</td></tr>
                    <tr><td class="text-fg-muted">Hardware</td><td>{{ model.sockets * model.cores }} vCPU ({{ model.cpuModel || 'default model' }}), {{ bytes(model.memoryMib * 1024 * 1024) }}, {{ model.firmware === 'uefi' ? `UEFI${model.secureBoot ? ' + Secure Boot' : ''}` : 'BIOS' }}{{ model.tpm ? ', TPM' : '' }}</td></tr>
                    <tr><td class="text-fg-muted">Disks to copy</td><td>{{ built.disks.map((d) => d.key).join(', ') || 'none' }} — {{ bytes(copyBytes) }}</td></tr>
                    <tr><td class="text-fg-muted">Network</td><td>{{ model.nics.filter((n) => n.attach !== 'none').map((n) => `${n.key} → ${n.attach.replace('multus:', 'Multus ')}`).join(', ') || 'none' }}</td></tr>
                  </tbody>
                </table>
              </div>
              <Notice v-if="notes.length" kind="warning" title="Differences from Proxmox">
                <ul class="list-disc space-y-0.5 pl-4"><li v-for="n in notes" :key="n">{{ n }}</li></ul>
              </Notice>
              <Notice v-if="detail.config.notImported.length" kind="info" title="Not imported">
                <ul class="list-disc space-y-0.5 pl-4"><li v-for="n in detail.config.notImported" :key="n">{{ n }}</li></ul>
              </Notice>
              <label class="flex items-center gap-2"><input v-model="model.start" type="checkbox" class="accent-[var(--accent)]" /> Start the VM once its disks are in</label>
              <p class="text-xs text-fg-muted">
                <Fa :icon="faTriangleExclamation" class="text-warn" /> Keep the Proxmox VM stopped until you are done: both copies share its MAC address{{ model.keepUuid ? ' and UUID' : '' }}.
              </p>
              <div class="flex items-center gap-2">
                <button class="btn" :disabled="busy || !!invalid.length" @click="dryRun">Validate (dry run)</button>
              </div>
              <Notice v-if="validation" :kind="validation.ok ? 'info' : 'error'">{{ validation.message }}</Notice>
            </div>
            <div class="flex min-h-[360px] flex-col">
              <div class="mb-1 text-xs text-fg-muted">What will be created</div>
              <div class="min-h-0 flex-1"><YamlEditor :model-value="yaml" readonly /></div>
            </div>
          </div>

          <Notice v-if="model && step !== 'confirm' && (issues as any)[step]?.length" kind="warning" class="mt-4 max-w-2xl">
            <div v-for="e in (issues as any)[step]" :key="e">{{ e }}</div>
          </Notice>
        </div>

        <footer class="flex shrink-0 items-center gap-2 border-t border-line bg-surface-2 px-4 py-2.5">
          <span class="flex items-center gap-1.5 text-xs text-fg-subtle"><Fa :icon="faServer" /> {{ session ? `${session.host} · ${session.node}` : 'not connected' }}</span>
          <button class="btn ml-auto" @click="emit('close')">Cancel</button>
          <button class="btn" :disabled="stepIndex === 0" @click="back"><Fa :icon="faChevronLeft" /> Back</button>
          <button v-if="step !== 'confirm'" class="btn btn-primary" :disabled="(step === 'connect' && !session) || (step === 'vm' && !model)" @click="next">Next <Fa :icon="faChevronRight" /></button>
          <button v-else class="btn btn-primary" :disabled="busy || !!invalid.length" @click="submit"><Fa :icon="faFileImport" /> Import</button>
        </footer>
      </div>
    </div>
  </Modal>
</template>
