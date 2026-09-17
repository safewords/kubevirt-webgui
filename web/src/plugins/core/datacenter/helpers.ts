/** Helpers shared by the datacenter and node screens. */
import { computed, type ComputedRef } from 'vue'
import type { KObject } from '@/api/types'
import { useCluster } from '@/stores/cluster'
import { useInventory } from '@/plugins/core/inventory'
import { can } from '@/stores/access'
import { useMultiWatch } from '@/stores/watch'

/**
 * Watch a namespaced resource cluster-wide when the user may list it that
 * way, otherwise in every namespace they can reach.
 */
export function useScopedWatch(apiVersion: () => string | null, group: string, resource: string) {
  const inv = useInventory()
  const scope: ComputedRef<string[] | null | undefined> = computed(() => {
    const allowed = can({ verb: 'list', group, resource })
    if (allowed === undefined) return undefined
    return allowed ? null : inv.reachableNamespaces
  })
  return useMultiWatch(
    () => {
      const version = apiVersion()
      return version && scope.value !== undefined ? { apiVersion: version, resource } : null
    },
    () => (scope.value === undefined ? [] : scope.value),
  )
}

/** Watch a cluster-scoped resource, if the cluster serves it and the user may list it. */
export function useClusterWatch(apiVersion: () => string | null, group: string, resource: string) {
  return useMultiWatch(
    () => {
      const version = apiVersion()
      return version && can({ verb: 'list', group, resource }) ? { apiVersion: version, resource } : null
    },
    () => null,
  )
}

export function byName(a: KObject, b: KObject) {
  return (a.metadata.namespace ?? '').localeCompare(b.metadata.namespace ?? '') || a.metadata.name.localeCompare(b.metadata.name, undefined, { numeric: true })
}

/** The group/version the cluster serves for a resource, or null. */
export function versionOf(group: string, resource: string): () => string | null {
  const cluster = useCluster()
  return () => (group === '' ? 'v1' : cluster.versionFor(group, resource))
}

export const DEFAULT_CLASS_ANNOTATION = 'storageclass.kubernetes.io/is-default-class'
export const DEFAULT_VIRT_CLASS_ANNOTATION = 'storageclass.kubevirt.io/is-default-virt-class'
