// Uploading a disk image from the browser through the in-cluster server, and
// booting a VM from it to prove the bytes arrived intact.
//
// Run against the deployed GUI (the default E2E_BASE, Vite → the in-cluster
// server): the in-cluster server reaches CDI's upload proxy directly.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { artifacts, wsBase } from './lib/env.mjs'
import { testNamespace, get, waitFor, DV, PVC, VMI } from './lib/k8s.mjs'
import { vmManifest } from './lib/fixtures.mjs'
import { avoidBadNodes } from './lib/placement.mjs'

const IMAGE_URL = 'https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img'
const IMAGE = join(artifacts, 'cirros-0.6.2-x86_64-disk.img')
const DISK = 'cirros-upload'
const VM_NAME = 'from-upload'
const CONTEXT = process.env.E2E_KUBE_CONTEXT ?? 'safewords'

let gw, ns, gui, startedAt

before(async () => {
  if (!existsSync(IMAGE)) {
    mkdirSync(artifacts, { recursive: true })
    const response = await fetch(IMAGE_URL)
    assert.ok(response.ok, `download ${IMAGE_URL}: ${response.status}`)
    writeFileSync(IMAGE, Buffer.from(await response.arrayBuffer()))
  }
  startedAt = new Date(Date.now() - 5_000).toISOString()
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'upload')
  gui = await openGui()
  await gui.login()
})

after(async () => {
  await gui?.close()
  await ns?.cleanup()
  gw?.close()
})

test('Images → Upload streams the file into a DataVolume', { timeout: 15 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto('/dc/images')
  await page.locator('#kve-image-ns').fill(ns.name)
  await page.getByRole('button', { name: 'Upload', exact: true }).click()
  const dialog = gui.dialog()
  await dialog.locator('input[type=file]').setInputFiles(IMAGE)
  await dialog.getByLabel('Disk image (template to clone)').check()
  const name = dialog.locator('label', { hasText: /^\s*Name\s*\*?\s*$/ }).locator('xpath=..').locator('input')
  await name.fill(DISK)
  await dialog.getByRole('button', { name: 'Upload', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  // Progress in the panel, then done.
  const job = page.locator('div', { hasText: `→ ${ns.name}/${DISK}` }).last()
  await job.waitFor({ timeout: 60_000 })
  await waitFor('the upload job to finish', async () => /Done/.test(await page.locator('section.card', { hasText: 'Uploads from this browser' }).innerText()), { timeoutMs: 12 * 60_000, intervalMs: 3000 })

  const dv = await get(gw, { ...DV, namespace: ns.name, name: DISK })
  assert.equal(dv.status.phase, 'Succeeded')
  assert.equal(dv.metadata.labels['kubevirt-webgui/image-type'], 'disk')
  assert.ok(dv.spec.source.upload, 'an upload source')
  const pvc = await get(gw, { ...PVC, namespace: ns.name, name: DISK })
  assert.equal(pvc.status.phase, 'Bound')
  assert.equal(pvc.spec.volumeMode, 'Block', 'the storage profile default')
  await page.locator('main tr', { hasText: DISK }).getByText('Succeeded').first().waitFor({ timeout: 30_000 })
})

test('The bytes went from the in-cluster server straight to CDI', { timeout: 60_000 }, async () => {
  const logs = execFileSync('kubectl', ['--context', CONTEXT, '-n', 'kubevirt-webgui', 'logs', 'deploy/kubevirt-webgui', `--since-time=${startedAt}`], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  const opened = logs.split('\n').filter((l) => l.includes('upload opened') && l.includes(DISK))
  assert.ok(opened.length, 'the deployed server handled this upload')
  const routes = logs.split('\n').filter((l) => l.includes('upload proxy connected')).map((l) => JSON.parse(l).route)
  assert.ok(routes.some((r) => /^directly at cdi-uploadproxy\.cdi\.svc:443$/.test(r)), `routes: ${routes.join(', ')}`)
  assert.ok(statSync(IMAGE).size > 10 * 1024 * 1024)
})

test('A VM cloned from the uploaded disk boots', { timeout: 12 * 60_000 }, async () => {
  const vm = avoidBadNodes(vmManifest(ns.name, VM_NAME, {
    // A NoCloud data source, so CirrOS stops hunting for a metadata server
    // and reaches its login prompt quickly.
    cloudInit: '#cloud-config\n',
    dataVolumeTemplates: [
      { metadata: { name: `${VM_NAME}-root` }, spec: { source: { pvc: { namespace: ns.name, name: DISK } }, storage: { resources: { requests: { storage: '1Gi' } } } } },
    ],
  }))
  vm.spec.template.spec.volumes = vm.spec.template.spec.volumes.map((v) => (v.name === 'root' ? { name: 'root', dataVolume: { name: `${VM_NAME}-root` } } : v))
  await gw.runTask('vm.create', { vm, start: false }, 10 * 60_000)
  await gw.runTask('vm.start', { namespace: ns.name, name: VM_NAME }, 8 * 60_000)
  assert.equal((await get(gw, { ...VMI, namespace: ns.name, name: VM_NAME })).status.phase, 'Running')

  // CirrOS prints its login prompt on the serial console once booted from the disk.
  const { path } = await gw.call('console.ticket', { namespace: ns.name, name: VM_NAME, kind: 'serial' })
  const output = await new Promise((resolve) => {
    const socket = new WebSocket(`${wsBase}${path}`)
    socket.binaryType = 'arraybuffer'
    let text = ''
    const done = () => {
      clearInterval(nudge)
      socket.close()
      resolve(text)
    }
    const nudge = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(new TextEncoder().encode('\n')), 5000)
    socket.onmessage = (event) => {
      text += new TextDecoder().decode(event.data)
      if (/login:/i.test(text)) done()
    }
    socket.onclose = () => resolve(text)
    setTimeout(done, 5 * 60_000)
  })
  assert.match(output, /login:/i, `serial console: ${output.slice(-500)}`)
})
