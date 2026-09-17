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

/**
 * Roughly how capable each model is, Intel and AMD on one scale (x86-64
 * microarchitecture level, then later extensions), so the suggestion is the
 * most capable common model. Opteron_G3 lacks SSE4.2 and POPCNT, which
 * Windows 11 and current Linux distributions need; SandyBridge has them.
 */
const CAPABILITY: Record<string, number> = {
  Conroe: 1.0, Penryn: 1.1, Opteron_G1: 1.0, Opteron_G2: 1.05, Opteron_G3: 1.2,
  Nehalem: 2.0, Westmere: 2.1, Opteron_G4: 2.4, SandyBridge: 2.5, IvyBridge: 2.6, Opteron_G5: 2.7,
  'Haswell-noTSX': 3.0, Haswell: 3.0, EPYC: 3.05, 'Broadwell-noTSX': 3.1, Broadwell: 3.1, 'Skylake-Client': 3.2, 'EPYC-Rome': 3.3, 'EPYC-Milan': 3.4,
  'Skylake-Server': 4.0, 'Cascadelake-Server': 4.1, 'Icelake-Server': 4.2, SapphireRapids: 4.3, 'EPYC-Genoa': 4.4,
}

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
    const rank = (m: string) => CAPABILITY[m.replace(/-v\d+$/, '')] ?? 0
    return shared.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
  })

  return { hostModels, mixed, common }
}
