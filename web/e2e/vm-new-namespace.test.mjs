// A VM in a namespace the wizard creates, installing from an ISO in another
// namespace's image library: the namespace is made on Finish, the VM's
// namespace is allowed to clone from the library, and the VM runs. Also: a
// named CPU model no node can run is refused before anything is created.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { DV, VM, get, testNamespace, waitFor } from './lib/k8s.mjs'
import { capture, closeDialogs, field, waitDataVolume, waitRunning } from './lib/vm.mjs'
import { chooseNamespace, createMenu } from './lib/forms.mjs'

const ALPINE_ISO = 'https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso'
const ISO = 'alpine-virt-e2e'
const RBAC = 'rbac.authorization.k8s.io/v1'

let gw, library, gui
const target = `kve-e2e-newns-${Math.random().toString(36).slice(2, 7)}`

before(async () => {
  gw = await Gateway.connect()
  library = await testNamespace(gw, 'lib')
  await gw.call('resource.create', {
    ...DV,
    namespace: library.name,
    body: {
      apiVersion: 'cdi.kubevirt.io/v1beta1',
      kind: 'DataVolume',
      metadata: { name: ISO, namespace: library.name, labels: { 'kubevirt-webgui/image-type': 'iso' } },
      spec: { source: { http: { url: ALPINE_ISO } }, storage: { resources: { requests: { storage: '1Gi' } } } },
    },
  })
  gui = await openGui()
  await gui.login()
})

after(async () => {
  if (gui) {
    if (gui.errors.length) console.log('browser errors:', gui.errors)
    await gui.close()
  }
  for (const vm of await (async () => (await gw.call('resource.list', { ...VM, namespace: target }).catch(() => ({ items: [] }))).items ?? [])()) {
    await gw.call('resource.delete', { ...VM, namespace: target, name: vm.metadata.name }).catch(() => {})
  }
  await gw.call('resource.delete', { apiVersion: 'v1', resource: 'namespaces', name: target }).catch(() => {})
  await library?.cleanup()
  gw?.close()
})

async function step(dialog, title) {
  await dialog.locator('nav button', { hasText: title }).click()
}

test('new namespace, ISO cloned from another namespace, CPU model checked', { timeout: 20 * 60_000 }, () => capture(gui, 'wizard-new-namespace', async () => {
  const { page } = gui
  await waitDataVolume(gw, library.name, ISO)
  // The wizard's image list comes from a watch; give it the finished ISO.
  await gui.goto('/dc/images')
  await page.locator('main tr', { hasText: ISO }).filter({ hasText: library.name }).getByText('Succeeded').waitFor({ timeout: 30_000 })

  await closeDialogs(page)
  await createMenu(page, 'Create VM')
  const dialog = page.locator('[role=dialog]', { hasText: 'Create: Virtual Machine' })
  await dialog.waitFor({ timeout: 15_000 })

  const name = 'wiz-newns'
  await chooseNamespace(dialog, target)
  await dialog.getByText(`“${target}” does not exist yet; it will be created.`).waitFor({ timeout: 5000 })
  await field(dialog, 'Name').fill(name)

  await step(dialog, 'OS')
  await dialog.getByText('Install from an ISO image').click()
  await field(dialog, 'ISO image').selectOption(`${library.name}/${ISO}`)
  await step(dialog, 'Disks')
  await field(dialog, 'Size (GiB)').fill('1')

  await step(dialog, 'CPU')
  await field(dialog, 'Cores').fill('1')
  await field(dialog, 'Type').fill('NoSuchCpu-Model')
  await dialog.getByText('No node can run the CPU model NoSuchCpu-Model').first().waitFor({ timeout: 5000 })
  await field(dialog, 'Type').fill('Westmere')
  await step(dialog, 'Memory')
  await field(dialog, 'Memory (MiB)').fill('512')

  await step(dialog, 'Confirm')
  assert.equal(await dialog.getByText('Some steps need attention').count(), 0, 'the wizard reports no problems')
  await dialog.getByRole('button', { name: 'Finish' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 60_000 })

  const ns = await waitFor('the new namespace', () => get(gw, { apiVersion: 'v1', resource: 'namespaces', name: target }))
  assert.equal(ns.metadata.name, target)
  const binding = await waitFor('the clone grant', () =>
    get(gw, { apiVersion: RBAC, resource: 'rolebindings', namespace: library.name, name: `kubevirt-webgui-clone-to-${target}` }),
  )
  assert.ok(binding.subjects.some((s) => s.kind === 'ServiceAccount' && s.name === 'default' && s.namespace === target))
  const role = await get(gw, { apiVersion: RBAC, resource: 'roles', namespace: library.name, name: 'kubevirt-webgui-clone-source' })
  assert.deepEqual(role.rules, [{ apiGroups: ['cdi.kubevirt.io'], resources: ['datavolumes/source'], verbs: ['create'] }])

  const vm = await waitFor('the VM', () => get(gw, { ...VM, namespace: target, name }))
  const cdrom = vm.spec.dataVolumeTemplates.find((t) => t.metadata.name === `${name}-cdrom`)
  assert.deepEqual(cdrom.spec.source.pvc, { namespace: library.name, name: ISO }, 'the ISO is cloned across namespaces')
  await waitDataVolume(gw, target, `${name}-cdrom`)
  await waitRunning(gw, target, name, 12 * 60_000)
  await closeDialogs(page)
}))
