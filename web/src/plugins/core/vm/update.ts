/**
 * Applying an edit to the live VM.
 *
 * The patch is built from the VM as it is *now*, not as it was when a dialog
 * opened: a VM's status changes every few seconds, and building from a stale
 * copy would either conflict needlessly or, for device lists, drop a change
 * somebody else made in the meantime. A conflict in the narrow window between
 * building and applying is retried against the newer object.
 */
import type { KObject } from '@/api/types'
import type { ObjectContext } from '@/plugins/registry'
import { isRpcError } from '@/api/gateway'
import { k8s } from '@/api/k8s'
import { patchVm, VM_API } from './spec'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function updateVm(ctx: ObjectContext, build: (vm: KObject) => Record<string, any>) {
  for (let attempt = 0; ; attempt++) {
    const vm: KObject =
      ctx.object && attempt === 0 ? ctx.object : await k8s.get({ apiVersion: VM_API, resource: 'virtualmachines', namespace: ctx.namespace, name: ctx.name })
    try {
      return await patchVm(vm, build(vm))
    } catch (e) {
      if (attempt < 2 && isRpcError(e) && e.status === 409) {
        await sleep(250)
        continue
      }
      throw e
    }
  }
}

/** The same, for `spec.template.spec`. */
export function updateTemplate(ctx: ObjectContext, build: (spec: any, vm: KObject) => Record<string, any>) {
  return updateVm(ctx, (vm) => ({ spec: { template: { spec: build(vm.spec?.template?.spec ?? {}, vm) } } }))
}
