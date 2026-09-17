/** Live UsbDevices and UsbDeviceClaims, shared by every atomic-usb screen and the tree. */
import { defineStore } from 'pinia'
import { computed } from 'vue'
import type { KObject } from '@/api/types'
import { useMultiWatch, useWatch } from '@/stores/watch'
import { can } from '@/stores/access'
import { useInventory } from '@/plugins/core/inventory'
import { gateway } from '@/api/gateway'
import { confirm, run } from '@/services/dialogs'

export const API = 'atomicusb.safewords.io/v1alpha1'

let created = false

export const useUsb = defineStore('atomic-usb', () => {
  created = true
  const inv = useInventory()
  const devicesWatch = useWatch(() => ({ apiVersion: API, resource: 'usbdevices' }))
  const claimsWatch = useMultiWatch(
    () => ({ apiVersion: API, resource: 'usbdeviceclaims' }),
    () => {
      const allowed = can({ verb: 'list', group: 'atomicusb.safewords.io', resource: 'usbdeviceclaims' })
      if (allowed === undefined) return []
      return allowed ? null : inv.reachableNamespaces
    },
  )

  const byName = (a: KObject, b: KObject) => a.metadata.name.localeCompare(b.metadata.name)
  const devices = computed(() => [...devicesWatch.items.value].sort(byName))
  const claims = computed(() => [...claimsWatch.items.value].sort(byName))

  return {
    devices,
    claims,
    devicesSynced: devicesWatch.synced,
    devicesError: devicesWatch.error,
    claimsSynced: claimsWatch.synced,
    claimsError: claimsWatch.error,
  }
})

/** Stop the store's watches, if it was ever used. */
export function disposeUsbStore() {
  if (!created) return
  useUsb().$dispose()
  created = false
}

export function deviceLabel(device: KObject): string {
  const product = device.spec?.product ?? device.spec?.manufacturer
  return product ? `${product} (${device.spec?.vendorId}:${device.spec?.productId})` : `${device.spec?.vendorId}:${device.spec?.productId}`
}

export async function detachClaim(claim: KObject) {
  const ok = await confirm({
    title: 'Detach USB device',
    message: `Detach ${claim.status?.deviceName ?? claim.metadata.name} from ${claim.metadata.namespace}/${claim.spec?.vmName}? The claim is deleted and the device released.`,
    confirmText: 'Detach',
    danger: true,
  })
  if (ok) await run('Detach USB device', () => gateway.call('usb.detach', { namespace: claim.metadata.namespace, claim: claim.metadata.name }))
}
