/**
 * Reading and changing a VM's definition.
 *
 * Edits are merge patches that carry the `resourceVersion` the screen was
 * showing, so two people editing the same VM get a conflict instead of one
 * silently undoing the other. Device lists are replaced whole, which is how a
 * merge patch treats arrays anyway.
 */
import type { KObject } from '@/api/types'
import type { ObjectContext } from '@/plugins/registry'
import { k8s } from '@/api/k8s'

export const VM_API = 'kubevirt.io/v1'

export function vmRef(ctx: Pick<ObjectContext, 'name' | 'namespace'>) {
  return { apiVersion: VM_API, resource: 'virtualmachines', namespace: ctx.namespace!, name: ctx.name }
}

export function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

/** Merge-patch the VM, failing on a concurrent change. */
export function patchVm(vm: KObject, patch: Record<string, any>) {
  return k8s.patch(
    { apiVersion: VM_API, resource: 'virtualmachines', namespace: vm.metadata.namespace, name: vm.metadata.name },
    { ...patch, metadata: { ...(patch.metadata ?? {}), resourceVersion: vm.metadata.resourceVersion } },
    'merge',
  )
}

/** Merge-patch `spec.template.spec`. */
export function patchTemplate(vm: KObject, specPatch: Record<string, any>) {
  return patchVm(vm, { spec: { template: { spec: specPatch } } })
}

export function template(vm: KObject | null | undefined): any {
  return vm?.spec?.template?.spec ?? {}
}

export function disksOf(spec: any): any[] {
  return spec?.domain?.devices?.disks ?? []
}

export function volumesOf(spec: any): any[] {
  return spec?.volumes ?? []
}

export function interfacesOf(spec: any): any[] {
  return spec?.domain?.devices?.interfaces ?? []
}

export function networksOf(spec: any): any[] {
  return spec?.networks ?? []
}

/** The patch that replaces the device lists given, leaving the others alone. */
export function devicesPatch(lists: { disks?: any[]; volumes?: any[]; interfaces?: any[]; networks?: any[]; dataVolumeTemplates?: any[] }) {
  const spec: Record<string, any> = {}
  const devices: Record<string, any> = {}
  if (lists.disks) devices.disks = lists.disks
  if (lists.interfaces) devices.interfaces = lists.interfaces
  if (Object.keys(devices).length) spec.domain = { devices }
  if (lists.volumes) spec.volumes = lists.volumes
  if (lists.networks) spec.networks = lists.networks
  const patch: Record<string, any> = { spec: { template: { spec } } }
  if (lists.dataVolumeTemplates) patch.spec.dataVolumeTemplates = lists.dataVolumeTemplates
  return patch
}

export type DiskType = 'disk' | 'cdrom' | 'lun'

export function diskType(disk: any): DiskType {
  if (disk?.cdrom) return 'cdrom'
  if (disk?.lun) return 'lun'
  return 'disk'
}

export function diskBus(disk: any): string {
  return disk?.[diskType(disk)]?.bus ?? (diskType(disk) === 'cdrom' ? 'sata' : 'virtio')
}

export interface VolumeInfo {
  type: string
  label: string
  /** The PVC holding the data, for DataVolume and PVC volumes. */
  claim?: string
  dataVolume?: boolean
  hotpluggable?: boolean
  detail?: string
}

export function volumeInfo(volume: any): VolumeInfo {
  if (!volume) return { type: 'missing', label: 'no volume' }
  if (volume.dataVolume) return { type: 'dataVolume', label: 'DataVolume', claim: volume.dataVolume.name, dataVolume: true, hotpluggable: !!volume.dataVolume.hotpluggable }
  if (volume.persistentVolumeClaim) return { type: 'persistentVolumeClaim', label: 'PVC', claim: volume.persistentVolumeClaim.claimName, hotpluggable: !!volume.persistentVolumeClaim.hotpluggable }
  if (volume.containerDisk) return { type: 'containerDisk', label: 'Container disk', detail: volume.containerDisk.image }
  if (volume.cloudInitNoCloud) return { type: 'cloudInitNoCloud', label: 'Cloud-init (NoCloud)' }
  if (volume.cloudInitConfigDrive) return { type: 'cloudInitConfigDrive', label: 'Cloud-init (ConfigDrive)' }
  if (volume.emptyDisk) return { type: 'emptyDisk', label: 'Empty disk (ephemeral)', detail: volume.emptyDisk.capacity }
  if (volume.ephemeral) return { type: 'ephemeral', label: 'Ephemeral PVC', claim: volume.ephemeral.persistentVolumeClaim?.claimName }
  if (volume.hostDisk) return { type: 'hostDisk', label: 'Host disk', detail: volume.hostDisk.path }
  if (volume.configMap) return { type: 'configMap', label: 'ConfigMap', detail: volume.configMap.name }
  if (volume.secret) return { type: 'secret', label: 'Secret', detail: volume.secret.secretName }
  if (volume.serviceAccount) return { type: 'serviceAccount', label: 'ServiceAccount', detail: volume.serviceAccount.serviceAccountName }
  if (volume.sysprep) return { type: 'sysprep', label: 'Sysprep' }
  if (volume.downwardMetrics) return { type: 'downwardMetrics', label: 'Downward metrics' }
  if (volume.memoryDump) return { type: 'memoryDump', label: 'Memory dump', claim: volume.memoryDump.claimName }
  const key = Object.keys(volume).find((k) => k !== 'name')
  return { type: key ?? 'unknown', label: key ?? 'unknown' }
}

export function interfaceBinding(iface: any): string {
  for (const key of ['masquerade', 'bridge', 'sriov', 'passt', 'slirp', 'macvtap']) if (iface?.[key]) return key
  if (iface?.binding?.name) return `plugin: ${iface.binding.name}`
  return 'default'
}

export function networkLabel(network: any): string {
  if (!network) return 'no network'
  if (network.pod) return 'pod network'
  if (network.multus) return `Multus ${network.multus.networkName}${network.multus.default ? ' (default)' : ''}`
  return Object.keys(network).find((k) => k !== 'name') ?? 'unknown'
}

/** The next free name like `disk1`, `disk2`, … among `taken`. */
export function nextName(prefix: string, taken: string[]): string {
  for (let i = 0; ; i++) {
    const name = `${prefix}${i}`
    if (!taken.includes(name)) return name
  }
}

export const QUANTITY = /^\d+(\.\d+)?(Ki|Mi|Gi|Ti|Pi|k|M|G|T|P)?$/

export function validQuantity(value: string): string | null {
  return QUANTITY.test(value.trim()) ? null : 'Use a Kubernetes quantity, e.g. 2Gi or 512Mi'
}

export const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

export function validName(value: string): string | null {
  if (!value) return 'A name is required'
  if (value.length > 63 || !DNS_LABEL.test(value)) return 'Lowercase letters, digits and dashes; start and end with a letter or digit'
  return null
}

export const MAC = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/
