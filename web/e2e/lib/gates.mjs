/**
 * Suites that need a KubeVirt feature gate turn it on for their own run and
 * put the CR back exactly as it was — including "no featureGates key at all"
 * — so the cluster does not drift from how KubeVirt was installed.
 *
 * E2E_NO_CLUSTER_CHANGES=1 skips such suites instead of touching KubeVirt.
 */
import { list, waitFor } from './k8s.mjs'

const KUBEVIRT = { apiVersion: 'kubevirt.io/v1', resource: 'kubevirts' }

async function kubevirtCr(gw) {
  const [cr] = await list(gw, KUBEVIRT)
  if (!cr) throw new Error('KubeVirt is not installed')
  return cr
}

async function waitAvailable(gw) {
  await waitFor('KubeVirt to be Available', async () => {
    const cr = await kubevirtCr(gw)
    const c = (type) => cr.status?.conditions?.find((x) => x.type === type)?.status
    return c('Available') === 'True' && c('Progressing') !== 'True'
  }, { timeoutMs: 10 * 60_000, intervalMs: 5000 })
}

/**
 * Enable `gates` (any one of `alternatives` already present counts) and
 * return a function that restores the CR exactly. Throws, with the reason,
 * when a gate is missing and E2E_NO_CLUSTER_CHANGES=1.
 */
export async function ensureFeatureGates(gw, gates, { alternatives = [] } = {}) {
  const cr = await kubevirtCr(gw)
  const ref = { ...KUBEVIRT, namespace: cr.metadata.namespace, name: cr.metadata.name }
  const developer = cr.spec?.configuration?.developerConfiguration ?? {}
  const hadKey = Object.prototype.hasOwnProperty.call(developer, 'featureGates')
  const before = [...(developer.featureGates ?? [])]
  if (alternatives.some((g) => before.includes(g))) return async () => {}
  const missing = gates.filter((g) => !before.includes(g))
  if (!missing.length) return async () => {}
  if (process.env.E2E_NO_CLUSTER_CHANGES === '1') {
    throw new Error(`this suite needs KubeVirt feature gates ${missing.join(', ')}, and E2E_NO_CLUSTER_CHANGES=1 forbids enabling them`)
  }

  await gw.call('resource.patch', { ...ref, patch: { spec: { configuration: { developerConfiguration: { featureGates: [...before, ...missing] } } } } })
  await waitAvailable(gw)

  return async () => {
    // Back to exactly what was there: the same list, or no key at all.
    const current = (await kubevirtCr(gw)).spec?.configuration?.developerConfiguration?.featureGates ?? []
    const restored = current.filter((g) => !missing.includes(g))
    const patch = hadKey || restored.length
      ? [{ op: 'replace', path: '/spec/configuration/developerConfiguration/featureGates', value: restored }]
      : [{ op: 'remove', path: '/spec/configuration/developerConfiguration/featureGates' }]
    await gw.call('resource.patch', { ...ref, patch, patchType: 'json' }).catch((e) => console.error('could not restore feature gates:', e.message))
    await waitAvailable(gw).catch(() => {})
  }
}
