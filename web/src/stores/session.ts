import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { gateway, type Hello } from '@/api/gateway'
import type { UserInfo } from '@/api/types'

const TICKET_KEY = 'kve.ticket'

interface StoredTicket {
  ticket: string
  expires: number
}

function readTicket(): StoredTicket | null {
  try {
    const raw = localStorage.getItem(TICKET_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredTicket
    if (!parsed.ticket || parsed.expires * 1000 < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

function writeTicket(ticket: StoredTicket | null) {
  try {
    if (ticket) localStorage.setItem(TICKET_KEY, JSON.stringify(ticket))
    else localStorage.removeItem(TICKET_KEY)
  } catch {
    /* storage unavailable: the session lasts as long as the tab */
  }
}

/**
 * With `AUTH_REQUIRED` the server serves nothing until a session cookie is set
 * by its own sign-in page. That cookie holds the same ticket the gateway uses,
 * so: resume from it instead of asking for the token again, hand every new
 * ticket back so the cookie lasts as long as the session, and clear it on
 * sign-out. Without the gate none of this runs.
 */
const gate = {
  up: () => gateway.hello.value?.auth.required === true,
  async ticket(): Promise<StoredTicket | null> {
    try {
      const response = await fetch('/auth/ticket', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) return null
      const body = (await response.json()) as StoredTicket
      return body.ticket ? body : null
    } catch {
      return null
    }
  },
  async keep(ticket: string) {
    try {
      await fetch('/auth/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket }),
      })
    } catch {
      /* the cookie runs out on its own; the next page load asks again */
    }
  },
  async leave() {
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } catch {
      /* a stale cookie is refused anyway once the ticket expires */
    }
    // The gate's own sign-in page, not this app's: nothing loads without it.
    window.location.assign('/')
  },
}

/** `AUTH_REQUIRED=false`: the server lets everyone in as its own identity. */
const openAccess = () => gateway.hello.value?.auth.open === true

export const useSession = defineStore('session', () => {
  const status = ref<'starting' | 'anonymous' | 'authenticated'>('starting')
  const user = ref<UserInfo | null>(null)
  const expires = ref<number>(0)
  const hello = computed<Hello | null>(() => gateway.hello.value)
  const lastError = ref<string | null>(null)
  let memoryTicket: StoredTicket | null = null
  let renewTimer: ReturnType<typeof setInterval> | null = null

  function remember(ticket: string, expiresAt: number) {
    memoryTicket = { ticket, expires: expiresAt }
    writeTicket(memoryTicket)
    if (gate.up()) void gate.keep(ticket)
  }

  function adopt(result: { user: UserInfo; expires: number; ticket?: string }) {
    user.value = result.user
    expires.value = result.expires
    if (result.ticket) remember(result.ticket, result.expires)
    status.value = 'authenticated'
    scheduleRenew()
  }

  function scheduleRenew() {
    if (renewTimer) clearInterval(renewTimer)
    // Renew well before expiry, which also re-checks the token is still valid.
    renewTimer = setInterval(async () => {
      if (status.value !== 'authenticated') return
      const remaining = expires.value * 1000 - Date.now()
      if (remaining > 60 * 60 * 1000) return
      try {
        adopt(await gateway.call('auth.renew'))
      } catch {
        /* leave it to expire; the server will say so */
      }
    }, 5 * 60 * 1000)
  }

  /** Called by the gateway after every (re)connection. */
  async function resume() {
    const stored = memoryTicket ?? readTicket() ?? (gate.up() ? await gate.ticket() : null)
    if (!stored && openAccess()) {
      // Open access: nobody signs in; everyone is the server's identity.
      // `immediate`: this runs inside the gateway's onOpen, before queued calls
      // are flushed — a queued call would wait for itself until it timed out.
      try {
        adopt(await gateway.call('auth.login', { method: 'server' }, { immediate: true, timeout: 15000 }))
      } catch (e: any) {
        lastError.value = e?.message ?? String(e)
        status.value = 'anonymous'
      }
      return
    }
    if (!stored) {
      if (status.value !== 'anonymous') status.value = 'anonymous'
      return
    }
    try {
      const result = await gateway.call('auth.resume', { ticket: stored.ticket }, { immediate: true, timeout: 15000 })
      memoryTicket = stored
      adopt(result)
    } catch (e: any) {
      if (e?.code === 'Disconnected' || e?.code === 'Timeout') return
      memoryTicket = null
      writeTicket(null)
      user.value = null
      status.value = 'anonymous'
    }
  }

  async function login(token: string) {
    lastError.value = null
    const result = await gateway.call('auth.login', { token })
    adopt(result)
  }

  async function loginAsServer() {
    lastError.value = null
    const result = await gateway.call('auth.login', { method: 'server' })
    adopt(result)
  }

  async function logout() {
    try {
      await gateway.call('auth.logout', {}, { timeout: 5000 })
    } catch {
      /* signing out locally is what matters */
    }
    gateway.closeAllSubscriptions()
    memoryTicket = null
    writeTicket(null)
    user.value = null
    status.value = 'anonymous'
    if (renewTimer) clearInterval(renewTimer)
    if (gate.up()) await gate.leave()
  }

  function expired() {
    memoryTicket = null
    writeTicket(null)
    if (openAccess()) {
      void resume() // just sign in again: there is nobody to ask
      return
    }
    user.value = null
    lastError.value = 'Your session has expired. Please sign in again.'
    status.value = 'anonymous'
    if (gate.up()) void gate.leave()
  }

  const displayName = computed(() => {
    const name = user.value?.username ?? ''
    const sa = name.match(/^system:serviceaccount:([^:]+):(.+)$/)
    return sa ? `${sa[2]}@${sa[1]}` : name
  })

  const open = computed(() => hello.value?.auth.open === true)

  return { status, user, expires, hello, lastError, displayName, open, resume, login, loginAsServer, logout, expired }
})
