/**
 * Driving the GUI in a real browser (playwright-core with an installed
 * Chromium-family browser — no browser download).
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { artifacts, base, browserPath, headed, token } from './env.mjs'

export async function openGui({ viewport = { width: 1600, height: 1000 } } = {}) {
  if (!browserPath) throw new Error('no Chromium-family browser found; set E2E_BROWSER')
  const browser = await chromium.launch({ executablePath: browserPath, headless: !headed })
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) errors.push(`console: ${m.text()}`)
  })

  const gui = {
    browser,
    page,
    errors,
    async login(bearer = token) {
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' })
      await page.locator('textarea').waitFor({ timeout: 20_000 })
      await page.fill('textarea', bearer)
      await page.click('button[type=submit]')
      await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 120_000 })
      await page.getByText('Datacenter').first().waitFor({ timeout: 60_000 })
    },
    async goto(path) {
      await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1500)
    },
    vmPath: (namespace, name, panel = 'summary') => `/n/vm/${namespace}/${name}/${panel}`,
    /** The open modal dialog. */
    dialog: () => page.locator('[role=dialog]').last(),
    /** Click a toolbar/menu entry by its visible text. */
    async action(text) {
      await page.getByRole('button', { name: text, exact: false }).first().click()
    },
    /** Open a header dropdown (`More`, `Console`, the split `Shutdown` arrow) and pick an item. */
    async menu(menuTitle, item) {
      if (menuTitle === 'power') await page.locator('button[data-split-toggle]').first().click()
      else await page.getByRole('button', { name: menuTitle, exact: true }).first().click()
      await page.getByRole('button', { name: item, exact: false }).last().click()
    },
    /** Confirm the confirmation dialog, typing the name when it asks. */
    async confirm(typeToConfirm) {
      const dialog = gui.dialog()
      await dialog.waitFor()
      if (typeToConfirm) await dialog.locator('input:not([type=checkbox])').last().fill(typeToConfirm)
      await dialog.locator('footer button').last().click()
    },
    /** The id of the task a toast or task viewer shows for `description`. */
    async waitTaskRow(description, { status = 'OK', timeoutMs = 5 * 60_000 } = {}) {
      const row = page.locator('section tr', { hasText: description }).first()
      await row.waitFor({ timeout: 30_000 })
      await row.getByText(status, { exact: false }).waitFor({ timeout: timeoutMs })
    },
    async shot(name) {
      mkdirSync(artifacts, { recursive: true })
      await page.screenshot({ path: join(artifacts, `${name}.png`) })
    },
    async close() {
      await browser.close()
    },
  }
  return gui
}
