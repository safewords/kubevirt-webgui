/**
 * A Proxmox VM's configuration → a KubeVirt VirtualMachine.
 *
 * The server parses Proxmox's config (`proxmox.vm`); this decides what each
 * setting becomes, with the choices the person can change in the wizard kept
 * in an `ImportModel`. Kept free of Vue so the mapping reads in one place.
 */
import { dump } from 'js-yaml'
import type { KObject } from '@/api/types'
import { DESCRIPTION_ANNOTATION, TAG_PREFIX } from '@/util/kubevirt'
import { toDnsLabel } from '@/util/format'

// --- what the server sends -------------------------------------------------------

export interface PveDisk {
  key: string
  bus: 'scsi' | 'virtio' | 'sata' | 'ide'
  media: 'disk' | 'cdrom'
  volid?: string
  storage?: string
  sizeBytes?: number
  format?: string
  cache?: string
  discard: boolean
  ssd: boolean
  iothread: boolean
  readonly: boolean
  serial?: string
  importable: boolean
  note?: string
}

export interface PveNic {
  key: string
  model: string
  mac?: string
  bridge?: string
  vlan?: number
  firewall: boolean
  linkDown: boolean
  queues?: number
}

export interface PveConfig {
  name: string
  description?: string
  tags: string[]
  ostype?: string
  bios: string
  machine: 'q35' | 'i440fx'
  machineVersion?: string
  sockets: number
  cores: number
  vcpus?: number
  cpuType: string
  cpuFlags?: string
  memoryMib: number
  balloonMib?: number
  onboot: boolean
  agent: boolean
  bootOrder: string[]
  smbios: { uuid?: string; serial?: string; manufacturer?: string; product?: string; family?: string }
  efiDisk: boolean
  secureBoot: boolean
  tpm: boolean
  disks: PveDisk[]
  nics: PveNic[]
  usb: Array<{ key: string; host: string }>
  serialConsole: boolean
  vga?: string
  tablet: boolean
  localtime: boolean
  template: boolean
  lock?: string
  hasSnapshots: boolean
  cloudInit: boolean
  notImported: string[]
  digest: string
}

export interface PveVmDetail {
  node: string
  vmid: number
  status: string
  timezone?: string
  config: PveConfig
  raw: Record<string, unknown>
}

// --- the person's choices -----------------------------------------------------------

export type Bus = 'virtio' | 'scsi' | 'sata'
export type NicAttach = 'masquerade' | 'bridge' | `multus:${string}` | 'none'

export interface ImportDisk {
  key: string
  include: boolean
  bus: Bus
  storageClass: string | null
  volumeMode: 'Block' | 'Filesystem' | null
  accessMode: 'ReadWriteOnce' | 'ReadWriteMany' | null
}

export interface ImportNic {
  key: string
  attach: NicAttach
  model: string
  keepMac: boolean
}

export interface ImportModel {
  namespace: string
  name: string
  description: string
  tags: string[]
  start: boolean
  cpuModel: string
  sockets: number
  cores: number
  memoryMib: number
  firmware: 'bios' | 'uefi'
  secureBoot: boolean
  tpm: boolean
  keepUuid: boolean
  graphics: boolean
  tablet: boolean
  windows: boolean
  clientPassthrough: boolean
  disks: ImportDisk[]
  nics: ImportNic[]
}

/** NIC models KubeVirt offers. */
export const KUBEVIRT_NIC_MODELS = ['virtio', 'e1000e', 'e1000', 'igb', 'rtl8139', 'pcnet', 'ne2k_pci']

export function isWindows(ostype?: string): boolean {
  return !!ostype && /^(win|w2k|wxp|wvista)/.test(ostype)
}

/** The closest KubeVirt model for a Proxmox NIC model, and whether it changed. */
export function nicModel(model: string): { model: string; changed: boolean } {
  if (KUBEVIRT_NIC_MODELS.includes(model)) return { model, changed: false }
  if (model === 'vmxnet3') return { model: 'e1000e', changed: true }
  return { model: 'e1000', changed: true }
}

/** KubeVirt has no IDE: IDE disks become SATA, which guests treat alike. */
export function diskBus(bus: PveDisk['bus']): Bus {
  return bus === 'ide' ? 'sata' : bus
}

export function initialModel(detail: PveVmDetail, options: { namespace: string; cpuModel: string; nads: string[] }): ImportModel {
  const c = detail.config
  const windows = isWindows(c.ostype)
  return {
    namespace: options.namespace,
    name: toDnsLabel(c.name || `vm-${detail.vmid}`).slice(0, 50).replace(/-+$/, '') || `vm-${detail.vmid}`,
    description: c.description ?? '',
    tags: c.tags.map((t) => t.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')).filter((t) => /^[a-z0-9]([-a-z0-9_.]*[a-z0-9])?$/.test(t)),
    start: false,
    cpuModel: options.cpuModel,
    sockets: c.sockets,
    cores: c.cores,
    memoryMib: c.memoryMib,
    firmware: c.bios === 'ovmf' ? 'uefi' : 'bios',
    secureBoot: c.bios === 'ovmf' && c.secureBoot,
    tpm: c.tpm,
    keepUuid: !!c.smbios.uuid,
    // A BIOS guest without a display device hangs in SeaBIOS or GRUB, so only
    // UEFI guests follow Proxmox's `vga: none` / `vga: serial0`.
    graphics: c.bios !== 'ovmf' || !(c.vga === 'none' || c.vga?.startsWith('serial')),
    tablet: c.tablet,
    windows,
    clientPassthrough: c.usb.length > 0,
    disks: c.disks.map((d) => ({
      key: d.key,
      // ISOs are usually not worth copying; data and boot disks are.
      include: d.importable && d.media === 'disk',
      bus: diskBus(d.bus),
      storageClass: null,
      volumeMode: null,
      accessMode: null,
    })),
    nics: c.nics.map((n, i) => ({
      key: n.key,
      // One NIC can use the pod network; further ones need a Multus network.
      attach: i === 0 ? 'masquerade' : options.nads.length ? (`multus:${options.nads[0]}` as NicAttach) : 'none',
      model: nicModel(n.model).model,
      keepMac: !!n.mac,
    })),
  }
}

/** Where the model and the source disagree, or KubeVirt cannot follow. */
export function warnings(detail: PveVmDetail, m: ImportModel): string[] {
  const c = detail.config
  const out: string[] = []
  if (c.machine === 'i440fx') out.push('Proxmox runs this VM on the i440fx chipset; KubeVirt only offers q35. Linux guests do not mind; Windows may need to find its devices again on first boot.')
  if (!m.graphics && m.firmware === 'bios') out.push('Without a display device a BIOS guest does not boot here: SeaBIOS and GRUB wait for a video BIOS. Keep the VGA display on; the serial console works either way.')
  if (m.firmware === 'uefi' && c.efiDisk) out.push('EFI boot entries are not copied: the guest boots from its disk\'s default loader (\\EFI\\BOOT\\BOOTX64.EFI). Most installers put one there.')
  for (const d of c.disks) {
    const chosen = m.disks.find((x) => x.key === d.key)
    if (d.bus === 'ide') out.push(`${d.key}: IDE becomes SATA.`)
    if (chosen?.include && chosen.bus !== diskBus(d.bus)) out.push(`${d.key}: moves from ${d.bus} to ${chosen.bus} — the guest needs a driver for the new bus (Windows especially).`)
    if (!d.importable && d.note) out.push(`${d.key}: not copied — ${d.note}.`)
  }
  for (const n of c.nics) {
    const mapped = nicModel(n.model)
    if (mapped.changed) out.push(`${n.key}: KubeVirt has no ${n.model} NIC; it becomes ${mapped.model}.`)
    if (n.bridge || n.vlan) {
      const chosen = m.nics.find((x) => x.key === n.key)
      if (chosen?.attach === 'masquerade' || chosen?.attach === 'bridge') out.push(`${n.key}: was on ${n.bridge ?? 'a bridge'}${n.vlan ? ` VLAN ${n.vlan}` : ''}; on the pod network it gets a cluster address instead of one on that LAN.`)
    }
  }
  const podNics = m.nics.filter((n) => n.attach === 'masquerade' || n.attach === 'bridge')
  if (podNics.length > 1) out.push('Only one NIC can use the pod network; attach the others to a Multus network or leave them out.')
  // Seen with Home Assistant OS: its saved connection matched Proxmox's PCI
  // slot and held a static LAN address, so the NIC came up disabled.
  if (podNics.some((n) => n.attach === 'masquerade')) {
    out.push('The guest keeps the network settings it had on Proxmox. If they use a static address, or are tied to the old NIC (its PCI slot or interface name — the NIC sits at a different address here), the guest comes up offline: on the pod network it must use DHCP on its new interface. Home Assistant OS: `ha network update <interface> --ipv4-method auto`.')
  }
  if (c.usb.length) out.push(`USB passthrough (${c.usb.map((u) => u.host).join(', ')}) is not moved: attach the device to the new VM from its USB tab once it runs.`)
  if (c.cpuType === 'host' && m.cpuModel !== 'host-passthrough') out.push(`Proxmox gave the guest the host's CPU; here it gets ${m.cpuModel || 'the cluster default'}.`)
  if (c.hasSnapshots) out.push('Proxmox snapshots are not copied — only the current state of each disk.')
  return out
}

export function dataVolumeName(m: ImportModel, disk: { key: string }): string {
  return `${m.name}-${disk.key}`
}

/** The VM to create, and which Proxmox disk fills which DataVolume. */
export function buildImport(detail: PveVmDetail, m: ImportModel): { vm: KObject; disks: Array<{ key: string; dataVolume: string }> } {
  const c = detail.config
  const labels: Record<string, string> = {}
  for (const tag of m.tags) labels[`${TAG_PREFIX}${tag}`] = 'true'
  const annotations: Record<string, string> = { 'kubevirt-webgui/proxmox-vmid': String(detail.vmid) }
  if (m.description) annotations[DESCRIPTION_ANNOTATION] = m.description
  if (c.ostype) annotations['kubevirt-webgui/proxmox-ostype'] = c.ostype

  const included = new Set([...m.disks.filter((d) => d.include).map((d) => d.key), ...m.nics.filter((n) => n.attach !== 'none').map((n) => n.key)])
  const bootOrder = new Map(c.bootOrder.filter((k) => included.has(k)).map((k, i) => [k, i + 1]))

  const disks: any[] = []
  const volumes: any[] = []
  const dataVolumeTemplates: any[] = []
  const mapping: Array<{ key: string; dataVolume: string }> = []
  for (const source of c.disks) {
    const d = m.disks.find((x) => x.key === source.key)
    if (!d?.include || !source.importable || !source.sizeBytes) continue
    const dv = dataVolumeName(m, d)
    const storage: Record<string, any> = { resources: { requests: { storage: String(source.sizeBytes) } } }
    if (d.storageClass) storage.storageClassName = d.storageClass
    if (d.volumeMode) storage.volumeMode = d.volumeMode
    if (d.accessMode) storage.accessModes = [d.accessMode]
    dataVolumeTemplates.push({
      metadata: { name: dv, annotations: { 'cdi.kubevirt.io/storage.bind.immediate.requested': 'true', 'kubevirt-webgui/proxmox-volume': source.volid } },
      spec: { source: { upload: {} }, contentType: 'kubevirt', storage },
    })
    const entry: Record<string, any> = { name: d.key }
    if (source.media === 'cdrom') entry.cdrom = { bus: 'sata', readonly: true }
    else entry.disk = { bus: d.bus }
    if (bootOrder.has(d.key)) entry.bootOrder = bootOrder.get(d.key)
    if (source.serial && /^[A-Za-z0-9_.+-]+$/.test(source.serial)) entry.serial = source.serial
    // KubeVirt gives a dedicated IO thread to VirtIO disks only.
    if (source.iothread && source.media === 'disk' && d.bus === 'virtio') entry.dedicatedIOThread = true
    disks.push(entry)
    volumes.push({ name: d.key, dataVolume: { name: dv } })
    mapping.push({ key: d.key, dataVolume: dv })
  }

  const interfaces: any[] = []
  const networks: any[] = []
  for (const source of c.nics) {
    const n = m.nics.find((x) => x.key === source.key)
    if (!n || n.attach === 'none') continue
    const iface: Record<string, any> = { name: n.key, model: n.model }
    if (n.attach === 'masquerade') iface.masquerade = {}
    else iface.bridge = {}
    if (n.keepMac && source.mac) iface.macAddress = source.mac.toLowerCase()
    if (bootOrder.has(n.key)) iface.bootOrder = bootOrder.get(n.key)
    interfaces.push(iface)
    networks.push(n.attach.startsWith('multus:') ? { name: n.key, multus: { networkName: n.attach.slice('multus:'.length) } } : { name: n.key, pod: {} })
  }

  const domain: Record<string, any> = {
    machine: { type: 'q35' },
    cpu: { sockets: m.sockets, cores: m.cores, threads: 1 },
    memory: { guest: `${m.memoryMib}Mi` },
    devices: { disks, interfaces },
  }
  if (m.cpuModel) domain.cpu.model = m.cpuModel
  if (!interfaces.length) domain.devices.autoattachPodInterface = false
  if (!m.graphics) domain.devices.autoattachGraphicsDevice = false
  if (m.tablet) domain.devices.inputs = [{ type: 'tablet', bus: 'usb', name: 'tablet' }]
  if (m.tpm) domain.devices.tpm = {}
  if (m.clientPassthrough) domain.devices.clientPassthrough = {}
  // Only when Proxmox had one: a Windows guest without the viorng driver shows an unknown device.
  if (detail.raw.rng0) domain.devices.rng = {}

  const firmware: Record<string, any> = {}
  if (m.firmware === 'uefi') {
    firmware.bootloader = { efi: { secureBoot: m.secureBoot } }
    if (m.secureBoot) domain.features = { smm: { enabled: true } }
  } else {
    firmware.bootloader = { bios: {} }
  }
  if (m.keepUuid && c.smbios.uuid) firmware.uuid = c.smbios.uuid
  if (c.smbios.serial) firmware.serial = c.smbios.serial
  domain.firmware = firmware

  if (m.windows) {
    // The enlightenments Proxmox gives Windows guests. Not `frequencies` or
    // `reenlightenment`: those tie the VM to nodes with the same TSC frequency.
    domain.features = {
      ...(domain.features ?? {}),
      acpi: {},
      apic: {},
      hyperv: { relaxed: {}, vapic: {}, spinlocks: { spinlocks: 8191 }, vpindex: {}, runtime: {}, synic: {}, stimer: {}, reset: {}, ipi: {} },
    }
    const timer = { hpet: { present: false }, pit: { tickPolicy: 'delay' }, rtc: { tickPolicy: 'catchup' }, hyperv: {} }
    // Windows keeps its clock in local time, as Proxmox gave it.
    domain.clock = c.localtime && detail.timezone ? { timezone: detail.timezone, timer } : { utc: {}, timer }
  }

  const vm: KObject = {
    apiVersion: 'kubevirt.io/v1',
    kind: 'VirtualMachine',
    metadata: { name: m.name, namespace: m.namespace, labels, annotations } as any,
    spec: {
      runStrategy: 'Halted',
      dataVolumeTemplates,
      template: {
        metadata: { labels: { 'kubevirt.io/vm': m.name, ...labels } },
        spec: { domain, networks, volumes, terminationGracePeriodSeconds: m.windows ? 3600 : 180 },
      },
    },
  }
  return { vm, disks: mapping }
}

/** What is wrong with the choices, per wizard step. */
export function problems(detail: PveVmDetail, m: ImportModel): { settings: string[]; disks: string[]; network: string[] } {
  const out = { settings: [] as string[], disks: [] as string[], network: [] as string[] }
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(m.name) || m.name.length > 50) out.settings.push('The name must be lowercase letters, digits and dashes, at most 50 characters')
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(m.namespace)) out.settings.push('Choose a valid namespace')
  if (![m.sockets, m.cores].every((n) => Number.isInteger(n) && n >= 1)) out.settings.push('Sockets and cores must be whole numbers of at least 1')
  if (!(m.memoryMib >= 128)) out.settings.push('Memory must be at least 128 MiB')
  if (m.secureBoot && m.firmware !== 'uefi') out.settings.push('Secure Boot needs UEFI firmware')
  for (const d of m.disks.filter((x) => x.include)) {
    const source = detail.config.disks.find((x) => x.key === d.key)
    if (!source?.sizeBytes) out.disks.push(`${d.key}: its size is unknown, so it cannot be copied`)
  }
  if (m.nics.filter((n) => n.attach === 'masquerade' || n.attach === 'bridge').length > 1) out.network.push('Only one NIC can use the pod network')
  return out
}

export function toYaml(vm: KObject): string {
  return dump(vm, { lineWidth: 140, noRefs: true })
}
