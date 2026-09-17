// atomic-usb from the GUI: enable USB redirection on a VM, attach a real USB
// device plugged into a node, and detach it. Uses E2E_USB_DEVICE (default the
// Intel Bluetooth adapter on pve-thin-5) and refuses a device already claimed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { createVm } from './lib/fixtures.mjs'
import { VM, get, list, testNamespace, waitFor } from './lib/k8s.mjs'

const API = 'atomicusb.safewords.io/v1alpha1'
const DEVICE = process.env.E2E_USB_DEVICE ?? 'usb-8087-0029-23f66d18'
const DEVICES = { apiVersion: API, resource: 'usbdevices' }
const CLAIMS = { apiVersion: API, resource: 'usbdeviceclaims' }

test(`attach and detach USB device ${DEVICE} from the GUI`, { timeout: 25 * 60_000 }, async (t) => {
  const gw = await Gateway.connect()
  const discovery = await gw.call('cluster.discovery')
  if (!discovery.resources[API]) {
    t.skip('atomic-usb is not installed')
    gw.close()
    return
  }
  const device = await get(gw, { ...DEVICES, name: DEVICE })
  assert.ok(device, `device ${DEVICE} exists`)
  assert.equal(device.status?.phase, 'Available', 'the device is plugged in')
  assert.equal(device.status?.attachedTo ?? null, null, 'the device is not claimed by anyone')

  const ns = await testNamespace(gw, 'usb')
  const name = 'usb-vm'
  const gui = await openGui()
  const claims = async () => (await list(gw, { ...CLAIMS, namespace: ns.name })).filter((c) => c.spec?.vmName === name)

  try {
    await createVm(gw, ns.name, name)
    await gui.login()
    await gui.goto(gui.vmPath(ns.name, name, 'usb'))

    await t.test('the panel offers to enable USB redirection, and does', async () => {
      await gui.page.getByText('USB redirection is not enabled').waitFor({ timeout: 30_000 })
      await gui.page.getByRole('button', { name: 'Enable', exact: true }).click()
      await gui.confirm()
      await waitFor('clientPassthrough in the VM spec', async () => {
        const vm = await get(gw, { ...VM, namespace: ns.name, name })
        return vm?.spec?.template?.spec?.domain?.devices?.clientPassthrough !== undefined
      }, { timeoutMs: 60_000 })
      await gui.page.getByText('USB redirection is not enabled').waitFor({ state: 'detached', timeout: 30_000 })
    })

    await gw.runTask('vm.start', { namespace: ns.name, name }, 10 * 60_000)
    const started = await get(gw, { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances', namespace: ns.name, name })
    console.log('VMI on', started.status.nodeName, 'clientPassthrough:', JSON.stringify(started.spec.domain.devices.clientPassthrough))

    await t.test('Attach', async () => {
      await gui.goto(gui.vmPath(ns.name, name, 'usb'))
      const row = gui.page.locator('tr', { hasText: device.status.node }).filter({ hasText: device.status.portPath }).first()
      await row.getByRole('button', { name: 'Attach' }).click()
      await gui.confirm()
      const claim = await waitFor('the claim to be attached and connected', async () => {
        const [c] = await claims()
        if (c) console.log('claim:', c.status?.phase, '|', c.status?.message, '|', c.status?.connection?.state ?? '')
        return c?.status?.phase === 'Attached' && c.status?.connection?.state === 'Connected' ? c : null
      }, { timeoutMs: 5 * 60_000, intervalMs: 3000 })
      assert.equal(claim.status.deviceName, DEVICE)
      const leased = await get(gw, { ...DEVICES, name: DEVICE })
      assert.equal(leased.status?.attachedTo?.vmName, name, 'the device is leased to the VM')
      await gui.page.getByText('Attached', { exact: true }).first().waitFor({ timeout: 30_000 })
    })

    await t.test('Detach', async () => {
      await gui.page.keyboard.press('Escape')
      await gui.goto(gui.vmPath(ns.name, name, 'usb'))
      await gui.page.getByRole('button', { name: 'Detach' }).first().click()
      await gui.confirm()
      await waitFor('the claim to be gone', async () => (await claims()).length === 0, { timeoutMs: 2 * 60_000 })
      await waitFor('the device lease to be released', async () => !(await get(gw, { ...DEVICES, name: DEVICE }))?.status?.attachedTo, { timeoutMs: 2 * 60_000 })
    })

    await gui.shot('usb-done')
    assert.deepEqual(gui.errors, [])
  } finally {
    // Never leave a real device claimed.
    for (const claim of await claims().catch(() => [])) {
      await gw.call('resource.delete', { ...CLAIMS, namespace: ns.name, name: claim.metadata.name }).catch(() => {})
    }
    await gui.close()
    await ns.cleanup()
    gw.close()
  }
})
