// Clone and snapshots, through the browser: a clone that starts, a snapshot
// that rolls a change back, and a clear explanation when a VM's disks cannot be
// snapshotted (this cluster serves no snapshot.storage.k8s.io).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { VM, get, list, testNamespace, waitFor } from './lib/k8s.mjs'
import { createVm } from './lib/fixtures.mjs'
import { capture, closeDialogs, field, vmSpec, waitRunning } from './lib/vm.mjs'
import { ensureFeatureGates } from './lib/gates.mjs'
import { blockPod as blockPodIn } from './lib/blockpod.mjs'

let gw, ns, gui, snapshotApi, restoreGates, csiSnapshots

before(async () => {
  gw = await Gateway.connect()
  // Snapshots and clones need KubeVirt's Snapshot gate: on for this run, restored afterwards.
  restoreGates = await ensureFeatureGates(gw, ['Snapshot'])
  ns = await testNamespace(gw, 'vm')
  const discovery = await gw.call('cluster.discovery')
  const group = discovery.groups.find((g) => g.name === 'snapshot.kubevirt.io')
  snapshotApi = `snapshot.kubevirt.io/${group.preferredVersion}`
  csiSnapshots = (discovery.resources['snapshot.storage.k8s.io/v1'] ?? []).some((r) => r.name === 'volumesnapshots')
  gui = await openGui()
  await gui.login()
})

after(async () => {
  if (gui) {
    if (gui.errors.length) console.log('browser errors:', gui.errors)
    await gui.close()
  }
  await ns?.cleanup()
  await restoreGates?.()
  gw?.close()
})

/** The id of the task whose viewer the GUI just opened (from its Status tab). */
async function openedTask(page) {
  const viewer = page.locator('[role=dialog]', { hasText: 'Task viewer' })
  await viewer.waitFor({ timeout: 30_000 })
  await viewer.getByRole('button', { name: 'Status', exact: true }).click()
  const id = viewer.locator('dt', { hasText: 'Unique task ID' }).locator('xpath=following-sibling::dd[1]')
  return (await id.innerText()).trim()
}

async function more(item) {
  const { page } = gui
  // By visible text: the Shutdown split button's arrow is also labelled "More".
  await page.locator('main button, section button').filter({ hasText: /^\s*More\s*$/ }).first().click()
  await page.locator('.card button', { hasText: item }).first().click()
}

test('clone a stopped VM; the clone starts', { timeout: 15 * 60_000 }, () => capture(gui, 'clone', async () => {
  const { page } = gui
  await createVm(gw, ns.name, 'src', { labels: { 'tags.kubevirt-webgui/e2e-clone': '' } })
  await gui.goto(gui.vmPath(ns.name, 'src'))
  await more('Clone')
  const dialog = page.locator('[role=dialog]', { hasText: 'Clone VM' })
  await field(dialog, 'Name of the new VM').fill('src-copy')
  await dialog.getByRole('button', { name: 'Clone', exact: true }).click()
  const task = await gw.waitTask(await openedTask(page), 10 * 60_000)
  assert.equal(task.status, 'ok', task.log.join('\n'))
  await closeDialogs(page)

  const copy = await waitFor('the clone', () => get(gw, { ...VM, namespace: ns.name, name: 'src-copy' }))
  assert.equal(copy.spec.template.spec.volumes.find((v) => v.name === 'root').containerDisk.image, (await vmSpec(gw, ns.name, 'src')).volumes.find((v) => v.name === 'root').containerDisk.image)
  assert.ok('tags.kubevirt-webgui/e2e-clone' in (copy.metadata.labels ?? {}), 'labels were copied')
  await gw.runTask('vm.start', { namespace: ns.name, name: 'src-copy' }, 10 * 60_000)
  await waitRunning(gw, ns.name, 'src-copy')
}))

test('snapshot, change, roll back', { timeout: 15 * 60_000 }, () => capture(gui, 'snapshot-rollback', async () => {
  const { page } = gui
  await createVm(gw, ns.name, 'snap')
  await gui.goto(gui.vmPath(ns.name, 'snap', 'snapshots'))
  await page.getByRole('button', { name: 'Take snapshot' }).first().click()
  let dialog = page.locator('[role=dialog]', { hasText: 'Take snapshot' })
  await field(dialog, 'Name').fill('snap-before')
  await field(dialog, 'Description').fill('before the memory change')
  await dialog.locator('footer').getByRole('button', { name: 'Take snapshot' }).click()
  const taken = await gw.waitTask(await openedTask(page), 10 * 60_000)
  assert.equal(taken.status, 'ok', taken.log.join('\n'))
  await closeDialogs(page)

  // Change the VM after the snapshot.
  const vm = await get(gw, { ...VM, namespace: ns.name, name: 'snap' })
  await gw.call('resource.patch', { ...VM, namespace: ns.name, name: 'snap', patch: { spec: { template: { spec: { domain: { memory: { guest: '300Mi' } } } } } }, patchType: 'merge' })
  assert.equal((await vmSpec(gw, ns.name, 'snap')).domain.memory.guest, '300Mi')
  assert.ok(vm)

  await gui.goto(gui.vmPath(ns.name, 'snap', 'snapshots'))
  const snapshotRow = page.locator('main tr', { hasText: 'snap-before' })
  await snapshotRow.getByText('ready').waitFor({ timeout: 60_000 })
  await snapshotRow.click()
  await page.getByRole('button', { name: 'Rollback' }).click()
  dialog = page.locator('[role=dialog]', { hasText: 'Roll snap back' })
  await dialog.locator('footer button').last().click()
  const restored = await gw.waitTask(await openedTask(page), 10 * 60_000)
  assert.equal(restored.status, 'ok', restored.log.join('\n'))
  await waitFor('memory back to 256Mi', async () => (await vmSpec(gw, ns.name, 'snap'))?.domain?.memory?.guest === '256Mi')
  await closeDialogs(page)
  await gui.goto(gui.vmPath(ns.name, 'snap', 'snapshots'))
  await page.getByText('Rollback history').waitFor({ timeout: 30_000 })
}))

/** A one-shot pod against a Block claim in this suite's namespace (lib/blockpod.mjs). */
const blockPod = (name, claim, script) => blockPodIn(gw, ns.name, name, claim, script)

test('a VM with a PVC disk: a snapshot captures it and rollback restores its data', { timeout: 20 * 60_000 }, async (t) => {
  if (!csiSnapshots) {
    t.skip('the cluster does not serve snapshot.storage.k8s.io')
    return
  }
  await capture(gui, 'snapshot-pvc-data', async () => {
    const { page } = gui
    const name = 'snap-data'
    const claim = `${name}-disk`
    // A plain Block claim, so the data can be written and read without a guest.
    await gw.call('resource.create', {
      apiVersion: 'v1',
      resource: 'persistentvolumeclaims',
      namespace: ns.name,
      body: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: claim }, spec: { storageClassName: 'ceph-rbd', volumeMode: 'Block', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
    })
    assert.match(await blockPod('write-before', claim, 'echo DATA-BEFORE-SNAPSHOT | dd of=/dev/blk bs=64 count=1 conv=notrunc 2>/dev/null && echo written'), /written/)

    await createVm(gw, ns.name, name, {
      extraDisks: [{ name: 'data', disk: { bus: 'virtio' } }],
      extraVolumes: [{ name: 'data', persistentVolumeClaim: { claimName: claim } }],
    })
    await waitFor('KubeVirt to judge the disk snapshottable', async () => {
      const v = await get(gw, { ...VM, namespace: ns.name, name })
      return (v?.status?.volumeSnapshotStatuses ?? []).some((s) => s.name === 'data' && s.enabled)
    })

    // Take the snapshot in the GUI; the dialog says the disk will be captured.
    await gui.goto(gui.vmPath(ns.name, name, 'snapshots'))
    assert.equal(await page.getByText('Disk snapshots are unavailable').count(), 0, 'no "unavailable" warning when CSI snapshots exist')
    await page.getByRole('button', { name: 'Take snapshot' }).first().click()
    let dialog = page.locator('[role=dialog]', { hasText: 'Take snapshot' })
    await dialog.getByText('Disks captured').waitFor({ timeout: 10_000 })
    assert.match(await dialog.innerText(), /data/)
    await field(dialog, 'Name').fill('with-data')
    await dialog.locator('footer').getByRole('button', { name: 'Take snapshot' }).click()
    const taken = await gw.waitTask(await openedTask(page), 10 * 60_000)
    assert.equal(taken.status, 'ok', taken.log.join('\n'))
    await closeDialogs(page)
    const snapshot = await get(gw, { apiVersion: snapshotApi, resource: 'virtualmachinesnapshots', namespace: ns.name, name: 'with-data' })
    assert.ok((snapshot.status?.snapshotVolumes?.includedVolumes ?? []).includes('data'), `the disk is in the snapshot: ${JSON.stringify(snapshot.status?.snapshotVolumes)}`)

    // Change the disk after the snapshot.
    assert.match(await blockPod('write-after', claim, 'echo DATA-AFTER-SNAPSHOT-XX | dd of=/dev/blk bs=64 count=1 conv=notrunc 2>/dev/null && echo written'), /written/)

    // Roll back in the GUI.
    await gui.goto(gui.vmPath(ns.name, name, 'snapshots'))
    const snapshotRow = page.locator('main tr', { hasText: 'with-data' })
    await snapshotRow.getByText('ready').waitFor({ timeout: 60_000 })
    await snapshotRow.click()
    await page.getByRole('button', { name: 'Rollback' }).click()
    dialog = page.locator('[role=dialog]', { hasText: 'Roll' })
    await dialog.locator('footer button').last().click()
    const restored = await gw.waitTask(await openedTask(page), 10 * 60_000)
    assert.equal(restored.status, 'ok', restored.log.join('\n'))
    await closeDialogs(page)

    // The VM now points at the restored claim, which holds the data from before.
    const volume = (await vmSpec(gw, ns.name, name)).volumes.find((v) => v.name === 'data')
    const restoredClaim = volume.persistentVolumeClaim?.claimName ?? volume.dataVolume?.name
    assert.ok(restoredClaim, JSON.stringify(volume))
    const content = await blockPod('read-restored', restoredClaim, 'dd if=/dev/blk bs=64 count=1 2>/dev/null | head -c 22; echo')
    assert.match(content, /DATA-BEFORE-SNAPSHOT/, `restored disk content: ${content}`)
  })
})

test('without CSI snapshots: the GUI explains why a PVC disk cannot be snapshotted', { timeout: 10 * 60_000 }, async (t) => {
  if (csiSnapshots) {
    t.skip('the cluster serves snapshot.storage.k8s.io; the data test above covers disks')
    return
  }
  await capture(gui, 'snapshot-pvc', async () => {
  const { page } = gui
  const name = 'snap-pvc'
  // A plain claim, so no CDI importer is involved.
  await gw.call('resource.create', {
    apiVersion: 'v1',
    resource: 'persistentvolumeclaims',
    namespace: ns.name,
    body: { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `${name}-data` }, spec: { storageClassName: 'ceph-rbd', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
  })
  await createVm(gw, ns.name, name, {
    extraDisks: [{ name: 'data', disk: { bus: 'virtio' } }],
    extraVolumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }],
  })
  // Wait until KubeVirt has judged the volumes, so the dialog can show it.
  await waitFor('volume snapshot statuses', async () => {
    const v = await get(gw, { ...VM, namespace: ns.name, name })
    return (v?.status?.volumeSnapshotStatuses ?? []).some((s) => s.name === 'data')
  })

  await gui.goto(gui.vmPath(ns.name, name, 'snapshots'))
  await page.getByText('Disk snapshots are unavailable').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Take snapshot' }).first().click()
  const dialog = page.locator('[role=dialog]', { hasText: 'Take snapshot' })
  await dialog.getByText('No CSI snapshot support').waitFor({ timeout: 10_000 })
  const excluded = dialog.locator('text=data').first()
  await excluded.waitFor({ timeout: 10_000 })
  await field(dialog, 'Name').fill('snap-pvc-1')
  await dialog.locator('footer').getByRole('button', { name: 'Take snapshot' }).click()

  const id = await openedTask(page)
  const started = Date.now()
  const task = await gw.waitTask(id, 5 * 60_000)
  // It must end quickly, and say why — not sit in a progress state for an hour.
  assert.ok(Date.now() - started < 4 * 60_000, 'the task ends within minutes')
  const text = `${task.message}\n${task.log.join('\n')}`
  assert.match(text, /data/, 'names the disk')
  assert.match(text, /snapshot/i)
  if (task.status === 'ok') {
    // KubeVirt may take a definition-only snapshot; then the log must say the disk was left out.
    assert.match(text, /not included|excluded|without/i, text)
  } else {
    assert.match(text, /VolumeSnapshotClass|snapshot\.storage\.k8s\.io|cannot be snapshotted|not supported/i, text)
  }
  const snapshots = await list(gw, { apiVersion: snapshotApi, resource: 'virtualmachinesnapshots', namespace: ns.name })
  assert.ok(snapshots.some((s) => s.metadata.name === 'snap-pvc-1'))
  await closeDialogs(page)
  })
})
