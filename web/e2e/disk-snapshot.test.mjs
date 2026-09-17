// Disk → Snapshots: take a CSI VolumeSnapshot, change the disk, restore the
// snapshot into a new disk, and prove the data in each. Skips on clusters
// without snapshot.storage.k8s.io.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { get, testNamespace, waitFor } from './lib/k8s.mjs'
import { blockClaim, readMarker, writeMarker } from './lib/blockpod.mjs'
import { capture, closeDialogs } from './lib/vm.mjs'

const SNAPSHOTS = { apiVersion: 'snapshot.storage.k8s.io/v1', resource: 'volumesnapshots' }
let gw, ns, gui, supported

before(async () => {
  gw = await Gateway.connect()
  const discovery = await gw.call('cluster.discovery')
  supported = (discovery.resources['snapshot.storage.k8s.io/v1'] ?? []).some((r) => r.name === 'volumesnapshots')
  if (!supported) return
  ns = await testNamespace(gw, 'disksnap')
  gui = await openGui()
  await gui.login()
})

after(async () => {
  await gui?.close()
  await ns?.cleanup()
  gw?.close()
})

test('snapshot a disk, change it, restore the snapshot to a new disk', { timeout: 20 * 60_000 }, async (t) => {
  if (!supported) {
    t.skip('the cluster does not serve snapshot.storage.k8s.io')
    return
  }
  await capture(gui, 'disk-snapshot', async () => {
    const { page } = gui
    const claim = 'snapdisk'
    await blockClaim(gw, ns.name, claim)
    assert.match(await writeMarker(gw, ns.name, 'write-before', claim, 'DISK-BEFORE'), /written/)

    // Take the snapshot from the disk's Snapshots panel.
    await gui.goto(`/n/disk/${ns.name}/${claim}/snapshots`)
    const nameInput = page.locator('label', { hasText: 'Snapshot name' }).locator('xpath=following-sibling::input[1]')
    await nameInput.fill('before-change')
    await page.getByRole('button', { name: 'Take snapshot' }).first().click()
    await gui.confirm()
    const snapshot = await waitFor('the VolumeSnapshot to be ready', async () => {
      const s = await get(gw, { ...SNAPSHOTS, namespace: ns.name, name: 'before-change' })
      if (s?.status?.error) throw new Error(s.status.error.message)
      return s?.status?.readyToUse ? s : null
    }, { timeoutMs: 5 * 60_000, intervalMs: 3000 })
    assert.equal(snapshot.spec.volumeSnapshotClassName, 'ceph-rbd', 'the default class was used')
    await page.locator('tr', { hasText: 'before-change' }).getByText('yes', { exact: true }).waitFor({ timeout: 60_000 })

    assert.match(await writeMarker(gw, ns.name, 'write-after', claim, 'DISK-AFTER!'), /written/)

    // Restore into a new disk, through CDI.
    await page.locator('tr', { hasText: 'before-change' }).getByRole('button', { name: 'Restore to new disk' }).click()
    await gui.confirm()
    const target = `${claim}-from-before-change`
    await waitFor('the restored DataVolume to succeed', async () => {
      const dv = await get(gw, { apiVersion: 'cdi.kubevirt.io/v1beta1', resource: 'datavolumes', namespace: ns.name, name: target })
      if (dv?.status?.phase === 'Failed') throw new Error(`restore failed: ${JSON.stringify(dv.status.conditions)}`)
      return dv?.status?.phase === 'Succeeded'
    }, { timeoutMs: 10 * 60_000, intervalMs: 5000 })
    await closeDialogs(page)

    assert.equal(await readMarker(gw, ns.name, 'read-restored', target, 11), 'DISK-BEFORE', 'the restored disk holds the data from before the change')
    assert.equal(await readMarker(gw, ns.name, 'read-original', claim, 11), 'DISK-AFTER!', 'the original disk is untouched')

    // Delete the snapshot.
    await gui.goto(`/n/disk/${ns.name}/${claim}/snapshots`)
    await page.locator('tr', { hasText: 'before-change' }).locator('button.btn-danger').click()
    await gui.confirm()
    await waitFor('the snapshot to be deleted', async () => (await get(gw, { ...SNAPSHOTS, namespace: ns.name, name: 'before-change' })) === null, { timeoutMs: 2 * 60_000 })
  })
})
