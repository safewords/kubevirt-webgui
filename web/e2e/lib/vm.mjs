/** Helpers for the VM screens: finding form fields, table rows, VM state, the serial console. */
import { wsBase } from './env.mjs'
import { DV, VM, VMI, get, list, waitFor } from './k8s.mjs'

/**
 * The control after a label, by the label's text. Most forms here put a
 * `<label>` before its control without `for`, so this walks the DOM instead.
 */
export function field(scope, label) {
  const text = JSON.stringify(label)
  return scope
    .locator(
      `xpath=.//label[normalize-space(.)=${text} or normalize-space(.)=${JSON.stringify(`${label}*`)}]/following-sibling::*[1]/descendant-or-self::*[self::input or self::select or self::textarea][1]`,
    )
    .first()
}

/** A table row in the main panel containing `text`. */
export function row(page, text) {
  return page.locator('main table tbody tr', { hasText: text }).first()
}

/** The dialog footer's primary button (the last one). */
export async function submitDialog(dialog) {
  await dialog.locator('footer button').last().click()
}

/** Wait for every modal to close — or fail with the error it shows. */
export async function dialogClosed(page, timeoutMs = 60_000) {
  const started = Date.now()
  for (;;) {
    const count = await page.locator('[role=dialog]').count()
    if (count === 0) return
    const error = page.locator('[role=dialog] .text-bad, [role=dialog] [class*="border-bad"]')
    if ((await error.count()) && Date.now() - started > 3000) {
      const texts = (await error.allInnerTexts()).filter((t) => t.trim())
      if (texts.length) throw new Error(`the dialog reports: ${texts.join(' | ')}`)
    }
    if (Date.now() - started > timeoutMs) throw new Error('the dialog did not close')
    await page.waitForTimeout(300)
  }
}

/** Close any task viewer or dialog left open. */
export async function closeDialogs(page) {
  for (let i = 0; i < 4 && (await page.locator('[role=dialog]').count()); i++) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
}

export async function vmSpec(gw, ns, name) {
  return (await get(gw, { ...VM, namespace: ns, name }))?.spec?.template?.spec
}

export function waitVmi(gw, ns, name, check, what = 'the VMI', timeoutMs = 10 * 60_000) {
  return waitFor(what, async () => {
    const vmi = await get(gw, { ...VMI, namespace: ns, name })
    return vmi && check(vmi) ? vmi : null
  }, { timeoutMs })
}

export function waitRunning(gw, ns, name, timeoutMs = 10 * 60_000) {
  return waitVmi(gw, ns, name, (v) => v.status?.phase === 'Running', `${ns}/${name} to run`, timeoutMs)
}

/**
 * Open the serial console over the GUI's console proxy, optionally type
 * lines into it, and return everything it printed after `ms`.
 */
export async function serialConsole(gw, ns, name, { ms = 5000, send = [], sendDelayMs = 1500 } = {}) {
  const { path } = await gw.call('console.ticket', { namespace: ns, name, kind: 'serial' })
  const socket = new WebSocket(`${wsBase}${path}`)
  socket.binaryType = 'arraybuffer'
  const chunks = []
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Error('the serial console did not open'))
  })
  socket.onmessage = (e) => chunks.push(Buffer.from(e.data))
  const encoder = new TextEncoder()
  for (const line of send) {
    socket.send(encoder.encode(line))
    await new Promise((r) => setTimeout(r, sendDelayMs))
  }
  await new Promise((r) => setTimeout(r, ms))
  socket.close()
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Log in on a CirrOS serial console and run `command`, returning the output.
 * CirrOS prints its login prompt on the serial console; the default password is
 * `gocubsgo`.
 */
export async function cirrosRun(gw, ns, name, command, { user = 'cirros', password = 'gocubsgo', timeoutMs = 4 * 60_000 } = {}) {
  const marker = `__E2E_${Math.random().toString(36).slice(2, 8)}__`
  let last = ''
  return waitFor(`the CirrOS console of ${ns}/${name} to answer`, async () => {
    const out = await serialConsole(gw, ns, name, {
      send: ['\n', `${user}\n`, `${password}\n`, `echo ${marker}; ${command}; echo ${marker}\n`, 'exit\n'],
      sendDelayMs: 2500,
      ms: 3000,
    })
    last = out
    const parts = out.split(marker)
    // The echoed command line contains the marker too; the output sits between the last two.
    return parts.length >= 4 ? parts[parts.length - 2] : null
  }, { timeoutMs, intervalMs: 5000 }).catch((e) => {
    throw new Error(`${e.message}\n--- console ---\n${last.slice(-1500)}`)
  })
}

/** Run `fn`, saving a screenshot (and the page's text) when it fails. */
export async function capture(gui, name, fn) {
  try {
    return await fn()
  } catch (e) {
    await gui.shot(`fail-${name}`).catch(() => {})
    const text = await gui.page.locator('body').innerText().catch(() => '')
    e.message += `\n--- page text (${name}) ---\n${text.slice(0, 1500)}`
    throw e
  }
}

/**
 * Wait for a DataVolume to succeed. On a timeout the error says where its
 * importer pods ran and how they were doing, so a node-specific CDI failure is
 * recognisable from the log alone.
 */
export async function waitDataVolume(gw, ns, name, { timeoutMs = 10 * 60_000, check = () => true } = {}) {
  let state = ''
  try {
    return await waitFor(`DataVolume ${name}`, async () => {
      const dv = await get(gw, { ...DV, namespace: ns, name })
      const pods = (await list(gw, { apiVersion: 'v1', resource: 'pods', namespace: ns })).filter((p) => /^(importer|cdi-upload|.*-source-pod)/.test(p.metadata.name))
      state = `phase=${dv?.status?.phase} progress=${dv?.status?.progress} restarts=${dv?.status?.restartCount ?? 0}; ` +
        pods.map((p) => {
          const cs = p.status?.containerStatuses?.[0]
          const why = cs?.state?.waiting?.reason ?? cs?.lastState?.terminated?.message ?? cs?.state?.terminated?.message ?? ''
          return `${p.metadata.name} on ${p.spec.nodeName ?? '(unscheduled)'} ${p.status?.phase} ${String(why).trim().slice(0, 160)}`
        }).join('; ')
      return dv?.status?.phase === 'Succeeded' && check(dv) ? dv : null
    }, { timeoutMs, intervalMs: 5000 })
  } catch (e) {
    e.message += `
--- ${name}: ${state}`
    throw e
  }
}
