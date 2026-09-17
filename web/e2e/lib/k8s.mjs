/** Cluster helpers over the gateway: fetch, wait, create test namespaces, clean up. */
import { keep, suffix } from './env.mjs'

export const VM = { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines' }
export const VMI = { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances' }
export const PVC = { apiVersion: 'v1', resource: 'persistentvolumeclaims' }
export const DV = { apiVersion: 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes' }

export async function get(gw, ref) {
  try {
    return await gw.call('resource.get', ref)
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

export async function list(gw, ref, options = {}) {
  return (await gw.call('resource.list', { ...ref, ...options })).items
}

/** Poll until `check` returns a truthy value, which is returned. */
export async function waitFor(what, check, { timeoutMs = 5 * 60_000, intervalMs = 2000 } = {}) {
  const started = Date.now()
  let last
  for (;;) {
    try {
      last = await check()
      if (last) return last
    } catch (e) {
      last = e
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)?.slice(0, 300)})`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** A fresh namespace for one test file, deleted afterwards (unless E2E_KEEP). */
export async function testNamespace(gw, prefix) {
  const name = `kve-e2e-${prefix}-${suffix()}`
  await gw.call('resource.create', {
    apiVersion: 'v1',
    resource: 'namespaces',
    body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: { 'kubevirt-webgui/e2e': 'true' } } },
  })
  return {
    name,
    async cleanup() {
      if (keep) return
      // VMs first, so their disks are released before the namespace goes.
      for (const vm of await list(gw, { ...VM, namespace: name }).catch(() => [])) {
        await gw.call('resource.delete', { ...VM, namespace: name, name: vm.metadata.name }).catch(() => {})
      }
      await gw.call('resource.delete', { apiVersion: 'v1', resource: 'namespaces', name }).catch(() => {})
    },
  }
}

/** Run `fn` and always attempt `cleanup`, reporting both failures. */
export async function withCleanup(fn, cleanup) {
  try {
    return await fn()
  } finally {
    await cleanup().catch((e) => console.error('cleanup failed:', e.message))
  }
}
