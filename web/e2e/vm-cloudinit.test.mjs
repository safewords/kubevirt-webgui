// Cloud-Init panel, through the browser: structured settings and raw user data
// are saved into the VM, and the guest really boots with them.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { load } from 'js-yaml'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { testNamespace, waitFor } from './lib/k8s.mjs'
import { createVm, FEDORA } from './lib/fixtures.mjs'
import { capture, cirrosRun, vmSpec, waitRunning, waitVmi } from './lib/vm.mjs'

let gw, ns, gui
const NAME = 'ci'
const USER = 'e2euser'
const PASSWORD = 'E2e-pass-4821'

before(async () => {
  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'vm')
  await createVm(gw, ns.name, NAME, { image: FEDORA, memory: '1536Mi', cloudInit: '#cloud-config\n' })
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

const userDataOf = async () => (await vmSpec(gw, ns.name, NAME))?.volumes?.find((v) => v.cloudInitNoCloud)?.cloudInitNoCloud?.userData ?? ''

/** A label's input in the structured form (the label precedes its input or a wrapper of it). */
function input(label) {
  return gui.page
    .locator(`xpath=//main//label[normalize-space(.)=${JSON.stringify(label)}]/following-sibling::*[1]/descendant-or-self::*[self::input or self::textarea or self::select][1]`)
    .first()
}

async function loginAndRun(command) {
  return cirrosRun(gw, ns.name, NAME, command, { user: USER, password: PASSWORD, timeoutMs: 8 * 60_000 })
}

test('structured user, password and hostname reach the guest', { timeout: 15 * 60_000 }, () => capture(gui, 'cloudinit-structured', async () => {
  const { page } = gui
  await gui.goto(gui.vmPath(ns.name, NAME, 'cloudinit'))
  await input('User').waitFor({ timeout: 30_000 })
  await input('User').fill(USER)
  await input('Password').fill(PASSWORD)
  await input('Hostname').fill('e2e-host')
  await page.getByRole('button', { name: 'Save' }).click()

  const userData = await waitFor('saved user data', async () => {
    const text = await userDataOf()
    return text.includes('e2e-host') ? text : null
  })
  assert.ok(userData.startsWith('#cloud-config\n'), 'keeps the cloud-config header')
  const doc = load(userData)
  assert.equal(doc.user, USER)
  assert.equal(doc.password, PASSWORD)
  assert.equal(doc.hostname, 'e2e-host')
  // Without fqdn, Fedora keeps the VM name from KubeVirt's meta-data.
  assert.equal(doc.fqdn, 'e2e-host')
  assert.deepEqual(doc.chpasswd, { expire: false })

  await gw.runTask('vm.start', { namespace: ns.name, name: NAME }, 10 * 60_000)
  const out = await loginAndRun('hostname; id -un')
  assert.match(out, /e2e-host/)
  assert.match(out, new RegExp(USER))
}))

test('raw user data round-trips and applies after a restart', { timeout: 15 * 60_000 }, () => capture(gui, 'cloudinit-raw', async () => {
  const { page } = gui
  await gui.goto(gui.vmPath(ns.name, NAME, 'cloudinit'))
  await page.getByRole('button', { name: /Raw user data/ }).click()
  const raw = `#cloud-config\nuser: ${USER}\npassword: ${PASSWORD}\nchpasswd:\n  expire: false\nhostname: e2e-raw\nfqdn: e2e-raw\nwrite_files:\n  - path: /etc/e2e-marker\n    content: written-by-raw-user-data\n`
  const editor = page.locator('main .cm-content').first()
  await editor.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.insertText(raw)
  await page.getByRole('button', { name: 'Save' }).click()
  await waitFor('raw user data saved', async () => (await userDataOf()) === raw)

  // Round trip: a fresh page shows exactly what was saved, and the structured view parses it.
  await gui.goto(gui.vmPath(ns.name, NAME, 'cloudinit'))
  await input('Hostname').waitFor({ timeout: 30_000 })
  assert.equal(await input('Hostname').inputValue(), 'e2e-raw')
  await page.getByRole('button', { name: /Raw user data/ }).click()
  const shown = await page.locator('main .cm-content').first().innerText()
  assert.ok(shown.includes('written-by-raw-user-data'), 'the raw editor shows the saved user data')

  const before = await waitRunning(gw, ns.name, NAME)
  await gw.runTask('vm.restart', { namespace: ns.name, name: NAME }, 10 * 60_000)
  await waitVmi(gw, ns.name, NAME, (v) => v.metadata.uid !== before.metadata.uid && v.status?.phase === 'Running', 'the restarted instance')
  const out = await loginAndRun('hostname; cat /etc/e2e-marker')
  assert.match(out, /e2e-raw/)
  assert.match(out, /written-by-raw-user-data/)
}))
