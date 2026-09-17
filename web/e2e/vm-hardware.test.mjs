// Hardware panel, through the browser: CPU, memory, a new disk, network
// devices — then proof the running instance got them, and the
// restart-required flow on a running VM.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, waitFor } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { capture, closeDialogs, dialogClosed, field, row, submitDialog, vmSpec, waitDataVolume, waitRunning, waitVmi } from './lib/vm.mjs'

let gw, ns, gui
const NAME = 'hw'

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'vm')
  await createVm(gw, ns.name, NAME)
  gui = await openGui()
  await gui.login()
})

after(async () => {
  if (gui) {
    if (gui.errors.length) console.log('browser errors:', gui.errors)
    await gui.close()
  }
  await ns?.cleanup()
  gw?.close()
})

async function openHardware() {
  await gui.goto(gui.vmPath(ns.name, NAME, 'hardware'))
  await row(gui.page, 'Processors').waitFor({ timeout: 30_000 })
}

test('edit processors and memory on a stopped VM', { timeout: 180_000 }, () => capture(gui, "edit processors and memory on a stopped ", async () => {
  const { page } = gui
  await openHardware()

  await row(page, 'Processors').dblclick()
  let dialog = gui.dialog()
  await field(dialog, 'Cores per socket').fill('2')
  await submitDialog(dialog)
  await dialogClosed(page)
  await waitFor('cores = 2', async () => (await vmSpec(gw, ns.name, NAME))?.domain?.cpu?.cores === 2)
  await row(page, 'Processors').getByText('2 (1 socket, 2 cores').waitFor({ timeout: 15_000 })

  await row(page, 'Memory').dblclick()
  dialog = gui.dialog()
  await field(dialog, 'Guest memory').fill('384Mi')
  await submitDialog(dialog)
  await dialogClosed(page)
  const spec = await waitFor('memory = 384Mi', async () => {
    const s = await vmSpec(gw, ns.name, NAME)
    return s?.domain?.memory?.guest === '384Mi' ? s : null
  })
  // The CPU model the VM was created with survives an unrelated edit.
  assert.equal(spec.domain.cpu.model, 'Westmere')
}))

test('add a blank disk as a DataVolume template', { timeout: 180_000 }, () => capture(gui, "add a blank disk as a DataVolume templat", async () => {
  const { page } = gui
  await openHardware()
  await page.getByRole('button', { name: 'Add' }).first().click()
  await page.getByRole('button', { name: 'Hard Disk' }).click()
  const dialog = gui.dialog()
  await field(dialog, 'Size').fill('1Gi')
  await field(dialog, 'Storage class').selectOption('ceph-rbd')
  await submitDialog(dialog)
  await dialogClosed(page)

  const vm = await waitFor('the disk template', async () => {
    const v = await gw.call('resource.get', { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace: ns.name, name: NAME })
    return v.spec.dataVolumeTemplates?.some((t) => t.metadata.name === `${NAME}-disk0`) ? v : null
  })
  const template = vm.spec.dataVolumeTemplates.find((t) => t.metadata.name === `${NAME}-disk0`)
  assert.equal(template.spec.storage.resources.requests.storage, '1Gi')
  assert.equal(template.spec.storage.storageClassName, 'ceph-rbd')
  assert.ok(vm.spec.template.spec.domain.devices.disks.some((d) => d.name === 'disk0'))
  assert.ok(vm.spec.template.spec.volumes.some((v) => v.name === 'disk0' && v.dataVolume?.name === `${NAME}-disk0`))
  await row(page, 'Hard Disk (virtio: disk0)').waitFor({ timeout: 15_000 })
}))

test('remove and add network devices', { timeout: 180_000 }, () => capture(gui, "remove and add network devices", async () => {
  const { page } = gui
  await openHardware()

  await row(page, 'Network Device (default)').click()
  await page.getByRole('button', { name: 'Remove' }).first().click()
  await gui.confirm()
  await waitFor('no interfaces', async () => ((await vmSpec(gw, ns.name, NAME))?.domain?.devices?.interfaces ?? []).length === 0)

  await page.getByRole('button', { name: 'Add' }).first().click()
  await page.getByRole('button', { name: 'Network Device' }).click()
  const dialog = gui.dialog()
  await field(dialog, 'Model').selectOption('e1000e')
  await submitDialog(dialog)
  await dialogClosed(page)

  const spec = await waitFor('net0', async () => {
    const s = await vmSpec(gw, ns.name, NAME)
    return s?.domain?.devices?.interfaces?.some((i) => i.name === 'net0') ? s : null
  })
  const iface = spec.domain.devices.interfaces.find((i) => i.name === 'net0')
  assert.equal(iface.model, 'e1000e')
  assert.ok(iface.masquerade, 'masquerade binding on the pod network')
  assert.ok(spec.networks.some((n) => n.name === 'net0' && n.pod))
}))

test('the started instance has the edited hardware', { timeout: 12 * 60_000 }, () => capture(gui, "the started instance has the edited hard", async () => {
  const { page } = gui
  await openHardware()
  await page.getByRole('button', { name: 'Start', exact: true }).click()
  // The instance waits for its new blank disk; a stuck importer shows up here with its node.
  await waitDataVolume(gw, ns.name, `${NAME}-disk0`)
  const vmi = await waitRunning(gw, ns.name, NAME)
  await closeDialogs(page)

  assert.equal(vmi.spec.domain.cpu.cores, 2)
  assert.equal(vmi.spec.domain.memory.guest, '384Mi')
  assert.ok(vmi.spec.volumes.some((v) => v.name === 'disk0'), 'disk0 attached')
  const iface = vmi.spec.domain.devices.interfaces.find((i) => i.name === 'net0')
  assert.equal(iface?.model, 'e1000e')
  const dv = await gw.call('resource.get', { apiVersion: 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', namespace: ns.name, name: `${NAME}-disk0` })
  assert.equal(dv.status.phase, 'Succeeded')
}))

test('a CPU edit on the running VM asks for a restart, and Restart now applies it', { timeout: 12 * 60_000 }, () => capture(gui, "a CPU edit on the running VM asks for a ", async () => {
  const { page } = gui
  await openHardware()
  const original = await waitRunning(gw, ns.name, NAME)

  await row(page, 'Processors').dblclick()
  const dialog = gui.dialog()
  await field(dialog, 'Cores per socket').fill('1')
  await submitDialog(dialog)
  await dialogClosed(page)

  const banner = page.getByText('Pending changes')
  await banner.waitFor({ timeout: 90_000 })
  await page.getByRole('button', { name: 'Restart now' }).click()

  const restarted = await waitVmi(gw, ns.name, NAME, (v) => v.metadata.uid !== original.metadata.uid && v.status?.phase === 'Running', 'the restarted instance')
  assert.equal(restarted.spec.domain.cpu.cores, 1)
  await closeDialogs(page)
  await banner.waitFor({ state: 'detached', timeout: 120_000 })
}))
