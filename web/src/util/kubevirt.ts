/** Reading KubeVirt objects: status, resources, addresses. */
import type { Condition, KObject } from '@/api/types'
import { quantity } from './format'

export type VmState = 'running' | 'stopped' | 'paused' | 'starting' | 'stopping' | 'migrating' | 'error' | 'provisioning' | 'unknown'

export function condition(object: KObject | null | undefined, type: string): Condition | undefined {
  return (object?.status?.conditions as Condition[] | undefined)?.find((c) => c.type === type)
}

export function isTrue(object: KObject | null | undefined, type: string): boolean {
  return condition(object, type)?.status === 'True'
}

/** A VM's state, from its printable status and its VMI. */
export function vmState(vm: KObject | null | undefined, vmi?: KObject | null): VmState {
  const printable: string = vm?.status?.printableStatus ?? ''
  if (vmi && isTrue(vmi, 'Paused')) return 'paused'
  if (vmi?.status?.migrationState && !vmi.status.migrationState.completed) return 'migrating'
  switch (printable) {
    case 'Running':
      return 'running'
    case 'Stopped':
      return 'stopped'
    case 'Paused':
      return 'paused'
    case 'Starting':
    case 'WaitingForVolumeBinding':
      return 'starting'
    case 'Stopping':
    case 'Terminating':
      return 'stopping'
    case 'Migrating':
      return 'migrating'
    case 'Provisioning':
      return 'provisioning'
    case 'CrashLoopBackOff':
    case 'ErrorUnschedulable':
    case 'ErrImagePull':
    case 'ImagePullBackOff':
    case 'ErrorPvcNotFound':
    case 'ErrorDataVolumeNotFound':
    case 'DataVolumeError':
      return 'error'
  }
  if (vmi?.status?.phase === 'Running') return 'running'
  if (!vm && vmi) return vmi.status?.phase === 'Running' ? 'running' : 'starting'
  return printable ? 'unknown' : 'stopped'
}

export const stateStyle: Record<VmState, { label: string; text: string; dot: string }> = {
  running: { label: 'running', text: 'text-ok', dot: 'bg-ok' },
  stopped: { label: 'stopped', text: 'text-fg-subtle', dot: 'bg-fg-subtle' },
  paused: { label: 'paused', text: 'text-warn', dot: 'bg-warn' },
  starting: { label: 'starting', text: 'text-info', dot: 'bg-info' },
  stopping: { label: 'stopping', text: 'text-warn', dot: 'bg-warn' },
  migrating: { label: 'migrating', text: 'text-info', dot: 'bg-info' },
  provisioning: { label: 'provisioning', text: 'text-info', dot: 'bg-info' },
  error: { label: 'error', text: 'text-bad', dot: 'bg-bad' },
  unknown: { label: 'unknown', text: 'text-fg-subtle', dot: 'bg-fg-subtle' },
}

/** The VMI template spec of a VM (or the spec of a bare VMI). */
export function templateSpec(object: KObject | null | undefined): any {
  if (!object) return {}
  if (object.kind === 'VirtualMachineInstance') return object.spec ?? {}
  return object.spec?.template?.spec ?? {}
}

export function vcpus(spec: any): number {
  const cpu = spec?.domain?.cpu ?? {}
  const sockets = cpu.sockets ?? 1
  const cores = cpu.cores ?? 1
  const threads = cpu.threads ?? 1
  if (!spec?.domain?.cpu && spec?.domain?.resources?.requests?.cpu) return Math.max(1, Math.ceil(quantity(spec.domain.resources.requests.cpu)))
  return sockets * cores * threads
}

export function memoryBytes(spec: any): number {
  return quantity(spec?.domain?.memory?.guest ?? spec?.domain?.resources?.requests?.memory ?? 0)
}

/** Guest IP addresses a VMI reports. */
export function addresses(vmi: KObject | null | undefined): string[] {
  const out = new Set<string>()
  for (const iface of vmi?.status?.interfaces ?? []) {
    for (const ip of iface.ipAddresses ?? (iface.ipAddress ? [iface.ipAddress] : [])) out.add(ip)
  }
  return [...out]
}

export function instancetypeName(vm: KObject | null | undefined): string | null {
  return vm?.spec?.instancetype?.name ?? null
}

export function preferenceName(vm: KObject | null | undefined): string | null {
  return vm?.spec?.preference?.name ?? null
}

export function runStrategy(vm: KObject | null | undefined): string {
  if (!vm) return '—'
  if (vm.spec?.runStrategy) return vm.spec.runStrategy
  if (vm.spec?.running === true) return 'Always'
  if (vm.spec?.running === false) return 'Halted'
  return '—'
}

/** Proxmox-style "tags": labels the GUI owns, under one prefix. */
export const TAG_PREFIX = 'tags.kubevirt-webgui/'

export function tags(object: KObject | null | undefined): string[] {
  return Object.keys(object?.metadata?.labels ?? {})
    .filter((k) => k.startsWith(TAG_PREFIX))
    .map((k) => k.slice(TAG_PREFIX.length))
}

export const NOTES_ANNOTATION = 'kubevirt-webgui/notes'
export const DESCRIPTION_ANNOTATION = 'kubevirt-webgui/description'

/** The OS a VM runs, from the guest agent, preference or template labels. */
export function osName(vm: KObject | null | undefined, vmi?: KObject | null): string | null {
  const guest = vmi?.status?.guestOSInfo
  if (guest?.prettyName) return guest.prettyName
  if (guest?.name) return `${guest.name} ${guest.version ?? ''}`.trim()
  const annotations = vm?.metadata?.annotations ?? {}
  return annotations['name.os.template.kubevirt.io'] ?? preferenceName(vm) ?? null
}

/** Node readiness. */
export function nodeReady(node: KObject | null | undefined): boolean {
  return isTrue(node, 'Ready')
}

export function nodeRoles(node: KObject | null | undefined): string[] {
  return Object.keys(node?.metadata?.labels ?? {})
    .filter((k) => k.startsWith('node-role.kubernetes.io/'))
    .map((k) => k.slice('node-role.kubernetes.io/'.length))
}

export function schedulableForVms(node: KObject | null | undefined): boolean {
  return node?.metadata?.labels?.['kubevirt.io/schedulable'] === 'true'
}
