// Node maintenance from the GUI: cordon, uncordon, and drain by live-migrating
// guests away. Uses E2E_NODE (default pve-thin-3), refuses a node that already
// runs other VMs, never evicts pods, and always leaves the node schedulable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { createVm } from './lib/fixtures.mjs'
import { VMI, get, list, testNamespace, waitFor } from './lib/k8s.mjs'

const NODE = process.env.E2E_NODE ?? 'pve-thin-3'
const NODES = { apiVersion: 'v1', resource: 'nodes' }

test(`cordon, uncordon and drain ${NODE} from the GUI`, { timeout: 30 * 60_000 }, async (t) => {
  const gw = await Gateway.connect()
  const node = await get(gw, { ...NODES, name: NODE })
  assert.ok(node, `node ${NODE} exists`)
  assert.equal(node.spec?.unschedulable ?? false, false, `${NODE} starts schedulable`)
  assert.equal(node.metadata.labels?.['kubevirt.io/schedulable'], 'true', `${NODE} can run VMs`)
  const others = (await list(gw, VMI)).filter((v) => v.status?.nodeName === NODE)
  if (others.length) {
    t.skip(`${NODE} already runs ${others.length} VM(s); not draining someone else's guests`)
    gw.close()
    return
  }

  const ns = await testNamespace(gw, 'node')
  const gui = await openGui()
  const unschedulable = async () => (await get(gw, { ...NODES, name: NODE }))?.spec?.unschedulable === true
  const vmi = () => get(gw, { ...VMI, namespace: ns.name, name: 'drain-me' })

  try {
    await createVm(gw, ns.name, 'drain-me', { start: true })
    if ((await vmi()).status.nodeName !== NODE) {
      await gw.runTask('vm.migrate', { namespace: ns.name, name: 'drain-me', targetNode: NODE }, 10 * 60_000)
    }
    assert.equal((await vmi()).status.nodeName, NODE, 'the test VM runs on the node')

    await gui.login()
    await gui.goto(`/c/node/${NODE}/summary`)

    await t.test('Cordon', async () => {
      await gui.page.getByRole('button', { name: 'Cordon', exact: true }).first().click()
      await gui.confirm()
      await waitFor(`${NODE} to be unschedulable`, unschedulable, { timeoutMs: 60_000 })
      assert.equal((await vmi()).status.nodeName, NODE, 'cordoning moves nothing')
    })

    await t.test('Uncordon', async () => {
      await gui.page.getByRole('button', { name: 'Uncordon', exact: true }).first().click()
      await waitFor(`${NODE} to be schedulable`, async () => !(await unschedulable()), { timeoutMs: 60_000 })
    })

    await t.test('Drain migrates the guest away and leaves the node cordoned', async () => {
      await gui.menu('power', 'Drain')
      const dialog = gui.dialog()
      await dialog.waitFor()
      assert.equal(await dialog.locator('input[type=checkbox]').first().isChecked(), false, 'pod eviction is off by default')
      await gui.confirm()
      const moved = await waitFor('the guest to leave the node', async () => {
        const current = await vmi()
        return current?.status?.phase === 'Running' && current.status.nodeName !== NODE ? current : null
      }, { timeoutMs: 10 * 60_000, intervalMs: 3000 })
      assert.notEqual(moved.status.nodeName, NODE)
      assert.ok(await unschedulable(), 'the node stays cordoned for maintenance')
      await gui.page.getByText(`Drain ${NODE}`).first().waitFor({ timeout: 30_000 })
    })

    await t.test('Uncordon after maintenance', async () => {
      await gui.page.keyboard.press('Escape')
      await gui.goto(`/c/node/${NODE}/summary`)
      await gui.page.getByRole('button', { name: 'Uncordon', exact: true }).first().click()
      await waitFor(`${NODE} to be schedulable again`, async () => !(await unschedulable()), { timeoutMs: 60_000 })
    })

    await gui.shot('node-maintenance-done')
    assert.deepEqual(gui.errors, [])
  } finally {
    // Whatever happened, the node goes back into service.
    if (await unschedulable().catch(() => false)) {
      await gw.call('resource.patch', { ...NODES, name: NODE, patch: { spec: { unschedulable: false } } }).catch((e) => console.error('could not uncordon', NODE, e.message))
    }
    await gui.close()
    await ns.cleanup()
    gw.close()
  }
})
