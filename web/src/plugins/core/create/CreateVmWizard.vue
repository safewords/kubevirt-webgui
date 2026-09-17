<script setup lang="ts">
/**
 * Create: Virtual Machine — Proxmox's wizard, step for step, producing a
 * KubeVirt VirtualMachine with DataVolume templates for its disks.
 */
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  faDesktop, faCircleInfo, faCompactDisc, faMicrochip, faHardDrive, faMemory, faNetworkWired, faCloud, faClipboardCheck,
  faGears, faPlus, faTrash, faCheck, faChevronLeft, faChevronRight, faCircleExclamation,
} from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import { useInventory } from '@/plugins/core/inventory'
import { useCluster } from '@/stores/cluster'
import { useWatch } from '@/stores/watch'
import { k8s, vmApi } from '@/api/k8s'
import { errorMessage } from '@/api/gateway'
import { run } from '@/services/dialogs'
import { routeTo } from '@/util/nav'
import { bytes, isDnsLabel, quantity } from '@/util/format'
import FormRow from './FormRow.vue'
import NamespaceSelect from './NamespaceSelect.vue'
import StorageClassSelect from './StorageClassSelect.vue'
import { formatHint, imageGib, imageNamespace, pvcGib, useDataSources, useImages } from './helpers'
import { useCpuModels } from './cpuModels'
import { CONTAINER_DISKS, buildVm, defaultModel, diskLabel, toYaml, type BootSource, type VmModel } from './vmBuilder'

export interface WizardPreset {
  namespace?: string
  source?: BootSource
  iso?: { namespace: string; name: string; sizeGib: number }
  clone?: { kind: 'datasource' | 'pvc'; namespace: string; name: string; sizeGib: number }
  url?: string
}

const props = defineProps<{ preset?: WizardPreset }>()
const emit = defineEmits<{ close: [result?: unknown] }>()

const router = useRouter()
const inv = useInventory()
const cluster = useCluster()
const { isos, disks: imageDisks } = useImages()
const { sources: dataSources } = useDataSources()
const cpuModels = useCpuModels()
const hostCpuModel = computed(() => model.cpuModel === 'host-model' || model.cpuModel === 'host-passthrough' || !model.cpuModel)

const initialNamespace = props.preset?.namespace ?? (inv.reachableNamespaces.includes('default') ? 'default' : (inv.reachableNamespaces[0] ?? 'default'))
const model = reactive<VmModel>(defaultModel(initialNamespace))
if (props.preset?.source) model.source = props.preset.source
if (props.preset?.iso) model.iso = props.preset.iso
if (props.preset?.clone) model.clone = props.preset.clone
if (props.preset?.url) model.url = props.preset.url
if (model.source === 'iso') model.cloudInit = false
// The root disk of a container-disk VM is the image itself; the watch below
// only reacts to a *change* of source, so the starting source needs the same.
if (model.source === 'container') model.disks = []

const tagsText = ref('')
watch(tagsText, (text) => (model.tags = text.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean)))

// --- catalog data ------------------------------------------------------------------------

const instancetypes = useWatch(() => {
  const version = cluster.versionFor('instancetype.kubevirt.io', 'virtualmachineclusterinstancetypes')
  return version ? { apiVersion: version, resource: 'virtualmachineclusterinstancetypes' } : null
})
const preferences = useWatch(() => {
  const version = cluster.versionFor('instancetype.kubevirt.io', 'virtualmachineclusterpreferences')
  return version ? { apiVersion: version, resource: 'virtualmachineclusterpreferences' } : null
})
const nads = useWatch(() => {
  const version = cluster.versionFor('k8s.cni.cncf.io', 'network-attachment-definitions')
  return version && isDnsLabel(model.namespace) ? { apiVersion: version, resource: 'network-attachment-definitions', namespace: model.namespace } : null
})

const sortedByName = <T extends { metadata: { name: string } }>(list: T[]) => [...list].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name, undefined, { numeric: true }))
const instancetypeList = computed(() => sortedByName(instancetypes.items.value))
const preferenceList = computed(() => sortedByName(preferences.items.value))

const selectedInstancetype = computed(() => instancetypeList.value.find((i) => i.metadata.name === model.instancetype))

const clonablePvcs = computed(() => inv.pvcs.filter((p) => p.status?.phase === 'Bound'))

// --- choices that imply others -----------------------------------------------------------

watch(
  () => model.osType,
  (os) => {
    const bus = os === 'windows' ? 'sata' : 'virtio'
    model.disks.forEach((d) => (d.bus = bus))
    model.nicModel = os === 'windows' ? 'e1000e' : 'virtio'
    if (os === 'windows') {
      model.firmware = 'uefi'
      model.secureBoot = true
      model.tpm = true
      model.cloudInit = false
      if (model.memoryMib < 4096) model.memoryMib = 4096
      if (model.disks[0] && model.disks[0].size < 64) model.disks[0].size = 64
    }
  },
)

watch(
  () => model.source,
  (source) => {
    if (source === 'iso') model.cloudInit = false
    if (source === 'container' && model.disks.length === 1 && model.disks[0].size === 20) model.disks = []
    if (source !== 'container' && model.disks.length === 0) model.disks.push({ size: 20, storageClass: null, bus: model.osType === 'windows' ? 'sata' : 'virtio', cache: '', accessMode: null, volumeMode: null })
  },
)

watch(
  () => model.clone,
  (clone) => {
    if (clone && model.disks[0] && model.disks[0].size < clone.sizeGib) model.disks[0].size = clone.sizeGib
  },
)

watch(
  () => model.containerImage,
  (image) => {
    const known = CONTAINER_DISKS.find((c) => c.image === image)
    if (known && (model.ciUser === 'admin' || CONTAINER_DISKS.some((c) => c.user === model.ciUser))) model.ciUser = known.user
  },
  { immediate: true },
)

function selectIso(event: Event) {
  const key = (event.target as HTMLSelectElement).value
  const dv = isos.value.find((d) => `${d.metadata.namespace}/${d.metadata.name}` === key)
  model.iso = dv ? { namespace: dv.metadata.namespace!, name: dv.metadata.name, sizeGib: imageGib(dv) } : null
}

function selectClone(event: Event) {
  const [kind, namespace, name] = (event.target as HTMLSelectElement).value.split('|')
  if (!name) {
    model.clone = null
    return
  }
  if (kind === 'datasource') {
    const ds = dataSources.value.find((d) => d.metadata.namespace === namespace && d.metadata.name === name)
    const pvcRef = ds?.spec?.source?.pvc
    const pvc = pvcRef ? inv.pvcs.find((p) => p.metadata.namespace === (pvcRef.namespace ?? namespace) && p.metadata.name === pvcRef.name) : null
    model.clone = { kind: 'datasource', namespace, name, sizeGib: pvcGib(pvc) || 10 }
  } else {
    const pvc = inv.pvcs.find((p) => p.metadata.namespace === namespace && p.metadata.name === name)
    model.clone = { kind: 'pvc', namespace, name, sizeGib: pvcGib(pvc) || 10 }
  }
}

function addDisk() {
  model.disks.push({ size: 10, storageClass: model.disks[0]?.storageClass ?? null, bus: model.osType === 'windows' ? 'sata' : 'virtio', cache: '', accessMode: null, volumeMode: null })
}

// --- steps and validation -------------------------------------------------------------

const steps = [
  { id: 'general', title: 'General', icon: faCircleInfo },
  { id: 'os', title: 'OS', icon: faCompactDisc },
  { id: 'system', title: 'System', icon: faGears },
  { id: 'disks', title: 'Disks', icon: faHardDrive },
  { id: 'cpu', title: 'CPU', icon: faMicrochip },
  { id: 'memory', title: 'Memory', icon: faMemory },
  { id: 'network', title: 'Network', icon: faNetworkWired },
  { id: 'cloudinit', title: 'Cloud-Init', icon: faCloud },
  { id: 'confirm', title: 'Confirm', icon: faClipboardCheck },
] as const
type StepId = (typeof steps)[number]['id']
const step = ref<StepId>('general')
const stepIndex = computed(() => steps.findIndex((s) => s.id === step.value))

const errors = computed<Record<StepId, string[]>>(() => {
  const e: Record<StepId, string[]> = { general: [], os: [], system: [], disks: [], cpu: [], memory: [], network: [], cloudinit: [], confirm: [] }
  if (!model.name) e.general.push('A name is required')
  else if (!isDnsLabel(model.name) || model.name.length > 45) e.general.push('The name must be lowercase letters, digits and dashes (at most 45 characters)')
  else if (inv.vms.some((v) => v.metadata.namespace === model.namespace && v.metadata.name === model.name)) e.general.push(`A VM named ${model.name} already exists in ${model.namespace}`)
  if (!isDnsLabel(model.namespace)) e.general.push('Choose a valid namespace')
  if (model.tags.some((t) => !/^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/.test(t) || t.length > 63)) e.general.push('Tags may contain lowercase letters, digits, dashes, dots and underscores')

  if (model.source === 'iso' && !model.iso) e.os.push('Choose an ISO image')
  if (model.source === 'url' && !/^https?:\/\/\S+$/.test(model.url.trim())) e.os.push('Enter an http(s) URL to the disk image')
  if (model.source === 'clone' && !model.clone) e.os.push('Choose a disk or golden image to clone')
  if (model.source === 'container' && !model.containerImage.trim()) e.os.push('Enter a container disk image')

  if (model.secureBoot && model.firmware !== 'uefi') e.system.push('Secure Boot requires UEFI firmware')

  if (model.source !== 'container' && !model.disks.length) e.disks.push('This boot source needs a root disk')
  model.disks.forEach((d, i) => {
    if (!(d.size > 0)) e.disks.push(`Disk ${i}: size must be positive`)
  })
  if (model.source === 'clone' && model.clone && model.disks[0] && model.disks[0].size < model.clone.sizeGib) e.disks.push(`The root disk must be at least ${model.clone.sizeGib} GiB, the size of the clone source`)

  if (model.useInstancetype && !model.instancetype) e.cpu.push('Choose an instance type')
  if (!model.useInstancetype && [model.sockets, model.cores, model.threads].some((n) => !Number.isInteger(n) || n < 1)) e.cpu.push('Sockets, cores and threads must be whole numbers of at least 1')

  if (!model.useInstancetype && !(model.memoryMib >= 128)) e.memory.push('Memory must be at least 128 MiB')
  if (model.memoryRequestMib !== null && model.memoryRequestMib > model.memoryMib) e.memory.push('The request cannot exceed the guest memory')

  if (model.mac && !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(model.mac)) e.network.push('The MAC address must look like 02:00:00:aa:bb:cc')

  if (model.cloudInit && model.ciRaw && !model.ciUserData.trim()) e.cloudinit.push('User data is empty')
  return e
})

const invalid = computed(() => steps.filter((s) => errors.value[s.id].length).map((s) => s.id))
const currentErrors = computed(() => errors.value[step.value])

function go(target: StepId) {
  step.value = target
}
function next() {
  if (stepIndex.value < steps.length - 1) step.value = steps[stepIndex.value + 1].id
}
function back() {
  if (stepIndex.value > 0) step.value = steps[stepIndex.value - 1].id
}

// --- confirm ----------------------------------------------------------------------------

const built = computed(() => buildVm(model))
const yaml = computed(() => toYaml(built.value))
const validation = ref<{ ok: boolean; message: string } | null>(null)
const busy = ref(false)

async function validate() {
  validation.value = null
  busy.value = true
  try {
    await k8s.create({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace: model.namespace }, built.value.vm, { dryRun: true })
    validation.value = { ok: true, message: 'The API server accepts this virtual machine.' }
  } catch (e) {
    validation.value = { ok: false, message: errorMessage(e) }
  } finally {
    busy.value = false
  }
}

async function submit() {
  if (invalid.value.length) {
    step.value = invalid.value[0]
    return
  }
  busy.value = true
  const { vm, extraObjects } = built.value
  // A refusal the API server would give (a quota, a webhook, a bad field)
  // belongs here, with the wizard still open to fix it — not on the page of
  // a VM that will never exist.
  try {
    await k8s.create({ apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace: model.namespace }, vm, { dryRun: true })
  } catch (e) {
    validation.value = { ok: false, message: errorMessage(e) }
    step.value = 'confirm'
    busy.value = false
    return
  }
  const result = await run(`Create VM ${model.name}`, () => vmApi.create(vm, { extraObjects, start: model.start }), { openLog: true })
  busy.value = false
  if (result) {
    emit('close', result)
    router.push(routeTo({ kind: 'vm', name: model.name, namespace: model.namespace }))
  }
}

const summary = computed(() => {
  const rows: Array<[string, string]> = [
    ['Name', `${model.namespace}/${model.name}`],
    ['OS type', model.osType],
  ]
  switch (model.source) {
    case 'iso':
      rows.push(['Boot', `ISO ${model.iso?.namespace}/${model.iso?.name} (cloned into ${model.name}-cdrom)`])
      break
    case 'url':
      rows.push(['Boot', `disk image imported from ${model.url}`])
      break
    case 'clone':
      rows.push(['Boot', `clone of ${model.clone?.kind === 'datasource' ? 'golden image' : 'disk'} ${model.clone?.namespace}/${model.clone?.name}`])
      break
    case 'container':
      rows.push(['Boot', `container disk ${model.containerImage} (ephemeral root disk)`])
      break
    case 'blank':
      rows.push(['Boot', 'network (PXE), then an empty disk'])
  }
  rows.push(['Firmware', `${model.firmware === 'uefi' ? `UEFI${model.secureBoot ? ' + Secure Boot' : ''}` : 'BIOS'} · ${model.machine}${model.tpm ? ' · TPM' : ''}`])
  model.disks.forEach((d, i) => rows.push([i === 0 && model.source !== 'container' ? 'Root disk' : `Disk ${i}`, diskLabel(d)]))
  rows.push(['CPU', model.useInstancetype ? `instance type ${model.instancetype}` : `${model.sockets * model.cores * model.threads} vCPU (${model.sockets}s/${model.cores}c/${model.threads}t, ${model.cpuModel})`])
  rows.push(['Memory', model.useInstancetype ? bytes(quantity(selectedInstancetype.value?.spec?.memory?.guest)) : bytes(model.memoryMib * 1024 * 1024)])
  if (model.preference) rows.push(['Preference', model.preference])
  rows.push(['Network', model.network === 'none' ? 'none' : `pod network (${model.network}, ${model.nicModel})${model.networkAttachment ? ` + ${model.networkAttachment}` : ''}`])
  rows.push(['Cloud-Init', model.cloudInit ? (model.ciRaw ? 'custom user data' : `user ${model.ciUser || '(image default)'}${model.ciPassword ? ', password' : ''}${model.ciSshKeys.trim() ? ', SSH keys' : ''}`) : 'off'])
  if (built.value.extraObjects.length) rows.push(['Secrets', built.value.extraObjects.map((o) => o.metadata.name).join(', ')])
  return rows
})
</script>

<template>
  <Modal title="Create: Virtual Machine" :icon="faDesktop" large @close="emit('close')">
    <div class="flex h-full min-h-0">
      <nav class="w-44 shrink-0 border-r border-line bg-surface-1 py-2">
        <button
          v-for="(s, i) in steps"
          :key="s.id"
          class="flex h-9 w-full items-center gap-2.5 px-3 text-left"
          :class="step === s.id ? 'bg-selection font-medium shadow-[inset_3px_0_0_var(--accent)]' : 'text-fg-muted hover:bg-surface-3 hover:text-fg'"
          @click="go(s.id)"
        >
          <Fa :icon="s.icon" class="w-4" :class="step === s.id ? 'text-accent' : ''" />
          <span class="flex-1">{{ s.title }}</span>
          <Fa v-if="invalid.includes(s.id) && i < stepIndex" :icon="faCircleExclamation" class="text-bad" />
        </button>
      </nav>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 overflow-auto p-5">
          <!-- General -->
          <div v-if="step === 'general'" class="max-w-2xl space-y-3">
            <FormRow label="Namespace" required hint="Proxmox's resource pool: RBAC and quotas apply per namespace.">
              <NamespaceSelect v-model="model.namespace" />
            </FormRow>
            <FormRow label="Name" required>
              <input v-model.trim="model.name" class="input" placeholder="my-vm" spellcheck="false" autofocus />
            </FormRow>
            <FormRow label="Description">
              <textarea v-model="model.description" class="input h-16 resize-y" />
            </FormRow>
            <FormRow label="Tags" hint="Separate with commas; shown in the Tag View.">
              <input v-model="tagsText" class="input" placeholder="web, production" />
            </FormRow>
            <FormRow label="Start after created">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.start" type="checkbox" class="accent-[var(--accent)]" /> Run the VM as soon as it is created (run strategy Always)</label>
            </FormRow>
          </div>

          <!-- OS -->
          <div v-else-if="step === 'os'" class="max-w-2xl space-y-3">
            <FormRow label="Guest OS type">
              <select v-model="model.osType" class="input">
                <option value="linux">Linux (virtio devices, cloud-init)</option>
                <option value="windows">Microsoft Windows (SATA, e1000e, Hyper-V enlightenments, UEFI + TPM)</option>
                <option value="other">Other</option>
              </select>
            </FormRow>
            <FormRow label="Boot source" required>
              <div class="grid gap-1.5">
                <label v-for="option in [
                  { value: 'container', title: 'Container disk', text: 'A cloud image from a registry, booted fresh each start (root disk is ephemeral).' },
                  { value: 'clone', title: 'Clone a disk or golden image', text: 'Copy an existing PVC or CDI DataSource — fast on storage that supports CSI cloning.' },
                  { value: 'url', title: 'Import a disk image from a URL', text: 'qcow2, raw, VMDK, VHD/VHDX, optionally xz/gz — CDI downloads and converts it with qemu-img.' },
                  { value: 'iso', title: 'Install from an ISO image', text: 'Attach an ISO from the image library as a CD/DVD drive, with an empty disk to install onto.' },
                  { value: 'blank', title: 'No media (network boot)', text: 'Boot via PXE onto an empty disk.' },
                ]" :key="option.value" class="flex cursor-pointer gap-2 rounded-md border px-3 py-2" :class="model.source === option.value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'">
                  <input v-model="model.source" type="radio" :value="option.value" class="mt-1 accent-[var(--accent)]" />
                  <span><span class="block font-medium">{{ option.title }}</span><span class="block text-xs text-fg-muted">{{ option.text }}</span></span>
                </label>
              </div>
            </FormRow>

            <FormRow v-if="model.source === 'container'" label="Image" required>
              <input v-model.trim="model.containerImage" class="input mono" list="kve-container-disks" spellcheck="false" />
              <datalist id="kve-container-disks">
                <option v-for="c in CONTAINER_DISKS" :key="c.image" :value="c.image">{{ c.label }}</option>
              </datalist>
              <div class="mt-1.5 flex flex-wrap gap-1">
                <button v-for="c in CONTAINER_DISKS" :key="c.image" type="button" class="chip hover:bg-accent-soft hover:text-accent" @click="model.containerImage = c.image">{{ c.label }}</button>
              </div>
            </FormRow>

            <FormRow v-if="model.source === 'iso'" label="ISO image" required :hint="isos.length ? `Stored in the image library; the VM gets its own copy.` : null">
              <select class="input" :value="model.iso ? `${model.iso.namespace}/${model.iso.name}` : ''" @change="selectIso">
                <option value="">— choose —</option>
                <option v-for="iso in isos" :key="iso.metadata.uid" :value="`${iso.metadata.namespace}/${iso.metadata.name}`" :disabled="iso.status?.phase !== 'Succeeded'">
                  {{ iso.metadata.namespace }}/{{ iso.metadata.name }}{{ iso.status?.phase !== 'Succeeded' ? ` (${iso.status?.phase ?? 'pending'})` : '' }}
                </option>
              </select>
              <Notice v-if="!isos.length" kind="info" class="mt-2">No ISO images yet. Add one under Datacenter → Images with “Download from URL” or “Upload”.</Notice>
            </FormRow>

            <FormRow v-if="model.source === 'url'" label="Image URL" required :hint="formatHint(model.url)">
              <input v-model.trim="model.url" class="input mono" placeholder="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2" spellcheck="false" />
            </FormRow>

            <FormRow v-if="model.source === 'clone'" label="Source" required hint="Cloning from another namespace needs permission to clone from it (datavolumes/source).">
              <select class="input" :value="model.clone ? `${model.clone.kind}|${model.clone.namespace}|${model.clone.name}` : ''" @change="selectClone">
                <option value="">— choose —</option>
                <optgroup v-if="dataSources.length" label="Golden images (DataSources)">
                  <option v-for="ds in dataSources" :key="ds.metadata.uid" :value="`datasource|${ds.metadata.namespace}|${ds.metadata.name}`">{{ ds.metadata.namespace }}/{{ ds.metadata.name }}</option>
                </optgroup>
                <optgroup v-if="imageDisks.length" label="Disk templates (image library)">
                  <option v-for="d in imageDisks" :key="d.metadata.uid" :value="`pvc|${d.metadata.namespace}|${d.metadata.name}`">{{ d.metadata.namespace }}/{{ d.metadata.name }}</option>
                </optgroup>
                <optgroup label="Disks">
                  <option v-for="p in clonablePvcs" :key="p.metadata.uid" :value="`pvc|${p.metadata.namespace}|${p.metadata.name}`">{{ p.metadata.namespace }}/{{ p.metadata.name }} ({{ p.status?.capacity?.storage }})</option>
                </optgroup>
              </select>
            </FormRow>

            <FormRow label="Preference" hint="A cluster preference sets OS-appropriate device defaults (optional).">
              <select v-model="model.preference" class="input">
                <option value="">none</option>
                <option v-for="p in preferenceList" :key="p.metadata.uid" :value="p.metadata.name">{{ p.metadata.name }}{{ p.metadata.annotations?.['openshift.io/display-name'] ? ` — ${p.metadata.annotations['openshift.io/display-name']}` : '' }}</option>
              </select>
            </FormRow>
          </div>

          <!-- System -->
          <div v-else-if="step === 'system'" class="max-w-2xl space-y-3">
            <FormRow label="Machine">
              <select v-model="model.machine" class="input">
                <option value="q35">q35 (PCIe, recommended)</option>
                <option value="pc-q35-rhel9.6.0">pc-q35-rhel9.6.0 (pinned)</option>
              </select>
            </FormRow>
            <FormRow label="Firmware">
              <select v-model="model.firmware" class="input">
                <option value="bios">SeaBIOS</option>
                <option value="uefi">OVMF (UEFI)</option>
              </select>
            </FormRow>
            <FormRow label="Secure Boot" hint="Needs UEFI; enables SMM.">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.secureBoot" type="checkbox" :disabled="model.firmware !== 'uefi'" class="accent-[var(--accent)]" /> Enable Secure Boot</label>
            </FormRow>
            <FormRow label="TPM" hint="An emulated TPM 2.0 (swtpm), e.g. for Windows 11.">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.tpm" type="checkbox" class="accent-[var(--accent)]" /> Add TPM</label>
            </FormRow>
            <FormRow label="Graphics" :hint="!model.graphics && model.firmware === 'bios' ? 'A SeaBIOS guest without a display device can hang before it boots; keep it, or use UEFI to run headless.' : null">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.graphics" type="checkbox" class="accent-[var(--accent)]" /> VGA display (noVNC console)</label>
            </FormRow>
            <FormRow label="Tablet pointer" hint="Keeps the mouse pointer in step in the noVNC console.">
              <label class="flex items-center gap-2 pt-1.5"><input v-model="model.tablet" type="checkbox" class="accent-[var(--accent)]" /> USB tablet input</label>
            </FormRow>
            <Notice kind="info">The QEMU guest agent reports IPs, users and filesystems and enables filesystem freeze for snapshots. Cloud-Init can install it for Linux guests.</Notice>
          </div>

          <!-- Disks -->
          <div v-else-if="step === 'disks'" class="space-y-3">
            <Notice v-if="model.source === 'container'" kind="info">The root disk comes from the container image and is reset on every start. Add persistent disks below if the guest needs to keep data.</Notice>
            <div v-for="(d, i) in model.disks" :key="i" class="card p-3">
              <div class="mb-2 flex items-center gap-2">
                <Fa :icon="faHardDrive" class="text-fg-muted" />
                <span class="font-semibold">{{ i === 0 && model.source !== 'container' ? 'rootdisk' : `disk${i}` }}</span>
                <span class="text-xs text-fg-subtle">
                  {{ i === 0 && model.source === 'url' ? 'imported from the URL' : i === 0 && model.source === 'clone' ? 'cloned from the source' : 'empty' }}
                </span>
                <button v-if="!(i === 0 && model.source !== 'container')" class="btn btn-sm btn-ghost ml-auto text-bad" @click="model.disks.splice(i, 1)"><Fa :icon="faTrash" /> Remove</button>
              </div>
              <div class="grid gap-3 lg:grid-cols-2">
                <FormRow label="Size (GiB)" required>
                  <input v-model.number="d.size" type="number" min="1" step="1" class="input" />
                </FormRow>
                <FormRow label="Bus">
                  <select v-model="d.bus" class="input">
                    <option value="virtio">VirtIO Block (fastest; drivers needed on Windows)</option>
                    <option value="scsi">SCSI (supports hotplug, discard)</option>
                    <option value="sata">SATA (widest compatibility)</option>
                  </select>
                </FormRow>
                <FormRow label="Storage">
                  <StorageClassSelect v-model="d.storageClass" />
                </FormRow>
                <FormRow label="Cache">
                  <select v-model="d.cache" class="input">
                    <option value="">Default (no cache)</option>
                    <option value="none">none</option>
                    <option value="writethrough">writethrough</option>
                  </select>
                </FormRow>
                <FormRow label="Access mode" hint="Default comes from the storage profile. ReadWriteMany enables live migration.">
                  <select v-model="d.accessMode" class="input">
                    <option :value="null">storage profile default</option>
                    <option value="ReadWriteMany">ReadWriteMany</option>
                    <option value="ReadWriteOnce">ReadWriteOnce</option>
                  </select>
                </FormRow>
                <FormRow label="Volume mode">
                  <select v-model="d.volumeMode" class="input">
                    <option :value="null">storage profile default</option>
                    <option value="Block">Block</option>
                    <option value="Filesystem">Filesystem</option>
                  </select>
                </FormRow>
              </div>
            </div>
            <button class="btn" @click="addDisk"><Fa :icon="faPlus" /> Add disk</button>
          </div>

          <!-- CPU -->
          <div v-else-if="step === 'cpu'" class="max-w-2xl space-y-3">
            <FormRow label="Sizing">
              <div class="flex gap-4 pt-1.5">
                <label class="flex items-center gap-2"><input v-model="model.useInstancetype" type="radio" :value="false" class="accent-[var(--accent)]" /> Custom CPU and memory</label>
                <label class="flex items-center gap-2" :class="instancetypeList.length ? '' : 'opacity-50'"><input v-model="model.useInstancetype" type="radio" :value="true" :disabled="!instancetypeList.length" class="accent-[var(--accent)]" /> Instance type</label>
              </div>
            </FormRow>
            <template v-if="model.useInstancetype">
              <FormRow label="Instance type" required>
                <select v-model="model.instancetype" class="input">
                  <option value="">— choose —</option>
                  <option v-for="it in instancetypeList" :key="it.metadata.uid" :value="it.metadata.name">
                    {{ it.metadata.name }} — {{ it.spec?.cpu?.guest }} vCPU, {{ it.spec?.memory?.guest }}
                  </option>
                </select>
              </FormRow>
              <Notice kind="info">An instance type fixes CPU and memory; the Memory step is then informational.</Notice>
            </template>
            <template v-else>
              <FormRow label="Sockets"><input v-model.number="model.sockets" type="number" min="1" class="input" /></FormRow>
              <FormRow label="Cores"><input v-model.number="model.cores" type="number" min="1" class="input" /></FormRow>
              <FormRow label="Threads"><input v-model.number="model.threads" type="number" min="1" class="input" /></FormRow>
              <FormRow label="Total">{{ model.sockets * model.cores * model.threads }} vCPU</FormRow>
              <FormRow label="Type" hint="host-model keeps VMs migratable between similar nodes; host-passthrough is fastest but pins to identical CPUs.">
                <input v-model.trim="model.cpuModel" class="input" list="kve-cpu-models" />
                <datalist id="kve-cpu-models">
                  <option value="host-model" />
                  <option value="host-passthrough" />
                  <option v-for="m in cpuModels.common.value.slice(0, 12)" :key="m" :value="m" />
                </datalist>
              </FormRow>
              <Notice v-if="cpuModels.mixed.value && hostCpuModel" kind="warning" title="Nodes have different CPUs">
                {{ Object.entries(cpuModels.hostModels.value).map(([n, m]) => `${n}: ${m}`).join(', ') }}. With the host's CPU model this VM can only live-migrate between nodes of the same kind.
                <template v-if="cpuModels.common.value.length">
                  A model every node supports keeps it movable anywhere —
                  <button type="button" class="underline" @click="model.cpuModel = cpuModels.common.value[0]">use {{ cpuModels.common.value[0] }}</button>.
                </template>
              </Notice>
            </template>
          </div>

          <!-- Memory -->
          <div v-else-if="step === 'memory'" class="max-w-2xl space-y-3">
            <template v-if="model.useInstancetype">
              <Notice kind="info">Memory comes from the instance type{{ selectedInstancetype ? `: ${selectedInstancetype.spec?.memory?.guest}` : '' }}.</Notice>
            </template>
            <template v-else>
              <FormRow label="Memory (MiB)" required :hint="bytes(model.memoryMib * 1024 * 1024)">
                <input v-model.number="model.memoryMib" type="number" min="128" step="256" class="input" />
                <div class="mt-1.5 flex flex-wrap gap-1">
                  <button v-for="size in [1024, 2048, 4096, 8192, 16384, 32768]" :key="size" type="button" class="chip hover:bg-accent-soft hover:text-accent" @click="model.memoryMib = size">{{ size / 1024 }} GiB</button>
                </div>
              </FormRow>
              <FormRow label="Minimum request (MiB)" hint="Optional. Lower than the guest memory lets the scheduler overcommit — like ballooning's minimum in Proxmox.">
                <input :value="model.memoryRequestMib ?? ''" type="number" min="64" step="256" class="input" placeholder="same as memory" @input="model.memoryRequestMib = ($event.target as HTMLInputElement).value ? Number(($event.target as HTMLInputElement).value) : null" />
              </FormRow>
            </template>
          </div>

          <!-- Network -->
          <div v-else-if="step === 'network'" class="max-w-2xl space-y-3">
            <FormRow label="Pod network">
              <select v-model="model.network" class="input">
                <option value="masquerade">Masquerade (NAT behind the pod IP — recommended)</option>
                <option value="bridge">Bridge (the guest takes the pod IP; blocks live migration)</option>
                <option value="none">No network device</option>
              </select>
            </FormRow>
            <FormRow label="Model">
              <select v-model="model.nicModel" class="input" :disabled="model.network === 'none'">
                <option value="virtio">VirtIO (paravirtualized)</option>
                <option value="e1000e">Intel E1000E</option>
              </select>
            </FormRow>
            <FormRow label="MAC address" hint="Leave empty to generate one.">
              <input v-model.trim="model.mac" class="input mono" placeholder="auto" :disabled="model.network === 'none'" />
            </FormRow>
            <FormRow label="Secondary network" :hint="nads.items.value.length ? 'A Multus NetworkAttachmentDefinition in this namespace, bridged.' : 'No NetworkAttachmentDefinitions (Multus) in this namespace.'">
              <select v-model="model.networkAttachment" class="input" :disabled="!nads.items.value.length">
                <option value="">none</option>
                <option v-for="n in nads.items.value" :key="n.metadata.uid" :value="n.metadata.name">{{ n.metadata.name }}</option>
              </select>
            </FormRow>
          </div>

          <!-- Cloud-Init -->
          <div v-else-if="step === 'cloudinit'" class="max-w-2xl space-y-3">
            <Notice v-if="model.source === 'iso'" kind="info">Installing from an ISO: Cloud-Init is not used.</Notice>
            <template v-else>
              <FormRow label="Cloud-Init">
                <label class="flex items-center gap-2 pt-1.5"><input v-model="model.cloudInit" type="checkbox" class="accent-[var(--accent)]" /> Configure the guest on first boot (NoCloud drive)</label>
              </FormRow>
              <template v-if="model.cloudInit">
                <FormRow label="Mode">
                  <div class="flex gap-4 pt-1.5">
                    <label class="flex items-center gap-2"><input v-model="model.ciRaw" type="radio" :value="false" class="accent-[var(--accent)]" /> Simple</label>
                    <label class="flex items-center gap-2"><input v-model="model.ciRaw" type="radio" :value="true" class="accent-[var(--accent)]" /> Custom user data</label>
                  </div>
                </FormRow>
                <template v-if="!model.ciRaw">
                  <FormRow label="User"><input v-model.trim="model.ciUser" class="input" /></FormRow>
                  <FormRow label="Password" hint="Stored in a Secret next to the VM, not in the VM definition.">
                    <input v-model="model.ciPassword" type="password" class="input" autocomplete="new-password" />
                  </FormRow>
                  <FormRow label="SSH public keys" hint="One per line.">
                    <textarea v-model="model.ciSshKeys" class="input mono h-20 resize-y" placeholder="ssh-ed25519 AAAA… you@host" spellcheck="false" />
                  </FormRow>
                  <FormRow label="Hostname"><input v-model.trim="model.ciHostname" class="input" :placeholder="model.name || 'defaults to the VM name'" /></FormRow>
                  <FormRow label="Packages" hint="Installed on first boot, separated by spaces."><input v-model="model.ciPackages" class="input" placeholder="htop tmux" /></FormRow>
                  <FormRow label="Guest agent">
                    <label class="flex items-center gap-2 pt-1.5"><input v-model="model.ciGuestAgent" type="checkbox" class="accent-[var(--accent)]" /> Install and start qemu-guest-agent</label>
                  </FormRow>
                </template>
                <FormRow v-else label="User data" wide hint="Stored in a Secret next to the VM.">
                  <textarea v-model="model.ciUserData" class="input mono h-64 resize-y" spellcheck="false" />
                </FormRow>
              </template>
            </template>
          </div>

          <!-- Confirm -->
          <div v-else-if="step === 'confirm'" class="grid h-full min-h-[420px] gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div class="space-y-3">
              <Notice v-if="invalid.length" kind="error" title="Some steps need attention">
                <button v-for="id in invalid" :key="id" class="mr-2 underline" @click="go(id)">{{ steps.find((s) => s.id === id)?.title }}</button>
              </Notice>
              <div class="overflow-hidden rounded-md border border-line">
                <table class="table-dense">
                  <tbody>
                    <tr v-for="[key, value] in summary" :key="key">
                      <td class="w-32 text-fg-muted">{{ key }}</td>
                      <td class="whitespace-normal break-all">{{ value }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <label class="flex items-center gap-2"><input v-model="model.start" type="checkbox" class="accent-[var(--accent)]" /> Start after created</label>
              <div class="flex items-center gap-2">
                <button class="btn" :disabled="busy || !!invalid.length" @click="validate"><Fa :icon="faCheck" /> Validate (dry run)</button>
              </div>
              <Notice v-if="validation" :kind="validation.ok ? 'info' : 'error'">{{ validation.message }}</Notice>
            </div>
            <div class="flex min-h-[360px] flex-col">
              <div class="mb-1 text-xs text-fg-muted">What will be created</div>
              <div class="min-h-0 flex-1"><YamlEditor :model-value="yaml" readonly /></div>
            </div>
          </div>

          <Notice v-if="currentErrors.length && step !== 'confirm'" kind="warning" class="mt-4 max-w-2xl">
            <div v-for="e in currentErrors" :key="e">{{ e }}</div>
          </Notice>
        </div>

        <footer class="flex shrink-0 items-center gap-2 border-t border-line bg-surface-2 px-4 py-2.5">
          <span class="text-xs text-fg-subtle">Step {{ stepIndex + 1 }} of {{ steps.length }}</span>
          <button class="btn ml-auto" @click="emit('close')">Cancel</button>
          <button class="btn" :disabled="stepIndex === 0" @click="back"><Fa :icon="faChevronLeft" /> Back</button>
          <button v-if="step !== 'confirm'" class="btn btn-primary" @click="next">Next <Fa :icon="faChevronRight" /></button>
          <button v-else class="btn btn-primary" :disabled="busy || !!invalid.length" @click="submit"><Fa :icon="faCheck" /> Finish</button>
        </footer>
      </div>
    </div>
  </Modal>
</template>
