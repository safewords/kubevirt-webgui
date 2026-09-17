/**
 * CPU models across the VM-capable nodes, from KubeVirt's node labeller:
 * whether their host CPUs differ, and which named models all of them run —
 * what a VM should use to stay live-migratable on a mixed cluster.
 */
import { computed } from 'vue'
import type { KObject } from '@/api/types'
import { useInventory } from '@/plugins/core/inventory'
import { nodeReady } from '@/util/kubevirt'

const HOST_MODEL = 'host-model-cpu.node.kubevirt.io/'
const MODEL = 'cpu-model.node.kubevirt.io/'

function labelled(node: KObject, prefix: string): string[] {
  return Object.entries(node.metadata.labels ?? {})
    .filter(([key, value]) => key.startsWith(prefix) && value === 'true')
    .map(([key]) => key.slice(prefix.length))
}

/** Rough generational order, newest last, so the suggestion is the most capable common model. */
const PREFERENCE = [
  'Westmere', 'SandyBridge', 'IvyBridge', 'Haswell-noTSX', 'Haswell', 'Broadwell-noTSX', 'Broadwell', 'Skylake-Client', 'Skylake-Server', 'Cascadelake-Server', 'Icelake-Server',
  'Opteron_G3', 'Opteron_G4', 'Opteron_G5', 'EPYC', 'EPYC-Rome', 'EPYC-Milan', 'EPYC-Genoa',
]

export function useCpuModels() {
  const inv = useInventory()
  const nodes = computed(() => inv.nodes.filter((n) => nodeReady(n) && n.metadata.labels?.['kubevirt.io/schedulable'] === 'true'))

  /** Host CPU model per node, e.g. { 'pve-thin-5': 'EPYC-Rome' }. */
  const hostModels = computed(() => Object.fromEntries(nodes.value.map((n) => [n.metadata.name, labelled(n, HOST_MODEL)[0] ?? 'unknown'])))
  const mixed = computed(() => new Set(Object.values(hostModels.value)).size > 1)

  /** Named models every VM-capable node supports, most capable first. */
  const common = computed(() => {
    if (!nodes.value.length) return []
    const sets = nodes.value.map((n) => new Set(labelled(n, MODEL)))
    const shared = [...sets[0]].filter((m) => sets.every((s) => s.has(m)))
    const rank = (m: string) => {
      const base = m.replace(/-v\d+$/, '')
      const i = PREFERENCE.indexOf(base)
      return i === -1 ? -1 : i
    }
    return shared.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
  })

  return { hostModels, mixed, common }
}
