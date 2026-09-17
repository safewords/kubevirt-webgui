// Options panel, through the browser: every editable option lands in the VM,
// tags show in the Tag View, and the run strategy starts and stops the VM.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { VM, VMI, get, testNamespace, waitFor } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { capture, closeDialogs, dialogClosed, field, row, submitDialog, vmSpec, waitRunning } from './lib/vm.mjs'

let gw, ns, gui
const NAME = 'opt'
const vm = () => get(gw, { ...VM, namespace: ns.name, name: NAME })

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

async function openOption(label) {
  const { page } = gui
  if (!page.url().endsWith(`/${NAME}/options`)) {
    await gui.goto(gui.vmPath(ns.name, NAME, 'options'))
  }
  await closeDialogs(page)
  const r = row(page, label)
  await r.waitFor({ timeout: 30_000 })
  await r.dblclick()
  const dialog = gui.dialog()
  await dialog.waitFor({ timeout: 10_000 })
  return dialog
}

test('notes', { timeout: 120_000 }, () => capture(gui, 'options-notes', async () => {
  const dialog = await openOption('Notes')
  await field(dialog, 'Notes').fill('Owned by the e2e suite.\nSecond line.')
  await submitDialog(dialog)
  await dialogClosed(gui.page)
  await waitFor('the notes annotation', async () => (await vm())?.metadata.annotations?.['kubevirt-webgui/notes'] === 'Owned by the e2e suite.\nSecond line.')
  await row(gui.page, 'Notes').getByText('Owned by the e2e suite. …').waitFor({ timeout: 15_000 })
}))

test('tags, shown in the Tag View', { timeout: 120_000 }, () => capture(gui, 'options-tags', async () => {
  const { page } = gui
  const dialog = await openOption('Tags')
  const input = field(dialog, 'Add a tag')
  await input.fill('e2e-web')
  await input.press('Enter')
  await input.fill('blue')
  await submitDialog(dialog)
  await dialogClosed(page)
  const labels = await waitFor('tag labels', async () => {
    const l = (await vm())?.metadata.labels ?? {}
    return 'tags.kubevirt-webgui/e2e-web' in l && 'tags.kubevirt-webgui/blue' in l ? l : null
  })
  assert.ok(labels)

  await page.locator('aside select').first().selectOption('tag')
  const tree = page.locator('nav[role=tree]')
  const group = tree.locator('[role=treeitem]', { hasText: 'e2e-web' }).first()
  await group.waitFor({ timeout: 30_000 })
  await group.getByText(NAME, { exact: true }).first().waitFor({ timeout: 15_000 })
  await page.locator('aside select').first().selectOption('server')
}))

test('eviction strategy', { timeout: 120_000 }, () => capture(gui, 'options-eviction', async () => {
  const dialog = await openOption('Eviction strategy')
  await field(dialog, 'When its node is drained').selectOption('LiveMigrate')
  await submitDialog(dialog)
  await dialogClosed(gui.page)
  await waitFor('evictionStrategy', async () => (await vmSpec(gw, ns.name, NAME))?.evictionStrategy === 'LiveMigrate')
}))

test('boot order: network first, then the root disk', { timeout: 120_000 }, () => capture(gui, 'options-boot', async () => {
  const dialog = await openOption('Boot order')
  const entries = dialog.locator('input[type=checkbox]')
  assert.equal(await entries.count(), 2, 'the root disk and the network device')
  // Entries start as Disk root, Network default; enable both, then move the network up.
  await entries.nth(0).check()
  await entries.nth(1).check()
  await dialog.getByRole('button', { name: 'Move up' }).nth(1).click()
  await submitDialog(dialog)
  await dialogClosed(gui.page)
  const spec = await waitFor('boot order', async () => {
    const s = await vmSpec(gw, ns.name, NAME)
    return s?.domain?.devices?.interfaces?.[0]?.bootOrder ? s : null
  })
  assert.equal(spec.domain.devices.interfaces.find((i) => i.name === 'default').bootOrder, 1)
  assert.equal(spec.domain.devices.disks.find((d) => d.name === 'root').bootOrder, 2)
  await row(gui.page, 'Boot order').getByText('default (network), root').waitFor({ timeout: 15_000 })
}))

test('shutdown timeout', { timeout: 120_000 }, () => capture(gui, 'options-grace', async () => {
  const dialog = await openOption('Shutdown timeout')
  await field(dialog, 'Grace period').fill('45')
  await submitDialog(dialog)
  await dialogClosed(gui.page)
  await waitFor('grace period 45', async () => (await vmSpec(gw, ns.name, NAME))?.terminationGracePeriodSeconds === 45)
}))

test('node placement: pin, then any node', { timeout: 120_000 }, () => capture(gui, 'options-placement', async () => {
  const { page } = gui
  let dialog = await openOption('Node placement')
  await dialog.getByText('Pin to one node').click()
  await dialog.locator('select').selectOption('pve-thin-2')
  await submitDialog(dialog)
  await dialogClosed(page)
  await waitFor('pinned', async () => (await vmSpec(gw, ns.name, NAME))?.nodeSelector?.['kubernetes.io/hostname'] === 'pve-thin-2')
  await row(page, 'Node placement').getByText('pinned to pve-thin-2').waitFor({ timeout: 15_000 })

  dialog = await openOption('Node placement')
  await dialog.getByText('Any node the scheduler picks').click()
  await submitDialog(dialog)
  await dialogClosed(page)
  await waitFor('unpinned', async () => !(await vmSpec(gw, ns.name, NAME))?.nodeSelector)
}))

test('run strategy Always starts the VM, Halted stops it', { timeout: 12 * 60_000 }, () => capture(gui, 'options-run', async () => {
  let dialog = await openOption('Run strategy (start at boot)')
  await field(dialog, 'Run strategy').selectOption('Always')
  await submitDialog(dialog)
  await dialogClosed(gui.page)
  const v = await vm()
  assert.equal(v.spec.runStrategy, 'Always')
  assert.equal(v.spec.running, undefined)
  await waitRunning(gw, ns.name, NAME)

  dialog = await openOption('Run strategy (start at boot)')
  await field(dialog, 'Run strategy').selectOption('Halted')
  await submitDialog(dialog)
  await dialogClosed(gui.page)
  await waitFor('the VM to stop', async () => !(await get(gw, { ...VMI, namespace: ns.name, name: NAME })), { timeoutMs: 5 * 60_000 })
}))
