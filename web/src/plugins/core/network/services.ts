/** Which Services expose a VM. */
import type { KObject } from '@/api/types'

/** The label virt-launcher pods carry with their VM's name. */
export const VM_NAME_LABEL = 'vm.kubevirt.io/name'

/** The VM a Service selects, if it selects exactly one by name. */
export function exposedVm(service: KObject): string | null {
  const selector = service.spec?.selector ?? {}
  return selector[VM_NAME_LABEL] ?? selector['kubevirt.io/vm'] ?? null
}

export function servicePorts(service: KObject): string {
  return ((service.spec?.ports ?? []) as any[])
    .map((p) => `${p.port}${p.targetPort !== undefined && String(p.targetPort) !== String(p.port) ? `→${p.targetPort}` : ''}/${p.protocol ?? 'TCP'}${p.nodePort ? ` (node ${p.nodePort})` : ''}`)
    .join(', ')
}

export function externalAddresses(service: KObject): string[] {
  const out: string[] = []
  for (const ingress of service.status?.loadBalancer?.ingress ?? []) out.push(ingress.ip ?? ingress.hostname)
  for (const ip of service.spec?.externalIPs ?? []) out.push(ip)
  return out.filter(Boolean)
}
