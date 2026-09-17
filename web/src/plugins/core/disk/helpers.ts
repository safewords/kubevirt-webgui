/** Shared helpers for the disk screens. */
import type { KObject } from '@/api/types'
import { useInventory } from '@/plugins/core/inventory'
import { quantity } from '@/util/format'

/** VMs in the disk's namespace whose volumes reference it. */
export function vmsUsing(namespace: string | undefined, name: string): KObject[] {
  const inv = useInventory()
  return inv.vms.filter(
    (vm) =>
      vm.metadata.namespace === namespace &&
      (vm.spec?.template?.spec?.volumes ?? []).some((v: any) => v.dataVolume?.name === name || v.persistentVolumeClaim?.claimName === name),
  )
}

export function sizeOf(pvc: KObject | null | undefined): number {
  return quantity(pvc?.status?.capacity?.storage ?? pvc?.spec?.resources?.requests?.storage)
}

/** Bytes as a Kubernetes quantity, in whole GiB when it divides evenly. */
export function toQuantity(bytes: number): string {
  const gib = 1024 ** 3
  if (bytes % gib === 0) return `${bytes / gib}Gi`
  const mib = 1024 ** 2
  return `${Math.ceil(bytes / mib)}Mi`
}

export const UNITS = [
  { label: 'MiB', factor: 1024 ** 2 },
  { label: 'GiB', factor: 1024 ** 3 },
  { label: 'TiB', factor: 1024 ** 4 },
]
