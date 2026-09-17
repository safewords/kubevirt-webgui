// Migrate dialog with a chosen target node, through the browser: the VM moves
// between two nodes with the same host CPU, and lands on the one picked. And a
// migration of a VM with gigabytes in use reports its transfer live — in the
// task and on the VM's Migrations tab.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { get, list, testNamespace, waitFor } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { capture, cirrosRun, closeDialogs, waitRunning, waitVmi } from './lib/vm.mjs'

// Opteron_G5 hosts. pve-thin-3 is left alone: the node tests cordon and drain it.
const OPTERON = ['pve-thin-2', 'pve-thin-4']
const NAME = 'mig'
const SLOW = 'busy-mig'

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

test('a migration of a VM with gigabytes of memory in use reports live progress, in the task and on the Migrations tab', { timeout: 25 * 60_000 }, () => capture(gui, 'migrate-progress', async () => {
  // virt-handler samples a migration every five seconds, so it has to last
  // longer than that: 3 GiB of random data in guest memory is half a minute
  // on a 1 GbE migration network. (A bandwidth policy is no help here — this
  // cluster's migrations ignore it.)
  await createVm(gw, ns.name, SLOW, { start: true, memory: '4Gi' })
  let vmi = await waitRunning(gw, ns.name, SLOW)
  if (!OPTERON.includes(vmi.status.nodeName)) {
    await gw.runTask('vm.migrate', { namespace: ns.name, name: SLOW, targetNode: OPTERON[0] }, 15 * 60_000)
    vmi = await waitVmi(gw, ns.name, SLOW, (v) => v.status?.nodeName === OPTERON[0] && v.status?.migrationState?.completed, 'the VM on an Opteron node')
  }
  const target = OPTERON.find((n) => n !== vmi.status.nodeName)
  // Detached from the console session, which would otherwise take it down on logout.
  const started = await cirrosRun(gw, ns.name, SLOW, "sudo sh -c 'mount -t tmpfs -o size=3300m none /mnt && setsid nohup dd if=/dev/urandom of=/mnt/fill bs=1M count=3000 >/dev/null 2>&1 < /dev/null &' && echo FILLING", { timeoutMs: 6 * 60_000 })
  assert.match(started, /FILLING/, started)
  await waitFor('3 GiB of guest memory filled', async () => {
    const size = await cirrosRun(gw, ns.name, SLOW, "stat -c 'SIZE=%s' /mnt/fill", { timeoutMs: 3 * 60_000 })
    return Number(size.match(/SIZE=(\d+)/)?.[1] ?? 0) >= 3000 * 1024 * 1024
  }, { timeoutMs: 10 * 60_000, intervalMs: 15_000 })

  const { page } = gui
  await gui.goto(gui.vmPath(ns.name, SLOW, 'migrations'))
  const { task } = await gw.call('vm.migrate', { namespace: ns.name, name: SLOW, targetNode: target })

  // The tab shows a live bar with a percentage once virt-handler has a sample.
  const live = page.locator('[data-migration-progress]')
  await live.waitFor({ timeout: 3 * 60_000 })
  await live.getByText(/\d+%/).first().waitFor({ timeout: 2 * 60_000 })
  const shown = await live.innerText()
  console.log(`# Migrations tab: ${shown.replace(/\s+/g, ' ')}`)
  assert.match(shown, /Remaining/)

  const done = await gw.waitTask(task, 15 * 60_000)
  assert.equal(done.status, 'ok', done.log.join('\n'))
  const reports = gw.taskProgress.get(task) ?? []
  console.log(`# ${reports.length} progress report(s); last: ${JSON.stringify(reports.at(-1))}`)
  console.log(`# ${done.log.filter((l) => /transfer/.test(l)).join(' | ')}`)
  assert.ok(reports.length >= 2, 'the task reported progress more than once')
  assert.ok(reports.every((r) => r.unit === 'bytes' && r.total > 0 && r.done <= r.total), 'reports are byte counts within the total')
  assert.ok(reports.some((r) => r.done > 0), 'some memory was reported as sent')
  assert.ok(done.log.some((l) => l.startsWith('transferring guest data')), 'the log names the amount to transfer')
  assert.equal((await get(gw, { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances', namespace: ns.name, name: SLOW })).status.nodeName, target)
}))
