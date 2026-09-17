/**
 * The Hardware table: its rows, and what editing or removing each one does.
 */
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import {
  faMemory, faMicrochip, faMicrochip as faCpu, faDisplay, faHardDrive, faCompactDisc, faNetworkWired, faShieldHalved,
  faDice, faDog, faComputerMouse, faGear, faServer, faCloud, faFolderTree,
} from '@fortawesome/free-solid-svg-icons'
import type { ObjectContext } from '@/plugins/registry'
import type { KObject } from '@/api/types'
import { gateway } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { confirm, openDialog, run, toast } from '@/services/dialogs'
import { bytes, quantity } from '@/util/format'
import FormDialog from './FormDialog.vue'
import NetworkDialog from './NetworkDialog.vue'
import { copy, diskBus, diskType, disksOf, interfaceBinding, interfacesOf, networkLabel, networksOf, validQuantity, volumeInfo, volumesOf } from './spec'
import { updateTemplate, updateVm } from './update'

export type RowKind =
  | 'memory' | 'cpu' | 'firmware' | 'machine' | 'display' | 'tpm' | 'rng' | 'watchdog' | 'input'
  | 'disk' | 'nic' | 'gpu' | 'hostDevice' | 'filesystem'

export interface HardwareRow {
  id: string
  kind: RowKind
  name?: string
  icon: IconDefinition
  label: string
  value: string
  /** Not yet in the running instance — applies at the next restart. */
  pending?: boolean
  hotplugged?: boolean
  editable: boolean
  removable: boolean
  resizable?: boolean
}

interface Lookups {
  pvc: (name: string) => KObject | null
}

/** Build the rows from the VM's (or expanded) spec and, when running, its instance. */
export function hardwareRows(spec: any, vmi: KObject | null, lookups: Lookups, fromInstancetype: boolean): HardwareRow[] {
  const rows: HardwareRow[] = []
  const domain = spec?.domain ?? {}
  const devices = domain.devices ?? {}
  const running = vmi?.spec?.domain ?? null

  const memory = domain.memory?.guest ?? domain.resources?.requests?.memory
  const runningMemory = running ? (running.memory?.guest ?? running.resources?.requests?.memory) : null
  rows.push({
    id: 'memory',
    kind: 'memory',
    icon: faMemory,
    label: 'Memory',
    value: `${memory ? bytes(quantity(memory)) : 'not set'}${domain.resources?.requests?.memory && domain.memory?.guest && domain.resources.requests.memory !== domain.memory.guest ? ` (request ${domain.resources.requests.memory})` : ''}${domain.memory?.hugepages ? ` · hugepages ${domain.memory.hugepages.pageSize}` : ''}`,
    pending: !!running && !!runningMemory && quantity(runningMemory) !== quantity(memory),
    editable: !fromInstancetype,
    removable: false,
  })

  const cpu = domain.cpu ?? {}
  const sockets = cpu.sockets ?? 1
  const cores = cpu.cores ?? 1
  const threads = cpu.threads ?? 1
  const rcpu = running?.cpu
  rows.push({
    id: 'cpu',
    kind: 'cpu',
    icon: faCpu,
    label: 'Processors',
    value: `${sockets * cores * threads} (${sockets} socket${sockets === 1 ? '' : 's'}, ${cores} core${cores === 1 ? '' : 's'}, ${threads} thread${threads === 1 ? '' : 's'})${cpu.model ? ` [${cpu.model}]` : ''}${cpu.dedicatedCpuPlacement ? ' · dedicated' : ''}`,
    pending: !!rcpu && (rcpu.sockets ?? 1) * (rcpu.cores ?? 1) * (rcpu.threads ?? 1) !== sockets * cores * threads,
    editable: !fromInstancetype,
    removable: false,
  })

  const bootloader = domain.firmware?.bootloader
  const efi = bootloader?.efi
  rows.push({
    id: 'firmware',
    kind: 'firmware',
    icon: faGear,
    label: 'BIOS',
    value: efi ? `OVMF (UEFI)${efi.secureBoot === false ? '' : ', secure boot'}${efi.persistent ? ', persistent variables' : ''}` : 'SeaBIOS',
    editable: true,
    removable: false,
  })

  rows.push({ id: 'machine', kind: 'machine', icon: faServer, label: 'Machine', value: domain.machine?.type ?? 'q35 (cluster default)', editable: true, removable: false })

  const graphics = devices.autoattachGraphicsDevice !== false
  rows.push({
    id: 'display',
    kind: 'display',
    icon: faDisplay,
    label: 'Display',
    value: `${graphics ? 'VGA (VNC)' : 'none'}${devices.autoattachSerialConsole === false ? '' : ' · serial console'}`,
    editable: true,
    removable: false,
  })

  const volumes = volumesOf(spec)
  const runningVolumes = new Set((vmi?.spec?.volumes ?? []).map((v: any) => v.name))
  const hotplugged = new Set((vmi?.status?.volumeStatus ?? []).filter((s: any) => s.hotplugVolume).map((s: any) => s.name))
  for (const disk of disksOf(spec)) {
    const volume = volumes.find((v: any) => v.name === disk.name)
    const info = volumeInfo(volume)
    const type = diskType(disk)
    const pvc = info.claim ? lookups.pvc(info.claim) : null
    const size = pvc ? bytes(quantity(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage)) : info.detail
    const parts = [
      `${info.label}${info.claim ? ` ${info.claim}` : ''}`,
      size && info.claim ? `size=${size}` : info.detail ? info.detail : null,
      pvc?.spec?.storageClassName ? `class=${pvc.spec.storageClassName}` : null,
      disk.bootOrder ? `boot=${disk.bootOrder}` : null,
      disk.cache ? `cache=${disk.cache}` : null,
      disk.serial ? `serial=${disk.serial}` : null,
      disk[type]?.readonly ? 'read-only' : null,
    ].filter(Boolean)
    const isCloudInit = info.type.startsWith('cloudInit')
    rows.push({
      id: `disk:${disk.name}`,
      kind: 'disk',
      name: disk.name,
      icon: type === 'cdrom' ? faCompactDisc : isCloudInit ? faCloud : faHardDrive,
      label: `${type === 'cdrom' ? 'CD/DVD Drive' : type === 'lun' ? 'LUN' : 'Hard Disk'} (${diskBus(disk)}: ${disk.name})`,
      value: parts.join(', '),
      pending: !!vmi && !runningVolumes.has(disk.name),
      hotplugged: hotplugged.has(disk.name),
      editable: true,
      removable: true,
      resizable: !!info.claim && type !== 'cdrom',
    })
  }

  const networks = networksOf(spec)
  const runningIfaces = new Set((vmi?.spec?.domain?.devices?.interfaces ?? []).map((i: any) => i.name))
  for (const iface of interfacesOf(spec)) {
    const network = networks.find((n: any) => n.name === iface.name)
    const status = (vmi?.status?.interfaces ?? []).find((s: any) => s.name === iface.name)
    const mac = iface.macAddress ?? status?.mac
    rows.push({
      id: `nic:${iface.name}`,
      kind: 'nic',
      name: iface.name,
      icon: faNetworkWired,
      label: `Network Device (${iface.name})`,
      value: [iface.model ?? 'virtio', mac ? `mac=${mac}` : null, networkLabel(network), interfaceBinding(iface), iface.state === 'down' ? 'link down' : null].filter(Boolean).join(', '),
      pending: !!vmi && !runningIfaces.has(iface.name),
      editable: true,
      removable: true,
    })
  }

  for (const fs of devices.filesystems ?? []) {
    rows.push({ id: `fs:${fs.name}`, kind: 'filesystem', name: fs.name, icon: faFolderTree, label: `Filesystem (${fs.name})`, value: 'virtiofs', editable: false, removable: false })
  }
  for (const gpu of devices.gpus ?? []) {
    rows.push({ id: `gpu:${gpu.name}`, kind: 'gpu', name: gpu.name, icon: faMicrochip, label: `GPU (${gpu.name})`, value: gpu.deviceName, editable: false, removable: true })
  }
  for (const dev of devices.hostDevices ?? []) {
    rows.push({ id: `hostdev:${dev.name}`, kind: 'hostDevice', name: dev.name, icon: faMicrochip, label: `PCI/USB Device (${dev.name})`, value: dev.deviceName, editable: false, removable: true })
  }
  if (devices.tpm && devices.tpm.enabled !== false) {
    rows.push({ id: 'tpm', kind: 'tpm', icon: faShieldHalved, label: 'TPM State', value: `v2.0${devices.tpm.persistent ? ', persistent' : ', ephemeral'}`, editable: true, removable: true })
  }
  if (devices.rng) {
    rows.push({ id: 'rng', kind: 'rng', icon: faDice, label: 'VirtIO RNG', value: '/dev/urandom', editable: false, removable: true })
  }
  if (devices.watchdog) {
    const model = Object.keys(devices.watchdog).find((k) => k !== 'name') ?? 'i6300esb'
    rows.push({ id: 'watchdog', kind: 'watchdog', icon: faDog, label: 'Watchdog', value: `${model}, action=${devices.watchdog[model]?.action ?? 'reset'}`, editable: true, removable: true })
  }
  for (const input of devices.inputs ?? []) {
    rows.push({ id: `input:${input.name}`, kind: 'input', name: input.name, icon: faComputerMouse, label: `Input (${input.name})`, value: `${input.type} on ${input.bus ?? 'usb'}`, editable: false, removable: true })
  }
  return rows
}

const done = (what: string) => toast('success', what, 'Saved. Changes to a running VM apply when it restarts.')

// --- editors -------------------------------------------------------------------

export async function editMemory(ctx: ObjectContext) {
  const domain = ctx.object?.spec?.template?.spec?.domain ?? {}
  const result = await openDialog(FormDialog, {
    title: 'Memory',
    icon: faMemory,
    initial: {
      guest: domain.memory?.guest ?? domain.resources?.requests?.memory ?? '2Gi',
      request: domain.resources?.requests?.memory ?? '',
      hugepages: domain.memory?.hugepages?.pageSize ?? '',
      overhead: !!domain.resources?.overcommitGuestOverhead,
    },
    fields: [
      { key: 'guest', label: 'Guest memory', type: 'text', placeholder: '4Gi', hint: 'What the guest sees.', validate: (v: string) => validQuantity(v) },
      { key: 'request', label: 'Memory request (overcommit)', type: 'text', placeholder: 'same as guest', hint: 'Reserve less than the guest sees to overcommit the node. Leave empty to reserve it all.', validate: (v: string) => (v ? validQuantity(v) : null) },
      { key: 'hugepages', label: 'Hugepages', type: 'select', options: [{ value: '', label: 'None' }, { value: '2Mi', label: '2 MiB' }, { value: '1Gi', label: '1 GiB' }] },
      { key: 'overhead', label: 'Do not reserve memory for QEMU overhead', type: 'checkbox', hint: 'overcommitGuestOverhead — packs more guests, risks OOM kills.' },
    ],
    submit: (v: Record<string, any>) =>
      updateTemplate(ctx, () => ({
        domain: {
          memory: { guest: v.guest.trim(), hugepages: v.hugepages ? { pageSize: v.hugepages } : null },
          resources: { requests: { memory: v.request.trim() || null }, overcommitGuestOverhead: v.overhead || null },
        },
      })),
  })
  if (result) done('Memory')
}

export async function editCpu(ctx: ObjectContext) {
  const cpu = ctx.object?.spec?.template?.spec?.domain?.cpu ?? {}
  const result = await openDialog(FormDialog, {
    title: 'Processors',
    icon: faCpu,
    initial: {
      sockets: cpu.sockets ?? 1,
      cores: cpu.cores ?? 1,
      threads: cpu.threads ?? 1,
      model: cpu.model ?? '',
      dedicated: !!cpu.dedicatedCpuPlacement,
      isolate: !!cpu.isolateEmulatorThread,
    },
    fields: [
      { key: 'sockets', label: 'Sockets', type: 'number', min: 1, max: 64, validate: (v: number) => (v >= 1 ? null : 'At least 1') },
      { key: 'cores', label: 'Cores per socket', type: 'number', min: 1, max: 256, validate: (v: number) => (v >= 1 ? null : 'At least 1') },
      { key: 'threads', label: 'Threads per core', type: 'number', min: 1, max: 8, validate: (v: number) => (v >= 1 ? null : 'At least 1') },
      {
        key: 'model',
        label: 'Type',
        type: 'text',
        placeholder: 'cluster default (host-model)',
        suggestions: ['host-passthrough', 'host-model', 'Skylake-Server', 'Cascadelake-Server', 'Icelake-Server', 'EPYC', 'EPYC-Rome', 'EPYC-Milan', 'EPYC-Genoa'],
        hint: 'host-passthrough is fastest but limits live migration to identical CPUs.',
      },
      { key: 'dedicated', label: 'Dedicated CPU placement (pinning)', type: 'checkbox', hint: 'Needs the CPU manager on the nodes.' },
      { key: 'isolate', label: 'Isolate the emulator thread', type: 'checkbox', visible: (v: Record<string, any>) => v.dedicated },
    ],
    description: undefined,
    submit: (v: Record<string, any>) =>
      updateTemplate(ctx, () => ({
        domain: {
          cpu: {
            sockets: Number(v.sockets),
            cores: Number(v.cores),
            threads: Number(v.threads),
            model: v.model.trim() || null,
            dedicatedCpuPlacement: v.dedicated || null,
            isolateEmulatorThread: (v.dedicated && v.isolate) || null,
          },
        },
      })),
  })
  if (result) done('Processors')
}

export async function editFirmware(ctx: ObjectContext) {
  const bootloader = ctx.object?.spec?.template?.spec?.domain?.firmware?.bootloader
  const result = await openDialog(FormDialog, {
    title: 'BIOS',
    icon: faGear,
    initial: {
      loader: bootloader?.efi ? 'efi' : 'bios',
      secureBoot: bootloader?.efi ? bootloader.efi.secureBoot !== false : false,
      persistent: !!bootloader?.efi?.persistent,
    },
    warning: 'Changing firmware usually makes an installed guest unbootable.',
    fields: [
      { key: 'loader', label: 'Firmware', type: 'select', options: [{ value: 'bios', label: 'SeaBIOS (legacy BIOS)' }, { value: 'efi', label: 'OVMF (UEFI)' }] },
      { key: 'secureBoot', label: 'Secure boot', type: 'checkbox', hint: 'Also enables SMM, which secure boot requires.', visible: (v: Record<string, any>) => v.loader === 'efi' },
      { key: 'persistent', label: 'Persist EFI variables', type: 'checkbox', hint: 'Keeps boot entries across restarts (needs VM state storage configured).', visible: (v: Record<string, any>) => v.loader === 'efi' },
    ],
    submit: (v: Record<string, any>) =>
      updateTemplate(ctx, () => ({
        domain: {
          firmware: {
            bootloader: v.loader === 'efi' ? { bios: null, efi: { secureBoot: !!v.secureBoot, persistent: v.persistent || null } } : { efi: null, bios: {} },
          },
          features: v.loader === 'efi' && v.secureBoot ? { smm: { enabled: true } } : undefined,
        },
      })),
  })
  if (result) done('BIOS')
}

export async function editMachine(ctx: ObjectContext) {
  const type = ctx.object?.spec?.template?.spec?.domain?.machine?.type ?? ''
  const result = await openDialog(FormDialog, {
    title: 'Machine',
    icon: faServer,
    initial: { type },
    fields: [
      {
        key: 'type',
        label: 'Machine type',
        type: 'text',
        placeholder: 'cluster default',
        suggestions: ['q35', 'pc-q35-rhel9.6.0', 'pc-q35-rhel9.4.0', 'pc-q35-rhel8.6.0'],
        hint: 'Only q35 variants the node emulators support are accepted.',
      },
    ],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ domain: { machine: v.type.trim() ? { type: v.type.trim() } : null } })),
  })
  if (result) done('Machine')
}

export async function editDisplay(ctx: ObjectContext) {
  const devices = ctx.object?.spec?.template?.spec?.domain?.devices ?? {}
  const tablet = (devices.inputs ?? []).some((i: any) => i.type === 'tablet')
  const result = await openDialog(FormDialog, {
    title: 'Display',
    icon: faDisplay,
    initial: { graphics: devices.autoattachGraphicsDevice !== false, serial: devices.autoattachSerialConsole !== false, tablet },
    fields: [
      { key: 'graphics', label: 'Graphics device (VNC console)', type: 'checkbox' },
      { key: 'serial', label: 'Serial console', type: 'checkbox' },
      { key: 'tablet', label: 'USB tablet input', type: 'checkbox', hint: 'Absolute pointer — keeps the VNC mouse in step with yours.' },
    ],
    submit: (v: Record<string, any>) =>
      updateTemplate(ctx, (spec) => {
        let inputs = copy(spec.domain?.devices?.inputs ?? []) as any[]
        if (v.tablet && !inputs.some((i) => i.type === 'tablet')) inputs.push({ name: 'tablet', type: 'tablet', bus: 'usb' })
        if (!v.tablet) inputs = inputs.filter((i) => i.type !== 'tablet')
        return {
          domain: {
            devices: {
              autoattachGraphicsDevice: v.graphics ? null : false,
              autoattachSerialConsole: v.serial ? null : false,
              inputs: inputs.length ? inputs : null,
            },
          },
        }
      }),
  })
  if (result) done('Display')
}

export async function editDisk(ctx: ObjectContext, name: string) {
  const disk = disksOf(ctx.object?.spec?.template?.spec).find((d) => d.name === name)
  if (!disk) return
  const type = diskType(disk)
  const result = await openDialog(FormDialog, {
    title: `Edit ${type === 'cdrom' ? 'CD/DVD Drive' : 'Hard Disk'} ${name}`,
    icon: type === 'cdrom' ? faCompactDisc : faHardDrive,
    initial: {
      bus: diskBus(disk),
      bootOrder: disk.bootOrder ?? '',
      cache: disk.cache ?? '',
      io: disk.io ?? '',
      serial: disk.serial ?? '',
      readonly: !!disk[type]?.readonly,
      iothread: !!disk.dedicatedIOThread,
    },
    fields: [
      {
        key: 'bus',
        label: 'Bus',
        type: 'select',
        options: (type === 'cdrom' ? ['sata', 'scsi'] : ['virtio', 'sata', 'scsi', 'usb']).map((b) => ({ value: b, label: b })),
        hint: 'virtio is fastest; Windows needs the virtio drivers for it.',
      },
      { key: 'bootOrder', label: 'Boot order', type: 'number', min: 1, placeholder: 'not bootable', hint: 'Lower boots first. Leave empty to exclude.' },
      {
        key: 'cache',
        label: 'Cache',
        type: 'select',
        options: [{ value: '', label: 'Default (none)' }, { value: 'none', label: 'No cache' }, { value: 'writethrough', label: 'Write through' }, { value: 'writeback', label: 'Write back' }],
        visible: () => type !== 'cdrom',
      },
      { key: 'io', label: 'Async IO', type: 'select', options: [{ value: '', label: 'Default' }, { value: 'native', label: 'native' }, { value: 'threads', label: 'threads' }], visible: () => type !== 'cdrom' },
      { key: 'serial', label: 'Serial number', type: 'text', placeholder: 'none', hint: 'Lets the guest find the disk under /dev/disk/by-id.' },
      { key: 'readonly', label: 'Read-only', type: 'checkbox', visible: () => type !== 'cdrom' },
      { key: 'iothread', label: 'Dedicated IO thread', type: 'checkbox', visible: () => type !== 'cdrom' },
    ],
    submit: (v: Record<string, any>) =>
      updateTemplate(ctx, (spec) => {
        const disks = copy(disksOf(spec))
        const target = disks.find((d: any) => d.name === name)
        if (!target) throw new Error('the disk no longer exists')
        const t = diskType(target)
        target[t] = { ...(target[t] ?? {}), bus: v.bus }
        if (t !== 'cdrom') {
          if (v.readonly) target[t].readonly = true
          else delete target[t].readonly
        }
        const assign = (key: string, value: unknown) => {
          if (value === '' || value === null || value === false || value === undefined) delete target[key]
          else target[key] = value
        }
        assign('bootOrder', v.bootOrder === '' ? '' : Number(v.bootOrder))
        assign('cache', v.cache)
        assign('io', v.io)
        assign('serial', v.serial.trim())
        assign('dedicatedIOThread', v.iothread)
        return { domain: { devices: { disks } } }
      }),
  })
  if (result) done(`Disk ${name}`)
}

export async function resizeDisk(ctx: ObjectContext, name: string, pvc: KObject | null) {
  const volume = volumesOf(ctx.object?.spec?.template?.spec).find((v) => v.name === name)
  const info = volumeInfo(volume)
  if (!info.claim || !pvc) {
    toast('warning', 'Resize disk', 'Only disks backed by a persistent volume claim can be resized.')
    return
  }
  const current = quantity(pvc.status?.capacity?.storage ?? pvc.spec?.resources?.requests?.storage)
  const result = await openDialog<Record<string, any>>(FormDialog, {
    title: `Resize disk ${name}`,
    icon: faHardDrive,
    description: `${info.claim} is ${bytes(current)}. Disks can only grow; grow the partition and filesystem inside the guest afterwards.`,
    initial: { size: pvc.spec?.resources?.requests?.storage ?? '' },
    fields: [
      {
        key: 'size',
        label: 'New size',
        type: 'text',
        placeholder: '40Gi',
        validate: (v: string) => validQuantity(v) ?? (quantity(v.trim()) <= current ? `Must be larger than ${bytes(current)}` : null),
        hint: 'The storage class must allow volume expansion.',
      },
    ],
    submitText: 'Resize',
    submit: (v: Record<string, any>) =>
      k8s.patch({ apiVersion: 'v1', resource: 'persistentvolumeclaims', namespace: ctx.namespace, name: info.claim! }, { spec: { resources: { requests: { storage: v.size.trim() } } } }),
  })
  if (result) toast('success', 'Resize disk', `${info.claim} is growing to ${result.size}`)
}

export async function removeDisk(ctx: ObjectContext, name: string, hotplugged: boolean) {
  const spec = ctx.object?.spec?.template?.spec
  const volume = volumesOf(spec).find((v) => v.name === name)
  const info = volumeInfo(volume)
  const running = !!ctx.related.vmi
  const answer = await confirm({
    title: `Remove disk ${name}`,
    message: `Detach ${name} (${info.label}${info.claim ? ` ${info.claim}` : ''}) from ${ctx.name}.${running && !hotplugged ? '\nThe VM is running: the disk stays attached until it restarts.' : ''}`,
    confirmText: 'Remove',
    danger: true,
    options: info.claim ? [{ key: 'destroy', label: `Also destroy ${info.claim} and its data`, default: false, hint: 'Otherwise the disk is kept and can be attached again.' }] : [],
  })
  if (!answer) return

  if (hotplugged && running) {
    await run(`Unplug ${name}`, () => gateway.call('vm.volume.remove', { namespace: ctx.namespace, name: ctx.name, volume: name }), { openLog: true })
  } else {
    const ok = await run(`Remove disk ${name}`, () =>
      updateVm(ctx, (vm) => {
        const s = vm.spec?.template?.spec ?? {}
        const disks = disksOf(s).filter((d) => d.name !== name)
        const volumes = volumesOf(s).filter((v) => v.name !== name)
        const templates = (vm.spec?.dataVolumeTemplates ?? []).filter((t: any) => !(info.dataVolume && t.metadata?.name === info.claim))
        return {
          spec: {
            dataVolumeTemplates: vm.spec?.dataVolumeTemplates ? templates : undefined,
            template: { spec: { domain: { devices: { disks } }, volumes } },
          },
        }
      }),
    )
    if (ok === undefined) return
  }

  if (answer.options.destroy && info.claim) {
    await run(`Destroy ${info.claim}`, async () => {
      if (info.dataVolume) {
        await k8s.delete({ apiVersion: 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', namespace: ctx.namespace, name: info.claim! }).catch((e) => {
          if (e?.status !== 404) throw e
        })
      }
      await k8s.delete({ apiVersion: 'v1', resource: 'persistentvolumeclaims', namespace: ctx.namespace, name: info.claim! }).catch((e) => {
        if (e?.status !== 404) throw e
      })
    })
  }
}

export async function editNic(ctx: ObjectContext, name?: string) {
  const result = await openDialog(NetworkDialog, { ctx, name })
  if (result) done(name ? `Network device ${name}` : 'Network device')
}

export async function removeNic(ctx: ObjectContext, name: string) {
  const ok = await confirm({ title: `Remove network device ${name}`, message: `Remove ${name} from ${ctx.name}? Takes effect when the VM restarts.`, confirmText: 'Remove', danger: true })
  if (!ok) return
  await run(`Remove network device ${name}`, () =>
    updateTemplate(ctx, (spec) => ({
      domain: { devices: { interfaces: interfacesOf(spec).filter((i) => i.name !== name) } },
      networks: networksOf(spec).filter((n) => n.name !== name),
    })),
  )
}

export async function removeListDevice(ctx: ObjectContext, list: 'gpus' | 'hostDevices' | 'inputs', name: string, label: string) {
  const ok = await confirm({ title: `Remove ${label}`, message: `Remove ${label} ${name} from ${ctx.name}? Takes effect when the VM restarts.`, confirmText: 'Remove', danger: true })
  if (!ok) return
  await run(`Remove ${label}`, () =>
    updateTemplate(ctx, (spec) => {
      const remaining = (spec.domain?.devices?.[list] ?? []).filter((d: any) => d.name !== name)
      return { domain: { devices: { [list]: remaining.length ? remaining : null } } }
    }),
  )
}

export async function setTpm(ctx: ObjectContext, add: boolean) {
  if (!add) {
    const ok = await confirm({ title: 'Remove TPM', message: 'Remove the TPM? Anything sealed to it — BitLocker keys, measured boot — is lost.', confirmText: 'Remove', danger: true })
    if (!ok) return
    await run('Remove TPM', () => updateTemplate(ctx, () => ({ domain: { devices: { tpm: null } } })))
    return
  }
  const result = await openDialog(FormDialog, {
    title: 'TPM State',
    icon: faShieldHalved,
    initial: { persistent: !!ctx.object?.spec?.template?.spec?.domain?.devices?.tpm?.persistent },
    fields: [{ key: 'persistent', label: 'Persistent', type: 'checkbox', hint: 'Keep TPM state across restarts (needs VM state storage configured in KubeVirt). Required by Windows 11 BitLocker.' }],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ domain: { devices: { tpm: { persistent: v.persistent || null } } } })),
  })
  if (result) done('TPM')
}

export async function setRng(ctx: ObjectContext, add: boolean) {
  await run(add ? 'Add VirtIO RNG' : 'Remove VirtIO RNG', () => updateTemplate(ctx, () => ({ domain: { devices: { rng: add ? {} : null } } })))
}

export async function editWatchdog(ctx: ObjectContext, remove = false) {
  if (remove) {
    const ok = await confirm({ title: 'Remove watchdog', message: 'Remove the watchdog device?', confirmText: 'Remove', danger: true })
    if (ok) await run('Remove watchdog', () => updateTemplate(ctx, () => ({ domain: { devices: { watchdog: null } } })))
    return
  }
  const current = ctx.object?.spec?.template?.spec?.domain?.devices?.watchdog
  const result = await openDialog(FormDialog, {
    title: 'Watchdog',
    icon: faDog,
    initial: { action: current?.i6300esb?.action ?? 'reset' },
    fields: [
      {
        key: 'action',
        label: 'Action when the guest stops responding',
        type: 'select',
        options: [{ value: 'reset', label: 'Reset' }, { value: 'poweroff', label: 'Power off' }, { value: 'shutdown', label: 'Shut down' }],
        hint: 'Emulates an Intel 6300ESB; the guest must run a watchdog daemon.',
      },
    ],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ domain: { devices: { watchdog: { name: current?.name ?? 'watchdog', i6300esb: { action: v.action } } } } })),
  })
  if (result) done('Watchdog')
}
