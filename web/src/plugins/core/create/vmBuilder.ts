/**
 * The Create VM wizard's model, and turning it into Kubernetes objects.
 *
 * Kept free of Vue so the mapping from "what the person chose" to "what the
 * API server receives" can be read — and checked — in one place.
 */
import { dump } from 'js-yaml'
import type { KObject } from '@/api/types'
import { TAG_PREFIX, DESCRIPTION_ANNOTATION } from '@/util/kubevirt'
import { dataVolumeSpec, gib, registryUrl, type DiskSource } from './helpers'
import { hostnameKeys } from '@/plugins/core/vm/cloudinit'

export type BootSource = 'iso' | 'url' | 'clone' | 'container' | 'blank'
export type OsType = 'linux' | 'windows' | 'other'
export type Bus = 'virtio' | 'sata' | 'scsi'

export interface DiskModel {
  size: number
  storageClass: string | null
  bus: Bus
  cache: '' | 'none' | 'writethrough'
  accessMode: string | null
  volumeMode: string | null
}

export interface VmModel {
  name: string
  namespace: string
  description: string
  tags: string[]
  start: boolean

  source: BootSource
  osType: OsType
  iso: { namespace: string; name: string; sizeGib: number } | null
  url: string
  clone: { kind: 'datasource' | 'pvc'; namespace: string; name: string; sizeGib: number } | null
  containerImage: string

  machine: string
  firmware: 'bios' | 'uefi'
  secureBoot: boolean
  tpm: boolean
  graphics: boolean
  tablet: boolean

  disks: DiskModel[]

  useInstancetype: boolean
  instancetype: string
  preference: string
  sockets: number
  cores: number
  threads: number
  cpuModel: string
  memoryMib: number
  memoryRequestMib: number | null

  network: 'masquerade' | 'bridge' | 'none'
  nicModel: 'virtio' | 'e1000e'
  mac: string
  networkAttachment: string

  cloudInit: boolean
  ciUser: string
  ciPassword: string
  ciSshKeys: string
  ciHostname: string
  ciPackages: string
  ciGuestAgent: boolean
  ciRaw: boolean
  ciUserData: string
}

export function defaultModel(namespace: string): VmModel {
  return {
    name: '',
    namespace,
    description: '',
    tags: [],
    start: true,
    source: 'container',
    osType: 'linux',
    iso: null,
    url: '',
    clone: null,
    containerImage: 'quay.io/containerdisks/fedora:latest',
    machine: 'q35',
    firmware: 'bios',
    secureBoot: false,
    tpm: false,
    graphics: true,
    tablet: true,
    disks: [{ size: 20, storageClass: null, bus: 'virtio', cache: '', accessMode: null, volumeMode: null }],
    useInstancetype: false,
    instancetype: '',
    preference: '',
    sockets: 1,
    cores: 2,
    threads: 1,
    cpuModel: 'host-model',
    memoryMib: 2048,
    memoryRequestMib: null,
    network: 'masquerade',
    nicModel: 'virtio',
    mac: '',
    networkAttachment: '',
    cloudInit: true,
    ciUser: 'admin',
    ciPassword: '',
    ciSshKeys: '',
    ciHostname: '',
    ciPackages: '',
    ciGuestAgent: true,
    ciRaw: false,
    ciUserData: '#cloud-config\n',
  }
}

/** Container disks CDI publishes — the "templates" of the KubeVirt world. */
export const CONTAINER_DISKS = [
  { label: 'Fedora (latest)', image: 'quay.io/containerdisks/fedora:latest', user: 'fedora' },
  { label: 'Ubuntu 24.04', image: 'quay.io/containerdisks/ubuntu:24.04', user: 'ubuntu' },
  { label: 'CentOS Stream 10', image: 'quay.io/containerdisks/centos-stream:10', user: 'cloud-user' },
  { label: 'Debian 12', image: 'quay.io/containerdisks/debian:12', user: 'debian' },
  { label: 'openSUSE Tumbleweed', image: 'quay.io/containerdisks/opensuse-tumbleweed:1.0.0', user: 'opensuse' },
  { label: 'CirrOS (tiny test image)', image: 'quay.io/kubevirt/cirros-container-disk-demo:latest', user: 'cirros' },
]

/** What the wizard produces: objects to create first, then the VM. */
export interface BuiltVm {
  vm: KObject
  extraObjects: KObject[]
}

function yamlList(values: string[]): string[] {
  return values.map((v) => `  - ${JSON.stringify(v)}`)
}

export function cloudInitUserData(m: VmModel): string {
  if (m.ciRaw) return m.ciUserData
  const lines = ['#cloud-config']
  if (m.ciHostname) {
    const { hostname, fqdn } = hostnameKeys(m.ciHostname)
    lines.push(`hostname: ${JSON.stringify(hostname)}`, `fqdn: ${JSON.stringify(fqdn)}`)
  }
  if (m.ciUser) lines.push(`user: ${JSON.stringify(m.ciUser)}`)
  if (m.ciPassword) {
    lines.push(`password: ${JSON.stringify(m.ciPassword)}`)
    lines.push('chpasswd:', '  expire: false')
    lines.push('ssh_pwauth: true')
  }
  const keys = m.ciSshKeys.split('\n').map((k) => k.trim()).filter(Boolean)
  if (keys.length) lines.push('ssh_authorized_keys:', ...yamlList(keys))
  const packages = m.ciPackages.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean)
  if (m.ciGuestAgent && !packages.includes('qemu-guest-agent')) packages.push('qemu-guest-agent')
  if (packages.length) lines.push('package_update: true', 'packages:', ...yamlList(packages))
  if (m.ciGuestAgent) lines.push('runcmd:', '  - [systemctl, enable, --now, qemu-guest-agent]')
  return `${lines.join('\n')}\n`
}

function diskSource(m: VmModel): DiskSource | null {
  switch (m.source) {
    case 'url':
      return { type: 'http', url: m.url }
    case 'clone':
      return m.clone ? { type: m.clone.kind === 'datasource' ? 'datasource' : 'pvc', namespace: m.clone.namespace, name: m.clone.name } : null
    case 'iso':
    case 'blank':
      return { type: 'blank' }
    default:
      return null
  }
}

/** Build the VM (and any secret it needs) from the wizard's model. */
export function buildVm(m: VmModel): BuiltVm {
  const windows = m.osType === 'windows'
  const labels: Record<string, string> = {}
  for (const tag of m.tags) labels[`${TAG_PREFIX}${tag}`] = 'true'
  const annotations: Record<string, string> = {}
  if (m.description) annotations[DESCRIPTION_ANNOTATION] = m.description

  const disks: any[] = []
  const volumes: any[] = []
  const dataVolumeTemplates: any[] = []
  const extraObjects: KObject[] = []
  let bootOrder = 1

  const template = (name: string, spec: Record<string, any>) => ({ metadata: { name }, spec })
  const diskEntry = (name: string, d: DiskModel, extra: Record<string, any> = {}) => {
    const entry: Record<string, any> = { name, disk: { bus: d.bus }, ...extra }
    if (d.cache) entry.cache = d.cache
    return entry
  }

  // The install medium comes first in the boot order.
  if (m.source === 'iso' && m.iso) {
    const cdrom = `${m.name}-cdrom`
    dataVolumeTemplates.push(
      template(cdrom, dataVolumeSpec({ name: cdrom, sizeGib: Math.max(1, m.iso.sizeGib), storageClass: m.disks[0]?.storageClass, source: { type: 'pvc', namespace: m.iso.namespace, name: m.iso.name } })),
    )
    disks.push({ name: 'cdrom', cdrom: { bus: 'sata', readonly: true }, bootOrder: bootOrder++ })
    volumes.push({ name: 'cdrom', dataVolume: { name: cdrom } })
  }

  if (m.source === 'container') {
    disks.push({ name: 'rootdisk', disk: { bus: windows ? 'sata' : 'virtio' }, bootOrder: bootOrder++ })
    volumes.push({ name: 'rootdisk', containerDisk: { image: registryUrl(m.containerImage).replace(/^docker:\/\//, '') } })
  }

  // Network boot (PXE) tries the NIC before the empty disk.
  const nicBootOrder = m.source === 'blank' && m.network !== 'none' ? bootOrder++ : undefined

  m.disks.forEach((d, index) => {
    const root = index === 0 && m.source !== 'container'
    const volumeName = root ? 'rootdisk' : `disk${index}`
    const dvName = `${m.name}-${volumeName}`
    const source = root ? diskSource(m) : ({ type: 'blank' } as DiskSource)
    if (!source) return
    dataVolumeTemplates.push(
      template(dvName, dataVolumeSpec({ name: dvName, sizeGib: d.size, storageClass: d.storageClass, source, accessMode: d.accessMode, volumeMode: d.volumeMode })),
    )
    disks.push(diskEntry(volumeName, d, root ? { bootOrder: bootOrder++ } : {}))
    volumes.push({ name: volumeName, dataVolume: { name: dvName } })
  })

  const interfaces: any[] = []
  const networks: any[] = []
  if (m.network !== 'none') {
    const iface: Record<string, any> = { name: 'default', model: m.nicModel }
    iface[m.network] = {}
    if (m.mac) iface.macAddress = m.mac
    if (nicBootOrder !== undefined) iface.bootOrder = nicBootOrder
    interfaces.push(iface)
    networks.push({ name: 'default', pod: {} })
  }
  if (m.networkAttachment) {
    interfaces.push({ name: 'secondary', bridge: {}, model: m.nicModel })
    networks.push({ name: 'secondary', multus: { networkName: m.networkAttachment } })
  }

  if (m.cloudInit && m.source !== 'iso') {
    const userData = cloudInitUserData(m)
    // A password in a VM's spec is readable by anyone who can read the VM;
    // in a Secret it is guarded by Secret RBAC.
    if (m.ciPassword || m.ciRaw) {
      const secret = `${m.name}-cloudinit`
      extraObjects.push({ apiVersion: 'v1', kind: 'Secret', metadata: { name: secret, namespace: m.namespace, labels: { 'kubevirt.io/vm': m.name } } as any, stringData: { userdata: userData }, type: 'Opaque' })
      volumes.push({ name: 'cloudinitdisk', cloudInitNoCloud: { secretRef: { name: secret } } })
    } else {
      volumes.push({ name: 'cloudinitdisk', cloudInitNoCloud: { userData } })
    }
    disks.push({ name: 'cloudinitdisk', disk: { bus: windows ? 'sata' : 'virtio' } })
  }

  const domain: Record<string, any> = {
    machine: { type: m.machine || 'q35' },
    devices: { disks, interfaces, rng: {} },
  }
  if (!m.graphics) domain.devices.autoattachGraphicsDevice = false
  if (m.tablet) domain.devices.inputs = [{ type: 'tablet', bus: 'usb', name: 'tablet' }]
  if (m.tpm) domain.devices.tpm = {}
  if (m.network === 'none' && !m.networkAttachment) domain.devices.autoattachPodInterface = false

  if (m.firmware === 'uefi') {
    domain.firmware = { bootloader: { efi: { secureBoot: m.secureBoot } } }
    if (m.secureBoot) domain.features = { ...(domain.features ?? {}), smm: { enabled: true } }
  }
  if (windows) {
    domain.features = {
      ...(domain.features ?? {}),
      acpi: {},
      apic: {},
      hyperv: { relaxed: {}, vapic: {}, spinlocks: { spinlocks: 8191 }, vpindex: {}, runtime: {}, synic: {}, stimer: {}, reset: {}, frequencies: {}, reenlightenment: {}, tlbflush: {}, ipi: {} },
    }
    domain.clock = { utc: {}, timer: { hpet: { present: false }, pit: { tickPolicy: 'delay' }, rtc: { tickPolicy: 'catchup' }, hyperv: {} } }
  }

  if (!m.useInstancetype) {
    domain.cpu = { sockets: m.sockets, cores: m.cores, threads: m.threads }
    if (m.cpuModel) domain.cpu.model = m.cpuModel
    domain.memory = { guest: `${m.memoryMib}Mi` }
    if (m.memoryRequestMib) domain.resources = { requests: { memory: `${m.memoryRequestMib}Mi` } }
  }

  const spec: Record<string, any> = {
    runStrategy: m.start ? 'Always' : 'Halted',
    template: {
      metadata: { labels: { 'kubevirt.io/vm': m.name, ...labels }, annotations: {} },
      spec: {
        domain,
        networks,
        volumes,
        terminationGracePeriodSeconds: windows ? 3600 : 180,
      },
    },
  }
  if (dataVolumeTemplates.length) spec.dataVolumeTemplates = dataVolumeTemplates
  if (m.useInstancetype && m.instancetype) spec.instancetype = { kind: 'VirtualMachineClusterInstancetype', name: m.instancetype }
  if (m.preference) spec.preference = { kind: 'VirtualMachineClusterPreference', name: m.preference }

  const vm: KObject = {
    apiVersion: 'kubevirt.io/v1',
    kind: 'VirtualMachine',
    metadata: { name: m.name, namespace: m.namespace, labels, annotations } as any,
    spec,
  }
  return { vm, extraObjects }
}

export function toYaml(built: BuiltVm): string {
  return [...built.extraObjects, built.vm].map((o) => dump(o, { lineWidth: 140, noRefs: true })).join('---\n')
}

/** Human-readable size for the summary. */
export function diskLabel(d: DiskModel): string {
  return `${gib(d.size)} on ${d.storageClass ?? 'default storage'} (${d.bus})`
}
