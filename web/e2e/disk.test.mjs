// Disks, through the GUI: create an empty disk, grow it, attach it to a
// stopped VM that then boots with it, clone it, and remove the clone.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, get, waitFor, PVC, DV, VM, VMI } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { closeDialogs, createMenu, field, headerAction, headerMenu } from './lib/forms.mjs'
import { quantityBytes } from './lib/quantity.mjs'

let gw, ns, gui
const VM_NAME = 'disk-vm'
const DISK = 'blank-disk'
const COPY = 'blank-disk-copy'

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'disk')
  await createVm(gw, ns.name, VM_NAME)
  gui = await openGui()
  await gui.login()
})

after(async () => {
  await gui?.close()
  await ns?.cleanup()
  gw?.close()
})

const dvPhase = async (name) => (await get(gw, { ...DV, namespace: ns.name, name }))?.status?.phase

test('Create Disk makes an empty 1 GiB DataVolume on ceph-rbd', { timeout: 5 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto('/dc/summary')
  await createMenu(page, 'Create Disk')
  const dialog = gui.dialog()
  await field(dialog, 'Namespace').fill(ns.name)
  await field(dialog, 'Name').fill(DISK)
  await field(dialog, 'Size (GiB)').fill('1')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()

  await waitFor('the disk to be ready', async () => (await dvPhase(DISK)) === 'Succeeded', { timeoutMs: 3 * 60_000 })
  const pvc = await get(gw, { ...PVC, namespace: ns.name, name: DISK })
  assert.equal(pvc.status.phase, 'Bound')
  assert.equal(pvc.spec.storageClassName, 'ceph-rbd')
  assert.equal(quantityBytes(pvc.status.capacity.storage), 1024 ** 3)
  await page.waitForURL(new RegExp(`/n/disk/${ns.name}/${DISK}`), { timeout: 20_000 })
  await closeDialogs(page)
})

test('Resize grows the disk to 2 GiB', { timeout: 5 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/disk/${ns.name}/${DISK}/summary`)
  await headerAction(page, 'Resize').click()
  const dialog = gui.dialog()
  await dialog.locator('input[type=number]').fill('1')
  await dialog.getByRole('button', { name: 'Resize disk' }).click()
  await dialog.waitFor({ state: 'detached' })

  const pvc = await waitFor(
    'the claim to report 2 GiB',
    async () => {
      const p = await get(gw, { ...PVC, namespace: ns.name, name: DISK })
      return quantityBytes(p?.status?.capacity?.storage) >= 2 * 1024 ** 3 && p
    },
    { timeoutMs: 3 * 60_000 },
  )
  assert.equal(quantityBytes(pvc.spec.resources.requests.storage), 2 * 1024 ** 3)
  // The summary follows the claim.
  await page.getByText('2.0 GiB').first().waitFor({ timeout: 30_000 })
})

test('Attach to VM adds the disk to a stopped VM, which boots with it', { timeout: 8 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/disk/${ns.name}/${DISK}/summary`)
  await headerAction(page, 'Attach to VM').click()
  const dialog = gui.dialog()
  await dialog.locator('select').first().selectOption(VM_NAME)
  await dialog.getByRole('button', { name: 'Attach', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  const vm = await waitFor('the VM definition to include the disk', async () => {
    const v = await get(gw, { ...VM, namespace: ns.name, name: VM_NAME })
    const spec = v.spec.template.spec
    return spec.volumes.some((x) => x.name === DISK && x.dataVolume?.name === DISK) && spec.domain.devices.disks.some((d) => d.name === DISK && d.disk?.bus === 'virtio') && v
  })
  assert.ok(vm)

  await gw.runTask('vm.start', { namespace: ns.name, name: VM_NAME }, 8 * 60_000)
  const vmi = await get(gw, { ...VMI, namespace: ns.name, name: VM_NAME })
  assert.equal(vmi.status.phase, 'Running')
  assert.ok(vmi.spec.volumes.some((v) => v.dataVolume?.name === DISK), 'the running instance uses the disk')
  await gw.runTask('vm.stop', { namespace: ns.name, name: VM_NAME, force: true }, 5 * 60_000)
})

test('Clone copies the disk into a new DataVolume', { timeout: 8 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/disk/${ns.name}/${DISK}/summary`)
  await headerMenu(page, 'More', 'Clone')
  const dialog = gui.dialog()
  await field(dialog, 'New disk name').fill(COPY)
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click()

  await waitFor('the clone to finish', async () => (await dvPhase(COPY)) === 'Succeeded', { timeoutMs: 6 * 60_000 })
  const pvc = await get(gw, { ...PVC, namespace: ns.name, name: COPY })
  assert.equal(pvc.status.phase, 'Bound')
  assert.ok(quantityBytes(pvc.status.capacity.storage) >= 2 * 1024 ** 3, 'the clone is at least as large as the source')
  await closeDialogs(page)
})

test('An import that keeps failing says why, on the disk and in its task', { timeout: 8 * 60_000 }, async () => {
  const { page } = gui
  const BROKEN = 'broken-import'
  await gui.goto('/dc/summary')
  await createMenu(page, 'Create Disk')
  const dialog = gui.dialog()
  await field(dialog, 'Source').selectOption('http')
  await field(dialog, 'URL').fill('https://download.cirros-cloud.net/0.6.2/kve-e2e-no-such-image.img')
  await field(dialog, 'Namespace').fill(ns.name)
  await field(dialog, 'Name').fill(BROKEN)
  await field(dialog, 'Size (GiB)').fill('1')
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()

  // The Disk screen names the failing pod and the reason while CDI retries.
  await page.waitForURL(new RegExp(`/n/disk/${ns.name}/${BROKEN}`), { timeout: 20_000 })
  await closeDialogs(page)
  const title = page.getByText(/CDI's pod keeps failing/)
  await title.waitFor({ timeout: 5 * 60_000 })
  const notice = page.locator('div.rounded-md.border', { has: title }).first()
  const text = await waitFor('the reason on the disk screen', async () => {
    const t = await notice.innerText()
    return /404|not found/i.test(t) && t
  }, { timeoutMs: 60_000, intervalMs: 1000 })
  assert.match(text, /on node \S+/, text)

  // And the task stops waiting once the pod has failed a few times, with the reason.
  const task = await waitFor(
    'the disk task to give up',
    async () => [...gw.tasks.values()].find((t) => t.target.name === BROKEN && t.target.namespace === ns.name && t.status !== 'running'),
    { timeoutMs: 5 * 60_000 },
  ).catch(async () => {
    // Tasks started in the browser belong to the same user; read them from the server.
    const list = await gw.call('tasks.list', {})
    return list.find((t) => t.target.name === BROKEN && t.target.namespace === ns.name && t.status !== 'running')
  })
  assert.equal(task?.status, 'error')
  assert.match(task.message, /keeps failing.*(404|not found)/i, task.message)
  await gw.call('resource.delete', { ...DV, namespace: ns.name, name: BROKEN })
})

test('Remove deletes the clone and its claim', { timeout: 3 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/disk/${ns.name}/${COPY}/summary`)
  await headerMenu(page, 'More', 'Remove')
  await gui.confirm(COPY)

  await waitFor('the DataVolume and claim to be gone', async () => {
    const dv = await get(gw, { ...DV, namespace: ns.name, name: COPY })
    const pvc = await get(gw, { ...PVC, namespace: ns.name, name: COPY })
    return !dv && (!pvc || pvc.metadata.deletionTimestamp)
  })
  assert.deepEqual(gui.errors, [])
})
