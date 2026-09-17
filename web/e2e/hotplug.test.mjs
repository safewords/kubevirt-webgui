// Hot-plugging a disk into a running VM and unplugging it, through the GUI.
// Needs KubeVirt's HotplugVolumes feature gate, which the suite enables for its run.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, get, waitFor, DV, VM, VMI } from './lib/k8s.mjs'
import { vmManifest } from './lib/fixtures.mjs'
import { avoidBadNodes } from './lib/placement.mjs'
import { closeDialogs, headerAction } from './lib/forms.mjs'
import { ensureFeatureGates } from './lib/gates.mjs'

let gw, ns, gui, restoreGates
const VM_NAME = 'hotplug-vm'
const DISK = 'hot-disk'

before(async () => {
  gw = await Gateway.connect()
  // Turned on for this run and restored exactly afterwards (lib/gates.mjs).
  restoreGates = await ensureFeatureGates(gw, ['HotplugVolumes'], { alternatives: ['DeclarativeHotplugVolumes'] })

  ns = await testNamespace(gw, 'hotplug')
  // Kept off nodes that cannot attach block volumes (see lib/placement.mjs).
  await gw.runTask('vm.create', { vm: avoidBadNodes(vmManifest(ns.name, VM_NAME)), start: false })
  await gw.runTask('vm.start', { namespace: ns.name, name: VM_NAME }, 8 * 60_000)
  await gw.runTask('datavolume.create', {
    body: {
      apiVersion: 'cdi.kubevirt.io/v1beta1',
      kind: 'DataVolume',
      metadata: { name: DISK, namespace: ns.name },
      spec: { source: { blank: {} }, storage: { resources: { requests: { storage: '1Gi' } } } },
    },
  })
  gui = await openGui()
  await gui.login()
})

after(async () => {
  await gui?.close()
  await ns?.cleanup()
  await restoreGates?.()
  gw?.close()
})

const volumeStatus = async () => (await get(gw, { ...VMI, namespace: ns.name, name: VM_NAME }))?.status?.volumeStatus ?? []

test('Attach to VM hot-plugs the disk into the running guest', { timeout: 8 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/disk/${ns.name}/${DISK}/summary`)
  await headerAction(page, 'Attach to VM').click()
  const dialog = gui.dialog()
  await dialog.locator('select').first().selectOption(VM_NAME)
  await dialog.getByText('The VM is running').waitFor()
  await dialog.getByRole('button', { name: 'Hotplug', exact: true }).click()

  const status = await waitFor(
    'the volume to be hot-plugged and ready',
    async () => (await volumeStatus()).find((s) => s.name === DISK && s.hotplugVolume && s.phase === 'Ready'),
    { timeoutMs: 6 * 60_000 },
  )
  assert.ok(status.target, 'the guest sees a device')

  const vm = await get(gw, { ...VM, namespace: ns.name, name: VM_NAME })
  const volume = vm.spec.template.spec.volumes.find((v) => v.name === DISK)
  assert.ok(volume?.dataVolume?.hotpluggable, 'the hot-plugged disk is kept in the VM definition')
  await closeDialogs(page)

  // The Hardware panel marks it.
  await gui.goto(`/n/vm/${ns.name}/${VM_NAME}/hardware`)
  await page.locator('tr', { hasText: DISK }).getByText('hot-plugged').waitFor({ timeout: 30_000 })
})

test('Removing the hot-plugged disk in Hardware unplugs it from the running guest', { timeout: 8 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/vm/${ns.name}/${VM_NAME}/hardware`)
  await page.locator('tr', { hasText: DISK }).first().click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await gui.confirm()

  await waitFor('the volume to leave the instance', async () => !(await volumeStatus()).some((s) => s.name === DISK), { timeoutMs: 6 * 60_000 })
  const vm = await waitFor('the definition to drop the disk', async () => {
    const v = await get(gw, { ...VM, namespace: ns.name, name: VM_NAME })
    return !v.spec.template.spec.volumes.some((x) => x.name === DISK) && v
  })
  assert.ok(!vm.spec.template.spec.domain.devices.disks.some((d) => d.name === DISK))
  const vmi = await get(gw, { ...VMI, namespace: ns.name, name: VM_NAME })
  assert.equal(vmi.status.phase, 'Running', 'the guest kept running throughout')
  assert.ok(await get(gw, { ...DV, namespace: ns.name, name: DISK }), 'the disk itself is kept')
  await closeDialogs(page)
  assert.deepEqual(gui.errors, [])
})
