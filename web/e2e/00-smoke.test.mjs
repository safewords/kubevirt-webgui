// The harness itself: the gateway signs in, the browser signs in and renders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'

test('gateway signs in and reads the cluster', async () => {
  const gw = await Gateway.connect()
  try {
    assert.ok(gw.user.username, 'a user name')
    const discovery = await gw.call('cluster.discovery')
    assert.ok(discovery.kubevirtVersion?.gitVersion, 'KubeVirt is installed')
  } finally {
    gw.close()
  }
})

test('browser signs in and shows the datacenter', { timeout: 120_000 }, async () => {
  const gui = await openGui()
  try {
    await gui.login()
    await gui.goto('/dc/summary')
    await gui.page.getByText('Health').first().waitFor({ timeout: 20_000 })
    assert.deepEqual(gui.errors, [])
  } finally {
    await gui.close()
  }
})
