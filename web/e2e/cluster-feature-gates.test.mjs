// Datacenter → Options: turn a KubeVirt feature gate on and off through the
// GUI, and prove the KubeVirt CR changes by exactly that — no empty objects
// or defaults written back, which would drift from how KubeVirt was installed.
//
// E2E_GATE=HotplugVolumes by default. E2E_GATE_ACTION:
//   cycle (default)  flip the gate and flip it back — ends as it started
//   on / off         leave it in that state (used around suites that need it)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { list, waitFor } from './lib/k8s.mjs'

const GATE = process.env.E2E_GATE ?? 'HotplugVolumes'
const ACTION = process.env.E2E_GATE_ACTION ?? (process.env.E2E_GATE_LEAVE_ENABLED === '1' ? 'on' : 'cycle')
const KUBEVIRT = { apiVersion: 'kubevirt.io/v1', resource: 'kubevirts' }

async function kubevirtCr(gw) {
  const [cr] = await list(gw, KUBEVIRT)
  assert.ok(cr, 'a KubeVirt CR exists')
  return cr
}

const gates = (cr) => cr.spec?.configuration?.developerConfiguration?.featureGates ?? []

/** The CR's spec with the feature gate list removed, for comparing everything else. */
function specWithoutGates(cr) {
  const spec = structuredClone(cr.spec)
  delete spec.configuration?.developerConfiguration?.featureGates
  return spec
}

async function toggleGateInGui(gui, want) {
  await gui.goto('/dc/options')
  const row = gui.page.locator('label', { hasText: GATE }).filter({ has: gui.page.locator('input[type=checkbox]') }).first()
  await row.waitFor({ timeout: 30_000 })
  const box = row.locator('input[type=checkbox]')
  if ((await box.isChecked()) === want) return false
  await box.click()
  await gui.page.getByRole('button', { name: 'Save' }).click()
  await gui.page.getByText('KubeVirt configuration saved').waitFor({ timeout: 30_000 })
  return true
}

async function waitAvailable(gw) {
  await waitFor('KubeVirt to report Available and not Progressing', async () => {
    const cr = await kubevirtCr(gw)
    const c = (type) => cr.status?.conditions?.find((x) => x.type === type)?.status
    return c('Available') === 'True' && c('Progressing') !== 'True' && c('Degraded') !== 'True'
  }, { timeoutMs: 10 * 60_000, intervalMs: 5000 })
}

test(`feature gate ${GATE}: ${ACTION} through the GUI with a minimal patch`, { timeout: 20 * 60_000 }, async () => {
  const gw = await Gateway.connect()
  const gui = await openGui()
  try {
    await gui.login()
    const before = await kubevirtCr(gw)
    const hadGate = gates(before).includes(GATE)
    const otherSpec = specWithoutGates(before)

    async function setGate(want) {
      await toggleGateInGui(gui, want)
      const cr = await waitFor(`the gate to be ${want ? 'in' : 'out of'} the CR`, async () => {
        const current = await kubevirtCr(gw)
        return gates(current).includes(GATE) === want ? current : null
      })
      assert.deepEqual(specWithoutGates(cr), otherSpec, 'nothing but the feature gates changed')
      await waitAvailable(gw)
      return cr
    }

    const steps = ACTION === 'on' ? [true] : ACTION === 'off' ? [false] : [!hadGate, hadGate]
    let last = before
    for (const want of steps) last = await setGate(want)
    if (ACTION === 'cycle') assert.deepEqual(gates(last), gates(before), 'the gate list is back to what it was')
    await gui.shot(`feature-gate-${GATE}-${ACTION}`)
    assert.deepEqual(gui.errors, [])
  } finally {
    await gui.close()
    gw.close()
  }
})
