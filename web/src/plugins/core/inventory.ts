/**
 * The live inventory: nodes, VMs, their instances, disks and migrations.
 *
 * One set of watches feeds the tree, search, summaries and pickers. For a
 * user who may list cluster-wide it is one watch per type; otherwise one per
 * namespace they can reach.
 */
import { defineStore } from 'pinia'
import { computed, type ComputedRef } from 'vue'
import type { KObject } from '@/api/types'
import { useCluster } from '@/stores/cluster'
import { useUi } from '@/stores/ui'
import { can } from '@/stores/access'
import { useMultiWatch } from '@/stores/watch'

export const useInventory = defineStore('inventory', () => {
  const cluster = useCluster()
  const ui = useUi()

  const reachableNamespaces = computed(() => {
    const names = new Set([...cluster.namespaceNames, ...ui.extraNamespaces])
    return [...names].sort()
  })

  /** `null` = cluster-wide; a list = those namespaces; `undefined` = still deciding. */
  function scopeFor(group: string, resource: string): ComputedRef<string[] | null | undefined> {
    return computed(() => {
      const allowed = can({ verb: 'list', group, resource })
      if (allowed === undefined) return undefined
      return allowed ? null : reachableNamespaces.value
    })
  }

  function collection(apiVersion: () => string | null, group: string, resource: string) {
    const scope = scopeFor(group, resource)
    return useMultiWatch(
      () => {
        const version = apiVersion()
        return version && scope.value !== undefined ? { apiVersion: version, resource } : null
      },
      () => (scope.value === undefined ? [] : scope.value),
    )
  }

  const nodesWatch = useMultiWatch(
    () => (can({ verb: 'list', group: '', resource: 'nodes' }) ? { apiVersion: 'v1', resource: 'nodes' } : null),
    () => null,
  )
  const vmsWatch = collection(() => (cluster.has('kubevirt.io/v1/virtualmachines') ? 'kubevirt.io/v1' : null), 'kubevirt.io', 'virtualmachines')
  const vmisWatch = collection(() => (cluster.has('kubevirt.io/v1/virtualmachineinstances') ? 'kubevirt.io/v1' : null), 'kubevirt.io', 'virtualmachineinstances')
  const dvWatch = collection(() => cluster.versionFor('cdi.kubevirt.io', 'datavolumes'), 'cdi.kubevirt.io', 'datavolumes')
  const pvcWatch = collection(() => 'v1', '', 'persistentvolumeclaims')
  const migrationWatch = collection(() => (cluster.has('kubevirt.io/v1/virtualmachineinstancemigrations') ? 'kubevirt.io/v1' : null), 'kubevirt.io', 'virtualmachineinstancemigrations')

  const byName = (a: KObject, b: KObject) => a.metadata.name.localeCompare(b.metadata.name, undefined, { numeric: true })
  const key = (o: KObject) => `${o.metadata.namespace ?? ''}/${o.metadata.name}`

  const nodes = computed(() => [...nodesWatch.items.value].sort(byName))
  const vms = computed(() => [...vmsWatch.items.value].sort(byName))
  const vmis = computed(() => vmisWatch.items.value)
  const dataVolumes = computed(() => dvWatch.items.value)
  const pvcs = computed(() => [...pvcWatch.items.value].sort(byName))
  const migrations = computed(() => migrationWatch.items.value)

  const vmiByKey = computed(() => new Map(vmis.value.map((v) => [key(v), v])))
  const dvByKey = computed(() => new Map(dataVolumes.value.map((d) => [key(d), d])))

  function vmiFor(vm: KObject): KObject | null {
    return vmiByKey.value.get(key(vm)) ?? null
  }

  function dataVolumeFor(pvc: KObject): KObject | null {
    return dvByKey.value.get(key(pvc)) ?? null
  }

  /** VMIs with no VirtualMachine owning them. */
  const bareVmis = computed(() => {
    const vmKeys = new Set(vms.value.map(key))
    return vmis.value.filter((v) => !vmKeys.has(key(v)))
  })

  const synced = computed(() => vmsWatch.synced.value && vmisWatch.synced.value)

  /** Kept for callers that want to make sure the store exists. */
  function start() {}

  return { nodes, vms, vmis, dataVolumes, pvcs, migrations, bareVmis, vmiFor, dataVolumeFor, synced, reachableNamespaces, start }
})
