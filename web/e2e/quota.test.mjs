// Namespace quotas through the GUI: a VM-count quota is created, shows its
// usage, and stops a second VM from being created with a clear error.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, get, waitFor, VM } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { createMenu, field } from './lib/forms.mjs'

let gw, ns, gui
const QUOTA = 'vm-quota'
const KEY = 'count/virtualmachines.kubevirt.io'

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'quota')
  await createVm(gw, ns.name, 'first-vm')
  gui = await openGui()
  await gui.login()
})

after(async () => {
  await gui?.close()
  await ns?.cleanup()
  gw?.close()
})

test('Add quota limits the namespace to one VM and shows the usage', { timeout: 4 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/c/namespace/${ns.name}/quotas`)
  await page.getByRole('button', { name: 'Add quota' }).click()
  const dialog = gui.dialog()
  assert.equal(await field(dialog, 'Name').inputValue(), QUOTA)
  await field(dialog, 'Virtual machines', { prefix: true }).fill('1')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  const quota = await waitFor('the quota to count the existing VM', async () => {
    const q = await get(gw, { apiVersion: 'v1', resource: 'resourcequotas', namespace: ns.name, name: QUOTA })
    return q?.status?.used?.[KEY] === '1' && q
  })
  assert.deepEqual(quota.spec.hard, { [KEY]: '1' })

  // Inside the panel: the task log at the bottom can mention the key too.
  const rows = page.locator('main tr', { hasText: KEY })
  await rows.first().waitFor({ timeout: 30_000 })
  const count = await rows.count()
  assert.equal(count, 1, `one usage row for the quota, got ${count}: ${(await rows.allInnerTexts()).join(' || ')}`)
  const row = rows.first()
  await row.getByText('100%').waitFor({ timeout: 30_000 })
  const cells = await row.locator('td').allInnerTexts()
  assert.deepEqual(cells.slice(1, 3).map((c) => c.trim()), ['1', '1'], `used and limit (${cells.join(' | ')})`)
})

test('Creating a second VM past the quota fails with the reason, and leaves nothing behind', { timeout: 5 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/c/namespace/${ns.name}/summary`)
  await createMenu(page, 'Create VM')
  const wizard = gui.dialog()
  await field(wizard, 'Namespace').fill(ns.name)
  await field(wizard, 'Name').fill('second-vm')
  await wizard.locator('nav').getByRole('button', { name: 'Confirm' }).click()

  // The dry run explains before anything is attempted.
  await wizard.getByRole('button', { name: 'Validate (dry run)' }).click()
  const notice = wizard.getByText(/exceeded quota/i).first()
  await notice.waitFor({ timeout: 30_000 })
  assert.match(await notice.innerText(), /count\/virtualmachines\.kubevirt\.io/)

  // Finish refuses the same way and keeps the wizard open to fix it.
  await wizard.getByRole('button', { name: 'Finish' }).click()
  await page.waitForTimeout(3000)
  assert.ok(await wizard.isVisible(), 'the wizard stays open')
  await wizard.getByText(/exceeded quota/i).first().waitFor({ timeout: 30_000 })
  assert.equal(await page.locator('[role=dialog]', { hasText: 'Task viewer' }).count(), 0, 'no task was started')

  assert.equal(await get(gw, { ...VM, namespace: ns.name, name: 'second-vm' }), null, 'no VM was created')
  assert.deepEqual(gui.errors, [])
})
