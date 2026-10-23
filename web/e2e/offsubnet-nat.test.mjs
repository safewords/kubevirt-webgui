// Network → Off-subnet client NAT, through the GUI: a bridged Multus
// interface is configured, validated, saved on the VM template and removed.
//
// With E2E_OFFSUBNET_VM=<namespace>/<name> — a running VM whose bridged
// interface already has the setting and the node agent installed — it also
// checks, read-only, that the agent reports it applied and the panel shows it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { load } from 'js-yaml'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { VM, VMI, get, testNamespace, waitFor } from './lib/k8s.mjs'
import { vmManifest } from './lib/fixtures.mjs'
import { capture } from './lib/vm.mjs'

const SPEC = 'kubevirt-webgui/offsubnet-nat'
const STATUS = 'kubevirt-webgui/offsubnet-nat-status'
const NAME = 'nat-vm'

let gw, ns, gui

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'nat')
  await gw.call('resource.create', {
    apiVersion: 'k8s.cni.cncf.io/v1',
    resource: 'network-attachment-definitions',
    namespace: ns.name,
    body: {
      apiVersion: 'k8s.cni.cncf.io/v1',
      kind: 'NetworkAttachmentDefinition',
      metadata: { name: 'lan', namespace: ns.name },
      spec: { config: JSON.stringify({ cniVersion: '0.3.1', name: 'lan', type: 'bridge', bridge: 'kve-e2e-none' }) },
    },
  })
  const vm = vmManifest(ns.name, NAME)
  vm.spec.template.spec.domain.devices.interfaces = [{ name: 'lan', bridge: {} }]
  vm.spec.template.spec.networks = [{ name: 'lan', multus: { networkName: `${ns.name}/lan` } }]
  await gw.call('resource.create', { ...VM, namespace: ns.name, body: vm })
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

/** The panel's card, and a labelled input in it. */
const card = () => gui.page.locator('.card', { hasText: 'Off-subnet client NAT' })
const input = (label) => card().locator(`xpath=.//label[normalize-space(.)=${JSON.stringify(label)}]/following-sibling::*[1]/descendant-or-self::input[1]`)

test('configure, validate, save and remove on a bridged interface', { timeout: 3 * 60_000 }, () => capture(gui, 'offsubnet-nat', async () => {
  const { page } = gui
  await gui.goto(gui.vmPath(ns.name, NAME, 'network'))
  await card().waitFor({ timeout: 20_000 })

  await card().getByLabel('lan').check()
  await input('Client ranges').fill('10.1.0.0/24, 10.2.0.0/33')
  await input('Translate to').fill('10.0.0.1')
  await card().getByText('10.2.0.0/33 is not an IPv4 range').waitFor({ timeout: 5000 })
  assert.ok(await card().getByRole('button', { name: 'Save', exact: true }).isDisabled(), 'an invalid range cannot be saved')

  await input('Client ranges').fill('10.1.0.0/24, 10.2.0.0/24')
  await input('Gateway MAC').fill('AA:BB:CC:00:11:22')
  await card().getByRole('button', { name: 'Save', exact: true }).click()

  const vm = await waitFor('the setting on the VM template', async () => {
    const v = await get(gw, { ...VM, namespace: ns.name, name: NAME })
    return v?.spec?.template?.metadata?.annotations?.[SPEC] ? v : null
  }, { timeoutMs: 30_000 })
  const text = vm.spec.template.metadata.annotations[SPEC]
  assert.deepEqual(load(text), [
    { interface: 'lan', clients: ['10.1.0.0/24', '10.2.0.0/24'], guestIP: 'auto', snatTo: '10.0.0.1', gatewayMAC: 'aa:bb:cc:00:11:22' },
  ])
  assert.match(text, /^- interface: lan\n/, 'stored as YAML, as documented')

  // Unticking the interface and removing takes the setting off the template.
  await page.waitForTimeout(1500)
  await card().getByLabel('lan').uncheck()
  await card().getByRole('button', { name: 'Remove', exact: true }).click()
  await waitFor('the setting removed', async () => {
    const v = await get(gw, { ...VM, namespace: ns.name, name: NAME })
    return v && !v.spec?.template?.metadata?.annotations?.[SPEC] ? v : null
  }, { timeoutMs: 30_000 })
  assert.deepEqual(gui.errors, [])
}))

const live = process.env.E2E_OFFSUBNET_VM
test('the node agent applies it to a running VM, and the panel shows it', { skip: !live && 'set E2E_OFFSUBNET_VM=<namespace>/<name>', timeout: 3 * 60_000 }, () => capture(gui, 'offsubnet-nat-live', async () => {
  const [namespace, name] = live.split('/')
  const vmi = await waitFor('an Applied status from the agent', async () => {
    const v = await get(gw, { ...VMI, namespace, name })
    const status = v?.metadata?.annotations?.[STATUS]
    return status && JSON.parse(status).state === 'Applied' ? v : null
  }, { timeoutMs: 60_000 })
  const status = JSON.parse(vmi.metadata.annotations[STATUS])
  const row = status.interfaces.find((i) => i.state === 'Applied')
  assert.match(row.bridge, /^k6t-/)
  assert.match(row.gatewayMAC, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)

  await gui.goto(gui.vmPath(namespace, name, 'network'))
  await card().waitFor({ timeout: 20_000 })
  await card().getByText(`bridge ${row.bridge}`).waitFor({ timeout: 10_000 })
  await card().getByRole('button', { name: 'Test', exact: true }).click()
  await card().getByText(/connection\(s\) translated so far/).waitFor({ timeout: 10_000 })
  assert.equal(await card().getByRole('button', { name: 'Save', exact: true }).isDisabled(), true, 'opening the panel changes nothing')
}))
