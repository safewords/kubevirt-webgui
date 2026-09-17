// Every power action, clicked in the GUI, and proven on the VM itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { FEDORA, createVm } from './lib/fixtures.mjs'
import { VM, VMI, get, testNamespace, waitFor } from './lib/k8s.mjs'
import { watchForBoot } from './lib/console.mjs'

const GRACE_SECONDS = 180

const condition = (object, type) => object?.status?.conditions?.find((c) => c.type === type)?.status

test('power actions from the GUI', { timeout: 40 * 60_000 }, async (t) => {
  const gw = await Gateway.connect()
  const ns = await testNamespace(gw, 'power')
  const name = 'power'
  const gui = await openGui()
  const vmi = () => get(gw, { ...VMI, namespace: ns.name, name })
  const vm = () => get(gw, { ...VM, namespace: ns.name, name })

  try {
    await createVm(gw, ns.name, name, { image: FEDORA, memory: '1Gi' })
    // A long grace period, so a shutdown that finishes quickly was graceful.
    await gw.call('resource.patch', { ...VM, namespace: ns.name, name, patch: { spec: { template: { spec: { terminationGracePeriodSeconds: GRACE_SECONDS } } } } })
    await gui.login()
    await gui.goto(gui.vmPath(ns.name, name))

    await t.test('Start', async () => {
      await gui.page.getByRole('button', { name: 'Start', exact: true }).click()
      const running = await waitFor('the VMI to run', async () => ((await vmi())?.status?.phase === 'Running' ? vmi() : null), { timeoutMs: 10 * 60_000 })
      assert.equal(running.status.phase, 'Running')
      await waitFor('the guest agent to connect', async () => condition(await vmi(), 'AgentConnected') === 'True', { timeoutMs: 10 * 60_000, intervalMs: 5000 })
    })

    await t.test('Reboot (soft, through the guest)', async () => {
      const before = (await vmi()).metadata.uid
      const boot = watchForBoot(gw, ns.name, name)
      await new Promise((r) => setTimeout(r, 1500))
      await gui.menu('power', 'Reboot')
      await gui.confirm()
      await boot
      assert.equal((await vmi()).metadata.uid, before, 'a soft reboot keeps the same instance')
      await waitFor('the guest agent to reconnect', async () => condition(await vmi(), 'AgentConnected') === 'True', { timeoutMs: 5 * 60_000, intervalMs: 5000 })
    })

    await t.test('Reset (hard)', async () => {
      const before = (await vmi()).metadata.uid
      const boot = watchForBoot(gw, ns.name, name)
      await new Promise((r) => setTimeout(r, 1500))
      await gui.menu('power', 'Reset')
      await gui.confirm()
      await boot
      assert.equal((await vmi()).metadata.uid, before, 'a reset keeps the same instance')
    })

    await t.test('Pause and Resume', async () => {
      await gui.menu('power', 'Pause')
      await waitFor('the VMI to be paused', async () => condition(await vmi(), 'Paused') === 'True', { timeoutMs: 60_000 })
      await gui.menu('power', 'Resume')
      await waitFor('the VMI to resume', async () => condition(await vmi(), 'Paused') !== 'True', { timeoutMs: 60_000 })
    })

    await t.test('Restart (new instance)', async () => {
      const before = (await vmi()).metadata.uid
      await gui.menu('power', 'Restart')
      await gui.confirm()
      const after = await waitFor('a new running instance', async () => {
        const current = await vmi()
        return current && current.metadata.uid !== before && current.status?.phase === 'Running' ? current : null
      }, { timeoutMs: 15 * 60_000, intervalMs: 3000 })
      assert.notEqual(after.metadata.uid, before)
      await waitFor('the guest agent to connect after restart', async () => condition(await vmi(), 'AgentConnected') === 'True', { timeoutMs: 10 * 60_000, intervalMs: 5000 })
    })

    await t.test('Shutdown (graceful)', async () => {
      const started = Date.now()
      // The split button's main half is Shutdown.
      await gui.page.getByRole('button', { name: 'Shutdown', exact: true }).first().click()
      await gui.confirm()
      await waitFor('the VMI to go away', async () => (await vmi()) === null, { timeoutMs: (GRACE_SECONDS + 120) * 1000 })
      const seconds = (Date.now() - started) / 1000
      assert.ok(seconds < GRACE_SECONDS - 30, `shut down in ${seconds.toFixed(0)}s — well inside the ${GRACE_SECONDS}s grace period, so the guest powered off by itself`)
      await waitFor('the VM to report Stopped', async () => (await vm())?.status?.printableStatus === 'Stopped', { timeoutMs: 60_000 })
    })

    await t.test('Stop (force)', async () => {
      await gui.page.getByRole('button', { name: 'Start', exact: true }).click()
      await waitFor('the VMI to run again', async () => (await vmi())?.status?.phase === 'Running', { timeoutMs: 10 * 60_000 })
      const started = Date.now()
      await gui.menu('power', 'Stop')
      await gui.confirm()
      await waitFor('the VMI to be killed', async () => (await vmi()) === null, { timeoutMs: 120_000 })
      assert.ok((Date.now() - started) / 1000 < 60, 'a forced stop does not wait for the guest')
    })

    await gui.shot('vm-power-done')
    assert.deepEqual(gui.errors, [])
  } finally {
    await gui.close()
    await ns.cleanup()
    gw.close()
  }
})
