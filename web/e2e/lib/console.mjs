/** Reading a VM's serial console over the console proxy. */
import { wsBase } from './env.mjs'

/**
 * Open the serial console and collect its output. `until(text)` decides when
 * enough has been seen; resolves with everything read, or rejects on timeout.
 */
export async function serialUntil(gw, namespace, name, until, { timeoutMs = 5 * 60_000, send } = {}) {
  const { path } = await gw.call('console.ticket', { namespace, name, kind: 'serial' })
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${path}`)
    socket.binaryType = 'arraybuffer'
    const decoder = new TextDecoder()
    let text = ''
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`serial console did not show what was expected within ${timeoutMs / 1000}s; last output:\n${text.slice(-600)}`))
    }, timeoutMs)
    socket.onopen = () => {
      if (send) socket.send(new TextEncoder().encode(send))
    }
    socket.onmessage = (event) => {
      text += decoder.decode(new Uint8Array(event.data), { stream: true })
      if (until(text)) {
        clearTimeout(timer)
        socket.close()
        resolve(text)
      }
    }
    socket.onclose = (event) => {
      if (event.code !== 1000 && event.code !== 1005) {
        clearTimeout(timer)
        reject(new Error(`serial console closed (${event.code} ${event.reason})`))
      }
    }
  })
}

/**
 * Start watching the console now and resolve once a fresh kernel boot is
 * seen — so a reboot triggered after this call is detected, not the boot
 * that already happened.
 */
export function watchForBoot(gw, namespace, name, timeoutMs = 5 * 60_000) {
  return serialUntil(gw, namespace, name, (text) => /Linux version \d/.test(text) || /Booting Linux|SeaBIOS \(version/.test(text), { timeoutMs })
}
