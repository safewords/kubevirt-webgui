// Permissions and API tokens, through the GUI, proven from the other side:
// a ServiceAccount made and granted a role here signs in with a token minted
// here, and sees exactly what RBAC allows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, get, list, waitFor, VMI } from './lib/k8s.mjs'
import { vmManifest } from './lib/fixtures.mjs'
import { avoidBadNodes } from './lib/placement.mjs'
import { closeDialogs, field, headerAction } from './lib/forms.mjs'

let gw, ns, admin, operator, token
const VM_NAME = 'rbac-vm'
const SA = 'e2e-operator'
const RBAC = { apiVersion: 'rbac.authorization.k8s.io/v1', resource: 'rolebindings' }

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'access')
  await gw.runTask('vm.create', { vm: avoidBadNodes(vmManifest(ns.name, VM_NAME)), start: false })
  admin = await openGui()
  await admin.login()
})

after(async () => {
  await operator?.close()
  await admin?.close()
  await ns?.cleanup()
  gw?.close()
})

const bindingsFor = async (role) =>
  (await list(gw, { ...RBAC, namespace: ns.name })).filter((b) => b.roleRef.name === role && (b.subjects ?? []).some((s) => s.kind === 'ServiceAccount' && s.name === SA && s.namespace === ns.name))

async function openTokensTab(page) {
  await admin.goto('/dc/permissions')
  await page.getByRole('button', { name: 'API tokens' }).click()
  await field(page.locator('main'), 'Namespace').selectOption(ns.name)
}

async function grant(role) {
  const { page } = admin
  await admin.goto(`/c/namespace/${ns.name}/permissions`)
  await page.getByRole('button', { name: 'Add permission' }).click()
  const dialog = admin.dialog()
  await field(dialog, 'Role (ClusterRole)').selectOption(role)
  await field(dialog, 'Subject').selectOption('ServiceAccount')
  await field(dialog, 'ServiceAccount name').fill(SA)
  assert.equal(await field(dialog, 'ServiceAccount namespace').inputValue(), ns.name)
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  await waitFor(`the ${role} binding`, async () => (await bindingsFor(role)).length === 1)
}

test('API tokens: create a ServiceAccount', { timeout: 3 * 60_000 }, async () => {
  const { page } = admin
  await openTokensTab(page)
  await field(page.locator('main'), 'New ServiceAccount').fill(SA)
  await page.locator('main').getByRole('button', { name: 'Create', exact: true }).click()
  await waitFor('the ServiceAccount', () => get(gw, { apiVersion: 'v1', resource: 'serviceaccounts', namespace: ns.name, name: SA }))
  await page.locator('main tr', { hasText: SA }).waitFor({ timeout: 30_000 })
})

test('Namespace permissions: grant it kubevirt.io:view', { timeout: 3 * 60_000 }, async () => {
  await grant('kubevirt.io:view')
  await admin.page.locator('main tr', { hasText: 'kubevirt.io:view' }).waitFor({ timeout: 30_000 })
})

test('API tokens: mint a token, shown once in the dialog', { timeout: 3 * 60_000 }, async () => {
  const { page } = admin
  await openTokensTab(page)
  await page.locator('main tr', { hasText: SA }).getByRole('button', { name: 'Create token' }).click()
  const dialog = admin.dialog()
  await dialog.getByRole('button', { name: 'Create token' }).click()
  const box = dialog.locator('textarea[readonly]')
  await box.waitFor({ timeout: 30_000 })
  token = (await box.inputValue()).trim()
  assert.match(token, /^eyJ/, 'a JWT')
  await dialog.getByRole('button', { name: 'Done' }).click()

  const probe = await Gateway.connect(token)
  try {
    assert.equal(probe.user.username, `system:serviceaccount:${ns.name}:${SA}`)
    assert.equal(probe.user.homeNamespace, ns.name)
  } finally {
    probe.close()
  }
})

test('With view only, the token sees the VM but cannot start it', { timeout: 5 * 60_000 }, async () => {
  operator = await openGui()
  await operator.login(token)
  const { page } = operator
  await operator.goto(`/n/vm/${ns.name}/${VM_NAME}/summary`)
  await page.getByText(`Virtual Machine ${VM_NAME}`).first().waitFor({ timeout: 30_000 })

  const start = headerAction(page, 'Start')
  await waitFor('Start to be disabled for lack of permission', async () => (await start.isDisabled()) && (await start.getAttribute('title')) === 'You do not have permission for this', { timeoutMs: 30_000, intervalMs: 500 })
  await page.locator('button[data-split-toggle]').first().click()
  assert.ok(await page.getByRole('button', { name: 'Stop', exact: true }).last().isDisabled(), 'Stop is disabled')
  await closeDialogs(page)

  // The server refuses too — the GUI only reflects what RBAC decides.
  const viewer = await Gateway.connect(token)
  try {
    const { task } = await viewer.call('vm.start', { namespace: ns.name, name: VM_NAME })
    const done = await viewer.waitTask(task, 60_000)
    assert.equal(done.status, 'error')
    assert.match(done.message, /forbidden/i, done.message)
  } finally {
    viewer.close()
  }
  assert.equal(await get(gw, { ...VMI, namespace: ns.name, name: VM_NAME }), null, 'the VM did not start')
})

test('Granted kubevirt.io:admin, the same token can start the VM', { timeout: 10 * 60_000 }, async () => {
  await grant('kubevirt.io:admin')

  const { page } = operator
  // A fresh page: the access answers are cached for a minute.
  await operator.goto(`/n/vm/${ns.name}/${VM_NAME}/summary`)
  const start = headerAction(page, 'Start')
  await waitFor('Start to be enabled', async () => !(await start.isDisabled()), { timeoutMs: 60_000, intervalMs: 1000 })
  await start.click()
  await operator.confirm().catch(() => {})
  const vmi = await waitFor('the VM to run', async () => {
    const v = await get(gw, { ...VMI, namespace: ns.name, name: VM_NAME })
    return v?.status?.phase === 'Running' && v
  }, { timeoutMs: 8 * 60_000 })
  assert.ok(vmi)
  assert.deepEqual(operator.errors, [])
})

test('Removing the admin binding in Namespace permissions takes the right away', { timeout: 4 * 60_000 }, async () => {
  const { page } = admin
  await admin.goto(`/c/namespace/${ns.name}/permissions`)
  const row = page.locator('main tr', { hasText: 'kubevirt.io:admin' }).filter({ hasText: SA })
  await row.getByRole('button', { name: 'Remove' }).click()
  await admin.confirm()
  await waitFor('the admin binding to be gone', async () => (await bindingsFor('kubevirt.io:admin')).length === 0)
  assert.equal((await bindingsFor('kubevirt.io:view')).length, 1, 'the view binding stays')

  const viewer = await Gateway.connect(token)
  try {
    const { task } = await viewer.call('vm.stop', { namespace: ns.name, name: VM_NAME, force: true })
    const done = await viewer.waitTask(task, 60_000)
    assert.equal(done.status, 'error')
    assert.match(done.message, /forbidden/i)
  } finally {
    viewer.close()
  }
  assert.deepEqual(admin.errors, [])
})
