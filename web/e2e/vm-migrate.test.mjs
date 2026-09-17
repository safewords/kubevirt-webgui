// Migrate dialog with a chosen target node, through the browser: the VM moves
// between two nodes with the same host CPU, and lands on the one picked.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { list, testNamespace } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { capture, closeDialogs, waitRunning, waitVmi } from './lib/vm.mjs'

// Opteron_G5 hosts. pve-thin-3 is left alone: the node tests cordon and drain it.
const OPTERON = ['pve-thin-2', 'pve-thin-4']
const NAME = 'mig'

let gw, ns, gui

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'vm')
  await createVm(gw, ns.name, NAME, { start: true })
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

test('migrate to a chosen node', { timeout: 15 * 60_000 }, () => capture(gui, 'migrate-target', async () => {
  let vmi = await waitRunning(gw, ns.name, NAME)
  // Start from one Opteron node, so the other one is a valid target.
  if (!OPTERON.includes(vmi.status.nodeName)) {
    await gw.runTask('vm.migrate', { namespace: ns.name, name: NAME, targetNode: OPTERON[1] }, 10 * 60_000)
    vmi = await waitVmi(gw, ns.name, NAME, (v) => v.status?.nodeName === OPTERON[1], 'the VM on an Opteron node')
  }
  const source = vmi.status.nodeName
  const target = OPTERON.find((n) => n !== source)

  const { page } = gui
  await gui.goto(gui.vmPath(ns.name, NAME))
  await page.getByRole('button', { name: 'Migrate', exact: true }).click()
  const dialog = page.locator('[role=dialog]', { hasText: 'Target node' })
  await dialog.getByText('Westmere').first().waitFor({ timeout: 15_000 })
  const option = dialog.locator('label', { hasText: target }).locator('input[type=radio]')
  assert.ok(await option.isEnabled(), `${target} is offered as a target`)
  await option.check()
  await dialog.locator('footer').getByRole('button', { name: 'Migrate' }).click()

  const viewer = page.locator('[role=dialog]', { hasText: 'Task viewer' })
  await viewer.waitFor({ timeout: 30_000 })
  const moved = await waitVmi(gw, ns.name, NAME, (v) => v.status?.nodeName === target && v.status?.migrationState?.completed, `the VM on ${target}`, 10 * 60_000)
  assert.equal(moved.status.nodeName, target)
  const migrations = await list(gw, { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstancemigrations', namespace: ns.name })
  const last = migrations.sort((a, b) => a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp)).pop()
  assert.deepEqual(last.spec.addedNodeSelector, { 'kubernetes.io/hostname': target })
  await viewer.getByText('migration finished successfully').waitFor({ timeout: 60_000 })
  await closeDialogs(page)
}))
