/** Finding form controls and waiting on things in the GUI, by what a person sees. */

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The control labelled `label` inside `scope`: works for the wizard's
 * FormRow (label beside the control) and for `label.label` above a control.
 */
export function field(scope, label, { prefix = false } = {}) {
  // The whole label (a required marker or a parenthesised note aside), so
  // "Name" does not find "Namespace"; `prefix` for labels with more after.
  const pattern = prefix ? `^\\s*${escape(label)}` : `^\\s*${escape(label)}\\s*\\*?\\s*(\\(.*\\))?\\s*$`
  return scope
    .locator('label', { hasText: new RegExp(pattern) })
    .first()
    .locator('xpath=..')
    .locator('input:not([type=checkbox]):not([type=radio]), select, textarea')
    .first()
}

/** A button inside `scope` by its visible text. */
export function button(scope, text, exact = false) {
  return scope.getByRole('button', { name: text, exact })
}

/** Close every open dialog (task viewers opened by an action, say). */
export async function closeDialogs(page) {
  for (let i = 0; i < 4; i++) {
    const dialogs = page.locator('[role=dialog]')
    if (!(await dialogs.count())) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
  }
}

/** The header's Create dropdown → an item. */
export async function createMenu(page, item) {
  const header = page.locator('header')
  await header.getByRole('button', { name: 'Create', exact: true }).click()
  await header.getByRole('button', { name: item, exact: true }).click()
}

/** The object header's dropdown (`More`, `Console`) → an item. */
export async function headerMenu(page, menu, item) {
  await page.getByRole('button', { name: menu, exact: true }).first().click()
  await page.getByRole('button', { name: item, exact: false }).last().click()
}

/** A header action button (primary group) by its title. */
export function headerAction(page, title) {
  return page.locator('section > div').first().getByRole('button', { name: title, exact: true })
}

/** Wait for a toast with `title` (and return its text). */
export async function toastText(page, title, timeout = 30_000) {
  const toast = page.locator('div.card', { hasText: title }).last()
  await toast.waitFor({ timeout })
  return toast.innerText()
}
