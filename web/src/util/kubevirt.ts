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

/**
 * A VMI that still exists and has not finished. KubeVirt refuses to start a
 * VM that has one ("VM is already running") even when its pod was never
 * scheduled, so such a VM has to be stopped, not started.
 */
export function liveInstance(vmi: KObject | null | undefined): boolean {
  if (!vmi) return false
  return !['Succeeded', 'Failed'].includes(vmi.status?.phase ?? '')
}

/** Why the scheduler cannot place a VMI's pod, when it cannot. */
export function unschedulableReason(vmi: KObject | null | undefined): string | null {
  const c = condition(vmi, 'PodScheduled')
  if (!c || c.status !== 'False') return null
  return c.message || c.reason || 'the pod cannot be scheduled'
}

/**
 * Hostnames a template's required node affinity restricts it to, or null
 * when it does not name any. Terms are ORed, so a term without a hostname
 * `In` leaves the VM free to go elsewhere and the result is null.
 */
export function affinityHostnames(spec: any): string[] | null {
  const terms: any[] = spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms ?? []
  if (!terms.length) return null
  const out = new Set<string>()
  for (const term of terms) {
    const ins = (term.matchExpressions ?? []).filter((e: any) => e.key === 'kubernetes.io/hostname' && e.operator === 'In')
    if (!ins.length) return null
    // Several `In`s in one term are ANDed: only hosts in every list qualify.
    let hosts: string[] = ins[0].values ?? []
    for (const e of ins.slice(1)) hosts = hosts.filter((h) => (e.values ?? []).includes(h))
    hosts.forEach((h) => out.add(h))
  }
  return [...out]
}

export interface SchedulingHint {
  /** What the scheduler's phrase means for this VM. */
  problem: string
  /** What to do about it. */
  remedy: string
}

/**
 * Turn the scheduler's "0/8 nodes are available: 1 Insufficient memory, …"
 * into one explanation and remedy per reason. `nodes` lets a hostname pin
 * that names a node the cluster does not have be called out by name.
 */
export function schedulingHints(message: string, spec: any, nodes: KObject[] = []): SchedulingHint[] {
  const hints: SchedulingHint[] = []
  const memory = spec?.domain?.memory?.guest ?? spec?.domain?.resources?.requests?.memory
  const pinned = affinityHostnames(spec)
  const selectorHost = spec?.nodeSelector?.['kubernetes.io/hostname']
  const known = new Set(nodes.map((n) => n.metadata.name))
  const missing = [...(pinned ?? []), ...(selectorHost ? [selectorHost] : [])].filter((h) => nodes.length && !known.has(h))

  if (/Insufficient memory/i.test(message)) {
    hints.push({
      problem: `A node this VM is allowed on does not have ${memory ? `${memory} plus overhead` : 'enough memory'} left to reserve.`,
      remedy: 'Stop or migrate another VM off that node, lower this VM’s memory (Hardware), or widen its placement so it may use a node with room.',
    })
  }
  if (/Insufficient cpu/i.test(message)) {
    hints.push({ problem: 'No allowed node has enough unreserved CPU.', remedy: 'Free CPU on an allowed node, lower the vCPU count, or widen the placement.' })
  }
  if (/didn't match Pod's node affinity\/selector/i.test(message)) {
    const where = pinned?.length ? `its affinity limits it to ${pinned.join(', ')}` : selectorHost ? `it is pinned to ${selectorHost}` : 'its node selector or affinity rules out those nodes'
    hints.push({
      problem: `Some nodes are ruled out by placement: ${where}.${missing.length ? ` ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the cluster.` : ''}`,
      remedy: 'Edit Options → Affinity / Node placement to allow a node that is online and has room. Nodes that are off cannot take it until they are back.',
    })
  }
  if (/untolerated taint/i.test(message)) {
    hints.push({ problem: 'Some nodes carry a taint the VM does not tolerate — usually a node that is offline or shut down.', remedy: 'Bring the node back online, or add a toleration only if the taint is meant to be crossed.' })
  }
  if (/were unschedulable|node\(s\) unschedulable/i.test(message)) {
    hints.push({ problem: 'Some nodes are cordoned (maintenance or offline).', remedy: 'Uncordon a node from its page once it is healthy.' })
  }
  if (/Insufficient devices\.kubevirt\.io|Insufficient .*gpu|Insufficient .*usb/i.test(message)) {
    hints.push({ problem: 'No allowed node has the device this VM asks for free.', remedy: 'Release the device from the VM holding it, or remove it from this VM’s hardware.' })
  }
  if (/volume node affinity conflict/i.test(message)) {
    hints.push({ problem: 'A disk lives on storage that only some nodes can reach, and none of those are allowed or available.', remedy: 'Bring that node online, or move the disk to shared storage.' })
  }
  return hints
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
