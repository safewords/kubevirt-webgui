// Exposing a VM and firewalling it, through the GUI, with the traffic proven
// by a client pod: SSH reachable through the Service, dropped by "Default
// DROP in", reachable again once an allow rule names the client.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, get, list, waitFor } from './lib/k8s.mjs'
import { vmManifest } from './lib/fixtures.mjs'
import { avoidBadNodes, avoidBadNodesPod } from './lib/placement.mjs'
import { closeDialogs, field } from './lib/forms.mjs'

let gw, ns, gui
const VM_NAME = 'net-vm'
const SERVICE = `${VM_NAME}-ssh`
const CLIENT = 'ssh-probe'
const OTHER = 'other-probe'

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'net')
  const vm = avoidBadNodes(vmManifest(ns.name, VM_NAME))
  await gw.runTask('vm.create', { vm, start: false })
  await gw.runTask('vm.start', { namespace: ns.name, name: VM_NAME }, 8 * 60_000)
  gui = await openGui()
  await gui.login()
})

after(async () => {
  await gui?.close()
  await ns?.cleanup()
  gw?.close()
})

/** What a probe pod most recently saw on the service's port 22. */
async function probe(name = CLIENT) {
  const log = await gw.call('resource.logs', { namespace: ns.name, name, tailLines: 1 })
  return (log.trim().split('\n').pop() ?? '').replace(/^\S+\s/, '').trim()
}

async function expectProbe(state, what, timeoutMs = 3 * 60_000, name = CLIENT) {
  // Several consecutive readings, so a connection that was mid-flight when a
  // policy changed does not decide the outcome.
  let streak = 0
  await waitFor(what, async () => {
    streak = (await probe(name)) === state ? streak + 1 : 0
    return streak >= 3
  }, { timeoutMs, intervalMs: 2500 })
}

/** A pod that tries SSH through the Service every few seconds and logs OPEN or CLOSED. */
function probePod(name, app) {
  return avoidBadNodesPod({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: ns.name, labels: { app } },
    spec: {
      terminationGracePeriodSeconds: 1,
      containers: [
        {
          name: 'probe',
          image: 'busybox:1.36',
          command: ['sh', '-c', `while true; do if (sleep 3 | timeout 4 nc ${SERVICE}.${ns.name}.svc 22) 2>/dev/null | grep -q SSH; then echo OPEN; else echo CLOSED; fi; sleep 1; done`],
        },
      ],
    },
  })
}

test('Expose creates a ClusterIP Service whose endpoint is the VM', { timeout: 10 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/n/vm/${ns.name}/${VM_NAME}/services`)
  await page.getByRole('button', { name: 'Expose', exact: true }).click()
  const dialog = gui.dialog()
  assert.equal(await field(dialog, 'Service name').inputValue(), SERVICE)
  await dialog.getByRole('button', { name: 'Create service' }).click()
  await dialog.waitFor({ state: 'detached' })

  const service = await waitFor('the Service', () => get(gw, { apiVersion: 'v1', resource: 'services', namespace: ns.name, name: SERVICE }))
  assert.equal(service.spec.type, 'ClusterIP')
  assert.deepEqual(service.spec.ports.map((p) => [p.port, Number(p.targetPort), p.protocol]), [[22, 22, 'TCP']])

  const [launcher] = await list(gw, { apiVersion: 'v1', resource: 'pods', namespace: ns.name }, { labelSelector: `vm.kubevirt.io/name=${VM_NAME}` })
  assert.ok(launcher?.status?.podIP, 'the launcher pod has an address')
  await waitFor('the Service endpoints to contain the launcher pod', async () => {
    const endpoints = await get(gw, { apiVersion: 'v1', resource: 'endpoints', namespace: ns.name, name: SERVICE })
    return (endpoints?.subsets ?? []).some((s) => (s.addresses ?? []).some((a) => a.ip === launcher.status.podIP))
  })

  // The panel lists it with its in-cluster address.
  await page.locator('tr', { hasText: SERVICE }).waitFor({ timeout: 30_000 })
  await page.getByText(`${SERVICE}.${ns.name}.svc:22`).waitFor({ timeout: 30_000 })

  // A client in the namespace reaches SSH through the Service: dropbear's banner comes back.
  const pod = probePod(CLIENT, 'kve-e2e-client')
  await gw.call('resource.create', { apiVersion: 'v1', resource: 'pods', namespace: ns.name, body: pod })
  // The guest's SSH server starts a little after boot.
  await expectProbe('OPEN', 'SSH to answer through the Service', 6 * 60_000)
})

test('Default DROP in blocks the traffic', { timeout: 6 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/c/namespace/${ns.name}/firewall`)
  await page.getByRole('button', { name: 'Default DROP in' }).click()
  await gui.confirm()

  const policy = await waitFor('the drop policy', async () =>
    (await list(gw, { apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: ns.name })).find((p) => p.spec.policyTypes?.includes('Ingress') && !p.spec.ingress?.length),
  )
  assert.deepEqual(policy.spec.podSelector.matchLabels, { 'kubevirt.io': 'virt-launcher' })
  await page.getByText('DROP all (no allow rules)').waitFor({ timeout: 30_000 })

  await expectProbe('CLOSED', 'the firewall to drop SSH')
  // A second client, which the allow rule will not name.
  await gw.call('resource.create', { apiVersion: 'v1', resource: 'pods', namespace: ns.name, body: probePod(OTHER, 'kve-e2e-other') })
  await waitFor('the second probe to report', async () => ['OPEN', 'CLOSED'].includes(await probe(OTHER).catch(() => '')), { timeoutMs: 3 * 60_000 })
  await expectProbe('CLOSED', 'the second probe to be dropped too', 3 * 60_000, OTHER)
})

test('An allow rule for the client restores SSH, and only for it', { timeout: 6 * 60_000 }, async () => {
  const { page } = gui
  await gui.goto(`/c/namespace/${ns.name}/firewall`)
  await page.getByRole('button', { name: 'Add rule' }).click()
  const dialog = gui.dialog()
  await field(dialog, 'Applies to').selectOption(VM_NAME)
  // The source kind picker: the select offering "Pods with labels".
  await dialog.locator('select', { has: page.locator('option[value=pods]') }).first().selectOption('pods')
  await dialog.locator('input[placeholder="app=web,tier=frontend"]').fill('app=kve-e2e-client')
  await field(dialog, 'Comment').fill('ssh from the probe')
  await dialog.getByRole('button', { name: 'Add rule', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })

  const allow = await waitFor('the allow policy', async () =>
    (await list(gw, { apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: ns.name })).find((p) => p.spec.ingress?.length),
  )
  assert.deepEqual(allow.spec.podSelector.matchLabels, { 'vm.kubevirt.io/name': VM_NAME })
  assert.deepEqual(allow.spec.ingress[0].from, [{ podSelector: { matchLabels: { app: 'kve-e2e-client' } } }])
  assert.deepEqual(allow.spec.ingress[0].ports, [{ protocol: 'TCP', port: 22 }])

  await expectProbe('OPEN', 'SSH to be allowed again for the probe')
  await expectProbe('CLOSED', 'SSH to stay dropped for the client the rule does not name', 60_000, OTHER)
  await closeDialogs(page)
  assert.deepEqual(gui.errors, [])
})
