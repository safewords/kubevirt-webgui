import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { gateway } from '@/api/gateway'
import type { Discovery, NamespaceSummary } from '@/api/types'

/** What the cluster serves, and where this user may work. */
export const useCluster = defineStore('cluster', () => {
  const discovery = shallowRef<Discovery | null>(null)
  const namespaces = ref<NamespaceSummary[]>([])
  const canListNamespaces = ref(true)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** What discovery says, reduced to what screens care about. */
  function signature(d: Discovery): string {
    return JSON.stringify([d.kubevirtVersion?.gitVersion, Object.entries(d.resources).map(([gv, rs]) => [gv, rs.map((r) => r.name)])])
  }

  async function load(refresh = false) {
    loading.value = true
    error.value = null
    try {
      const [d, ns] = await Promise.all([
        gateway.call<Discovery>('cluster.discovery', { refresh }),
        gateway.call<{ canList: boolean; namespaces: NamespaceSummary[] }>('cluster.namespaces'),
      ])
      // Replaced only on a real change: every screen that asks `has()` would
      // otherwise recompute once a minute for nothing.
      if (!discovery.value || signature(discovery.value) !== signature(d)) discovery.value = d
      canListNamespaces.value = ns.canList
      namespaces.value = [...ns.namespaces].sort((a, b) => a.name.localeCompare(b.name))
    } catch (e: any) {
      error.value = e?.message ?? String(e)
    } finally {
      loading.value = false
    }
  }

  let poller: ReturnType<typeof setInterval> | null = null
  /** Re-read discovery and namespaces every minute. */
  function startPolling() {
    if (poller) return
    poller = setInterval(() => {
      if (gateway.state.value === 'open') load().catch(() => {})
    }, 60_000)
  }

  async function reloadNamespaces() {
    const ns = await gateway.call<{ canList: boolean; namespaces: NamespaceSummary[] }>('cluster.namespaces')
    canListNamespaces.value = ns.canList
    namespaces.value = [...ns.namespaces].sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Whether the cluster serves a resource. Accepts `group/version/resource`,
   * `version/resource` for the core group, or `group` alone (any version).
   */
  function has(spec: string): boolean {
    const d = discovery.value
    if (!d) return false
    const parts = spec.split('/')
    if (parts.length === 1) return spec === 'v1' || d.groups.some((g) => g.name === spec)
    const resource = parts.pop()!
    const gv = parts.join('/')
    return (d.resources[gv] ?? []).some((r) => r.name === resource)
  }

  /** The preferred `group/version` for a group, e.g. `snapshot.kubevirt.io/v1beta1`. */
  function preferred(group: string): string | null {
    const g = discovery.value?.groups.find((g) => g.name === group)
    return g ? `${group}/${g.preferredVersion}` : null
  }

  /** The `group/version` that serves `resource` in `group`, preferring the preferred version. */
  function versionFor(group: string, resource: string): string | null {
    const d = discovery.value
    const g = d?.groups.find((g) => g.name === group)
    if (!d || !g) return null
    const order = [g.preferredVersion, ...g.versions.filter((v) => v !== g.preferredVersion)]
    for (const version of order) {
      if ((d.resources[`${group}/${version}`] ?? []).some((r) => r.name === resource)) return `${group}/${version}`
    }
    return null
  }

  const kubevirtVersion = computed(() => discovery.value?.kubevirtVersion?.gitVersion ?? null)
  const kubernetesVersion = computed(() => discovery.value?.serverVersion?.gitVersion ?? null)
  const namespaceNames = computed(() => namespaces.value.map((n) => n.name))

  return {
    discovery,
    namespaces,
    namespaceNames,
    canListNamespaces,
    loading,
    error,
    load,
    startPolling,
    reloadNamespaces,
    has,
    preferred,
    versionFor,
    kubevirtVersion,
    kubernetesVersion,
  }
})
