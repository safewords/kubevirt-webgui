/**
 * Clipboard access that also works over plain HTTP on a LAN address, where
 * browsers withhold `navigator.clipboard` (it needs a secure context).
 */

export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* fall through to the legacy path */
    }
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/** Read the clipboard, or `null` when the browser will not allow it here. */
export async function readText(): Promise<string | null> {
  if (window.isSecureContext && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return null
    }
  }
  return null
}
