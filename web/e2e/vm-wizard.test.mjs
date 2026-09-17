// Create VM wizard, through the browser, clicking Finish: a container disk, a
// disk image imported from a URL, and an install from an ISO in the image
// library (downloaded through Images → Download from URL first).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { DV, VM, get, list, testNamespace, waitFor } from './lib/k8s.mjs'
import { capture, closeDialogs, field, serialConsole, waitDataVolume, waitRunning } from './lib/vm.mjs'
import { createMenu } from './lib/forms.mjs'

const CIRROS_QCOW2 = 'https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img'
const ALPINE_ISO = 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso'

let gw, ns, gui

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'vm')
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

/** The wizard dialog, opened from the header. */
async function openWizard() {
  const { page } = gui
  await closeDialogs(page)
  await createMenu(page, 'Create VM')
  const dialog = page.locator('[role=dialog]', { hasText: 'Create: Virtual Machine' })
  await dialog.waitFor({ timeout: 15_000 })
  return dialog
}

async function step(dialog, title) {
  await dialog.locator('nav button', { hasText: title }).click()
}

/** General → name and namespace; CPU → a model every node runs; Memory → small. */
async function common(dialog, name, { memoryMib = 256 } = {}) {
  await field(dialog, 'Namespace').fill(ns.name)
  await field(dialog, 'Name').fill(name)
  await step(dialog, 'CPU')
  await field(dialog, 'Cores').fill('1')
  await field(dialog, 'Type').fill('Westmere')
  await step(dialog, 'Memory')
  await field(dialog, 'Memory (MiB)').fill(String(memoryMib))
}

async function finish(dialog) {
  await step(dialog, 'Confirm')
  const notice = dialog.getByText('Some steps need attention')
  assert.equal(await notice.count(), 0, 'the wizard reports no problems')
  await dialog.getByRole('button', { name: 'Finish' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 60_000 })
}

test('container disk: created, started and running', { timeout: 10 * 60_000 }, () => capture(gui, 'wizard-container', async () => {
  const name = 'wiz-container'
  const dialog = await openWizard()
  await common(dialog, name)
  await step(dialog, 'OS')
  await dialog.getByText('Container disk', { exact: true }).click()
  await dialog.getByRole('button', { name: 'CirrOS (tiny test image)' }).click()
  await step(dialog, 'Disks')
  // A container-disk VM needs no extra disk unless one is added.
  assert.equal(await dialog.getByRole('button', { name: 'Remove' }).count(), 0, 'no extra disks by default')
  await finish(dialog)

  await gui.page.waitForURL((u) => u.pathname.includes(`/n/vm/${ns.name}/${name}`), { timeout: 30_000 })
  const vm = await waitFor('the VM', () => get(gw, { ...VM, namespace: ns.name, name }))
  assert.equal(vm.spec.runStrategy, 'Always')
  assert.equal(vm.spec.template.spec.domain.cpu.model, 'Westmere')
  assert.ok(vm.spec.template.spec.volumes.some((v) => v.containerDisk?.image.includes('cirros')))
  assert.ok(!vm.spec.dataVolumeTemplates?.length, 'no disks were created for a container-disk VM')
  await waitRunning(gw, ns.name, name)
  await closeDialogs(gui.page)
}))

test('disk image imported from a URL: imported and running', { timeout: 15 * 60_000 }, () => capture(gui, 'wizard-url', async () => {
  const name = 'wiz-url'
  const dialog = await openWizard()
  await common(dialog, name)
  await step(dialog, 'OS')
  await dialog.getByText('Import a disk image from a URL').click()
  await field(dialog, 'Image URL').fill(CIRROS_QCOW2)
  await step(dialog, 'Disks')
  await field(dialog, 'Size (GiB)').fill('1')
  await step(dialog, 'Cloud-Init')
  await dialog.getByText('Configure the guest on first boot').click() // off: CirrOS needs none
  await finish(dialog)

  const dv = await waitDataVolume(gw, ns.name, `${name}-rootdisk`)
  assert.equal(dv.spec.source.http.url, CIRROS_QCOW2)
  await waitRunning(gw, ns.name, name)
  // CirrOS from the imported disk really boots.
  const out = await serialConsole(gw, ns.name, name, { send: ['\n'], ms: 8000 })
  assert.match(out, /cirros|login/i)
  await closeDialogs(gui.page)
}))

test('install from an ISO downloaded into the image library', { timeout: 20 * 60_000 }, () => capture(gui, 'wizard-iso', async () => {
  const { page } = gui
  const iso = 'alpine-virt-e2e'
  await gui.goto('/dc/images')
  await page.getByRole('button', { name: 'Download from URL' }).click()
  const download = page.locator('[role=dialog]', { hasText: 'Download image from URL' })
  await field(download, 'URL').fill(ALPINE_ISO)
  // The content type is inferred from the .iso name.
  assert.ok(await download.locator('input[type=radio][value=iso]').isChecked(), 'recognised as an ISO')
  await field(download, 'Namespace').fill(ns.name)
  await field(download, 'Name').fill(iso)
  await field(download, 'Size (GiB)').fill('1')
  await download.getByRole('button', { name: 'Download' }).click()
  await download.waitFor({ state: 'detached', timeout: 60_000 })

  await waitDataVolume(gw, ns.name, iso, { check: (d) => d.metadata.labels?.['kubevirt-webgui/image-type'] === 'iso' })
  await closeDialogs(page)
  await gui.goto('/dc/images')
  // The library lists every namespace; an earlier run's image may still be terminating.
  await page.locator('main tr', { hasText: iso }).filter({ hasText: ns.name }).getByText('Succeeded').waitFor({ timeout: 30_000 })

  const name = 'wiz-iso'
  const dialog = await openWizard()
  await common(dialog, name, { memoryMib: 512 })
  await step(dialog, 'OS')
  await dialog.getByText('Install from an ISO image').click()
  await field(dialog, 'ISO image').selectOption(`${ns.name}/${iso}`)
  await step(dialog, 'Disks')
  await field(dialog, 'Size (GiB)').fill('1')
  await finish(dialog)

  const vm = await waitFor('the VM', () => get(gw, { ...VM, namespace: ns.name, name }))
  const cdrom = vm.spec.template.spec.domain.devices.disks.find((d) => d.cdrom)
  assert.ok(cdrom, 'a CD/DVD drive')
  assert.equal(cdrom.bootOrder, 1, 'the ISO boots first')
  const cdromVolume = vm.spec.template.spec.volumes.find((v) => v.name === cdrom.name)
  const template = vm.spec.dataVolumeTemplates.find((t) => t.metadata.name === cdromVolume.dataVolume.name)
  assert.deepEqual(template.spec.source.pvc, { namespace: ns.name, name: iso }, 'the VM gets its own clone of the ISO')

  await waitRunning(gw, ns.name, name, 12 * 60_000)
  const dvs = await list(gw, { ...DV, namespace: ns.name })
  assert.ok(dvs.some((d) => d.metadata.name === `${name}-cdrom` && d.status?.phase === 'Succeeded'))
  // The Alpine installer's boot loader and kernel talk on the serial console.
  let seen = ''
  const out = await waitFor('Alpine on the serial console', async () => {
    seen += await serialConsole(gw, ns.name, name, { send: ['\n'], ms: 6000 })
    return /alpine|login:|isolinux|syslinux|Welcome/i.test(seen) ? seen : null
  }, { timeoutMs: 5 * 60_000, intervalMs: 5000 }).catch(async (e) => {
    // Keep what the display shows too: firmware and boot-loader errors only go there.
    await gui.goto(gui.vmPath(ns.name, name, 'console')).catch(() => {})
    await page.waitForTimeout(10_000)
    await gui.shot('fail-wizard-iso-display').catch(() => {})
    const vmi = await get(gw, { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachineinstances', namespace: ns.name, name })
    e.message += `\n--- serial: ${JSON.stringify(seen.slice(-500))}; node ${vmi?.status?.nodeName}`
    throw e
  })
  assert.ok(out)
  await closeDialogs(page)
}))
